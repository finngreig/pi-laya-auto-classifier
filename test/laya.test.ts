import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CandidateInput } from "../src/engine.ts";
import { createLayaClient, validateResponse, type LayaRequest } from "../src/laya/client.ts";
import { classify, combine } from "../src/laya/decide.ts";
import { actionMayBeCut, createLayaEngine, requestMessages } from "../src/laya/engine.ts";
import { buildQuestions, DEFAULT_RULES, safeProbability } from "../src/laya/questions.ts";
import { DEFAULT_SETTINGS } from "../src/settings.ts";
import { fakeLaya, layaBody } from "./helpers.ts";

const questions = buildQuestions(DEFAULT_RULES);
const request: LayaRequest = { state: { proposed_tool_call: "bash: ls" }, questions, model: "english" };
const probs = (requested: number, routine: number) => ({ requested: { A: 1 - requested, B: requested }, routine: { A: 1 - routine, B: routine } });

describe("questions", () => {
  it("are two-option choices with neutral keys", () => {
    for (const question of Object.values(questions)) {
      assert.equal(question.type, "choice");
      assert.deepEqual(Object.keys(question.criteria), ["A", "B"]);
    }
  });

  it("read the safe probability in either option order", () => {
    assert.equal(safeProbability({ A: 0.2, B: 0.8 }), 0.8);
    assert.equal(safeProbability({ A: 0.2, B: 0.8 }, "safe-first"), 0.2);
    assert.equal(safeProbability(undefined), 0);
  });
});

describe("validateResponse", () => {
  it("accepts a well-formed answer", () => {
    const checked = validateResponse(layaBody("english", { requested: 0.8, routine: 0.5 }), request);
    assert.ok(checked.ok);
    assert.equal(checked.value.probabilities.requested?.B, 0.8);
  });

  it("refuses an answer from a checkpoint that was not asked for", () => {
    const checked = validateResponse(layaBody("multilingual", { requested: 0.8, routine: 0.5 }), request);
    assert.equal(checked.ok, false);
    assert.equal(!checked.ok && checked.reason, "wrong_checkpoint");
  });

  it("refuses a response without routing (LAYA_JEV_STRICT)", () => {
    const body = layaBody("english", { requested: 0.8, routine: 0.5 }) as Record<string, unknown>;
    delete body.routing;
    assert.equal(validateResponse(body, request).ok, false);
  });

  it("refuses missing answers, wrong options and probabilities that do not add up", () => {
    assert.equal(validateResponse(layaBody("english", { requested: 0.8 }), request).ok, false);
    const extra = layaBody("english", { requested: 0.8, routine: 0.5 });
    (extra.answers.routine!.probabilities as Record<string, number>).C = 0.1;
    assert.equal(validateResponse(extra, request).ok, false);
    const bad = layaBody("english", { requested: 0.8, routine: 0.5 });
    bad.answers.routine!.probabilities.A = 0.9;
    assert.equal(validateResponse(bad, request).ok, false);
  });

  it("reports truncation", () => {
    const checked = validateResponse(layaBody("english", { requested: 0.8, routine: 0.5 }, { truncated: true, state_tokens: 400, state_tokens_dropped: 80 }), request);
    assert.ok(checked.ok && checked.value.truncated && checked.value.stateTokensDropped === 80);
  });
});

