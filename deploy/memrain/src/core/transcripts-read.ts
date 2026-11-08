/**
 * Read-side accessor for recently-ingested conversation transcript pages —
 * backs the `get_recent_transcripts` MCP tool.
 *
 * memrain has no on-disk transcript corpus: transcripts are ingested as pages in
 * RDS Postgres. So this op returns "recent transcript-typed pages",
 * newest-first, scoped to the caller's tenant, with a summary/full-body toggle
 * and a day window — over the DB instead of the filesystem.
 * Deterministic SELECT; no LLM, no Bedrock.
 */
import type { Engine } from "./engine/interface.ts";
import { normalizeScope } from "./source-scope.ts";

/**
 * Page types memrain treats as conversation/transcript prose — a subset of the
 * fact-extraction-eligible types, narrowed to the kinds that actually carry a
 * back-and-forth transcript (a meeting log, an email thread, a journal entry, a
 * captured note, an imported chat export) rather than a synthesized artifact.
 */
export const TRANSCRIPT_PAGE_TYPES: readonly string[] = [
  "conversation",
  "meeting",
  "email",
  "journal",
  "note",
];

const SUMMARY_HEAD_CHARS = 300;
const FULL_BODY_CAP = 100 * 1024;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_DAYS = 30;

export interface RecentTranscript {
  slug: string;
  type: string;
  title: string | null;
  updated_at: string;
  /** Full markdown_body length in chars (regardless of summary mode). */
  length: number;
  /** summary=true → first ~300 chars; summary=false → body capped at 100 KB. */
  content: string;
}

export interface RecentTranscriptOptions {
  /** Only pages updated within the last N days. Default 30. */
  days?: number;
  /** true (default) returns a ~300-char summary; false the capped full body. */
  summary?: boolean;
  /** Max rows. Default 50, hard cap 200. */
  limit?: number;
  /** Effective read-source set; scopes the rows to the caller's tenant(s). */
  sourceIds?: string[];
}


/** First non-empty line, then the leading ~300 chars — cheap + deterministic. */
function summarize(body: string): string {
  const head = body.slice(0, SUMMARY_HEAD_CHARS).trim();
  if (head.length > 0) return head;
  return (body.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "").trim();
}

/**
 * Recent transcript-typed pages, newest-first, within `days`, tenant-scoped and
 * limit-capped. Fail-open to [] on any query error (e.g. a pre-pages brain).
 */
export async function listRecentTranscripts(
  engine: Engine,
  opts: RecentTranscriptOptions = {},
): Promise<RecentTranscript[]> {
  const summary = opts.summary !== false; // default true
  const days =
    typeof opts.days === "number" && opts.days >= 0 ? opts.days : DEFAULT_DAYS;
  const limit =
    typeof opts.limit === "number" && opts.limit >= 1
      ? Math.min(Math.floor(opts.limit), MAX_LIMIT)
      : DEFAULT_LIMIT;
  const cutoffIso = new Date(Date.now() - days * 86_400_000).toISOString();
  const sources = normalizeScope(opts.sourceIds);

  const params: unknown[] = [[...TRANSCRIPT_PAGE_TYPES], cutoffIso];
  let sourceFilter = "";
  if (sources) {
    params.push(sources);
    sourceFilter = ` AND source_id = ANY($${params.length}::text[])`;
  }
  params.push(limit);
  const limitIdx = params.length;

  const r = await engine.query<{
    slug: string;
    type: string;
    title: string | null;
    updated_at: string;
    length: number;
    markdown_body: string;
  }>(
    `SELECT slug, type, title, updated_at::text AS updated_at,
            length(markdown_body) AS length, markdown_body
       FROM pages
      WHERE deleted_at IS NULL
        AND type = ANY($1::text[])
        AND updated_at >= $2::timestamptz${sourceFilter}
      ORDER BY updated_at DESC
      LIMIT $${limitIdx}`,
    params,
  );
  return r.rows.map((row) => ({
    slug: row.slug,
    type: row.type,
    title: row.title,
    updated_at: row.updated_at,
    length: row.length,
    content: summary
      ? summarize(row.markdown_body)
      : row.markdown_body.slice(0, FULL_BODY_CAP),
  }));
}
