/**
 * Test helpers: a fake laya-serve at the HTTP boundary, and gate fixtures.
 * Nothing here needs a network, Python or a model.
 */

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateState, type GateContext, type GateDeps, type GateState } from "../src/gate.ts";
import { createLayaClient } from "../src/laya/client.ts";
import { createLayaEngine } from "../src/laya/engine.ts";
import type { DecisionRecord } from "../src/records.ts";
import { DEFAULT_SETTINGS, type LayaAutoModeSettings } from "../src/settings.ts";

/** p(safe) for each question id; `B` is the safe key with the shipped option order. */
export type SafeProbabilities = Record<string, number>;

export function choiceAnswer(pSafe: number) {
  return { type: "choice", choice: pSafe >= 0.5 ? "B" : "A", probabilities: { A: 1 - pSafe, B: pSafe }, confidence: 0.5 };
}

export function layaBody(model: string, answers: SafeProbabilities, usage: Record<string, unknown> = {}) {
  return {
    model: "laya-rl-agent",
    answers: Object.fromEntries(Object.entries(answers).map(([id, p]) => [id, choiceAnswer(p)])),
    usage: { input_tokens: 100, output_tokens: 0, state_tokens: 40, state_tokens_dropped: 0, truncated: false, ...usage },
    routing: { model, repo: "convaiinnovations/laya", reason: "test" },
  };
}

export interface FakeLaya {
  readonly fetch: typeof fetch;
  readonly requests: { url: string; body: any; headers: Record<string, string> }[];
}

/**
 * A fake server. `answer` sees each state (one per pair) and returns p(safe) per
 * question, or a Response to send as is.
 */
export function fakeLaya(
  answer: (state: any, questions: Record<string, unknown>) => SafeProbabilities | Response,
  options: { model?: string; usage?: Record<string, unknown> } = {},
): FakeLaya {
  const requests: FakeLaya["requests"] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, body, headers: (init?.headers ?? {}) as Record<string, string> });
    if (url.endsWith("/health")) return Response.json({ status: "ok", loaded: ["english"], device: "cpu" });
    const model = options.model ?? body.model;
    if (url.endsWith("/v1/systemone/batch")) {
      const results = [];
      for (const state of body.states) {
        const out = answer(state, body.questions);
        if (out instanceof Response) return out;
        results.push(layaBody(model, out, options.usage));
      }
      return Response.json({ results, total_usage: { input_tokens: 0, output_tokens: 0 } });
    }
    const out = answer(body.state, body.questions);
    return out instanceof Response ? out : Response.json(layaBody(model, out, options.usage));
  }) as typeof fetch;
  return { fetch: fetchImpl, requests };
}

export function projectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "laya-test-"));
  mkdirSync(join(dir, ".git"));
  return dir;
}

export function userBranch(...messages: string[]) {
  return messages.map((text) => ({ type: "message", message: { role: "user", content: text } }));
}

export interface GateHarness {
  readonly ctx: GateContext & { asked: string[] };
  readonly state: GateState;
  readonly deps: GateDeps;
  readonly records: DecisionRecord[];
  readonly laya: FakeLaya;
}

export function gateHarness(options: {
  answer?: (state: any, questions: Record<string, unknown>) => SafeProbabilities | Response;
  settings?: Partial<LayaAutoModeSettings>;
  messages?: string[];
  hasUI?: boolean;
  select?: string;
  cwd?: string;
  annotations?: GateDeps["toolAnnotations"];
}): GateHarness {
  const settings: LayaAutoModeSettings = { ...DEFAULT_SETTINGS, ...options.settings };
  const state = createGateState(settings);
  const laya = fakeLaya(options.answer ?? (() => ({ requested: 0.9, routine: 0.6 })));
  const client = createLayaClient({ baseUrl: "http://laya.test", fetch: laya.fetch });
  const engine = createLayaEngine({ client: async () => ({ ok: true, client }), settings: () => state.settings });
  const records: DecisionRecord[] = [];
  const asked: string[] = [];
  const branch = userBranch(...(options.messages ?? ["Run the tests and fix what fails"]));
  const ctx = {
    cwd: options.cwd ?? projectDir(),
    hasUI: options.hasUI ?? false,
    sessionManager: { getBranch: () => branch },
    ui: {
      notify: () => undefined,
      select: async (title: string) => {
        asked.push(title);
        return options.select;
      },
    },
    asked,
  };
  const deps: GateDeps = {
    engine,
    record: (record) => records.push(record),
    now: () => 1_700_000_000_000,
    ...(options.annotations ? { toolAnnotations: options.annotations } : {}),
  };
  return { ctx, state, deps, records, laya };
}

export const bash = (command: string) => ({ toolName: "bash", input: { command } });
