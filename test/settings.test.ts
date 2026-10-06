import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS, mergeSettings, parseCutoffs, parseSettingsPatch, SettingsStore } from "../src/settings.ts";

describe("parseSettingsPatch", () => {
  it("keeps valid values and drops malformed ones", () => {
    const patch = parseSettingsPatch(
      {
        enabled: false,
        uncertain: "ask",
        checkpoint: "typed-decisions",
        requestMessages: 9,
        timeoutMs: "fast",
        safeCommands: ["npm test*", 3, "", "x\ny"],
        thresholds: { requested: { pass: 0.7, reject: 0.6 }, routine: 0.8, bad: { pass: 0.5, reject: 0.6 } },
        denialLimits: { consecutive: 5 },
        server: { mode: "managed", url: "ftp://nope", command: "~/.laya/bin/laya-serve" },
      },
      { allowServer: true },
    );
    assert.equal(patch.enabled, false);
    assert.equal(patch.uncertain, "ask");
    assert.equal(patch.checkpoint, "typed-decisions");
    assert.equal(patch.requestMessages, undefined);
    assert.equal(patch.timeoutMs, undefined);
    assert.deepEqual(patch.safeCommands, ["npm test*"]);
    assert.deepEqual(patch.thresholds, { requested: { pass: 0.7, reject: 0.6 }, routine: { pass: 0.8, reject: 1 - 0.8 } });
    assert.deepEqual(patch.server, { mode: "managed", command: "~/.laya/bin/laya-serve" });
    assert.deepEqual(mergeSettings(DEFAULT_SETTINGS, patch).denialLimits, { consecutive: 5, total: 20 });
  });

  it("refuses an unclear-answer setting other than block or ask", () => {
    assert.equal(parseSettingsPatch({ uncertain: "allow" }, { allowServer: true }).uncertain, undefined);
  });

  it("drops the server block from a project file", () => {
    assert.equal(parseSettingsPatch({ server: { url: "http://evil.example" } }, { allowServer: false }).server, undefined);
  });

  it("validates cut-offs", () => {
    assert.deepEqual(parseCutoffs({ pass: 0.65, reject: 0.6 }), { pass: 0.65, reject: 0.6 });
    assert.equal(parseCutoffs({ pass: 0.6, reject: 0.65 }), undefined);
    assert.equal(parseCutoffs(0.4), undefined);
    assert.equal(parseCutoffs({ pass: 1.2, reject: 0.1 }), undefined);
  });
});

describe("SettingsStore", () => {
  const setup = () => {
    const agentDir = mkdtempSync(join(tmpdir(), "laya-agent-"));
    const cwd = mkdtempSync(join(tmpdir(), "laya-project-"));
    mkdirSync(join(cwd, ".pi"));
    return { agentDir, cwd, store: new SettingsStore(agentDir, ".pi") };
  };

  it("layers a trusted project's file over the global one, but never its server", async () => {
    const { agentDir, cwd, store } = setup();
    writeFileSync(join(agentDir, "laya-auto-mode.json"), JSON.stringify({ uncertain: "ask", server: { url: "http://127.0.0.1:9000" } }));
    writeFileSync(join(cwd, ".pi", "laya-auto-mode.json"), JSON.stringify({ uncertain: "block", server: { url: "http://evil.example" } }));
    const trusted = await store.load(cwd, true);
    assert.equal(trusted.scope, "project");
    assert.equal(trusted.settings.uncertain, "block");
    assert.equal(trusted.settings.server.url, "http://127.0.0.1:9000");
    const untrusted = await store.load(cwd, false);
    assert.equal(untrusted.settings.uncertain, "ask");
  });

  it("merges updates into the global file and removes keys set to null", async () => {
    const { agentDir, store } = setup();
    writeFileSync(join(agentDir, "laya-auto-mode.json"), JSON.stringify({ comment: "mine", thresholds: { requested: { pass: 0.7, reject: 0.6 } } }));
    await store.updateGlobal({ uncertain: "ask", thresholds: { routine: { pass: 0.6, reject: 0.1 } } });
    await store.updateGlobal({ thresholds: { requested: null } });
    const saved = JSON.parse(readFileSync(join(agentDir, "laya-auto-mode.json"), "utf8"));
    assert.equal(saved.comment, "mine");
    assert.equal(saved.uncertain, "ask");
    assert.deepEqual(saved.thresholds, { routine: { pass: 0.6, reject: 0.1 } });
  });
});
