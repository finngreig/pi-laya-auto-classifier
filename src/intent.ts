/**
 * Recover what the user actually asked for.
 *
 * Only user-authored text is used, as in Claude Code's auto mode. Assistant
 * messages and tool output can carry file contents and command output, so letting
 * them shape "what the user wants" would let repository content argue for its own
 * approval.
 *
 * Adapted from pi-jev-auto-mode (MIT). See THIRD_PARTY_NOTICES.
 */

import { redactSecrets } from "./call.ts";

export interface IntentOptions {
  /** How many of the most recent user messages to consider. */
  readonly maxMessages: number;
  readonly maxMessageChars: number;
  /** Total budget across all messages. Laya's input is small; see call.ts. */
  readonly maxTotalChars: number;
}

export const DEFAULT_INTENT_OPTIONS: IntentOptions = {
  maxMessages: 6,
  maxMessageChars: 600,
  maxTotalChars: 1500,
};

/** Recent user messages, newest first. */
export interface UserIntent {
  readonly messages: readonly string[];
}

export const NO_INTENT: UserIntent = { messages: [] };

const ACKNOWLEDGEMENT =
  /^(?:ok(?:ay)?|k|yes|yep|yeah|yup|sure|go|go ahead|go for it|do it|please do|sounds good|lgtm|looks good|thanks?|thank you|ty|cool|great|perfect|nice|continue|proceed|carry on|approved?)\b[\s!.,]*(?:(?:go ahead|do it|please|thanks?|continue|proceed)\b[\s!.,]*)*$/i;

/**
 * "ok, go ahead" and friends.
 *
 * A bare go-ahead says nothing about what was asked for, and next to a tool call
 * Laya tends to read it as permission for that call, whatever the call is. So it
 * is not used as the request; the message before it is.
 */
export function isAcknowledgement(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length <= 40 && ACKNOWLEDGEMENT.test(trimmed);
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

/** Flatten a Pi message content value into plain text. */
export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((part): part is { type?: unknown; text?: unknown } => Boolean(part) && typeof part === "object")
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n")
    .trim();
}

/**
 * Recent user turns, newest first.
 *
 * Messages carrying a `customType` are extension-injected context, not user
 * speech, so they are skipped.
 */
export function extractRecentIntent(
  branch: readonly unknown[],
  options: IntentOptions = DEFAULT_INTENT_OPTIONS,
): UserIntent {
  const collected: string[] = [];
  let total = 0;

  for (let index = branch.length - 1; index >= 0 && collected.length < options.maxMessages; index -= 1) {
    const entry = branch[index];
    if (!entry || typeof entry !== "object") continue;
    if ((entry as { type?: unknown }).type !== "message") continue;

    const message = (entry as { message?: { role?: unknown; content?: unknown; customType?: unknown } }).message;
    if (!message || message.role !== "user") continue;
    if (typeof message.customType === "string" && message.customType.length > 0) continue;

    const text = truncate(redactSecrets(messageText(message.content)).trim(), options.maxMessageChars);
    if (!text) continue;
    if (total + text.length > options.maxTotalChars) {
      const room = options.maxTotalChars - total;
      if (room > 40) collected.push(truncate(text, room));
      break;
    }
    collected.push(text);
    total += text.length;
  }

  return { messages: collected };
}
