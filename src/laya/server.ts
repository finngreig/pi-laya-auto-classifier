/**
 * Managed mode: start `laya-serve` for this Pi session and stop it afterwards.
 *
 * The server is started with the settings a laptop wants rather than
 * `laya-serve`'s defaults, which suit a shared deployment:
 *
 * - bound to 127.0.0.1 on a free port (the default is 0.0.0.0:8000, open to the network)
 * - a random API key, so another local process cannot use or probe it
 * - only the configured checkpoint loaded (the default loads all three, ~5.5 GB of RAM)
 *
 * The child is not detached, so it shares Pi's process group and goes with it if
 * Pi is interrupted; a normal exit stops it from `session_shutdown`.
 */

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { homedir } from "node:os";

export type ManagedState = "stopped" | "starting" | "ready" | "failed";

export interface ManagedServerOptions {
  readonly command: string;
  readonly checkpoint: string;
  readonly startupTimeoutMs: number;
  readonly threads: number;
  readonly spawn?: typeof nodeSpawn;
  /** Probe used to decide the server is up. Defaults to `GET /health`. */
  readonly probe?: (url: string, apiKey: string) => Promise<boolean>;
  readonly onStateChange?: (state: ManagedState) => void;
}

export type StartResult = { readonly ok: true; readonly url: string; readonly apiKey: string } | { readonly ok: false; readonly detail: string };

const LOG_LINES = 40;
const POLL_INTERVAL_MS = 500;

export function expandHome(command: string): string {
  return command === "~" ? homedir() : command.startsWith("~/") ? `${homedir()}${command.slice(1)}` : command;
}

export async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

async function defaultProbe(url: string, apiKey: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/health`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(2000),
    });
    if (response.status !== 200) return false;
    const body = (await response.json()) as { status?: unknown };
    return body.status === "ok";
  } catch {
    return false;
  }
}

export class ManagedServer {
  private child: ChildProcess | undefined;
  private starting: Promise<StartResult> | undefined;
  private readonly log: string[] = [];
  private exitHook: (() => void) | undefined;
  state: ManagedState = "stopped";
  url = "";
  apiKey = "";
  lastError = "";

  private readonly options: ManagedServerOptions;

  constructor(options: ManagedServerOptions) {
    this.options = options;
  }

  /** The last lines the server printed, for `doctor`. */
  logTail(): readonly string[] {
    return [...this.log];
  }

  private setState(state: ManagedState): void {
    this.state = state;
    this.options.onStateChange?.(state);
  }

  private remember(chunk: Buffer | string): void {
    for (const line of chunk.toString().split(/\r?\n|\r/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.log.push(trimmed.slice(0, 300));
      if (this.log.length > LOG_LINES) this.log.shift();
    }
  }

  /** Start once; concurrent callers share the same attempt. */
  start(): Promise<StartResult> {
    if (this.state === "ready") return Promise.resolve({ ok: true, url: this.url, apiKey: this.apiKey });
    this.starting ??= this.launch().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  /** Wait for a start already in progress, up to `waitMs`. Does not start one. */
  async ready(waitMs: number): Promise<StartResult> {
    if (this.state === "ready") return { ok: true, url: this.url, apiKey: this.apiKey };
    if (!this.starting) return { ok: false, detail: this.lastError || "the managed Laya server is not running" };
    const timer = new Promise<StartResult>((resolve) =>
      setTimeout(() => resolve({ ok: false, detail: "the managed Laya server is still starting" }), waitMs).unref(),
    );
    return Promise.race([this.starting, timer]);
  }

  private async launch(): Promise<StartResult> {
    this.setState("starting");
    this.log.length = 0;
    const spawn = this.options.spawn ?? nodeSpawn;
    const probe = this.options.probe ?? defaultProbe;

    let port: number;
    try {
      port = await findFreePort();
    } catch (error) {
      return this.fail(`could not find a free port: ${String(error)}`);
    }
    const apiKey = randomBytes(24).toString("hex");
    const url = `http://127.0.0.1:${port}`;

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      LAYA_HOST: "127.0.0.1",
      LAYA_PORT: String(port),
      LAYA_API_KEY: apiKey,
      LAYA_MODELS: this.options.checkpoint,
      LAYA_DEFAULT_MODEL: this.options.checkpoint,
      LAYA_PRELOAD: "1",
      LAYA_MAX_LOADED: "1",
      LAYA_LOG_LEVEL: "warning",
      // transformers probes for TensorFlow at import, which can deadlock model
      // construction when TF is installed (Laya's model card).
      USE_TF: "0",
    };
    if (this.options.threads > 0) env.LAYA_THREADS = String(this.options.threads);

    let exited: string | undefined;
    try {
      const child = spawn(expandHome(this.options.command), [], { env, stdio: ["ignore", "pipe", "pipe"] });
      this.child = child;
      child.stdout?.on("data", (chunk) => this.remember(chunk));
      child.stderr?.on("data", (chunk) => this.remember(chunk));
      child.once("error", (error) => {
        exited = (error as NodeJS.ErrnoException).code === "ENOENT"
          ? `\`${this.options.command}\` was not found. Install it with \`pip install "laya[serve]"\` and set server.command to its full path.`
          : `could not start \`${this.options.command}\`: ${error.message}`;
      });
      child.once("exit", (code, signal) => {
        exited ??= `laya-serve exited (${signal ?? `code ${code}`}) before it was ready`;
        if (this.child === child) {
          this.child = undefined;
          if (this.state === "ready") {
            this.lastError = `laya-serve exited (${signal ?? `code ${code}`})`;
            this.setState("failed");
          }
        }
      });
      this.exitHook = () => child.kill("SIGTERM");
      process.once("exit", this.exitHook);
    } catch (error) {
      return this.fail(`could not start \`${this.options.command}\`: ${String(error)}`);
    }

    const deadline = Date.now() + this.options.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (exited) {
        const tail = this.log.slice(-3).join(" | ");
        return this.fail(tail ? `${exited}: ${tail}` : exited);
      }
      if (await probe(url, apiKey)) {
        this.url = url;
        this.apiKey = apiKey;
        this.lastError = "";
        this.setState("ready");
        return { ok: true, url, apiKey };
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    this.stop();
    return this.fail(
      `laya-serve did not become ready within ${Math.round(this.options.startupTimeoutMs / 1000)}s (the first start downloads about 800 MB)`,
    );
  }

  private fail(detail: string): StartResult {
    this.lastError = detail;
    this.setState("failed");
    return { ok: false, detail };
  }

  /** Idempotent. */
  stop(): void {
    const child = this.child;
    this.child = undefined;
    if (this.exitHook) {
      process.removeListener("exit", this.exitHook);
      this.exitHook = undefined;
    }
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    this.url = "";
    this.apiKey = "";
    if (this.state !== "failed") this.setState("stopped");
  }
}
