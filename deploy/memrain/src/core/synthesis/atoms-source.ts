import { createHash } from "node:crypto";
import type { Engine } from "../engine/interface.ts";
import { OperationError } from "../operation-error.ts";
import { quarantineFilterFragment } from "../quarantine.ts";
import { compiledTruthHash, serializeCompiledTruth } from "../page-index.ts";

export interface AtomSourceExpectation {
  id: string;
  sourceId: string | null;
  contentHash: string;
}

export interface AtomPageExpectation {
  sourceRef: string;
  sourceHash: string;
  atomKey: string;
  contentHash: string;
}

/** A source lock must never wait for a slug: rename already locks slug → document. */
export async function tryLockAtomSlugs(tx: Engine, ...slugs: string[]): Promise<boolean> {
  for (const slug of [...new Set(slugs)].sort()) {
    const { rows } = await tx.query<{ held: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtext($1)) AS held", [`memrain:page:${slug}`],
    );
    if (!rows[0]?.held) return false;
  }
  return true;
}

function sourceChanged(): never {
  throw new OperationError("conflict", "Atom source changed or is no longer eligible.", "Extract the current source again.");
}

export async function lockAtomSource(tx: Engine, expected: AtomSourceExpectation): Promise<Record<string, unknown>> {
  const { rows } = await tx.query<{ source_id: string | null; source_path: string; frontmatter: Record<string, unknown> | null }>(
    `SELECT d.source_id, d.source_path, d.frontmatter FROM documents d
      WHERE d.id = $1 AND d.deleted_at IS NULL AND ${quarantineFilterFragment("d")} FOR UPDATE`, [expected.id],
  );
  const doc = rows[0];
  if (!doc || doc.source_id !== expected.sourceId) sourceChanged();
  const chunks = await tx.query<{ text: string | null }>(
    "SELECT string_agg(content, E'\\n\\n' ORDER BY chunk_index) AS text FROM chunks WHERE document_id = $1", [expected.id],
  );
  const hash = createHash("sha256").update(chunks.rows[0]?.text ?? "").digest("hex").slice(0, 16);
  if (hash !== expected.contentHash) sourceChanged();
  if (doc.source_path.startsWith("page://") || doc.source_path.startsWith("page-truth://")) {
    await lockSourcePage(tx, doc);
  }
  return doc.frontmatter ?? {};
}

async function lockSourcePage(tx: Engine, doc: {
  source_id: string | null; source_path: string; frontmatter: Record<string, unknown> | null;
}): Promise<void> {
  if (doc.source_id === null) sourceChanged();
  const truth = doc.source_path.startsWith("page-truth://");
  const prefix = `${truth ? "page-truth" : "page"}://${doc.source_id === "default" ? "" : `${doc.source_id}/`}`;
  if (!doc.source_path.startsWith(prefix)) sourceChanged();
  const slug = doc.source_path.slice(prefix.length);
  if (!await tryLockAtomSlugs(tx, slug)) throw new OperationError("db_busy", "Atom source page is being edited.");
  const { rows } = await tx.query<{ title: string | null; compiled_truth: unknown; content_hash: string }>(
    "SELECT title, compiled_truth, content_hash FROM pages WHERE slug = $1 AND source_id = $2 AND deleted_at IS NULL",
    [slug, doc.source_id],
  );
  const page = rows[0];
  if (!page) sourceChanged();
  if (truth) {
    if (doc.frontmatter?.page_truth_hash !== compiledTruthHash(serializeCompiledTruth(page.title, slug, page.compiled_truth))) sourceChanged();
  } else if (doc.frontmatter?.page_content_hash !== page.content_hash || doc.frontmatter?.page_title !== (page.title ?? "")) {
    sourceChanged();
  }
}

/** Called under the slug lock, including the latest complete automatic snapshots. */
export async function atomPageMatches(tx: Engine, slug: string, expected: AtomPageExpectation, sourceId: string): Promise<boolean> {
  const { rows } = await tx.query(
    `SELECT 1 FROM pages p JOIN LATERAL (
       SELECT written_by, written_by_principal, hash_new, body_snapshot, compiled_truth_snapshot FROM page_versions
        WHERE slug = p.slug ORDER BY version_n DESC LIMIT 1
     ) v ON true
      WHERE p.slug = $1 AND p.source_id = $2 AND p.deleted_at IS NULL AND p.type = 'atom'
        AND p.content_hash = $3 AND v.written_by = 'extract-atoms' AND v.hash_new = p.content_hash
        AND v.written_by_principal = 'operator'
        AND v.body_snapshot = p.markdown_body AND v.compiled_truth_snapshot = p.compiled_truth
        AND p.compiled_truth #>> '{atom_origin,source_ref}' = $4
        AND p.compiled_truth #>> '{atom_origin,source_hash}' = $5
        AND p.compiled_truth #>> '{atom_origin,source_id}' = $2
        AND p.compiled_truth #>> '{atom_origin,atom_key}' = $6`,
    [slug, sourceId, expected.contentHash, expected.sourceRef, expected.sourceHash, expected.atomKey],
  );
  return rows.length === 1;
}
