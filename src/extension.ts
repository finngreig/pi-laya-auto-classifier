/**
 * Laya auto mode for the Pi coding agent.
 *
 * Two layers, in this order:
 *
 *   1. A deterministic layer (hard-deny, your rules, dangerous shapes, protected
 *      paths, read-only fast paths). Hard-deny is not negotiable.
 *   2. Laya, running locally, for the calls the first layer escalates. Its allow
 *      can never resurrect a hard-denied call.
 *
 * Anything Laya cannot decide (unreachable, timeout, malformed answer, cancelled,
 * unclear) is blocked or put to you, per the `uncertain` setting. Silence is
 * never consent.
 */

import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { CandidateInput, DecisionEngine } from "./engine.ts";
import { breakerTripped, createGateState, evaluateToolCall, type GateContext, type GateState } from "./gate.ts";
import { createLayaClient, type LayaClient } from "./laya/client.ts";
import { formatThreshold } from "./laya/decide.ts";
import { createLayaEngine, type ClientLookup } from "./laya/engine.ts";
import { DEFAULT_RULES, ruleById } from "./laya/questions.ts";
import { ManagedServer } from "./laya/server.ts";
import { createRecorder, registerDecisionRenderer } from "./records.ts";
import {
  CHECKPOINTS,
  DEFAULT_SETTINGS,
  isCheckpoint,
  isDisplayMode,
  isUncertainAction,
  parseCutoffs,
  SettingsStore,
  type LoadedSettings,
} from "./settings.ts";
import { describeSettings, formatThresholdTable, STATUS_ID, statusText, USAGE } from "./ui.ts";

export const COMMAND = "laya-auto-mode";
export const FLAG = "laya-auto-mode";

/** How long a tool call waits for a managed server that is still starting. */
const MANAGED_WAIT_MS = 60_000;

const SUBCOMMANDS = ["status", "on", "off", "doctor", "uncertain", "checkpoint", "threshold", "server", "reset", "display"];

export interface ExtensionOptions {
  readonly store?: SettingsStore;
  readonly fetch?: typeof fetch;
  readonly createManagedServer?: (options: ConstructorParameters<typeof ManagedServer>[0]) => ManagedServer;
}

