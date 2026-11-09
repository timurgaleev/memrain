import type { Engine } from "./engine/interface.ts";
import { PAGE_MIRROR_PATH_SQL } from "./page-index.ts";
import { MARKDOWN_CHUNKER_VERSION } from "./chunkers/recursive.ts";
import { isQuarantined } from "./quarantine.ts";
import { isEmbedSkipped } from "./embed-skip.ts";

const HINTS = {
  missing: "Check the exact slug and --source; restore or import the page if needed.",
  "soft-deleted": "Inspect the deletion and restore the page if it should be searchable.",
  quarantined: "Inspect `memrain quarantine list` before clearing the quarantine.",
  embed_skip: "Keyword search remains available; inspect the size/content gate before reindexing.",
  mirror_missing: "Inspect page-mirror failures; the page-mirror cycle phase can rebuild the search mirror.",
  mirror_stale: "Inspect the page-mirror cycle phase; it can refresh this search mirror.",
  chunks_without_vector: "Keyword search remains available; inspect the embed-gaps phase and its budget.",
  "page-mirror-failed": "Inspect the latest page-mirror-failed server log before retrying the mirror.",
  ok: "Index state is current; supply a query to inspect retrieval ranks.",
} as const;
type Verdict = keyof typeof HINTS;
interface IndexRow {
  source_id: string;
  deleted_at: string | null;
  title: string | null;
  content_hash: string;
  doc_id: string | null;
  doc_source: string | null;
  doc_deleted: string | null;
  archived: boolean | null;
  frontmatter: Record<string, unknown> | null;
  chunker_version: number | null;
  missing_vectors: number;
  last_failure_at: string | null;
  failure_after_mirror: boolean | null;
}

function state(row: IndexRow): Verdict {
  if (row.deleted_at) return "soft-deleted";
  if (isQuarantined(row.frontmatter)) return "quarantined";
  if (isEmbedSkipped(row.frontmatter)) return "embed_skip";
  if (!row.doc_id) return "mirror_missing";
  if (row.doc_deleted || row.archived || row.doc_source !== row.source_id ||
      row.frontmatter?.page_content_hash !== row.content_hash ||
      (row.frontmatter?.page_title ?? "") !== (row.title ?? "") ||
      (row.chunker_version ?? 0) < MARKDOWN_CHUNKER_VERSION) return "mirror_stale";
  if (row.missing_vectors > 0) return "chunks_without_vector";
  if (row.failure_after_mirror) return "page-mirror-failed";
  return "ok";
}

export async function diagnosePageIndex(engine: Engine, target: string, sourceId?: string) {
  const { rows } = await engine.query<IndexRow>(
    `SELECT p.source_id, p.deleted_at::text, p.title, p.content_hash,
            d.id AS doc_id, d.source_id AS doc_source, d.deleted_at::text AS doc_deleted,
            d.archived, d.frontmatter, d.chunker_version,
            (SELECT count(*)::int FROM chunks c LEFT JOIN embeddings em ON em.chunk_id = c.id
              WHERE c.document_id = d.id AND length(btrim(c.content)) > 0 AND em.chunk_id IS NULL) AS missing_vectors,
            failure.created_at::text AS last_failure_at, failure.created_at > d.updated_at AS failure_after_mirror
       FROM pages p LEFT JOIN documents d ON d.source_path = ${PAGE_MIRROR_PATH_SQL}
       LEFT JOIN LATERAL (SELECT created_at FROM ingest_log
         WHERE source_type = 'page-mirror-failed' AND source_id = p.source_id
           AND (source_ref = p.slug OR pages_updated @> jsonb_build_array(p.slug))
         ORDER BY created_at DESC, id DESC LIMIT 1) failure ON true
      WHERE p.slug = $1 AND ($2::text IS NULL OR p.source_id = $2)
      ORDER BY p.source_id`, [target, sourceId ?? null],
  );
  const sources = rows.map(row => {
    const verdict = state(row);
    return { source_id: row.source_id, verdict, hint: HINTS[verdict],
      chunks_without_vector: row.missing_vectors, last_mirror_failure_at: row.last_failure_at };
  });
  const priority = Object.keys(HINTS);
  const verdict = sources.length ? [...sources].sort((a, b) => priority.indexOf(a.verdict) - priority.indexOf(b.verdict))[0]!.verdict : "missing";
  return { ok: true, target, verdict, hint: HINTS[verdict], sources };
}
