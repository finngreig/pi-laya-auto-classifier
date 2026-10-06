/**
 * The gate: one tool call in, allow or block out.
 *
 *   auto mode off                              → run
 *   hard-deny (shell), or a change to the gate's own settings
 *                                              → block, Laya never asked
 *   user deny / allow pattern (shell)          → block / run (recorded)
 *   user safe command (shell)                  → run
 *   dangerous shape (shell)                    → Laya, flagged
 *   read-only command chain (bash)             → run
 *   anything else on a shell                   → Laya
 *   write/edit outside the project or to a protected path → Laya, flagged
 *   other write/edit                           → run
 *   read/grep of credential material           → Laya, flagged
 *   other read-only built-ins                  → run
 *   extension/MCP tool not marked read-only    → Laya
 *
 * Laya's answer: allow runs; a block blocks and tells the agent why; an unclear
 * answer, or no answer at all, is resolved by the `uncertain` setting (block, or
 * ask the user). Nothing that cannot be decided is ever allowed silently.
 *
 * After `denialLimits` blocks in a row (or in total), escalated calls go to the
 * user instead, as Claude Code's auto mode does. Without a UI they keep blocking,
 * and the block asks Pi to stop the agent after the current batch.
 */

import { buildGatedCall, type GatedCall, type ToolCallEventLike } from "./call.ts";
import type { DecisionEngine, EngineEvidence, EngineVerdict } from "./engine.ts";
import { extractRecentIntent } from "./intent.ts";
import {
  dangerousReasons,
  evaluateUserCommandRules,
  hardDenyReasons,
  isReadOnlyCommandChain,
  isUserDeclaredSafeCommand,
  touchesGateSettings,
  unique,
} from "./policy.ts";
import type { DecisionRecord, DecisionSource } from "./records.ts";
import type { LayaAutoModeSettings, SettingsScope } from "./settings.ts";
import { buildConfirmationDialog } from "./ui.ts";

export const NOT_KNOWN_SAFE_REASON = "not on the known-safe list";
export const EXTENSION_TOOL_REASON = "extension tool not marked read-only";
export const GATE_SETTINGS_REASON = "changes the auto mode's own settings";

/**
 * Reasons Laya cannot settle on its own. Whether a downloaded script is
 * trustworthy is a supply-chain question, not something a classifier can read
 * from the command, so an allow is downgraded to unclear.
 */
const ALWAYS_UNCLEAR_REASONS = new Set(["downloaded script execution"]);

export interface GateUi {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  select(title: string, options: string[]): Promise<string | undefined>;
}

export interface GateContext {
  readonly cwd: string;
  readonly hasUI: boolean;
  readonly sessionManager: { getBranch?: () => readonly unknown[] };
  readonly ui: GateUi;
  readonly signal?: AbortSignal | undefined;
}

export interface DenialCounts {
  consecutive: number;
  total: number;
}

export interface GateState {
  settings: LayaAutoModeSettings;
  scope: SettingsScope;
  denials: DenialCounts;
  /** Last probability seen per rule, for `/laya-auto-mode threshold`. */
  lastProbabilities: Record<string, number>;
}

export interface GateDeps {
  readonly engine: DecisionEngine;
  readonly record: (record: DecisionRecord) => void;
  readonly now: () => number;
  /** MCP-style annotations of a tool, when Pi knows the tool. */
  readonly toolAnnotations?: (toolName: string) => { readonly readOnlyHint?: boolean } | undefined;
}

export interface BlockResult {
  readonly block: true;
  readonly reason: string;
  readonly terminate?: boolean;
}

export function createGateState(settings: LayaAutoModeSettings, scope: SettingsScope = "global"): GateState {
  return { settings, scope, denials: { consecutive: 0, total: 0 }, lastProbabilities: {} };
}

/** Whether repeated blocks have handed the decision back to the user. */
export function breakerTripped(state: GateState): boolean {
  const { consecutive, total } = state.settings.denialLimits;
  return (consecutive > 0 && state.denials.consecutive >= consecutive) || (total > 0 && state.denials.total >= total);
}

interface Escalation {
  readonly reasons: readonly string[];
  readonly flagged: boolean;
}

type Triage =
  | { readonly kind: "run" }
  | { readonly kind: "block"; readonly source: DecisionSource; readonly reasons: readonly string[]; readonly rationale: string }
  | { readonly kind: "allow"; readonly reasons: readonly string[]; readonly rationale: string }
  | ({ readonly kind: "escalate" } & Escalation);