describe("client", () => {
  it("sends the pinned checkpoint, max_len and the API key", async () => {
    const laya = fakeLaya(() => ({ requested: 0.8, routine: 0.5 }));
    const client = createLayaClient({ baseUrl: "http://laya.test/", apiKey: "k", fetch: laya.fetch });
    const result = await client.predict({ ...request, maxLen: 1024 }, { timeoutMs: 1000 });
    assert.ok(result.ok);
    assert.equal(laya.requests[0]?.url, "http://laya.test/v1/systemone");
    assert.equal(laya.requests[0]?.body.model, "english");
    assert.equal(laya.requests[0]?.body.max_len, 1024);
    assert.equal(laya.requests[0]?.headers.authorization, "Bearer k");
  });

  it("turns every failure into a typed result", async () => {
    const respond = (response: Response) => createLayaClient({ baseUrl: "http://x", fetch: fakeLaya(() => response).fetch });
    const call = { timeoutMs: 1000 };
    assert.equal(((await respond(new Response("no", { status: 401 })).predict(request, call)) as { reason: string }).reason, "unauthorised");
    assert.equal(((await respond(new Response("bad", { status: 422 })).predict(request, call)) as { reason: string }).reason, "http_error");
    assert.equal(((await respond(new Response("not json")).predict(request, call)) as { reason: string }).reason, "malformed");
    const down = createLayaClient({ baseUrl: "http://x", fetch: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch });
    assert.equal(((await down.predict(request, call)) as { reason: string }).reason, "unreachable");
    const cancelled = new AbortController();
    cancelled.abort();
    assert.equal(((await respond(new Response("{}")).predict(request, { ...call, signal: cancelled.signal })) as { reason: string }).reason, "cancelled");
  });

  it("times out", async () => {
    // A real request holds a socket open; this stand-in holds a timer instead, so
    // the event loop stays alive until the client's own timeout fires.
    const slow = (async (_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const keepAlive = setTimeout(() => undefined, 5000);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(keepAlive);
          reject(new Error("aborted"));
        });
      })) as typeof fetch;
    const result = await createLayaClient({ baseUrl: "http://x", fetch: slow }).predict(request, { timeoutMs: 20 });
    assert.equal(!result.ok && result.reason, "timeout");
  });

  it("retries once when the server is busy", async () => {
    let calls = 0;
    const laya = fakeLaya(() => (calls++ === 0 ? new Response("busy", { status: 503 }) : { requested: 0.8, routine: 0.5 }));
    const result = await createLayaClient({ baseUrl: "http://x", fetch: laya.fetch }).predict(request, { timeoutMs: 1000 });
    assert.ok(result.ok);
    assert.equal(calls, 2);
  });

  it("checks every result of a batch", async () => {
    const laya = fakeLaya((state): Record<string, number> => (state.user_request === "bad" ? { requested: 0.8 } : { requested: 0.8, routine: 0.5 }));
    const client = createLayaClient({ baseUrl: "http://x", fetch: laya.fetch });
    const ok = await client.predictBatch({ states: [{ user_request: "a" }, { user_request: "b" }], questions, model: "english" }, { timeoutMs: 1000 });
    assert.ok(ok.ok && ok.items.length === 2);
    const bad = await client.predictBatch({ states: [{ user_request: "a" }, { user_request: "bad" }], questions, model: "english" }, { timeoutMs: 1000 });
    assert.equal(!bad.ok && bad.reason, "malformed");
  });
});

describe("combine", () => {
  it("classifies against both cut-offs", () => {
    assert.equal(classify(0.65, 0.65, 0.6), "satisfied");
    assert.equal(classify(0.6, 0.65, 0.6), "rejected");
    assert.equal(classify(0.62, 0.65, 0.6), "uncertain");
  });

  it("blocks a call the user clearly did not ask for, flagged or not", () => {
    assert.equal(combine(DEFAULT_RULES, probs(0.3, 0.5), true).verdict, "deny");
    assert.equal(combine(DEFAULT_RULES, probs(0.3, 0.5), false).verdict, "deny");
  });

  it("needs a clear request for a flagged call, not for an ordinary one", () => {
    assert.equal(combine(DEFAULT_RULES, probs(0.62, 0.5), true).verdict, "uncertain");
    assert.equal(combine(DEFAULT_RULES, probs(0.62, 0.5), false).verdict, "allow");
  });

  it("lets a clear request clear an emphatic 'check first'", () => {
    const cleared = combine(DEFAULT_RULES, probs(0.9, 0.05), true);
    assert.equal(cleared.verdict, "allow");
    assert.ok(cleared.observations.find((o) => o.ruleId === "routine")?.clearedByIntent);
    assert.equal(combine(DEFAULT_RULES, probs(0.62, 0.05), false).verdict, "deny");
  });

  it("never reads a missing answer as safe", () => {
    assert.equal(combine(DEFAULT_RULES, {}, false).verdict, "deny");
  });
});

