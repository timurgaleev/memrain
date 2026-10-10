/**
 * Codex CLI session rollout (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`):
 * one file per session, one `{timestamp, type, payload}` record per line.
 *
 * Turns are chosen by record kind, not by guessing at text. What the person
 * typed is the `event_msg` of payload type `user_message` (Codex up to 0.152)
 * or of payload type `item_completed` with a `UserMessage` item (0.153 on); a
 * rollout that records one turn both ways keeps it once. The `response_item`
 * messages with role `user` or `developer` are context the CLI injected
 * (instructions, environment, plugin lists) and are left out. The answer is a
 * `response_item` message with role `assistant`, read from its `output_text`
 * blocks. Reasoning, tool calls and their output, token counts and every other
 * event kind are dropped: a transcript page records the conversation.
 */
import { titleFromText } from "./jsonl.ts";
import {
  asRecord,
  toEpochMs,
  USER_TURNS_MISSING,
  type AdapterResult,
  type TranscriptAdapter,
  type TranscriptMessage,
} from "./types.ts";

function outputText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map(asRecord)
    .filter((b): b is Record<string, unknown> => b !== null && b["type"] === "output_text" && typeof b["text"] === "string")
    .map((b) => (b["text"] as string).trim())
    .filter((t) => t.length > 0)
    .join("\n")
    .trim();
}

/** `UserMessage` item text: its `text` blocks, in order. */
function userItemText(item: Record<string, unknown> | null): string {
  if (!item || item["type"] !== "UserMessage" || !Array.isArray(item["content"])) return "";
  return item["content"]
    .map(asRecord)
    .filter((b): b is Record<string, unknown> => b !== null && b["type"] === "text" && typeof b["text"] === "string")
    .map((b) => (b["text"] as string).trim())
    .filter((t) => t.length > 0)
    .join("\n")
    .trim();
}

/** A rollout written during the 0.153 transition records a typed turn as
 *  `user_message` and again as an `item_completed` UserMessage: the same text
 *  with no answer between them. */
function isRepeatedUserTurn(previous: TranscriptMessage | undefined, text: string): boolean {
  return previous?.role === "user" && previous.text === text;
}

function nonEmpty(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function parseCodexRollout(records: readonly unknown[]): AdapterResult {
  let id: string | null = null;
  let startedAt: number | null = null;
  let sawMeta = false;
  const messages: TranscriptMessage[] = [];
  let skippedMessages = 0;

  for (const raw of records) {
    const rec = asRecord(raw);
    if (!rec) continue;
    const payload = asRecord(rec["payload"]) ?? {};
    const ts = toEpochMs(rec["timestamp"]);
    const type = rec["type"];

    if (type === "session_meta") {
      // A forked or sub-agent rollout repeats its parent's header further down;
      // the first header is this file's own identity. `id` is per thread,
      // `session_id` is the root shared by every fork of it.
      if (sawMeta) continue;
      sawMeta = true;
      id = nonEmpty(payload["id"]) ?? nonEmpty(payload["session_id"]);
      startedAt = toEpochMs(payload["timestamp"]) ?? ts;
      // A worker thread (review, spawned task) names its parent in an object
      // `source`; its "user" turn is the delegating prompt, not the person.
      const source = asRecord(payload["source"]);
      if (source !== null && "subagent" in source) {
        return { sessions: [], skipped: [{ index: 0, ...(id !== null ? { id } : {}), reason: "subagent rollout" }], skippedMessages: 0 };
      }
      continue;
    }
    if (type === "event_msg" && (payload["type"] === "user_message" || payload["type"] === "item_completed")) {
      const item = asRecord(payload["item"]);
      // Other completed items (agent messages, commands) repeat the response
      // items or are not text.
      if (payload["type"] === "item_completed" && item?.["type"] !== "UserMessage") continue;
      const text =
        payload["type"] === "user_message"
          ? typeof payload["message"] === "string" ? payload["message"].trim() : ""
          : userItemText(item);
      if (!text) {
        skippedMessages++;
        continue;
      }
      if (isRepeatedUserTurn(messages[messages.length - 1], text)) continue;
      messages.push({ id: "", role: "user", speaker: "User", text, ts });
      continue;
    }
    if (type === "response_item" && payload["type"] === "message") {
      if (payload["role"] !== "assistant") {
        skippedMessages++;
        continue;
      }
      const text = outputText(payload["content"]);
      if (!text) {
        skippedMessages++;
        continue;
      }
      messages.push({ id: nonEmpty(payload["id"]) ?? "", role: "assistant", speaker: "Codex", text, ts });
    }
  }

  if (id === null) {
    return { sessions: [], skipped: [{ index: 0, reason: "no session_meta id" }], skippedMessages };
  }
  if (messages.length === 0) {
    return { sessions: [], skipped: [{ index: 0, id, reason: "no user or assistant text" }], skippedMessages };
  }
  if (!messages.some((m) => m.role === "user")) {
    return { sessions: [], skipped: [{ index: 0, id, reason: USER_TURNS_MISSING }], skippedMessages };
  }
  return {
    sessions: [
      {
        format: "codex",
        id,
        title: titleFromText(messages.find((m) => m.role === "user")?.text),
        startedAt: startedAt ?? messages.find((m) => m.ts !== null)?.ts ?? null,
        messages,
      },
    ],
    skipped: [],
    skippedMessages,
  };
}

export const codexAdapter: TranscriptAdapter = {
  format: "codex",
  detect: (items) => items.some((it) => asRecord(it)?.["type"] === "session_meta" && asRecord(asRecord(it)!["payload"]) !== null),
  parse: parseCodexRollout,
};
