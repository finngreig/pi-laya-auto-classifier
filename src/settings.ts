/**
 * Settings.
 *
 * Global settings live with the rest of Pi's agent state
 * (`$PI_CODING_AGENT_DIR` or `~/.pi/agent`). A project can override them from
 * `<cwd>/.pi/laya-auto-mode.json`, but only when Pi trusts the project: an
 * untrusted checkout must not be able to loosen the gate that is judging it.
 *
 * The `server` block is global only, even for a trusted project. Pointing the gate
 * at a different "Laya" is the one change that could quietly approve everything,
 * so a repository never gets to make it.
 *
 * Validation is adapted from pi-jev-auto-mode (MIT). See THIRD_PARTY_NOTICES.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Cutoffs } from "./laya/questions.ts";

export type UncertainAction = "block" | "ask";
export const UNCERTAIN_ACTIONS: readonly UncertainAction[] = ["block", "ask"];

export type ServerMode = "external" | "managed";
export const SERVER_MODES: readonly ServerMode[] = ["external", "managed"];

export type Checkpoint = "english" | "multilingual" | "typed-decisions";
export const CHECKPOINTS: readonly Checkpoint[] = ["english", "multilingual", "typed-decisions"];

export type DisplayMode = "compact" | "full";
export const DISPLAY_MODES: readonly DisplayMode[] = ["compact", "full"];

export interface ServerSettings {
  /** `external`: you run `laya-serve`. `managed`: the extension starts and stops it. */
  readonly mode: ServerMode;
  /** Base URL of an external server. */
  readonly url: string;
  /** Managed mode: the `laya-serve` executable, e.g. `~/.laya/bin/laya-serve`. */
  readonly command: string;
  /** Managed mode: how long to wait for the server to answer `/health`. */
  readonly startupTimeoutMs: number;
  /** Managed mode: cap on CPU threads (`LAYA_THREADS`). 0 leaves it to torch. */
  readonly threads: number;
}

export interface LayaAutoModeSettings {
  readonly enabled: boolean;
  readonly server: ServerSettings;
  /** Which Laya checkpoint answers. Pinned on every request and checked in every response. */
  readonly checkpoint: Checkpoint;
  /** Per-request `max_len`. 0 uses the checkpoint's own (512 for english). */
  readonly maxLen: number;
  /** Per-request timeout. A CPU-only machine needs about a second per call. */
  readonly timeoutMs: number;
  /**
   * How many recent user messages (skipping bare "ok, go ahead" replies) Laya
   * compares the call against. 1 is the safest measured setting; more lets
   * ordinary work through when the request was a few messages back, and lets
   * more unrequested calls through too. See docs/calibration.md.
   */
  readonly requestMessages: number;
  /** What an unclear answer (or an unreachable server) resolves to. */
  readonly uncertain: UncertainAction;
  /** Commands that run without judgement or a record. Safe on *your* machine. */
  readonly safeCommands: readonly string[];
  /** Commands that run without judgement, even if they match a dangerous pattern. Recorded. */
  readonly allowedCommands: readonly string[];
  /** Commands that are always blocked. */
  readonly disallowedCommands: readonly string[];
  readonly extraProtectedPaths: readonly string[];
  /** Judge extension and MCP tools that do not declare themselves read-only. */
  readonly gateOtherTools: boolean;
  /**
   * Longest action Laya is shown. A longer command cannot be judged in full, so it
   * resolves like an unclear answer instead of being judged on its first half.
   */
  readonly maxActionCharacters: number;
  /** Per-question cut-off overrides. */
  readonly thresholds: Readonly<Record<string, Cutoffs>>;
  /**
   * After this many blocks in a row, or in total, escalated calls go to the user
   * (as in Claude Code's auto mode). 0 disables a limit.
   */
  readonly denialLimits: { readonly consecutive: number; readonly total: number };
  readonly display: DisplayMode;
}

export const DEFAULT_URL = "http://127.0.0.1:8000";

export const DEFAULT_SETTINGS: LayaAutoModeSettings = {
  enabled: true,
  server: {
    mode: "external",
    url: DEFAULT_URL,
    command: "laya-serve",
    startupTimeoutMs: 180_000,
    threads: 0,
  },
  checkpoint: "english",
  maxLen: 0,
  timeoutMs: 8000,
  requestMessages: 1,
  uncertain: "block",
  safeCommands: [],
  allowedCommands: [],
  disallowedCommands: [],
  extraProtectedPaths: [],
  gateOtherTools: true,
  maxActionCharacters: 800,
  thresholds: {},
  denialLimits: { consecutive: 3, total: 20 },
  display: "compact",
};

