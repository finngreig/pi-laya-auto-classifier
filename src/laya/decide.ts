/**
 * Probabilities to a decision.
 *
 * Each question has two cut-offs on the probability of its safe answer:
 *
 *   p >= pass     the safe answer is clear
 *   p <= reject   the unsafe answer is clear
 *   in between    the middle band
 *
 * They are not symmetric because Laya's answers are not: on these checkpoints
 * the "should run" and "should not" clusters sit at different distances from 0.5.
 *
 * Composition happens here, in code, so the model never weighs concerns against
 * each other:
 *
 * 1. A clear "the user did not ask for this" blocks.
 * 2. For a flagged call (a dangerous shape or protected target), the user's
 *    request must be clear; a middle-band answer is unclear.
 * 3. A clear unsafe answer to a `hazard` question blocks.
 * 4. A clear unsafe answer to a `soft` question blocks unless the user clearly
 *    asked for the call.
 * 5. Otherwise the call is allowed.
 *
 * Adapted from pi-jev-auto-mode (MIT). See LICENSE.
 */

import { INTENT_RULE_ID, safeProbability, type LayaRule, type OptionOrder } from "./questions.ts";

export type Band = "satisfied" | "rejected" | "uncertain";

/** Widen both cut-offs by a hair so 0.55 read back from JSON still counts as 0.55. */
const BOUNDARY_EPSILON = 1e-9;

export function classify(probability: number, pass: number, reject: number): Band {
  if (probability <= reject + BOUNDARY_EPSILON) return "rejected";
  if (probability >= pass - BOUNDARY_EPSILON) return "satisfied";
  return "uncertain";
}

export interface Observation {
  readonly ruleId: string;
  readonly label: string;
  /** Probability of the safe answer. */
  readonly probability: number;
  readonly pass: number;
  readonly reject: number;
  readonly band: Band;
  /** What the band did to this call. */
  readonly effect: "pass" | "block" | "unclear" | "ignored";
  readonly clearedByIntent: boolean;
}

export interface Combined {
  readonly verdict: "allow" | "deny" | "uncertain";
  readonly rationale: string;
  readonly observations: readonly Observation[];
  readonly decidingRule?: string;
}

/** A cut-off shown as it is, not rounded into a different one (`0.995` is not `0.99`). */
export function formatThreshold(value: number): string {
  const two = value.toFixed(2);
  return Number(two) === Number(value.toFixed(4)) ? two : Number(value.toFixed(4)).toString();
}

export function combine(
  rules: readonly LayaRule[],
  probabilities: Readonly<Record<string, Readonly<Record<string, number>>>>,
  flagged: boolean,
  order: OptionOrder = "unsafe-first",
): Combined {
  const bands = rules.map((rule) => {
    const probability = safeProbability(probabilities[rule.id], order);
    return { rule, probability, band: classify(probability, rule.pass, rule.reject) };
  });

  const intent = bands.find(({ rule }) => rule.id === INTENT_RULE_ID);
  const intentSatisfied = intent?.band === "satisfied";

  const rank = (effect: Observation["effect"], severity: LayaRule["severity"]): number =>
    effect === "block" ? (severity === "soft" ? 2 : 3) : effect === "unclear" ? 1 : 0;
  let decided: { rule: LayaRule; probability: number; effect: Observation["effect"] } | undefined;
  const observations: Observation[] = [];

  for (const { rule, probability, band } of bands) {
    let effect: Observation["effect"];
    let clearedByIntent = false;

    if (rule.severity === "intent") {
      effect = band === "rejected" ? "block" : band === "satisfied" ? "pass" : flagged ? "unclear" : "ignored";
    } else if (band === "rejected") {
      if (rule.severity === "soft" && intentSatisfied) {
        effect = "pass";
        clearedByIntent = true;
      } else {
        effect = "block";
      }
    } else {
      // The middle band of a hazard question is not evidence of a hazard.
      effect = band === "satisfied" ? "pass" : "ignored";
    }

    observations.push({ ruleId: rule.id, label: rule.label, probability, pass: rule.pass, reject: rule.reject, band, effect, clearedByIntent });
    if (rank(effect, rule.severity) > (decided ? rank(decided.effect, decided.rule.severity) : 0)) {
      decided = { rule, probability, effect };
    }
  }

  if (decided) {
    const message = decided.effect === "block" ? decided.rule.denyMessage : decided.rule.uncertainMessage;
    return {
      verdict: decided.effect === "block" ? "deny" : "uncertain",
      rationale: `${message} (${decided.rule.label}: p=${decided.probability.toFixed(2)})`,
      observations,
      decidingRule: decided.rule.id,
    };
  }

  const cleared = observations.filter((observation) => observation.clearedByIntent);
  if (cleared.length > 0) {
    return {
      verdict: "allow",
      rationale: `The user asked for this, which clears ${cleared.map((o) => `${o.label} (p=${o.probability.toFixed(2)})`).join(", ")}.`,
      observations,
    };
  }
  const shown = observations.map((o) => `${o.label} p=${o.probability.toFixed(2)}`).join(", ");
  return { verdict: "allow", rationale: observations.length > 0 ? `Nothing stood out (${shown}).` : "No questions applied.", observations };
}
