/**
 * Pages the vector arm can never return, each with the state that explains it.
 *
 * A page is visible to vector search once its search mirror holds at least one
 * chunk with a vector. Everything else lands in one of four states:
 *
 *   empty               nothing to embed: the body is blank once the facts and
 *                       takes fences are stripped (they live in their own stores)
 *   skip                deliberately kept out: embed_skip or quarantine marker
 *   failed              the latest mirror attempt failed after the last good one
 *   chunkless_healable  text exists but no vector yet: no mirror, or chunks
 *                       still waiting for the embed fill
 *
 * Read-only and bounded: one page of candidates per call, ordered by slug.
 */
import type { Engine } from "./engine/interface.ts";
import { PAGE_MIRROR_PATH_SQL } from "./page-index.ts";
import { chunkMarkdown } from "./chunkers/recursive.ts";
import { stripFactsFence } from "./facts-fence.ts";
import { stripTakesFence } from "./synthesis/takes-fence.ts";
import { isQuarantined } from "./quarantine.ts";
import { isEmbedSkipped } from "./embed-skip.ts";

export type VectorInvisibleState = "empty" | "chunkless_healable" | "skip" | "failed";

export interface VectorInvisiblePage {
  slug: string;
  source_id: string;
  state: VectorInvisibleState;
  reason: string;
  hint: string;
}

export interface VectorVisibilityReport {
  ok: true;
  source_id: string | null;
  limit: number;
  pages: VectorInvisiblePage[];
  /** `embedded` counts every visible page in scope; the other states count the listed pages. */
  counts: Record<"embedded" | VectorInvisibleState, number>;
  truncated: boolean;
}

export const VECTOR_VISIBILITY_MAX_LIMIT = 1000;

const HINTS: Record<VectorInvisibleState, string> = {
  empty: "Nothing to do: the page has no prose of its own; keyword and fence stores still serve it.",
  skip: "Deliberate: clear the marker only if the page should be searchable by meaning.",
  failed: "Inspect the failure; the page-mirror cycle phase retries it once the cause is fixed.",
  chunkless_healable: "The page-mirror and embed-gaps cycle phases fill this within their normal budget.",
};

interface CandidateRow {
  slug: string;
  source_id: string;
  markdown_body: string;
  doc_id: string | null;
  frontmatter: Record<string, unknown> | null;
  chunks: number;
  failure_summary: string | null;
  failure_at: string | null;
  failure_after_mirror: boolean | null;
}

function classify(row: CandidateRow): { state: VectorInvisibleState; reason: string } {
  if (isQuarantined(row.frontmatter)) return { state: "skip", reason: "quarantined" };
  if (isEmbedSkipped(row.frontmatter)) return { state: "skip", reason: "embed_skip marker on the search mirror" };
  const prose = chunkMarkdown(stripTakesFence(stripFactsFence(row.markdown_body ?? ""))).chunks;
  if (prose.every((c) => c.trim().length === 0)) {
    return { state: "empty", reason: "body holds no prose outside the facts/takes fences" };
  }
  if (row.failure_at && (row.doc_id === null || row.failure_after_mirror)) {
    return { state: "failed", reason: `mirror failed at ${row.failure_at}: ${row.failure_summary ?? "no detail"}` };
  }
  if (row.doc_id === null) return { state: "chunkless_healable", reason: "no search mirror" };
  if (row.chunks === 0) return { state: "chunkless_healable", reason: "search mirror has no chunks" };
  return { state: "chunkless_healable", reason: `${row.chunks} chunk(s) without a vector` };
}

export async function vectorInvisiblePages(
  engine: Engine,
  opts: { sourceId?: string; limit: number },
): Promise<VectorVisibilityReport> {
  const limit = Math.min(Math.max(1, Math.trunc(opts.limit)), VECTOR_VISIBILITY_MAX_LIMIT);
  const source = opts.sourceId ?? null;
  const { rows } = await engine.query<CandidateRow>(
    `SELECT p.slug, p.source_id, p.markdown_body, d.id AS doc_id, d.frontmatter,
            COALESCE(ch.chunks, 0)::int AS chunks,
            failure.summary AS failure_summary, failure.created_at::text AS failure_at,
            failure.created_at > d.updated_at AS failure_after_mirror
       FROM pages p
       LEFT JOIN documents d ON d.source_path = ${PAGE_MIRROR_PATH_SQL}
             AND d.deleted_at IS NULL AND d.source_id = p.source_id
       LEFT JOIN LATERAL (
         SELECT count(*) AS chunks, count(em.chunk_id) AS vectors
           FROM chunks c LEFT JOIN embeddings em ON em.chunk_id = c.id
          WHERE c.document_id = d.id) ch ON true
       LEFT JOIN LATERAL (
         SELECT created_at, summary FROM ingest_log
          WHERE source_type = 'page-mirror-failed' AND source_id = p.source_id
            AND (source_ref = p.slug OR pages_updated @> jsonb_build_array(p.slug))
          ORDER BY created_at DESC, id DESC LIMIT 1) failure ON true
      WHERE p.deleted_at IS NULL AND ($1::text IS NULL OR p.source_id = $1)
        AND COALESCE(ch.vectors, 0) = 0
      ORDER BY p.slug, p.source_id
      LIMIT $2`,
    [source, limit + 1],
  );
  const embedded = await engine.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM pages p
       JOIN documents d ON d.source_path = ${PAGE_MIRROR_PATH_SQL}
            AND d.deleted_at IS NULL AND d.source_id = p.source_id
      WHERE p.deleted_at IS NULL AND ($1::text IS NULL OR p.source_id = $1)
        AND EXISTS (SELECT 1 FROM chunks c JOIN embeddings em ON em.chunk_id = c.id
                     WHERE c.document_id = d.id)`,
    [source],
  );
  const counts: VectorVisibilityReport["counts"] = {
    embedded: Number(embedded.rows[0]?.n ?? 0), empty: 0, chunkless_healable: 0, skip: 0, failed: 0,
  };
  const pages = rows.slice(0, limit).map((row) => {
    const { state, reason } = classify(row);
    counts[state]++;
    return { slug: row.slug, source_id: row.source_id, state, reason, hint: HINTS[state] };
  });
  return { ok: true, source_id: source, limit, pages, counts, truncated: rows.length > limit };
}
