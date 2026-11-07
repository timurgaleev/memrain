/**
 * Claude Code session log (`~/.claude/projects/<project>/<session>.jsonl`):
 * one file per session, one record per line. Turn records are
 * `{type: "user"|"assistant", message: {role, content}, uuid, sessionId,
 * timestamp, isSidechain?, isMeta?}` with `content` a string or a block list.
 *
 * Only what was said is kept: `text` blocks. Tool calls, tool results (which
 * arrive as `user` records; an AskUserQuestion answer is the exception, it is
 * the person's decision and becomes a user turn), thinking and images are dropped, as are sub-agent
 * traffic (`isSidechain`), harness notes (`isMeta`), the compaction summary,
 * the context the harness injects into a prompt (`<system-reminder>`
 * blocks, slash-command bookkeeping), and whole user records the harness
 * delivered rather than the person typed (see {@link HARNESS_ORIGINS}). One reply is often written as several
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
  EMPTY_SESSION,
  toEpochMs,
  USER_TURNS_MISSING,
  type AdapterResult,
  type TranscriptAdapter,
  type TranscriptMessage,
} from "./types.ts";

const INJECTED_BLOCK_RE =
  /<(system-reminder|local-command-stdout|local-command-stderr|local-command-caveat|command-name|command-message|command-args)>[\s\S]*?<\/\1>/g;
/**
 * `origin.kind` of a user record that is not the person: a background task's
 * notification, another agent's message, an automatic continuation. `human`,
 * `channel` (the person writing through a channel), an unknown kind and a
 * record with no `origin` (older logs) are all kept: dropping someone's words
 * is data loss, keeping a stray notification is not.
 */
const HARNESS_ORIGINS: ReadonlySet<unknown> = new Set(["task-notification", "peer", "auto-continuation"]);
const INTERRUPTED_RE = /^\[Request interrupted by user[^\]]*\]$/;
/** Content block types the adapter understands, text or not. */
const KNOWN_BLOCKS: ReadonlySet<unknown> = new Set([
  "text",
  "tool_use",
  "tool_result",
  "thinking",
  "redacted_thinking",
  "image",
  "document",
  "tool_addition",
  "tool_removal",
]);

/** Content in a shape the adapter does not know: a renamed block type or a non-list, non-string body. */
function isUnreadable(content: unknown): boolean {
  if (typeof content === "string") return false;
  if (!Array.isArray(content)) return true;
  return content.some((b) => !KNOWN_BLOCKS.has(asRecord(b)?.["type"]));
}

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

/**
 * An AskUserQuestion result as one line per answered question,
 * `header → answer`; "" when nothing was answered (a cancelled question).
 */
function answersText(result: Record<string, unknown> | null): string {
  const answers = asRecord(result?.["answers"]);
  if (!answers) return "";
  const questions = Array.isArray(result?.["questions"]) ? result["questions"].map(asRecord) : [];
  return Object.entries(answers)
    .map(([question, answer]) => {
      const text = Array.isArray(answer) ? answer.join(", ") : typeof answer === "string" ? answer : "";
      if (!text.trim()) return "";
      const header = nonEmpty(questions.find((q) => q?.["question"] === question)?.["header"]);
      return `${header ?? question} → ${text.trim()}`;
    })
    .filter((line) => line.length > 0)
    .join("\n");
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
  // A turn record whose content the adapter could not read: with no kept
  // turn, that is a format change, not an empty session.
  let sawUnreadable = false;

  for (const raw of records) {
    const rec = asRecord(raw);
    if (!rec) {
      sawUnreadable = true;
      continue;
    }
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
    const text =
      (message ? contentText(message["content"]) : "") ||
      (type === "user" ? answersText(asRecord(rec["toolUseResult"])) : "");
    if (
      rec["isSidechain"] === true ||
      rec["isMeta"] === true ||
      rec["isCompactSummary"] === true ||
      (type === "user" && HARNESS_ORIGINS.has(asRecord(rec["origin"])?.["kind"]))
    ) {
      skippedMessages++;
      continue;
    }
    if (!text) {
      if (isUnreadable(message?.["content"])) sawUnreadable = true;
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
    return { sessions: [], skipped: [{ index: 0, id, reason: sawUnreadable ? "no user or assistant text" : EMPTY_SESSION }], skippedMessages };
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
