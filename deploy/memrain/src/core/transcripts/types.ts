/**
 * The transcript adapter seam. An adapter turns one vendor export into
 * sessions of plain messages; everything after that (secret redaction,
 * rendering, splitting, idempotent writes) is shared and format-blind.
 */

export const TRANSCRIPT_FORMATS = ["chatgpt", "claude-ai", "codex", "claude-code"] as const;
export type TranscriptFormat = (typeof TRANSCRIPT_FORMATS)[number];

/** Session logs written one JSON record per line, one file per session. */
export const JSONL_TRANSCRIPT_FORMATS: ReadonlySet<TranscriptFormat> = new Set(["codex", "claude-code"]);

export function isTranscriptFormat(v: string): v is TranscriptFormat {
  return (TRANSCRIPT_FORMATS as readonly string[]).includes(v);
}

export interface TranscriptMessage {
  /** The vendor's own message id — provenance, never invented. */
  id: string;
  role: "user" | "assistant";
  /** Display name rendered in the turn header. */
  speaker: string;
  text: string;
  /** Epoch ms from the source, or null when the export carries none. */
  ts: number | null;
}

export interface TranscriptSession {
  format: TranscriptFormat;
  /** The vendor's conversation id. */
  id: string;
  title: string | null;
  /** Epoch ms of the conversation start from the source, or null. */
  startedAt: number | null;
  messages: TranscriptMessage[];
}

/**
 * Skip reason for a session log that carried assistant turns but not one user
 * turn: the shape a vendor renaming its user-turn record leaves behind. It is
 * drift, never a quiet import of half a conversation.
 */
export const USER_TURNS_MISSING = "user_turns_missing";

export interface SkippedSession {
  index: number;
  id?: string;
  reason: string;
}

export interface AdapterResult {
  sessions: TranscriptSession[];
  skipped: SkippedSession[];
  /** Messages dropped inside kept sessions (system, tool, hidden, empty). */
  skippedMessages: number;
}

export interface TranscriptAdapter {
  format: TranscriptFormat;
  /** Cheap shape probe over the export's conversation items. */
  detect(items: readonly unknown[]): boolean;
  parse(items: readonly unknown[]): AdapterResult;
}

export interface TranscriptDiagnostics {
  format: TranscriptFormat | null;
  /** How the format was chosen. */
  detected_by: "override" | "detection" | "none";
  bytes: number;
  /** Conversation items found in the export container. */
  items: number;
  sessions: number;
  skipped: SkippedSession[];
  skippedMessages: number;
  /** Bytes were read but nothing usable came out: the export shape moved. */
  format_drift: boolean;
  /** Turns the person typed, a turn that is only pasted content left out. */
  user_turns: number;
  /** Sessions skipped as {@link USER_TURNS_MISSING}; any is drift. */
  user_turns_missing: number;
  /** JSONL input only: lines that were not valid JSON. */
  malformed_lines?: number;
  /** Directory input only: session files read. */
  files?: number;
}

export function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** Epoch seconds, epoch ms, or an ISO string → epoch ms; anything else null. */
export function toEpochMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    return v > 1e11 ? Math.round(v) : Math.round(v * 1000);
  }
  if (typeof v === "string" && v.trim()) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}