/** The deterministic layer. Exported for tests and for the calibration script. */
export function triage(
  event: ToolCallEventLike,
  call: GatedCall,
  settings: LayaAutoModeSettings,
  cwd: string,
  annotations?: GateDeps["toolAnnotations"],
): Triage {
  switch (call.kind) {
    case "shell": {
      // Patterns run on the raw command: redaction must not hide a shape.
      const command = typeof event.input.command === "string" ? event.input.command : "";
      const hard = [...hardDenyReasons(command), ...(touchesGateSettings({ command }) ? [GATE_SETTINGS_REASON] : [])];
      if (hard.length > 0) {
        return { kind: "block", source: "hard-deny", reasons: hard, rationale: `A non-negotiable safety rule matched: ${hard.join(", ")}.` };
      }
      const userRule = evaluateUserCommandRules(command, settings);
      if (userRule?.decision === "deny") {
        return { kind: "block", source: "user-rule", reasons: [userRule.pattern], rationale: `Your disallowed pattern matched: ${userRule.pattern}.` };
      }
      if (userRule?.decision === "allow") {
        return { kind: "allow", reasons: [userRule.pattern], rationale: `Your allowed pattern matched: ${userRule.pattern}.` };
      }
      if (isUserDeclaredSafeCommand(command, settings.safeCommands)) return { kind: "run" };
      const dangerous = dangerousReasons(command, cwd);
      if (dangerous.length > 0) return { kind: "escalate", reasons: dangerous, flagged: true };
      if (call.tool === "bash" && isReadOnlyCommandChain(command)) return { kind: "run" };
      return { kind: "escalate", reasons: [NOT_KNOWN_SAFE_REASON], flagged: false };
    }

    case "write": {
      if (call.path !== undefined && touchesGateSettings({ path: call.path })) {
        return { kind: "block", source: "hard-deny", reasons: [GATE_SETTINGS_REASON], rationale: `A non-negotiable safety rule matched: ${GATE_SETTINGS_REASON}.` };
      }
      const reasons = unique(
        [call.protectedReason, call.outsideCwd ? "write outside the working directory" : undefined].filter(
          (reason): reason is string => typeof reason === "string",
        ),
      );
      return reasons.length > 0 ? { kind: "escalate", reasons, flagged: true } : { kind: "run" };
    }

    case "read":
      // Listing a credential directory shows names, not secrets; reading one does not.
      return call.credentialReason && (call.tool === "read" || call.tool === "grep")
        ? { kind: "escalate", reasons: [`reads ${call.credentialReason}`], flagged: true }
        : { kind: "run" };

    case "tool": {
      if (!settings.gateOtherTools) return { kind: "run" };
      if (annotations?.(call.tool)?.readOnlyHint === true) return { kind: "run" };
      return { kind: "escalate", reasons: [EXTENSION_TOOL_REASON], flagged: false };
    }
  }
}

function blockMessage(rationale: string): string {
  return `Laya auto mode blocked this tool call. ${rationale} Do not repeat the same call unchanged: change the approach, or ask the user.`;
}

function unavailableHint(state: GateState): string {
  return state.settings.server.mode === "managed"
    ? "Run `/laya-auto-mode doctor` to see why the managed server is not answering."
    : `Start laya-serve (LAYA_HOST=127.0.0.1 laya-serve) or check server.url (${state.settings.server.url}). \`/laya-auto-mode doctor\` checks the connection.`;
}

/**
 * Decide one tool call. Returns `undefined` to let it run.
 *
 * Exported so the whole path can be tested without a Pi runtime.
 */
