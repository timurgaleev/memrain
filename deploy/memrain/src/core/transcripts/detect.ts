/**
 * Format detection and the size cap for transcript exports.
 *
 * Adapters are tried in a fixed order and the first whose shape probe matches
 * wins; `--format` skips detection entirely. An export that had content but
 * yields no sessions is reported as format drift, so a vendor changing its
 * export shape surfaces as a failure rather than a quiet import of nothing.
 */
import { chatGptAdapter } from "./chatgpt.ts";
import { claudeAiAdapter } from "./claude-ai.ts";
import { claudeCodeAdapter } from "./claude-code.ts";
import { codexAdapter } from "./codex.ts";
import { parseJsonlRecords } from "./jsonl.ts";
import { isPasteOnly } from "./pasted-content.ts";
import {
  asRecord,
  USER_TURNS_MISSING,
  type TranscriptAdapter,
  type TranscriptDiagnostics,
  type TranscriptFormat,
  type TranscriptSession,
} from "./types.ts";

export const TRANSCRIPT_ADAPTERS: readonly TranscriptAdapter[] = [
  chatGptAdapter,
  claudeAiAdapter,
  codexAdapter,
  claudeCodeAdapter,
];

export const DEFAULT_TRANSCRIPT_MAX_FILE_BYTES = 100 * 1024 * 1024;

/** Items probed for detection — enough to see past a leading odd entry. */
const DETECT_PROBE = 20;

export function transcriptMaxFileBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.MEMRAIN_TRANSCRIPT_MAX_FILE_BYTES ?? "").trim();
  const n = Number(raw);
  return raw !== "" && Number.isInteger(n) && n > 0 ? n : DEFAULT_TRANSCRIPT_MAX_FILE_BYTES;
}

/** Refuse, never truncate: a half-read export would import half the sessions
 *  and look complete. Returns the refusal message, or null when it fits. */
export function checkTranscriptFileSize(bytes: number, max: number = transcriptMaxFileBytes()): string | null {
  return bytes > max
    ? `export is ${bytes} bytes, over the ${max}-byte cap (MEMRAIN_TRANSCRIPT_MAX_FILE_BYTES); nothing was imported`
    : null;
}

/** The conversation list: the root array, or an array under a known key. */
export function conversationItems(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data;
  const rec = asRecord(data);
  if (!rec) return null;
  for (const k of ["conversations", "chats"]) {
    if (Array.isArray(rec[k])) return rec[k];
  }
  return null;
}

export function detectFormat(items: readonly unknown[], probeSize: number = DETECT_PROBE): TranscriptFormat | null {
  const probe = items.slice(0, probeSize);
  return TRANSCRIPT_ADAPTERS.find((a) => a.detect(probe))?.format ?? null;
}

function isEmptyValue(data: unknown): boolean {
  if (data === null || data === undefined) return true;
  if (Array.isArray(data)) return data.length === 0;
  const rec = asRecord(data);
  return rec !== null && Object.keys(rec).length === 0;
}

/** Turns the person typed across `sessions`; a paste-only turn is not one. */
export function countUserTurns(sessions: readonly TranscriptSession[]): number {
  let n = 0;
  for (const s of sessions) {
    for (const m of s.messages) if (m.role === "user" && !isPasteOnly(m.text)) n++;
  }
  return n;
}

export interface ParsedExport {
  sessions: TranscriptSession[];
  diagnostics: TranscriptDiagnostics;
}

export function parseTranscriptExport(
  data: unknown,
  bytes: number,
  override?: TranscriptFormat,
  probeSize: number = DETECT_PROBE,
): ParsedExport {
  const found = conversationItems(data);
  const items = found ?? [];
  const format = override ?? detectFormat(items, probeSize);
  const adapter = TRANSCRIPT_ADAPTERS.find((a) => a.format === format);
  const result = adapter ? adapter.parse(items) : { sessions: [], skipped: [], skippedMessages: 0 };
  const userTurnsMissing = result.skipped.filter((s) => s.reason === USER_TURNS_MISSING).length;
  return {
    sessions: result.sessions,
    diagnostics: {
      format: adapter ? adapter.format : null,
      detected_by: override ? "override" : adapter ? "detection" : "none",
      bytes,
      items: items.length,
      sessions: result.sessions.length,
      skipped: result.skipped,
      skippedMessages: result.skippedMessages,
      // An export with no conversations at all is empty, not drifted; content
      // that no adapter could read is, and so is a session with no user turn.
      format_drift:
        userTurnsMissing > 0 ||
        (result.sessions.length === 0 && bytes > 0 && (items.length > 0 || (found === null && !isEmptyValue(data)))),
      user_turns: countUserTurns(result.sessions),
      user_turns_missing: userTurnsMissing,
    },
  };
}

/**
 * One session log (Codex rollout, Claude Code session): a JSON record per
 * line. Detection reads every record, since a Claude Code log can open with
 * any number of bookkeeping lines before its first turn. A file of nothing
 * but broken lines is drift, not an empty log.
 */
export function parseTranscriptJsonl(raw: string, bytes: number, override?: TranscriptFormat): ParsedExport {
  const { records, malformed } = parseJsonlRecords(raw);
  const parsed = parseTranscriptExport(records, bytes, override, records.length);
  return {
    sessions: parsed.sessions,
    diagnostics: {
      ...parsed.diagnostics,
      format_drift: parsed.diagnostics.format_drift || (parsed.sessions.length === 0 && malformed > 0),
      malformed_lines: malformed,
    },
  };
}
