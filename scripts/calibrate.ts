/**
 * Run the calibration fixtures through the real gate against a running laya-serve.
 *
 *   LAYA_HOST=127.0.0.1 laya-serve          # in another terminal
 *   node --experimental-strip-types scripts/calibrate.ts [options]
 *
 * Options:
 *   --url <url>                 server (default http://127.0.0.1:8000, or PI_LAYA_URL)
 *   --checkpoint <name>         english | multilingual | typed-decisions (default english)
 *   --order <order>             unsafe-first | safe-first (default unsafe-first)
 *   --max-len <n>               per-request max_len (default: the checkpoint's own)
 *   --messages <n>              requestMessages, 1-4 (default 1)
 *   --set <set>                 tuning | holdout | all (default all; holdout fixtures were
 *                               never used to choose the cut-offs)
 *   --json <file>               also write the raw results
 *
 * This goes through `evaluateToolCall`, not just the engine, because the gate is
 * what users get: a fixture the deterministic layer lets through never reaches
 * Laya, and that is part of the result. Not part of the published package.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createGateState, evaluateToolCall } from "../src/gate.ts";
import { createLayaClient } from "../src/laya/client.ts";
import { createLayaEngine } from "../src/laya/engine.ts";
import { DEFAULT_RULES, type OptionOrder } from "../src/laya/questions.ts";
import type { DecisionRecord } from "../src/records.ts";
import { DEFAULT_SETTINGS, isCheckpoint, type LayaAutoModeSettings } from "../src/settings.ts";
import { FIXTURES, HOLDOUT, type Fixture } from "./fixtures.ts";

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    checkpoint: { type: "string", default: "english" },
    order: { type: "string", default: "unsafe-first" },
    "max-len": { type: "string" },
    messages: { type: "string", default: "1" },
    set: { type: "string", default: "all" },
    json: { type: "string" },
  },
});

const checkpoint = values.checkpoint ?? "english";
if (!isCheckpoint(checkpoint)) throw new Error(`unknown checkpoint ${checkpoint}`);
const order = (values.order ?? "unsafe-first") as OptionOrder;
const url = values.url ?? process.env.PI_LAYA_URL ?? "http://127.0.0.1:8000";
const maxLen = values["max-len"] ? Number(values["max-len"]) : 0;

// A fixed path: Laya reads file paths, and a random one would make runs differ.
const project = join(tmpdir(), "laya-calibration-project");
mkdirSync(join(project, ".git"), { recursive: true });
writeFileSync(join(project, "package.json"), '{ "name": "demo", "version": "1.1.0" }\n');

const settings: LayaAutoModeSettings = {
  ...DEFAULT_SETTINGS,
  checkpoint,
  maxLen,
  timeoutMs: 60_000,
  requestMessages: Number(values.messages ?? "1"),
  uncertain: "block",
  denialLimits: { consecutive: 0, total: 0 },
};
const client = createLayaClient({ baseUrl: url, ...(process.env.LAYA_API_KEY ? { apiKey: process.env.LAYA_API_KEY } : {}) });
const engine = createLayaEngine({ client: async () => ({ ok: true, client }), settings: () => settings, optionOrder: order });

const set = values.set ?? "all";
const selected: readonly (Fixture & { holdout: boolean })[] = [
  ...(set === "holdout" ? [] : FIXTURES.map((f) => ({ ...f, holdout: false }))),
  ...(set === "tuning" ? [] : HOLDOUT.map((f) => ({ ...f, holdout: true }))),
];

interface Row {
  readonly holdout: boolean;
  readonly name: string;
  readonly expect: "allow" | "block";
  readonly outcome: "allow" | "block";
  readonly record?: DecisionRecord;
}

const rows: Row[] = [];
for (const fixture of selected) {
  const records: DecisionRecord[] = [];
  const state = createGateState(settings);
  const branch = fixture.messages.map((text) => ({ type: "message", message: { role: "user", content: text } }));
  const result = await evaluateToolCall(
    { toolName: fixture.tool, input: structuredClone(fixture.input) },
    {
      cwd: project,
      hasUI: false,
      sessionManager: { getBranch: () => branch },
      ui: { notify: () => undefined, select: async () => undefined },
    },
    state,
    { engine, record: (record) => records.push(record), now: Date.now },
  );
  const record = records[0];
  rows.push({ holdout: fixture.holdout, name: fixture.name, expect: fixture.expect, outcome: result?.block ? "block" : "allow", ...(record ? { record } : {}) });
}

const ruleIds = DEFAULT_RULES.map((rule) => rule.id);
const pad = (text: string, width: number) => (text.length >= width ? text.slice(0, width) : text.padEnd(width));
console.log(`checkpoint ${checkpoint}, options ${order}, requestMessages ${settings.requestMessages}, max_len ${maxLen || "default"}, ${url}\n`);
console.log(`${pad("fixture", 40)} ${pad("expect", 6)} ${pad("got", 6)}   ${pad("via", 12)} ${ruleIds.map((id) => pad(id, 15)).join("")} ms`);
for (const row of rows) {
  const ok = row.expect === row.outcome ? "✓" : "✗";
  const observations = row.record?.observations ?? [];
  const cells = ruleIds.map((id) => {
    const o = observations.find((x) => x.ruleId === id);
    return pad(o ? `${o.probability.toFixed(2)} ${o.effect === "ignored" ? "" : o.effect}` : "", 15);
  });
  const via = row.record ? row.record.source : "fast path";
  const ms = row.record?.latencyMs === undefined ? "" : String(Math.round(row.record.latencyMs));
  console.log(`${pad((row.holdout ? "* " : "") + row.name, 40)} ${pad(row.expect, 6)} ${pad(row.outcome, 6)} ${ok} ${pad(via, 12)} ${cells.join("")} ${ms}`);
}

for (const [label, group] of [["tuning", rows.filter((r) => !r.holdout)], ["held out (*)", rows.filter((r) => r.holdout)]] as const) {
  if (group.length === 0) continue;
  const safe = group.filter((row) => row.expect === "allow");
  const unsafe = group.filter((row) => row.expect === "block");
  console.log(`\n${label}: ordinary work allowed ${safe.filter((r) => r.outcome === "allow").length}/${safe.length}, unsafe calls blocked ${unsafe.filter((r) => r.outcome === "block").length}/${unsafe.length}`);
}
const judged = rows.filter((row) => row.record?.source === "laya" || row.record?.source === "uncertain");
const latencies = rows.map((row) => row.record?.latencyMs).filter((x): x is number => typeof x === "number").sort((a, b) => a - b);
console.log(`\njudged by Laya: ${judged.length}; median latency ${latencies.length ? Math.round(latencies[Math.floor(latencies.length / 2)] ?? 0) : "–"}ms`);

console.log("\np(safe) by question, for calls Laya judged (should-allow | should-block):");
for (const id of ruleIds) {
  const values = (expect: "allow" | "block") =>
    rows
      .filter((row) => row.expect === expect)
      .map((row) => row.record?.observations?.find((o) => o.ruleId === id)?.probability)
      .filter((x): x is number => typeof x === "number")
      .sort((a, b) => a - b)
      .map((x) => x.toFixed(2));
  console.log(`  ${pad(id, 16)} ${values("allow").join(" ")} | ${values("block").join(" ")}`);
}

if (values.json) {
  writeFileSync(values.json, JSON.stringify({ checkpoint, order, requestMessages: settings.requestMessages, maxLen, set, rows }, null, 2));
  console.log(`\nwrote ${values.json}`);
}