export type SettingsScope = "global" | "project";

const MAX_PATTERN_ENTRIES = 200;
const MAX_PATTERN_LENGTH = 300;
const MAX_THRESHOLD_ENTRIES = 32;
const MAX_RULE_ID_LENGTH = 64;


type Mutable<T> = { -readonly [K in keyof T]?: T[K] };
export type SettingsPatch = Mutable<Omit<LayaAutoModeSettings, "server" | "denialLimits">> & {
  server?: Mutable<ServerSettings>;
  denialLimits?: { consecutive?: number; total?: number };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && values.includes(value as T);
}

export function isUncertainAction(value: unknown): value is UncertainAction {
  return oneOf(UNCERTAIN_ACTIONS, value);
}

export function isCheckpoint(value: unknown): value is Checkpoint {
  return oneOf(CHECKPOINTS, value);
}

export function isServerMode(value: unknown): value is ServerMode {
  return oneOf(SERVER_MODES, value);
}

export function isDisplayMode(value: unknown): value is DisplayMode {
  return oneOf(DISPLAY_MODES, value);
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * Validate one question's cut-offs: `{ "pass": 0.7, "reject": 0.55 }`, or a
 * single number `t` meaning `{ pass: t, reject: 1 - t }`. `reject` must be
 * below `pass`. `undefined` when the value is not usable.
 */
export function parseCutoffs(value: unknown): Cutoffs | undefined {
  if (typeof value === "number") {
    return isProbability(value) && value > 0.5 ? { pass: value, reject: 1 - value } : undefined;
  }
  if (!isRecord(value) || !isProbability(value.pass) || !isProbability(value.reject)) return undefined;
  return value.reject < value.pass ? { pass: value.pass, reject: value.reject } : undefined;
}

function readBoundedInteger(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  return rounded < min || rounded > max ? undefined : rounded;
}

function readStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry.length <= MAX_PATTERN_LENGTH && !entry.includes("\n"))
    .slice(0, MAX_PATTERN_ENTRIES);
}

function readThresholds(value: unknown): Readonly<Record<string, Cutoffs>> | undefined {
  if (!isRecord(value)) return undefined;
  const thresholds: Record<string, Cutoffs> = {};
  for (const [ruleId, raw] of Object.entries(value)) {
    if (ruleId.length === 0 || ruleId.length > MAX_RULE_ID_LENGTH) continue;
    const cutoffs = parseCutoffs(raw);
    if (cutoffs === undefined) continue;
    thresholds[ruleId] = cutoffs;
    if (Object.keys(thresholds).length >= MAX_THRESHOLD_ENTRIES) break;
  }
  return thresholds;
}

function readUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? value.trim().replace(/\/+$/, "") : undefined;
  } catch {
    return undefined;
  }
}

function readServer(value: unknown): Mutable<ServerSettings> | undefined {
  if (!isRecord(value)) return undefined;
  const server: Mutable<ServerSettings> = {};
  if (isServerMode(value.mode)) server.mode = value.mode;
  const url = readUrl(value.url);
  if (url !== undefined) server.url = url;
  if (typeof value.command === "string" && value.command.trim() && !value.command.includes("\n")) {
    server.command = value.command.trim();
  }
  const startup = readBoundedInteger(value.startupTimeoutMs, 5_000, 1_800_000);
  if (startup !== undefined) server.startupTimeoutMs = startup;
  const threads = readBoundedInteger(value.threads, 0, 256);
  if (threads !== undefined) server.threads = threads;
  return server;
}

/**
 * Validate an untrusted settings file.
 *
 * Malformed values are dropped rather than replaced by a default, so a broken
 * project file cannot pin a value over the global layer. Unknown fields are
 * ignored. `allowServer: false` drops the `server` block (project files).
 */
