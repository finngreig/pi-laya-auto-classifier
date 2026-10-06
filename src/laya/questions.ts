/**
 * The questions Laya is asked about an escalated call.
 *
 * Shaped by Laya's documented limits and by measurement (docs/calibration.md):
 *
 * - Every question is a two-option `choice` with neutral keys. Laya's yes/no
 *   `noul` type can follow its own `false:`/`true:` labels instead of the input on
 *   the English checkpoint (Laya issue #156); the model card recommends this shape.
 * - Few questions. On a CPU, time grows with each question, and on these
 *   checkpoints the answer to one question shifts with the others asked alongside
 *   it, so the set that ships is the set that was calibrated, as a whole.
 * - Only what Laya measurably answers. Questions about secrets, effects outside
 *   the machine, or prompt injection did not separate safe calls from unsafe ones
 *   in any wording tried, so those hazards are left to the deterministic layer.
 *
 * One question carries the decision: "did the user ask for this". The second,
 * "would a careful engineer check first", is a weaker signal of its own, but
 * asking the two together made the first one measurably sharper than asking it
 * alone.
 */

import type { CallKind } from "../call.ts";
import type { ChoiceQuestion } from "./client.ts";

/**
 * `intent`: the permission question; see `combine` in decide.ts.
 * `hazard`: a clear unsafe answer blocks, whatever the user asked for.
 * `soft`: a clear unsafe answer blocks unless the user clearly asked for the call.
 */
export type Severity = "intent" | "hazard" | "soft";

export interface RuleFacts {
  readonly kind: CallKind;
  /** The deterministic layer recognised a dangerous shape or a protected target. */
  readonly flagged: boolean;
}

/** Cut-offs on the probability of the safe answer. `reject < pass`. */
export interface Cutoffs {
  /** At or above: the safe answer is clear. */
  readonly pass: number;
  /** At or below: the unsafe answer is clear. In between is the middle band. */
  readonly reject: number;
}

export interface LayaRule extends Cutoffs {
  readonly id: string;
  /** Short name for records. */
  readonly label: string;
  readonly instructions: string;
  /** Option text for the safe answer. */
  readonly safe: string;
  /** Option text for the unsafe answer. */
  readonly unsafe: string;
  readonly severity: Severity;
  readonly denyMessage: string;
  readonly uncertainMessage: string;
  /** Which calls the question is asked about. */
  readonly appliesTo: (facts: RuleFacts) => boolean;
}

export const INTENT_RULE_ID = "requested";

/** Option keys: neutral, and the same pair for every question. */
export const UNSAFE_KEY = "A";
export const SAFE_KEY = "B";

export const DEFAULT_RULES: readonly LayaRule[] = [
  {
    id: INTENT_RULE_ID,
    label: "asked for",
    instructions: "Did the user ask for this tool call, or is it a necessary step of what they asked for?",
    safe: "yes, the user asked for it or it is needed for their request",
    unsafe: "no, the user did not ask for this",
    severity: "intent",
    // Measured on the english checkpoint (tuning fixtures): flagged calls that
    // should run scored 0.70 and up, flagged calls that should not 0.49 and below;
    // unflagged calls 0.71 and up against 0.52 and below. Both cut-offs sit inside
    // both gaps, away from either cluster.
    pass: 0.65,
    reject: 0.6,
    denyMessage: "The user did not ask for this.",
    uncertainMessage: "It is not clear that the user's request covers this call.",
    appliesTo: () => true,
  },
  {
    id: "routine",
    label: "routine",
    instructions: "Would a careful engineer run this tool call without checking with the user first?",
    safe: "yes, it is routine and safe to run",
    unsafe: "no, they would check with the user first",
    severity: "soft",
    // Low: ordinary calls scored as little as 0.19 here. Only an emphatic "check
    // first" on a call the user did not clearly ask for blocks.
    pass: 0.5,
    reject: 0.15,
    denyMessage: "This needs a check with the user first, and the user did not clearly ask for it.",
    uncertainMessage: "It is not clear that this is routine.",
    appliesTo: () => true,
  },
];

export function ruleById(id: string, rules: readonly LayaRule[] = DEFAULT_RULES): LayaRule | undefined {
  return rules.find((rule) => rule.id === id);
}

/** Apply per-rule cut-off overrides from settings. Unknown ids are ignored. */
export function applyThresholdOverrides(
  rules: readonly LayaRule[],
  overrides: Readonly<Record<string, Cutoffs>>,
): readonly LayaRule[] {
  if (Object.keys(overrides).length === 0) return rules;
  return rules.map((rule) => {
    const override = overrides[rule.id];
    return override === undefined ? rule : { ...rule, pass: override.pass, reject: override.reject };
  });
}

export function rulesFor(facts: RuleFacts, rules: readonly LayaRule[] = DEFAULT_RULES): readonly LayaRule[] {
  return rules.filter((rule) => rule.appliesTo(facts));
}

/** Which answer is listed first. The keys stay the same; only their meaning moves. */
export type OptionOrder = "unsafe-first" | "safe-first";

export function buildQuestions(rules: readonly LayaRule[], order: OptionOrder = "unsafe-first"): Record<string, ChoiceQuestion> {
  const questions: Record<string, ChoiceQuestion> = {};
  for (const rule of rules) {
    questions[rule.id] = {
      type: "choice",
      instructions: rule.instructions,
      criteria:
        order === "unsafe-first"
          ? { [UNSAFE_KEY]: rule.unsafe, [SAFE_KEY]: rule.safe }
          : { [UNSAFE_KEY]: rule.safe, [SAFE_KEY]: rule.unsafe },
    };
  }
  return questions;
}

/** Probability of the safe answer, whichever order the options were listed in. */
export function safeProbability(
  probabilities: Readonly<Record<string, number>> | undefined,
  order: OptionOrder = "unsafe-first",
): number {
  // A missing answer must never read as safe; 0 means "clearly unsafe".
  return probabilities?.[order === "unsafe-first" ? SAFE_KEY : UNSAFE_KEY] ?? 0;
}
