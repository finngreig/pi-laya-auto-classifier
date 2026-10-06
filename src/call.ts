/**
 * Turn a Pi tool call into the gate's view of it.
 *
 * Laya runs on this machine, so nothing here leaves it. The limit that matters is
 * Laya's input budget instead: the English checkpoint reads about 320 tokens of
 * state per question, so the action is kept short and whole, and anything that
 * cannot be shown in full is reported as such rather than silently cut.
 *
 * Redaction and the call shape are adapted from pi-jev-auto-mode (MIT). See LICENSE.
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { classifyWriteTarget, credentialPathReason } from "./policy.ts";

/** Shell tools are judged on their command text. */
export const SHELL_TOOLS: readonly string[] = ["bash", "powershell"];
/** File tools that change a file. */
export const WRITE_TOOLS: readonly string[] = ["write", "edit"];
/** Built-in tools that only read. */
export const READ_TOOLS: readonly string[] = ["read", "grep", "find", "ls"];

export type CallKind = "shell" | "write" | "read" | "tool";

export interface ToolCallEventLike {
  readonly toolName: string;
  readonly toolCallId?: string;
  readonly input: Record<string, unknown>;
}

export interface GatedCall {
  readonly kind: CallKind;
  /** The Pi tool name (`bash`, `edit`, an MCP tool, ...). */
  readonly tool: string;
  /** One line for records and dialogs. */
  readonly summary: string;
  /**
   * The text Laya judges, e.g. `bash: git push origin main`. Redacted, and bounded
   * by `maxActionCharacters`.
   */
  readonly action: string;
  /** The action did not fit in `maxActionCharacters` and was cut. */
  readonly actionTruncated: boolean;
  /** shell: the full command, redacted. */
  readonly command?: string;
  /** write/read: absolute target path. */
  readonly path?: string;
  /** write/read: target relative to the working directory, when inside it. */
  readonly relativePath?: string;
  readonly outsideCwd: boolean;
  /** write: why the target is protected, if it is. */
  readonly protectedReason?: string;
  /** read: why the target holds credential material, if it does. */
  readonly credentialReason?: string;
}

export interface CallOptions {
  readonly cwd: string;
  /** Bound on the action text Laya reads. Longer actions are marked truncated. */
  readonly maxActionCharacters: number;
  readonly extraProtectedPaths?: readonly string[];
}

const SECRET_PATTERNS: readonly { readonly pattern: RegExp; readonly replacement: string }[] = [
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: "<redacted-private-key>",
  },
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, replacement: "<redacted-jwt>" },
  { pattern: /\b(?:sk|rk)-[A-Za-z0-9_-]{16,}\b/g, replacement: "<redacted-key>" },
  { pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, replacement: "<redacted-token>" },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replacement: "<redacted-token>" },
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{12,}\b/g, replacement: "<redacted-aws-key>" },
  { pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, replacement: "<redacted-slack-token>" },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/g, replacement: "Bearer <redacted>" },
  {
    pattern:
      /((?:api[_-]?key|secret|token|password|passwd|access[_-]?key|client[_-]?secret|auth[_-]?token)\s*[:=]\s*)(["']?)([^\s"';|&]{6,})/gi,
    replacement: "$1$2<redacted>",
  },
];

/**
 * Replace obvious credentials.
 *
 * Laya is local, so this is not about a third party. Records are stored in the
 * session file and shown on screen, and a secret should not be copied into either
 * just because a command mentioned it.
 */
export function redactSecrets(text: string): string {
  let result = text;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

export function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function bounded(action: string, max: number): { action: string; truncated: boolean } {
  return action.length > max ? { action: truncate(action, max), truncated: true } : { action, truncated: false };
}

/**
 * Resolve symlinks for the deepest part of the path that exists.
 *
 * The lexical check in policy.ts cannot see that `./link/file` lands in `~/.ssh`.
 * Resolving the nearest existing ancestor catches a symlinked directory inside the
 * project pointing outside it, which is the case that matters for a write.
 */
export function resolveRealTarget(absolute: string): string {
  let existing = absolute;
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return absolute;
    rest.unshift(existing.slice(parent.length).replace(/^[\\/]+/, ""));
    existing = parent;
  }
  try {
    return resolve(realpathSync(existing), ...rest);
  } catch {
    return absolute;
  }
}

function realCwd(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return resolve(cwd);
  }
}

