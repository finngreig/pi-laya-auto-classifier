/**
 * Footer status and user-facing text.
 *
 * The preview bounding is adapted from pi-jev-auto-mode (MIT). See THIRD_PARTY_NOTICES.
 */

import { formatThreshold } from "./laya/decide.ts";
import { DEFAULT_RULES, type Cutoffs, type LayaRule } from "./laya/questions.ts";
import type { ManagedState } from "./laya/server.ts";
import type { LayaAutoModeSettings, SettingsScope } from "./settings.ts";

export const STATUS_ID = "laya-auto-mode";

export interface StatusInput {
  readonly enabled: boolean;
  readonly serverMode: "external" | "managed";
  readonly managedState?: ManagedState;
  readonly reachable?: boolean;
  readonly paused: boolean;
}

/** Short, but never silent: off, starting, unreachable and paused all look different. */
export function statusText(input: StatusInput): string {
  if (!input.enabled) return "🛡 laya off";
  if (input.paused) return "🛡 laya paused (asking)";
  if (input.serverMode === "managed") {
    if (input.managedState === "starting") return "🛡 laya starting…";
    if (input.managedState === "failed" || input.managedState === "stopped") return "🛡 laya not running";
  }
  if (input.reachable === false) return "🛡 laya unreachable";
  return "🛡 laya";
}

export const USAGE = `/laya-auto-mode                   status
/laya-auto-mode on | off          turn auto mode on or off (saved)
/laya-auto-mode doctor            check the server, the checkpoint and a test decision
/laya-auto-mode uncertain block | ask
                                  what an unclear answer (or no answer) does
/laya-auto-mode checkpoint english | multilingual | typed-decisions
/laya-auto-mode threshold         cut-offs and the last probability seen per question
/laya-auto-mode threshold <question> <pass> <block>
/laya-auto-mode threshold reset [question]
/laya-auto-mode server start | stop | restart   (managed mode)
/laya-auto-mode reset             clear the block counters and resume after a pause
/laya-auto-mode display compact | full`;

export function describeSettings(settings: LayaAutoModeSettings, scope: SettingsScope, settingsPath: string): string {
  const server =
    settings.server.mode === "managed"
      ? `managed (${settings.server.command})`
      : `external at ${settings.server.url}${process.env.LAYA_API_KEY ? " (with LAYA_API_KEY)" : ""}`;
  return [
    `auto mode: ${settings.enabled ? "on" : "off"}`,
    `server: ${server}`,
    `checkpoint: ${settings.checkpoint}${settings.maxLen ? ` (max_len ${settings.maxLen})` : ""}`,
    `request window: the last ${settings.requestMessages === 1 ? "user message" : `${settings.requestMessages} user messages`} (ignoring "ok, go ahead")`,
    `unclear answers: ${settings.uncertain}`,
    `timeout: ${settings.timeoutMs}ms`,
    `pause after: ${settings.denialLimits.consecutive || "∞"} blocks in a row, ${settings.denialLimits.total || "∞"} in total`,
    `extension tools judged: ${settings.gateOtherTools ? "yes" : "no"}`,
    `your rules: ${settings.safeCommands.length} safe, ${settings.allowedCommands.length} allowed, ${settings.disallowedCommands.length} disallowed, ${settings.extraProtectedPaths.length} protected paths`,
    `settings: ${settingsPath}${scope === "project" ? " + this project's .pi/laya-auto-mode.json" : ""}`,
  ].join("\n");
}

const showCutoffs = (c: Cutoffs): string => `pass ≥ ${formatThreshold(c.pass)}, block ≤ ${formatThreshold(c.reject)}`;

export function formatThresholdTable(
  rules: readonly LayaRule[],
  overrides: Readonly<Record<string, Cutoffs>>,
  lastSeen: Readonly<Record<string, number>>,
): string {
  const lines = rules.map((rule) => {
    const base = DEFAULT_RULES.find((r) => r.id === rule.id) ?? rule;
    const override = overrides[rule.id];
    const seen = lastSeen[rule.id];
    return `${rule.id.padEnd(10)} ${showCutoffs(override ?? base)}${override ? ` (default ${showCutoffs(base)})` : ""}  last p(safe)=${seen === undefined ? "–" : seen.toFixed(2)}`;
  });
  return [...lines, "", "p(safe) is Laya's probability of the safe answer. Change with: threshold <question> <pass> <block>"].join("\n");
}

const PREVIEW_LINES = 6;
const PREVIEW_LINE_LENGTH = 120;

/**
 * A bounded command preview. Pi's dialogs do not clip, so an unbounded command
 * makes a dialog taller than the terminal; the full command is already in the
 * tool call above it.
 */
export function previewCommand(command: string): string[] {
  const all = command.split("\n");
  const lines = all.slice(0, PREVIEW_LINES).map((line) => (line.length > PREVIEW_LINE_LENGTH ? `${line.slice(0, PREVIEW_LINE_LENGTH)}…` : line));
  if (all.length > PREVIEW_LINES) lines.push(`… ${all.length - PREVIEW_LINES} more line(s), in full in the tool call above`);
  return lines;
}

export interface ConfirmationParts {
  readonly tool: string;
  readonly command?: string;
  readonly summary?: string;
  readonly reasons: readonly string[];
  readonly rationale: string;
}

export function buildConfirmationDialog(parts: ConfirmationParts): string {
  const body = parts.command !== undefined ? previewCommand(parts.command).map((line) => `  ${line}`) : [`  ${parts.summary ?? ""}`];
  return [
    `Laya auto mode: allow this ${parts.tool} call?`,
    ...body,
    "",
    `Escalated because: ${parts.reasons.join(", ")}`,
    `Laya: ${parts.rationale}`,
  ].join("\n");
}