export function parseSettingsPatch(value: unknown, options: { allowServer: boolean }): SettingsPatch {
  if (!isRecord(value)) return {};
  const patch: SettingsPatch = {};

  if (typeof value.enabled === "boolean") patch.enabled = value.enabled;
  if (options.allowServer) {
    const server = readServer(value.server);
    if (server !== undefined) patch.server = server;
  }
  if (isCheckpoint(value.checkpoint)) patch.checkpoint = value.checkpoint;
  const maxLen = value.maxLen === 0 ? 0 : readBoundedInteger(value.maxLen, 128, 8192);
  if (maxLen !== undefined) patch.maxLen = maxLen;
  const timeoutMs = readBoundedInteger(value.timeoutMs, 250, 120_000);
  if (timeoutMs !== undefined) patch.timeoutMs = timeoutMs;
  const requestMessages = readBoundedInteger(value.requestMessages, 1, 4);
  if (requestMessages !== undefined) patch.requestMessages = requestMessages;
  if (isUncertainAction(value.uncertain)) patch.uncertain = value.uncertain;
  if (isDisplayMode(value.display)) patch.display = value.display;
  if (typeof value.gateOtherTools === "boolean") patch.gateOtherTools = value.gateOtherTools;
  const maxAction = readBoundedInteger(value.maxActionCharacters, 100, 20_000);
  if (maxAction !== undefined) patch.maxActionCharacters = maxAction;

  for (const key of ["safeCommands", "allowedCommands", "disallowedCommands", "extraProtectedPaths"] as const) {
    const list = value[key] === undefined ? undefined : readStringArray(value[key]);
    if (list !== undefined) patch[key] = list;
  }

  const thresholds = value.thresholds === undefined ? undefined : readThresholds(value.thresholds);
  if (thresholds !== undefined) patch.thresholds = thresholds;

  if (isRecord(value.denialLimits)) {
    const limits: { consecutive?: number; total?: number } = {};
    const consecutive = readBoundedInteger(value.denialLimits.consecutive, 0, 1000);
    if (consecutive !== undefined) limits.consecutive = consecutive;
    const total = readBoundedInteger(value.denialLimits.total, 0, 100_000);
    if (total !== undefined) limits.total = total;
    patch.denialLimits = limits;
  }

  return patch;
}

export function mergeSettings(base: LayaAutoModeSettings, patch: SettingsPatch): LayaAutoModeSettings {
  return {
    ...base,
    ...patch,
    server: { ...base.server, ...patch.server },
    // Per-rule: a project that retunes one rule keeps the global overrides for the rest.
    thresholds: { ...base.thresholds, ...patch.thresholds },
    denialLimits: { ...base.denialLimits, ...patch.denialLimits },
  };
}

async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

async function writeFileAtomic(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, contents, "utf8");
  await rename(temporary, path);
}

export interface LoadedSettings {
  readonly settings: LayaAutoModeSettings;
  readonly scope: SettingsScope;
}

export class SettingsStore {
  private readonly agentDir: string;
  private readonly configDirName: string;

  constructor(agentDir: string, configDirName: string) {
    this.agentDir = agentDir;
    this.configDirName = configDirName;
  }

  globalPath(): string {
    return join(this.agentDir, "laya-auto-mode.json");
  }

  projectPath(cwd: string): string {
    return join(cwd, this.configDirName, "laya-auto-mode.json");
  }

  /** Global settings with the project file layered on top when the project is trusted. */
  async load(cwd: string, projectTrusted: boolean): Promise<LoadedSettings> {
    const globalPatch = parseSettingsPatch(await readJsonFile(this.globalPath()), { allowServer: true });
    const globalSettings = mergeSettings(DEFAULT_SETTINGS, globalPatch);
    if (!projectTrusted) return { settings: globalSettings, scope: "global" };
    const projectValue = await readJsonFile(this.projectPath(cwd));
    if (projectValue === undefined) return { settings: globalSettings, scope: "global" };
    return {
      settings: mergeSettings(globalSettings, parseSettingsPatch(projectValue, { allowServer: false })),
      scope: "project",
    };
  }

  /**
   * Merge a change into the global file, keeping whatever else it holds.
   *
   * Commands write here rather than to the project file: a setting typed at the
   * prompt is the user's, and a project file is the repository's. Objects merge one
   * level deep, and a `null` inside one removes that key.
   */
  async updateGlobal(patch: Record<string, unknown>): Promise<void> {
    const current = await readJsonFile(this.globalPath());
    const base = isRecord(current) ? current : {};
    const next: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(patch)) {
      if (!isRecord(value)) {
        next[key] = value;
        continue;
      }
      const merged: Record<string, unknown> = { ...(isRecord(base[key]) ? base[key] : {}), ...value };
      for (const [inner, innerValue] of Object.entries(merged)) if (innerValue === null) delete merged[inner];
      next[key] = merged;
    }
    await writeFileAtomic(this.globalPath(), `${JSON.stringify(next, null, 2)}\n`);
  }
}
