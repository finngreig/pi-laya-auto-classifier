/**
 * The Laya decision engine: one request per escalated call, every applicable
 * question answered in one forward pass, the decision composed locally.
 */

import type { CandidateInput, DecisionEngine, EngineVerdict } from "../engine.ts";
import { isAcknowledgement } from "../intent.ts";
import type { LayaClient, LayaItem } from "./client.ts";
import { combine } from "./decide.ts";
import {
  applyThresholdOverrides,
  buildQuestions,
  DEFAULT_RULES,
  INTENT_RULE_ID,
  rulesFor,
  safeProbability,
  type Cutoffs,
  type LayaRule,
  type OptionOrder,
} from "./questions.ts";

export interface EngineSettings {
  readonly checkpoint: string;
  readonly maxLen: number;
  readonly timeoutMs: number;
  readonly thresholds: Readonly<Record<string, Cutoffs>>;
  /** How many recent substantive user messages are paired with the action. */
  readonly requestMessages: number;
}

export type ClientLookup =
  | { readonly ok: true; readonly client: LayaClient }
  | { readonly ok: false; readonly detail: string };

export interface LayaEngineOptions {
  /** Resolves the client lazily, so a managed server can still be starting. */
  readonly client: (signal?: AbortSignal) => Promise<ClientLookup>;
  readonly settings: () => EngineSettings;
  readonly rules?: readonly LayaRule[];
  /** Calibration knobs; the defaults are what ships. */
  readonly optionOrder?: OptionOrder;
}

export const NO_USER_MESSAGE = "(no recent user message)";

/**
 * The messages paired with the action: the most recent substantive ones, newest
 * first. A bare "ok, go ahead" says nothing about what was asked for, so it is
 * skipped, unless it is all there is.
 *
 * Each message is judged against the action on its own and the clearest match
 * speaks for the request. More than one message lets ordinary work through when
 * the request was a few messages back, but every extra message is another chance
 * for unrelated text to look like permission: with four, an unrequested
 * `npm publish` passed on a vaguely related remark about commits. The default is
 * one (docs/calibration.md has the measurements).
 */
export function requestMessages(input: CandidateInput, max: number): string[] {
  const substantive = input.intent.messages.filter((message) => !isAcknowledgement(message));
  const chosen = (substantive.length > 0 ? substantive : input.intent.messages).slice(0, max);
  return chosen.length > 0 ? chosen : [NO_USER_MESSAGE];
}

/**
 * One state Laya reads. It serialises the state as JSON in key order and, when it
 * is too long, cuts from the end, so the action goes first.
 *
 * Nothing else goes in. Laya is sensitive to irrelevant detail: changing only the
 * name of the working directory moved answers by as much as 0.2.
 */
export function pairState(input: CandidateInput, message: string): Record<string, unknown> {
  return { proposed_tool_call: input.call.action, user_request: message };
}

/**
 * Whether Laya's cut may have reached the action itself.
 *
 * The response reports how many state tokens were kept, not which ones, so the
 * action's length is estimated generously (two characters per token, plus the
 * JSON key) and anything that might not have fitted counts as unread.
 */
export function actionMayBeCut(
  action: string,
  truncated: boolean,
  stateTokens: number | undefined,
  stateTokensDropped: number | undefined,
): boolean {
  if (!truncated) return false;
  if (stateTokens === undefined || stateTokensDropped === undefined) return true;
  const kept = stateTokens - stateTokensDropped;
  const estimate = Math.ceil(JSON.stringify(action).length / 2) + 12;
  return kept < estimate;
}

export function createLayaEngine(options: LayaEngineOptions): DecisionEngine {
  const baseRules = options.rules ?? DEFAULT_RULES;
  const order = options.optionOrder ?? "unsafe-first";

  return {
    id: "laya",

    async judge(input, judgeOptions): Promise<EngineVerdict> {
      const settings = options.settings();
      const lookup = await options.client(judgeOptions.signal);
      if (!lookup.ok) return { verdict: "unavailable", reason: "unreachable", rationale: lookup.detail };

      const rules = rulesFor(
        { kind: input.call.kind, flagged: input.flagged },
        applyThresholdOverrides(baseRules, settings.thresholds),
      );
      const questions = buildQuestions(rules, order);
      const common = { questions, model: settings.checkpoint, ...(settings.maxLen > 0 ? { maxLen: settings.maxLen } : {}) };
      const call = { timeoutMs: settings.timeoutMs, ...(judgeOptions.signal ? { signal: judgeOptions.signal } : {}) };

      const states = requestMessages(input, settings.requestMessages).map((message) => pairState(input, message));
      let items: readonly LayaItem[];
      let latencyMs: number;
      if (states.length === 1) {
        const result = await lookup.client.predict({ ...common, state: states[0] as Record<string, unknown> }, call);
        if (!result.ok) return { verdict: "unavailable", reason: result.reason, rationale: result.detail, latencyMs: result.latencyMs };
        items = [result];
        latencyMs = result.latencyMs;
      } else {
        const result = await lookup.client.predictBatch({ ...common, states }, call);
        if (!result.ok) return { verdict: "unavailable", reason: result.reason, rationale: result.detail, latencyMs: result.latencyMs };
        items = result.items;
        latencyMs = result.latencyMs;
      }

      // The pair whose message most clearly covers the call speaks for the request.
      const intentOf = (item: LayaItem): number => safeProbability(item.probabilities[INTENT_RULE_ID], order);
      const best = items.reduce((a, b) => (intentOf(b) > intentOf(a) ? b : a));
      const combined = combine(rules, best.probabilities, input.flagged, order);
      const evidence = {
        observations: combined.observations,
        ...(combined.decidingRule ? { decidingRule: combined.decidingRule } : {}),
        checkpoint: best.checkpoint,
        latencyMs,
      };

      // A clear block stands even on a partial read. Anything else on a partial
      // read is a judgement about a call Laya did not see in full.
      const cut = items.some((item) => actionMayBeCut(input.call.action, item.truncated, item.stateTokens, item.stateTokensDropped));
      if (combined.verdict !== "deny" && cut) {
        return { verdict: "uncertain", rationale: "The call is too long for Laya to read in full, so it cannot be judged.", ...evidence };
      }
      return { verdict: combined.verdict, rationale: combined.rationale, ...evidence };
    },
  };
}
