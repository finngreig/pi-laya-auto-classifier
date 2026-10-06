/**
 * Decision records.
 *
 * Written with `pi.appendEntry`, which keeps them out of the model's context on
 * purpose: the agent should not learn to argue with the gate. The agent only sees
 * the block reason returned from `tool_call`.
 *
 * The renderer is adapted from pi-jev-auto-mode (MIT). See THIRD_PARTY_NOTICES.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { formatThreshold, type Observation } from "./laya/decide.ts";
import type { DisplayMode } from "./settings.ts";

export const DECISION_ENTRY_TYPE = "laya-auto-mode-decision";

export type DecisionSource = "hard-deny" | "user-rule" | "laya" | "uncertain" | "unavailable" | "user";

export interface DecisionRecord {
  readonly tool: string;
  readonly summary: string;
  readonly reasons: readonly string[];
  readonly status: "allowed" | "blocked" | "confirmed" | "declined";
  readonly source: DecisionSource;
  readonly rationale: string;
  readonly observations?: readonly Observation[];
  readonly decidingRule?: string;
  readonly checkpoint?: string;
  readonly latencyMs?: number;
  readonly timestamp: number;
}

export function createRecorder(pi: Pick<ExtensionAPI, "appendEntry">): (record: DecisionRecord) => void {
  return (record) => {
    try {
      pi.appendEntry(DECISION_ENTRY_TYPE, record);
    } catch (error) {
      console.warn("[laya-auto-mode] could not record a decision:", error);
    }
  };
}

const STATUS_LABEL: Record<DecisionRecord["status"], string> = {
  allowed: "allowed",
  blocked: "blocked",
  confirmed: "allowed by you",
  declined: "declined by you",
};

const SOURCE_LABEL: Record<DecisionSource, string> = {
  "hard-deny": "safety rule",
  "user-rule": "your rule",
  laya: "laya",
  uncertain: "unclear",
  unavailable: "laya unavailable",
  user: "you",
};

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function isApproved(record: DecisionRecord): boolean {
  return record.status === "allowed" || record.status === "confirmed";
}

/** `🛡 laya allowed · bash · 512ms · npm test`, plus the rationale for a block. */
export function formatCompactLines(record: DecisionRecord): { headline: string; detail?: string } {
  const approved = isApproved(record);
  const parts = [`${approved ? "🛡" : "⛔"} laya ${STATUS_LABEL[record.status]}`, record.tool];
  if (!approved || record.source !== "laya") parts.push(`via ${SOURCE_LABEL[record.source]}`);
  if (typeof record.latencyMs === "number") parts.push(`${Math.round(record.latencyMs)}ms`);
  const summary = oneLine(record.summary);
  if (summary) parts.push(summary);
  const headline = parts.join(" · ");
  return approved ? { headline } : { headline, detail: oneLine(record.rationale) };
}

const EFFECT_LABEL: Record<Observation["effect"], string> = {
  pass: "pass",
  block: "block",
  unclear: "unclear",
  ignored: "no effect",
};

/** One line per question: probability of the safe answer, band, cut-offs. Used for tuning. */
export function formatObservationLines(record: DecisionRecord): string[] {
  return (record.observations ?? []).map((o) => {
    const marks = [record.decidingRule === o.ruleId ? "<- decided" : "", o.clearedByIntent ? "(cleared by the request)" : ""]
      .filter(Boolean)
      .join(" ");
    return `${o.ruleId.padEnd(12)} p(safe)=${o.probability.toFixed(2)}  ${o.band} → ${EFFECT_LABEL[o.effect]}  (pass ≥ ${formatThreshold(o.pass)}, block ≤ ${formatThreshold(o.reject)}) ${marks}`.trimEnd();
  });
}

class ClippedLine implements Component {
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }
  render(width: number): string[] {
    return [truncateToWidth(this.text, Math.max(1, width))];
  }
  invalidate(): void {}
}

export function registerDecisionRenderer(
  pi: Pick<ExtensionAPI, "registerEntryRenderer">,
  displayMode: () => DisplayMode,
): void {
  pi.registerEntryRenderer<DecisionRecord>(DECISION_ENTRY_TYPE, (entry, options, theme) => {
    const record = entry.data;
    if (!record) return undefined;
    const approved = isApproved(record);

    if (displayMode() === "compact" && !options.expanded) {
      const lines = formatCompactLines(record);
      const box = new Box(1, 0, (text) => theme.bg("customMessageBg", text));
      box.addChild(new ClippedLine(theme.fg(approved ? "muted" : "error", lines.headline)));
      if (lines.detail !== undefined) box.addChild(new ClippedLine(theme.fg("dim", `why: ${lines.detail}`)));
      return box;
    }

    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(
      new Text(`${approved ? "🛡" : "⛔"} ${theme.bold("laya auto mode")} ${theme.fg(approved ? "success" : "error", STATUS_LABEL[record.status])}`),
    );
    const meta = [record.tool, `via ${SOURCE_LABEL[record.source]}`];
    if (record.checkpoint) meta.push(record.checkpoint);
    if (typeof record.latencyMs === "number") meta.push(`${Math.round(record.latencyMs)}ms`);
    box.addChild(new Text(theme.fg("muted", meta.join(" · "))));
    box.addChild(new Text(record.summary));
    if (record.reasons.length > 0) box.addChild(new Text(theme.fg("dim", `escalated: ${record.reasons.join(", ")}`)));
    box.addChild(new Text(theme.fg("dim", `why: ${record.rationale}`)));
    if (options.expanded) {
      for (const line of formatObservationLines(record)) box.addChild(new Text(theme.fg("dim", line)));
    }
    return box;
  });
}