export async function evaluateToolCall(
  event: ToolCallEventLike,
  ctx: GateContext,
  state: GateState,
  deps: GateDeps,
): Promise<BlockResult | undefined> {
  const { settings } = state;
  if (!settings.enabled) return undefined;

  const call = buildGatedCall(event, {
    cwd: ctx.cwd,
    maxActionCharacters: settings.maxActionCharacters,
    extraProtectedPaths: settings.extraProtectedPaths,
  });

  const record = (
    status: DecisionRecord["status"],
    source: DecisionSource,
    reasons: readonly string[],
    rationale: string,
    evidence: EngineEvidence = {},
  ): void => {
    deps.record({
      tool: call.tool,
      summary: call.summary,
      reasons: [...reasons],
      status,
      source,
      rationale,
      ...(evidence.observations ? { observations: evidence.observations } : {}),
      ...(evidence.decidingRule ? { decidingRule: evidence.decidingRule } : {}),
      ...(evidence.checkpoint ? { checkpoint: evidence.checkpoint } : {}),
      ...(evidence.latencyMs !== undefined ? { latencyMs: evidence.latencyMs } : {}),
      timestamp: deps.now(),
    });
  };

  const decision = triage(event, call, settings, ctx.cwd, deps.toolAnnotations);
  if (decision.kind === "run") return undefined;
  if (decision.kind === "block") {
    record("blocked", decision.source, decision.reasons, decision.rationale);
    return { block: true, reason: blockMessage(decision.rationale) };
  }
  if (decision.kind === "allow") {
    record("allowed", "user-rule", decision.reasons, decision.rationale);
    return undefined;
  }

  const { reasons, flagged } = decision;

  // A judged call that ends in a block counts towards the limits; one that runs
  // resets the run of consecutive blocks.
  const deny = (source: DecisionSource, rationale: string, evidence?: EngineEvidence): BlockResult => {
    state.denials.consecutive += 1;
    state.denials.total += 1;
    record("blocked", source, reasons, rationale, evidence);
    const stop = !ctx.hasUI && breakerTripped(state);
    return { block: true, reason: blockMessage(rationale), ...(stop ? { terminate: true } : {}) };
  };
  const allow = (status: "allowed" | "confirmed", source: DecisionSource, rationale: string, evidence?: EngineEvidence): undefined => {
    state.denials.consecutive = 0;
    record(status, source, reasons, rationale, evidence);
    return undefined;
  };
  const ask = async (rationale: string, evidence?: EngineEvidence): Promise<BlockResult | undefined> => {
    const choice = await ctx.ui.select(
      buildConfirmationDialog({
        tool: call.tool,
        ...(call.command !== undefined ? { command: call.command } : { summary: call.summary }),
        reasons,
        rationale,
      }),
      ["Block", "Allow once"],
    );
    if (choice === "Allow once") return allow("confirmed", "user", rationale, evidence);
    record("declined", "user", reasons, "You declined the call.", evidence);
    return { block: true, reason: "The user declined this tool call at the Laya auto mode prompt. Do not retry it unchanged." };
  };

  if (breakerTripped(state) && ctx.hasUI) {
    const { consecutive, total } = state.denials;
    return ask(`Auto mode is paused after ${consecutive} blocks in a row (${total} this session), so this call needs you. \`/laya-auto-mode reset\` resumes it.`);
  }

  const intent = extractRecentIntent(ctx.sessionManager.getBranch?.() ?? []);
  let verdict: EngineVerdict;
  try {
    verdict = await deps.engine.judge({ call, reasons, flagged, intent, cwd: ctx.cwd }, ctx.signal ? { signal: ctx.signal } : {});
  } catch (error) {
    verdict = { verdict: "unavailable", reason: "engine_error", rationale: `The decision engine failed: ${String(error)}` };
  }

  for (const observation of verdict.observations ?? []) state.lastProbabilities[observation.ruleId] = observation.probability;
  const evidence: EngineEvidence = {
    ...(verdict.observations ? { observations: verdict.observations } : {}),
    ...(verdict.decidingRule ? { decidingRule: verdict.decidingRule } : {}),
    ...(verdict.checkpoint ? { checkpoint: verdict.checkpoint } : {}),
    ...(verdict.latencyMs !== undefined ? { latencyMs: verdict.latencyMs } : {}),
  };

  if (ctx.signal?.aborted) {
    record("blocked", "unavailable", reasons, "The turn was cancelled before a decision was reached.", evidence);
    return { block: true, reason: "The turn was cancelled." };
  }

  let unclear: { source: DecisionSource; rationale: string } | undefined;
  switch (verdict.verdict) {
    case "deny":
      return deny("laya", verdict.rationale, evidence);
    case "allow": {
      const forced = reasons.find((reason) => ALWAYS_UNCLEAR_REASONS.has(reason));
      if (forced) unclear = { source: "uncertain", rationale: `Laya found no clear hazard, but ${forced} always needs a decision it cannot make.` };
      else if (call.actionTruncated) unclear = { source: "uncertain", rationale: `The call is longer than maxActionCharacters (${settings.maxActionCharacters}), so Laya could not read it in full.` };
      else return allow("allowed", "laya", verdict.rationale, evidence);
      break;
    }
    case "uncertain":
      unclear = { source: "uncertain", rationale: verdict.rationale };
      break;
    case "unavailable":
      unclear = { source: "unavailable", rationale: `Laya is unavailable (${verdict.reason}): ${verdict.rationale} ${unavailableHint(state)}` };
      break;
  }

  if (settings.uncertain === "ask" && ctx.hasUI) return ask(unclear.rationale, evidence);
  return deny(unclear.source, unclear.rationale, evidence);
}