function isInside(target: string, root: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function editExcerpt(input: Record<string, unknown>): string {
  const edits = Array.isArray(input.edits) ? input.edits : [];
  return edits
    .map((edit) => (edit && typeof edit === "object" ? asString((edit as { newText?: unknown }).newText) : undefined))
    .filter((text): text is string => typeof text === "string")
    .join(" … ");
}

/**
 * Build the gate's view of a tool call. Every tool gets one: which of them reach
 * Laya is the gate's decision, not this module's.
 */
export function buildGatedCall(event: ToolCallEventLike, options: CallOptions): GatedCall {
  const max = options.maxActionCharacters;
  const tool = event.toolName;

  if (SHELL_TOOLS.includes(tool)) {
    const command = redactSecrets(asString(event.input.command) ?? "");
    const { action, truncated } = bounded(`${tool}: ${command}`, max);
    return {
      kind: "shell",
      tool,
      summary: truncate(oneLine(command), 200) || "(empty command)",
      action,
      actionTruncated: truncated,
      command,
      outsideCwd: false,
    };
  }

  if (WRITE_TOOLS.includes(tool)) {
    const inputPath = asString(event.input.path) ?? "";
    const target = classifyWriteTarget(inputPath, options.cwd, options.extraProtectedPaths ?? []);
    // A symlink inside the project that points elsewhere is judged by where it lands.
    const real = resolveRealTarget(target.absolute);
    const escapes = !target.outsideCwd && real !== target.absolute && !isInside(real, realCwd(options.cwd));
    const realTarget = real !== target.absolute ? classifyWriteTarget(real, options.cwd, options.extraProtectedPaths ?? []) : target;
    const protectedReason = target.protectedReason ?? realTarget.protectedReason;
    const shownPath = target.relativeToCwd ?? target.absolute;

    // The content is local data and may help Laya see what the write does (a line
    // appended to a shell profile, say). It is supplementary: the path decided that
    // the call needs judging, so a cut excerpt does not make the call unjudgeable.
    const content = tool === "write" ? (asString(event.input.content) ?? "") : editExcerpt(event.input);
    // Inside the project the relative path is what matters, and it keeps the
    // machine's directory names (which shift Laya's answers) out of the input.
    const head = `${tool} ${target.relativeToCwd ?? target.absolute}${escapes ? ` (symlink to ${real})` : ""}`;
    const room = Math.max(0, max - head.length - 12);
    const excerpt = content ? `: ${truncate(oneLine(redactSecrets(content)), room)}` : "";

    return {
      kind: "write",
      tool,
      summary: `${tool} ${shownPath}`,
      action: `${head}${excerpt}`,
      actionTruncated: false,
      path: target.absolute,
      ...(target.relativeToCwd === undefined ? {} : { relativePath: target.relativeToCwd }),
      outsideCwd: target.outsideCwd || escapes,
      ...(protectedReason === undefined ? {} : { protectedReason }),
    };
  }

  if (READ_TOOLS.includes(tool)) {
    const inputPath = asString(event.input.path) ?? "";
    const absolute = inputPath ? resolve(options.cwd, inputPath) : resolve(options.cwd);
    const real = resolveRealTarget(absolute);
    const credentialReason = credentialPathReason(absolute) ?? credentialPathReason(real);
    const pattern = asString(event.input.pattern);
    const described = `${tool} ${absolute}${pattern ? ` (pattern: ${pattern})` : ""}`;
    const { action, truncated } = bounded(described, max);
    return {
      kind: "read",
      tool,
      summary: truncate(oneLine(`${tool} ${inputPath || "."}`), 200),
      action,
      actionTruncated: truncated,
      path: absolute,
      outsideCwd: !isInside(absolute, resolve(options.cwd)) && absolute !== resolve(options.cwd),
      ...(credentialReason === undefined ? {} : { credentialReason }),
    };
  }

  let args: string;
  try {
    args = JSON.stringify(event.input) ?? "{}";
  } catch {
    args = "{}";
  }
  const { action, truncated } = bounded(`${tool}: ${redactSecrets(args)}`, max);
  return {
    kind: "tool",
    tool,
    summary: truncate(oneLine(`${tool} ${redactSecrets(args)}`), 200),
    action,
    actionTruncated: truncated,
    outsideCwd: false,
  };
}
