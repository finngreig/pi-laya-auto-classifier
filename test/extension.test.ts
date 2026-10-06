import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { COMMAND, createExtension, FLAG } from "../src/extension.ts";
import { DECISION_ENTRY_TYPE } from "../src/records.ts";
import { SettingsStore } from "../src/settings.ts";
import { STATUS_ID } from "../src/ui.ts";
import { fakeLaya, projectDir, userBranch } from "./helpers.ts";

function fakePi(flags: Record<string, boolean> = {}) {
  const handlers = new Map<string, (event: any, ctx: any) => Promise<any>>();
  const commands = new Map<string, any>();
  const entries: { type: string; data: any }[] = [];
  const registered = { flags: [] as string[], renderers: [] as string[] };
  const pi = {
    on: (event: string, handler: any) => {
      handlers.set(event, handler);
      return () => undefined;
    },
    registerFlag: (name: string) => registered.flags.push(name),
    getFlag: (name: string) => flags[name],
    registerCommand: (name: string, options: any) => commands.set(name, options),
    registerEntryRenderer: (type: string) => registered.renderers.push(type),
    appendEntry: (type: string, data: any) => entries.push({ type, data }),
    getAllTools: () => [],
  };
  return { pi: pi as any, handlers, commands, entries, registered };
}

function fakeCtx(cwd: string, messages: string[] = ["Run the tests"]) {
  const status = new Map<string, string | undefined>();
  const notes: string[] = [];
  const branch = userBranch(...messages);
  return {
    status,
    notes,
    ctx: {
      cwd,
      hasUI: true,
      mode: "tui",
      signal: undefined,
      isProjectTrusted: () => false,
      sessionManager: { getBranch: () => branch },
      ui: {
        setStatus: (key: string, text: string | undefined) => status.set(key, text),
        notify: (text: string) => notes.push(text),
        select: async () => undefined,
      },
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("extension", () => {
  const setup = (answer: Parameters<typeof fakeLaya>[0] = () => ({ requested: 0.9, routine: 0.6 }), flags: Record<string, boolean> = {}) => {
    const agentDir = mkdtempSync(join(tmpdir(), "laya-agent-"));
    const laya = fakeLaya(answer);
    const fake = fakePi(flags);
    createExtension({ store: new SettingsStore(agentDir, ".pi"), fetch: laya.fetch })(fake.pi);
    return { ...fake, laya, agentDir };
  };

  it("registers its flag, command, renderer and events", () => {
    const { registered, commands, handlers } = setup();
    assert.deepEqual(registered.flags, [FLAG]);
    assert.ok(commands.has(COMMAND));
    assert.deepEqual(registered.renderers, [DECISION_ENTRY_TYPE]);
    for (const event of ["session_start", "session_shutdown", "tool_call"]) assert.ok(handlers.has(event), event);
  });

  it("judges tool calls through Laya and records the decision out of context", async () => {
    const { handlers, entries } = setup();
    const { ctx, status } = fakeCtx(projectDir());
    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
    await settle();
    assert.equal(status.get(STATUS_ID), "🛡 laya");
    const result = await handlers.get("tool_call")?.({ type: "tool_call", toolCallId: "1", toolName: "bash", input: { command: "npm test" } }, ctx);
    assert.equal(result, undefined);
    assert.equal(entries[0]?.type, DECISION_ENTRY_TYPE);
    assert.equal(entries[0]?.data.status, "allowed");
  });

  it("blocks what Laya blocks", async () => {
    const { handlers } = setup(() => ({ requested: 0.1, routine: 0.1 }));
    const { ctx } = fakeCtx(projectDir(), ["Fix the typo"]);
    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
    const result = await handlers.get("tool_call")?.({ type: "tool_call", toolCallId: "1", toolName: "bash", input: { command: "npm publish" } }, ctx);
    assert.equal(result?.block, true);
  });

  it("saves settings changed by command to the global file", async () => {
    const { handlers, commands, agentDir } = setup();
    const { ctx, notes } = fakeCtx(projectDir());
    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
    await commands.get(COMMAND).handler("uncertain ask", ctx);
    await commands.get(COMMAND).handler("threshold requested 0.7 0.6", ctx);
    await commands.get(COMMAND).handler("off", ctx);
    const saved = JSON.parse(readFileSync(join(agentDir, "laya-auto-mode.json"), "utf8"));
    assert.equal(saved.uncertain, "ask");
    assert.deepEqual(saved.thresholds, { requested: { pass: 0.7, reject: 0.6 } });
    assert.equal(saved.enabled, false);
    assert.match(notes.at(-1) ?? "", /off/);
    await commands.get(COMMAND).handler("threshold requested 0.6 0.7", ctx);
    assert.match(notes.at(-1) ?? "", /block below pass/);
  });

  it("turns auto mode on from the flag even when the settings say off", async () => {
    const { handlers, commands } = setup(undefined, { [FLAG]: true });
    const { ctx, status } = fakeCtx(projectDir());
    await commands.get(COMMAND).handler("off", ctx);
    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
    assert.equal(status.get(STATUS_ID), "🛡 laya");
  });

  it("doctor checks the server and runs both canaries", async () => {
    const { handlers, commands } = setup((state: any) => ({ requested: String(state.user_request).includes("test") ? 0.9 : 0.1, routine: 0.5 }));
    const { ctx, notes } = fakeCtx(projectDir());
    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
    await commands.get(COMMAND).handler("doctor", ctx);
    const report = notes.at(-1) ?? "";
    assert.match(report, /answers/);
    assert.match(report, /✓ requested test run: allow/);
    assert.match(report, /✓ unrequested force push: deny/);
  });
});
