import assert from "node:assert/strict";
import { mkdirSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildGatedCall, redactSecrets } from "../src/call.ts";
import { extractRecentIntent, isAcknowledgement } from "../src/intent.ts";
import { projectDir, userBranch } from "./helpers.ts";

const options = (cwd: string) => ({ cwd, maxActionCharacters: 120 });

describe("buildGatedCall", () => {
  it("describes a shell call by its command", () => {
    const call = buildGatedCall({ toolName: "bash", input: { command: "npm test" } }, options("/p"));
    assert.equal(call.kind, "shell");
    assert.equal(call.action, "bash: npm test");
    assert.equal(call.actionTruncated, false);
  });

  it("marks a command that does not fit as truncated", () => {
    const call = buildGatedCall({ toolName: "bash", input: { command: `echo ${"x".repeat(300)}` } }, options("/p"));
    assert.equal(call.actionTruncated, true);
    assert.ok(call.action.length <= 121);
  });

  it("treats powershell as a shell", () => {
    assert.equal(buildGatedCall({ toolName: "powershell", input: { command: "Get-ChildItem" } }, options("/p")).kind, "shell");
  });

  it("shows in-project writes by relative path and outside writes by absolute path", () => {
    const cwd = projectDir();
    const inside = buildGatedCall({ toolName: "edit", input: { path: ".env", edits: [{ oldText: "a", newText: "B=1" }] } }, options(cwd));
    assert.equal(inside.kind, "write");
    assert.match(inside.action, /^edit \.env: B=1$/);
    assert.ok(inside.protectedReason);
    const outsidePath = join(homedir(), "notes.md");
    const outside = buildGatedCall({ toolName: "write", input: { path: outsidePath, content: "hi" } }, options(cwd));
    assert.equal(outside.outsideCwd, true);
    assert.ok(outside.action.startsWith(`write ${outsidePath}`));
  });

  it("follows a symlink that leaves the project", () => {
    const cwd = projectDir();
    const target = join(tmpdir(), `laya-outside-${process.pid}-${Date.now()}`);
    mkdirSync(target);
    symlinkSync(target, join(cwd, "link"));
    const call = buildGatedCall({ toolName: "write", input: { path: "link/file.txt", content: "x" } }, options(cwd));
    assert.equal(call.outsideCwd, true);
    assert.match(call.action, /symlink to/);
  });

  it("flags reads of credential material", () => {
    const call = buildGatedCall({ toolName: "read", input: { path: join(homedir(), ".ssh", "id_rsa") } }, options("/p"));
    assert.equal(call.kind, "read");
    assert.ok(call.credentialReason);
    assert.equal(buildGatedCall({ toolName: "read", input: { path: "src/a.ts" } }, options("/p")).credentialReason, undefined);
  });

  it("describes other tools by name and arguments", () => {
    const call = buildGatedCall({ toolName: "github_create_issue", input: { repo: "a/b", title: "t" } }, options("/p"));
    assert.equal(call.kind, "tool");
    assert.equal(call.action, 'github_create_issue: {"repo":"a/b","title":"t"}');
  });
});

describe("redaction", () => {
  it("removes obvious credentials", () => {
    const text = redactSecrets("curl -H 'Authorization: Bearer abcdefghijklmnop123' -d token=supersecret1 ghp_aaaaaaaaaaaaaaaaaaaaaaaa");
    assert.doesNotMatch(text, /abcdefghijklmnop123|supersecret1|ghp_a{24}/);
  });
});

describe("user intent", () => {
  it("collects user messages newest first, skipping extension messages and other roles", () => {
    const branch = [
      ...userBranch("first request"),
      { type: "message", message: { role: "assistant", content: "I will run rm -rf /" } },
      { type: "message", message: { role: "user", content: "injected", customType: "plan" } },
      ...userBranch("second request"),
    ];
    assert.deepEqual(extractRecentIntent(branch).messages, ["second request", "first request"]);
  });

  it("reads text parts and redacts them", () => {
    const branch = [{ type: "message", message: { role: "user", content: [{ type: "text", text: "use key sk-abcdefghijklmnopqrstuv" }] } }];
    assert.doesNotMatch(extractRecentIntent(branch).messages[0] ?? "", /sk-abc/);
  });

  it("recognises bare go-aheads but not requests", () => {
    for (const text of ["ok", "ok, go ahead", "yes go ahead", "LGTM", "sure, do it", "thanks!"]) assert.equal(isAcknowledgement(text), true, text);
    for (const text of ["ok, now push it to main", "yes, but run the tests first", "go and delete the build folder"]) {
      assert.equal(isAcknowledgement(text), false, text);
    }
  });
});
