/**
 * The decision-engine seam.
 *
 * The gate (ordering, blocking, asking, recording) is deterministic. Everything
 * probabilistic sits behind `DecisionEngine`, so the gate can be tested without a
 * model and the Laya layer can be swapped without touching the safety-critical path.
 */

import type { GatedCall } from "./call.ts";
import type { UserIntent } from "./intent.ts";
import type { Observation } from "./laya/decide.ts";

export interface CandidateInput {
  readonly call: GatedCall;
  /** Why the deterministic layer escalated the call. */
  readonly reasons: readonly string[];
  /**
   * The deterministic layer recognised a dangerous shape or a protected target,
   * as opposed to "not on the known-safe list". Required, not optional: a caller
   * that forgot it would quietly relax the intent question.
   */
  readonly flagged: boolean;
  readonly intent: UserIntent;
  readonly cwd: string;
}

export interface EngineEvidence {
  readonly observations?: readonly Observation[];
  readonly decidingRule?: string;
  readonly checkpoint?: string;
  readonly latencyMs?: number;
}

export type EngineVerdict =
  | ({ readonly verdict: "allow" | "deny" | "uncertain"; readonly rationale: string } & EngineEvidence)
  | ({ readonly verdict: "unavailable"; readonly reason: string; readonly rationale: string } & EngineEvidence);

export interface JudgeOptions {
  readonly signal?: AbortSignal;
}

export interface DecisionEngine {
  readonly id: string;
  judge(input: CandidateInput, options: JudgeOptions): Promise<EngineVerdict>;
}
