import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { ManagedServer } from "../src/laya/server.ts";

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed: string[] = [];
  kill(signal: string) {
    this.killed.push(signal);
    this.signalCode = signal;
    return true;
  }
}

function harness(options: { probe?: () => Promise<boolean>; onSpawn?: (child: FakeChild) => void; startupTimeoutMs?: number } = {}) {
  const spawned: { command: string; env: NodeJS.ProcessEnv; child: FakeChild }[] = [];
  const spawn = ((command: string, _args: string[], opts: { env: NodeJS.ProcessEnv }) => {
    const child = new FakeChild();
    spawned.push({ command, env: opts.env, child });
    queueMicrotask(() => options.onSpawn?.(child));
    return child;
  }) as never;
  const server = new ManagedServer({
    command: "~/.laya/bin/laya-serve",
    checkpoint: "english",
    startupTimeoutMs: options.startupTimeoutMs ?? 5000,
    threads: 4,
    spawn,
    probe: options.probe ?? (async () => true),
  });
  return { server, spawned };
}

describe("ManagedServer", () => {
  it("starts laya-serve on localhost with a random key and only the configured checkpoint", async () => {
    const { server, spawned } = harness();
    const started = await server.start();
    assert.ok(started.ok);
    assert.equal(server.state, "ready");
    const env = spawned[0]?.env ?? {};
    assert.equal(env.LAYA_HOST, "127.0.0.1");
    assert.equal(env.LAYA_MODELS, "english");
    assert.equal(env.LAYA_THREADS, "4");
    assert.equal(env.USE_TF, "0");
    assert.match(env.LAYA_API_KEY ?? "", /^[0-9a-f]{48}$/);
    assert.equal(started.ok && started.url, `http://127.0.0.1:${env.LAYA_PORT}`);
    assert.ok(!spawned[0]?.command.startsWith("~"));
  });

  it("shares one start between concurrent callers", async () => {
    const { server, spawned } = harness();
    await Promise.all([server.start(), server.start(), server.start()]);
    assert.equal(spawned.length, 1);
  });

  it("explains a missing executable", async () => {
    const { server } = harness({
      probe: async () => false,
      onSpawn: (child) => child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })),
    });
    const started = await server.start();
    assert.equal(started.ok, false);
    assert.match(!started.ok ? started.detail : "", /pip install "laya\[serve\]"/);
    assert.equal(server.state, "failed");
  });

  it("reports an early exit with the server's last output", async () => {
    const { server } = harness({
      probe: async () => false,
      onSpawn: (child) => {
        child.stderr.emit("data", "ModuleNotFoundError: No module named 'torch'\n");
        child.emit("exit", 1, null);
      },
    });
    const started = await server.start();
    assert.match(!started.ok ? started.detail : "", /torch/);
  });

  it("gives up after the startup timeout and stops the child", async () => {
    const { server, spawned } = harness({ probe: async () => false, startupTimeoutMs: 600 });
    const started = await server.start();
    assert.equal(started.ok, false);
    assert.deepEqual(spawned[0]?.child.killed, ["SIGTERM"]);
  });

  it("stops idempotently", async () => {
    const { server, spawned } = harness();
    await server.start();
    server.stop();
    server.stop();
    assert.deepEqual(spawned[0]?.child.killed, ["SIGTERM"]);
    assert.equal(server.state, "stopped");
  });

  it("waits for a start in progress without starting one itself", async () => {
    const { server } = harness();
    assert.equal((await server.ready(10)).ok, false);
    void server.start();
    assert.equal((await server.ready(5000)).ok, true);
  });
});
