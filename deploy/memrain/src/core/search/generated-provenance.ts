import { createHash } from "node:crypto";
import type { Engine } from "../engine/interface.ts";
import { andSourceScope } from "../source-scope.ts";
import { visibilityClause } from "../visibility.ts";
import { pageText, serializeCompiledTruth, PAGE_MIRROR_PATH_SQL, PAGE_TRUTH_PATH_SQL } from "../page-index.ts";
import { chunkMarkdown } from "../chunkers/recursive.ts";
import { stripFactsFence } from "../facts-fence.ts";
import { stripTakesFence } from "../synthesis/takes-fence.ts";

const GENERATORS = ["extract-atoms", "synthesize-concepts", "patterns", "reflection", "think", "auto-think", "life-chronicle"];

export async function markGeneratedChunks<T extends { chunkId: string }>(engine: Engine, hits: readonly T[], sourceIds?: readonly string[]): Promise<Array<T & { generated?: true }>> {
  if (!hits.length) return [];
  const params: unknown[] = [hits.map(hit => hit.chunkId), GENERATORS];
  const scope = andSourceScope("d.source_id", sourceIds, params);
  const { rows } = await engine.query<{
    id: string; content: string; source_path: string; slug: string; title: string | null;
    markdown_body: string; compiled_truth: Record<string, unknown>; content_hash: string;
  }>(`SELECT c.id,c.content,d.source_path,p.slug,p.title,p.markdown_body,p.compiled_truth,p.content_hash
    FROM chunks c JOIN documents d ON d.id=c.document_id
    JOIN pages p ON p.source_id=d.source_id AND p.deleted_at IS NULL
      AND d.source_path IN (${PAGE_MIRROR_PATH_SQL},${PAGE_TRUTH_PATH_SQL})
    JOIN LATERAL (SELECT * FROM page_versions pv WHERE pv.slug=p.slug AND pv.source_id=p.source_id
      ORDER BY pv.version_n DESC LIMIT 1) v ON TRUE
    WHERE c.id=ANY($1::text[]) AND ${visibilityClause("d")}${scope}
      AND v.written_by=ANY($2::text[]) AND v.written_by_principal='operator'
      AND v.hash_new=p.content_hash AND v.body_snapshot=p.markdown_body
      AND v.compiled_truth_snapshot IS NOT DISTINCT FROM p.compiled_truth`, params);
  const generated = new Set<string>();
  const expected = new Map<string, Set<string>>();
  for (const row of rows) {
    if (createHash("sha256").update(row.markdown_body).digest("hex") !== row.content_hash) continue;
    let chunks = expected.get(row.source_path);
    if (!chunks) {
      const text = row.source_path.startsWith("page-truth://")
        ? serializeCompiledTruth(row.title, row.slug, row.compiled_truth) : pageText(row.title, row.markdown_body);
      chunks = new Set(chunkMarkdown(stripTakesFence(stripFactsFence(text))).chunks);
      expected.set(row.source_path, chunks);
    }
    if (chunks.has(row.content)) generated.add(row.id);
  }
  return hits.map(hit => generated.has(hit.chunkId) ? { ...hit, generated: true } : hit);
}