const input = (messages: string[], action = "bash: npm publish"): CandidateInput => ({
  call: { kind: "shell", tool: "bash", summary: action, action, actionTruncated: false, outsideCwd: false },
  reasons: ["package execution or publish"],
  flagged: true,
  intent: { messages },
  cwd: "/p",
});

describe("engine", () => {
  it("pairs the action with the latest substantive message, skipping go-aheads", () => {
    assert.deepEqual(requestMessages(input(["ok, go ahead", "publish 1.2.0", "older"]), 1), ["publish 1.2.0"]);
    assert.deepEqual(requestMessages(input(["ok, go ahead", "publish 1.2.0", "older"]), 2), ["publish 1.2.0", "older"]);
    assert.deepEqual(requestMessages(input(["yes"]), 1), ["yes"]);
    assert.deepEqual(requestMessages(input([]), 1), ["(no recent user message)"]);
  });

  const engineWith = (answer: Parameters<typeof fakeLaya>[0], overrides: Partial<typeof DEFAULT_SETTINGS> = {}, usage?: Record<string, unknown>) => {
    const laya = fakeLaya(answer, usage ? { usage } : {});
    const client = createLayaClient({ baseUrl: "http://x", fetch: laya.fetch });
    const settings = { ...DEFAULT_SETTINGS, ...overrides };
    return { laya, engine: createLayaEngine({ client: async () => ({ ok: true, client }), settings: () => settings }) };
  };

  it("sends only the action and the message, action first", async () => {
    const { laya, engine } = engineWith(() => ({ requested: 0.9, routine: 0.5 }));
    await engine.judge(input(["publish 1.2.0"]), {});
    assert.deepEqual(Object.keys(laya.requests[0]?.body.state), ["proposed_tool_call", "user_request"]);
  });

  it("batches several messages and lets the clearest match speak for the request", async () => {
    const { laya, engine } = engineWith((state) => ({ requested: state.user_request === "publish 1.2.0" ? 0.9 : 0.2, routine: 0.5 }), { requestMessages: 2 });
    const verdict = await engine.judge(input(["tidy the docs", "publish 1.2.0"]), {});
    assert.equal(verdict.verdict, "allow");
    assert.ok(laya.requests[0]?.url.endsWith("/batch"));
  });

  it("applies cut-off overrides", async () => {
    const { engine } = engineWith(() => ({ requested: 0.7, routine: 0.5 }), { thresholds: { requested: { pass: 0.8, reject: 0.75 } } });
    assert.equal((await engine.judge(input(["publish"]), {})).verdict, "deny");
  });

  it("will not judge a call whose text Laya may not have read in full", async () => {
    const { engine } = engineWith(() => ({ requested: 0.9, routine: 0.5 }), {}, { truncated: true, state_tokens: 300, state_tokens_dropped: 295 });
    assert.equal((await engine.judge(input(["publish"]), {})).verdict, "uncertain");
    assert.equal(actionMayBeCut("bash: ls", true, 300, 10), false);
    assert.equal(actionMayBeCut("bash: ls", true, undefined, undefined), true);
  });

  it("reports an unreachable server as unavailable", async () => {
    const engine = createLayaEngine({ client: async () => ({ ok: false, detail: "down" }), settings: () => DEFAULT_SETTINGS });
    const verdict = await engine.judge(input(["publish"]), {});
    assert.equal(verdict.verdict, "unavailable");
  });
});
