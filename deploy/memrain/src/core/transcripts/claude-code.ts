/**
 * Claude Code session log (`~/.claude/projects/<project>/<session>.jsonl`):
 * one file per session, one record per line. Turn records are
 * `{type: "user"|"assistant", message: {role, content}, uuid, sessionId,
 * timestamp, isSidechain?, isMeta?}` with `content` a string or a block list.
 *
 * Only what was said is kept: `text` blocks. Tool calls, tool results (which
 * arrive as `user` records), thinking and images are dropped, as are sub-agent
 * traffic (`isSidechain`), harness notes (`isMeta`), the compaction summary,
 * and the context the harness injects into a prompt (`<system-reminder>`
 * blocks, slash-command bookkeeping). One reply is often written as several
 * records sharing an API message id; those are joined back into one turn.
 *
 * A turn that is only pasted content (`<pasted_content>` blocks) is kept as
 * written, but it is not something the person said: it never names the
 * session.
 */
import { titleFromText } from "./jsonl.ts";
import { isPasteOnly } from "./pasted-content.ts";
import {
  asRecord,
  toEpochMs,
  USER_TURNS_MISSING,
  type AdapterResult,
  type TranscriptAdapter,
  type TranscriptMessage,
} from "./types.ts";

const INJECTED_BLOCK_RE =
  /<(system-reminder|local-command-stdout|local-command-stderr|local-command-caveat|command-name|command-message|command-args)>[\s\S]*?<\/\1>/g;
const INTERRUPTED_RE = /^\[Request interrupted by user[^\]]*\]$/;

export function cleanClaudeCodeText(text: string): string {
  const t = text.replace(INJECTED_BLOCK_RE, "").trim();
  return INTERRUPTED_RE.test(t) ? "" : t;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return cleanClaudeCodeText(content);
  if (!Array.isArray(content)) return "";
  return content
    .map(asRecord)
    .filter((b): b is Record<string, unknown> => b !== null && b["type"] === "text" && typeof b["text"] === "string")
    .map((b) => cleanClaudeCodeText(b["text"] as string))
    .filter((t) => t.length > 0)
    .join("\n\n");
}

function nonEmpty(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function parseClaudeCodeSession(records: readonly unknown[]): AdapterResult {
  let id: string | null = null;
  const messages: TranscriptMessage[] = [];
  let lastApiId: string | null = null;
  let skippedMessages = 0;
  const uuids = new Set<string>();
  const summaries: Array<{ leaf: string; text: string }> = [];
  // Any `user` record at all, kept or not: tool results and slash-command
  // bookkeeping arrive as user records, so a log with those and no kept user
  // turn is understood. One with none is the shape a renamed record leaves.
  let sawUserRecord = false;

  for (const raw of records) {
    const rec = asRecord(raw);
    if (!rec) continue;
    id ??= nonEmpty(rec["sessionId"]);
    const uuid = nonEmpty(rec["uuid"]);
    if (uuid) uuids.add(uuid);
    const type = rec["type"];
    if (type === "summary") {
      const leaf = nonEmpty(rec["leafUuid"]);
      const text = nonEmpty(rec["summary"]);
      if (leaf && text) summaries.push({ leaf, text });
      continue;
    }
    if (type !== "user" && type !== "assistant") continue;
    if (type === "user") sawUserRecord = true;
    const message = asRecord(rec["message"]);
    const text = message ? contentText(message["content"]) : "";
    if (rec["isSidechain"] === true || rec["isMeta"] === true || rec["isCompactSummary"] === true || !text) {
      skippedMessages++;
      continue;
    }
    const apiId = type === "assistant" ? nonEmpty(message?.["id"]) : null;
    const prev = messages[messages.length - 1];
    if (prev && prev.role === "assistant" && type === "assistant" && apiId !== null && apiId === lastApiId) {
      messages[messages.length - 1] = { ...prev, text: `${prev.text}\n\n${text}` };
      continue;
    }
    lastApiId = apiId;
    messages.push({
      id: uuid ?? "",
      role: type,
      speaker: type === "user" ? "User" : "Claude",
      text,
      ts: toEpochMs(rec["timestamp"]),
    });
  }

  if (id === null) {
    return { sessions: [], skipped: [{ index: 0, reason: "no sessionId" }], skippedMessages };
  }
  if (messages.length === 0) {
    return { sessions: [], skipped: [{ index: 0, id, reason: "no user or assistant text" }], skippedMessages };
  }
  if (!sawUserRecord) {
    return { sessions: [], skipped: [{ index: 0, id, reason: USER_TURNS_MISSING }], skippedMessages };
  }
  // A resumed session file also carries summaries of the sessions it resumed;
  // only one that points into this file describes it.
  const own = summaries.filter((s) => uuids.has(s.leaf)).at(-1);
  return {
    sessions: [
      {
        format: "claude-code",
        id,
        title: own?.text ?? titleFromText(messages.find((m) => m.role === "user" && !isPasteOnly(m.text))?.text),
        startedAt: messages.find((m) => m.ts !== null)?.ts ?? null,
        messages,
      },
    ],
    skipped: [],
    skippedMessages,
  };
}

export const claudeCodeAdapter: TranscriptAdapter = {
  format: "claude-code",
  detect: (items) =>
    items.some((it) => {
      const r = asRecord(it);
      return (
        r !== null &&
        (r["type"] === "user" || r["type"] === "assistant") &&
        typeof r["sessionId"] === "string" &&
        asRecord(r["message"]) !== null
      );
    }),
  parse: parseClaudeCodeSession,
};