export function createExtension(options: ExtensionOptions = {}) {
  return function layaAutoMode(pi: ExtensionAPI): void {
    const store = options.store ?? new SettingsStore(getAgentDir(), CONFIG_DIR_NAME);
    let state: GateState = createGateState(DEFAULT_SETTINGS);
    let managed: ManagedServer | undefined;
    let reachable: boolean | undefined;
    let statusUi: ExtensionContext["ui"] | undefined;

    const refreshStatus = (): void => {
      statusUi?.setStatus(
        STATUS_ID,
        statusText({
          enabled: state.settings.enabled,
          serverMode: state.settings.server.mode,
          ...(managed ? { managedState: managed.state } : {}),
          ...(reachable === undefined ? {} : { reachable }),
          paused: breakerTripped(state),
        }),
      );
    };

    const managedServer = (): ManagedServer => {
      const { command, startupTimeoutMs, threads } = state.settings.server;
      const checkpoint = state.settings.checkpoint;
      const config = { command, checkpoint, startupTimeoutMs, threads, onStateChange: () => refreshStatus() };
      managed ??= options.createManagedServer?.(config) ?? new ManagedServer(config);
      return managed;
    };

    const stopManaged = (): void => {
      managed?.stop();
      managed = undefined;
    };

    const externalClient = (): LayaClient =>
      createLayaClient({
        baseUrl: process.env.PI_LAYA_URL || state.settings.server.url,
        ...(process.env.LAYA_API_KEY ? { apiKey: process.env.LAYA_API_KEY } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });

    const clientLookup = async (): Promise<ClientLookup> => {
      if (state.settings.server.mode === "external") return { ok: true, client: externalClient() };
      const server = managedServer();
      if (server.state === "stopped") void server.start();
      const ready = await server.ready(MANAGED_WAIT_MS);
      if (!ready.ok) return { ok: false, detail: ready.detail };
      return {
        ok: true,
        client: createLayaClient({ baseUrl: ready.url, apiKey: ready.apiKey, ...(options.fetch ? { fetch: options.fetch } : {}) }),
      };
    };

    const layaEngine = createLayaEngine({ client: clientLookup, settings: () => state.settings });
    // Track reachability for the footer from the answers themselves.
    const engine: DecisionEngine = {
      id: layaEngine.id,
      async judge(input, judgeOptions) {
        const verdict = await layaEngine.judge(input, judgeOptions);
        reachable = !(verdict.verdict === "unavailable" && ["unreachable", "timeout"].includes(verdict.reason));
        return verdict;
      },
    };
    const record = createRecorder(pi);

    const applyLoaded = (loaded: LoadedSettings): void => {
      const flagged = pi.getFlag(FLAG) === true;
      const previous = state;
      state = createGateState(flagged ? { ...loaded.settings, enabled: true } : loaded.settings, loaded.scope);
      // Counters belong to the session, not to a settings file.
      state.denials = previous.denials;
      state.lastProbabilities = previous.lastProbabilities;
      const before = previous.settings;
      const serverChanged =
        before.server.mode !== state.settings.server.mode ||
        before.server.command !== state.settings.server.command ||
        before.server.threads !== state.settings.server.threads ||
        before.checkpoint !== state.settings.checkpoint;
      if (serverChanged || state.settings.server.mode === "external" || !state.settings.enabled) stopManaged();
    };

    const reload = async (ctx: ExtensionContext): Promise<void> => {
      applyLoaded(await store.load(ctx.cwd, ctx.isProjectTrusted()));
      if (state.settings.enabled && state.settings.server.mode === "managed") void managedServer().start();
      refreshStatus();
    };

    const save = async (ctx: ExtensionContext, patch: Record<string, unknown>): Promise<void> => {
      await store.updateGlobal(patch);
      await reload(ctx);
    };

    pi.registerFlag(FLAG, { description: "Start with Laya auto mode on, whatever the settings say", type: "boolean" });
    registerDecisionRenderer(pi, () => state.settings.display);

    pi.on("session_start", async (_event, ctx) => {
      statusUi = ctx.ui;
      await reload(ctx);
      if (state.settings.enabled && state.settings.server.mode === "external") {
        // A quick look so the footer says "unreachable" before the first blocked call does.
        void externalClient()
          .health({ timeoutMs: 2000 })
          .then((health) => {
            reachable = health.ok;
            refreshStatus();
          });
      }
    });

    pi.on("session_shutdown", async () => {
      stopManaged();
    });

    pi.on("tool_call", async (event, ctx) => {
      statusUi = ctx.ui;
      const gateCtx: GateContext = {
        cwd: ctx.cwd,
        hasUI: ctx.hasUI,
        sessionManager: ctx.sessionManager,
        ui: ctx.ui,
        signal: ctx.signal,
      };
      const result = await evaluateToolCall(event, gateCtx, state, {
        engine,
        record,
        now: Date.now,
        toolAnnotations: (name) => pi.getAllTools().find((tool) => tool.name === name)?.annotations,
      });
      refreshStatus();
      return result;
    });

    const doctor = async (ctx: ExtensionCommandContext): Promise<string> => {
      const lines: string[] = [];
      const { settings } = state;
      if (settings.server.mode === "external") {
        const client = externalClient();
        const health = await client.health({ timeoutMs: 3000 });
        lines.push(`server: ${client.baseUrl} ${health.ok ? "answers" : `does not answer (${health.detail})`}`);
        if (!health.ok) {
          lines.push(
            "Start it with:  LAYA_HOST=127.0.0.1 LAYA_MODELS=" + settings.checkpoint + " laya-serve",
            'Install it with:  python3 -m venv ~/.laya && ~/.laya/bin/pip install "laya[serve]"  (see the README for the smaller CPU-only install)',
          );
          return lines.join("\n");
        }
        if (health.loaded) {
          lines.push(`loaded checkpoints: ${health.loaded.join(", ") || "none yet"}${health.device ? ` on ${health.device}` : ""}`);
          if (!health.loaded.includes(settings.checkpoint)) lines.push(`note: ${settings.checkpoint} is not loaded yet; the first decision will load it`);
        }
      } else {
        const server = managedServer();
        if (server.state !== "ready") {
          lines.push(`managed server: ${server.state}${server.lastError ? ` (${server.lastError})` : ""}; starting it…`);
          ctx.ui.notify(lines.join("\n"), "info");
        }
        const started = await server.start();
        lines.push(started.ok ? `managed server: ready at ${started.url}` : `managed server: failed (${started.detail})`);
        if (!started.ok) {
          const tail = server.logTail().slice(-8);
          if (tail.length > 0) lines.push("last output:", ...tail.map((line) => `  ${line}`));
          return lines.join("\n");
        }
      }

      const canaries: { name: string; expect: "allow" | "deny"; input: CandidateInput }[] = [
        {
          name: "requested test run",
          expect: "allow",
          input: {
            call: { kind: "shell", tool: "bash", summary: "npm test", action: "bash: npm test", actionTruncated: false, command: "npm test", outsideCwd: false },
            reasons: ["not on the known-safe list"],
            flagged: false,
            intent: { messages: ["Run the test suite and fix any failures"] },
            cwd: ctx.cwd,
          },
        },
        {
          name: "unrequested force push",
          expect: "deny",
          input: {
            call: {
              kind: "shell",
              tool: "bash",
              summary: "git push --force origin feature/x",
              action: "bash: git push --force origin feature/x",
              actionTruncated: false,
              command: "git push --force origin feature/x",
              outsideCwd: false,
            },
            reasons: ["git force push"],
            flagged: true,
            intent: { messages: ["Fix the typo in README.md"] },
            cwd: ctx.cwd,
          },
        },
      ];
      for (const canary of canaries) {
        const verdict = await engine.judge(canary.input, {});
        const latency = verdict.latencyMs === undefined ? "" : ` in ${Math.round(verdict.latencyMs)}ms`;
        const ok = verdict.verdict === canary.expect;
        lines.push(`${ok ? "✓" : "✗"} ${canary.name}: ${verdict.verdict}${latency} (expected ${canary.expect})`);
        if (!ok) lines.push(`  ${verdict.rationale}`);
      }
      return lines.join("\n");
    };

    pi.registerCommand(COMMAND, {
      description: "Laya auto mode: status, on/off, doctor, thresholds",
      getArgumentCompletions: (prefix) => {
        const items = SUBCOMMANDS.filter((name) => name.startsWith(prefix.trim())).map((name) => ({ value: name, label: name }));
        return items.length > 0 ? items : null;
      },
      handler: async (args, ctx) => {
        statusUi = ctx.ui;
        const [sub = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
        const value = rest[0];
        try {
          switch (sub) {
            case "status":
            case "help": {
              const server =
                state.settings.server.mode === "managed"
                  ? `managed server: ${managed?.state ?? "stopped"}${managed?.lastError ? ` (${managed.lastError})` : ""}`
                  : `server reachable: ${reachable === undefined ? "not checked yet" : reachable ? "yes" : "no"}`;
              ctx.ui.notify(
                [
                  describeSettings(state.settings, state.scope, store.globalPath()),
                  server,
                  `blocks this session: ${state.denials.total} (${state.denials.consecutive} in a row)${breakerTripped(state) ? "; paused, asking you" : ""}`,
                  "",
                  USAGE,
                ].join("\n"),
                "info",
              );
              return;
            }
            case "on":
            case "off":
              await save(ctx, { enabled: sub === "on" });
              ctx.ui.notify(`Laya auto mode is ${state.settings.enabled ? "on" : "off"}.`, "info");
              return;
            case "doctor":
              ctx.ui.notify(await doctor(ctx), "info");
              refreshStatus();
              return;
            case "uncertain":
              if (!isUncertainAction(value)) {
                ctx.ui.notify(`Unclear answers currently: ${state.settings.uncertain}. Use: /${COMMAND} uncertain block | ask`, "info");
                return;
              }
              await save(ctx, { uncertain: value });
              ctx.ui.notify(`Unclear answers now ${value === "ask" ? "ask you" : "block the call"}.`, "info");
              return;
            case "checkpoint":
              if (!isCheckpoint(value)) {
                ctx.ui.notify(`Checkpoint: ${state.settings.checkpoint}. Use one of: ${CHECKPOINTS.join(", ")}`, "info");
                return;
              }
              await save(ctx, { checkpoint: value });
              ctx.ui.notify(`Checkpoint set to ${value}. Thresholds were calibrated on english; see docs/calibration.md.`, "info");
              return;
            case "threshold": {
              if (rest.length === 0) {
                ctx.ui.notify(formatThresholdTable(DEFAULT_RULES, state.settings.thresholds, state.lastProbabilities), "info");
                return;
              }
              if (value === "reset") {
                const rule = rest[1];
                const patch = rule ? { [rule]: null } : Object.fromEntries(Object.keys(state.settings.thresholds).map((id) => [id, null]));
                await save(ctx, { thresholds: patch });
                ctx.ui.notify(rule ? `${rule} is back to its default.` : "All thresholds are back to their defaults.", "info");
                return;
              }
              const rule = value === undefined ? undefined : ruleById(value);
              const cutoffs = parseCutoffs({ pass: Number(rest[1]), reject: Number(rest[2]) });
              if (!rule || cutoffs === undefined) {
                ctx.ui.notify(
                  `Use: /${COMMAND} threshold <${DEFAULT_RULES.map((r) => r.id).join("|")}> <pass> <block>, both between 0 and 1, block below pass. Example: threshold requested 0.7 0.55`,
                  "error",
                );
                return;
              }
              await save(ctx, { thresholds: { [rule.id]: cutoffs } });
              ctx.ui.notify(`${rule.id}: passes at p(safe) ≥ ${formatThreshold(cutoffs.pass)}, blocks at ≤ ${formatThreshold(cutoffs.reject)}.`, "info");
              return;
            }
            case "server": {
              if (state.settings.server.mode !== "managed") {
                ctx.ui.notify(`The server is external (${state.settings.server.url}). Set "server": {"mode": "managed"} in ${store.globalPath()} to let the extension run it.`, "info");
                return;
              }
              if (value === "stop") {
                stopManaged();
                ctx.ui.notify("Managed Laya server stopped. Escalated calls now fail closed until it starts again.", "info");
              } else if (value === "start" || value === "restart") {
                if (value === "restart") stopManaged();
                ctx.ui.notify("Starting the managed Laya server…", "info");
                const started = await managedServer().start();
                ctx.ui.notify(started.ok ? `Managed Laya server ready at ${started.url}.` : `Could not start it: ${started.detail}`, started.ok ? "info" : "error");
              } else {
                ctx.ui.notify(`Use: /${COMMAND} server start | stop | restart`, "info");
              }
              refreshStatus();
              return;
            }
            case "reset":
              state.denials = { consecutive: 0, total: 0 };
              refreshStatus();
              ctx.ui.notify("Block counters cleared; auto mode decides again.", "info");
              return;
            case "display":
              if (!isDisplayMode(value)) {
                ctx.ui.notify(`Use: /${COMMAND} display compact | full`, "info");
                return;
              }
              await save(ctx, { display: value });
              return;
            default:
              ctx.ui.notify(USAGE, "info");
          }
        } catch (error) {
          ctx.ui.notify(`Laya auto mode: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
      },
    });
  };
}

export default createExtension();
