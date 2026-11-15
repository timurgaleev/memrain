/**
 * The live eval set: queries the operator labelled on the admin labelling
 * screen (eval_queries rows with every relevant document), as qrels.
 *
 * Only `good` rows with at least one relevant document count, and only the
 * dev split unless asked: sealed rows are scored once per pre-registration by
 * the sealed A/B run (`eval qrels build`, then `eval --split sealed`), never by
 * a tuning loop. Document ids are
 * mapped to their current source path; a label whose documents are all gone
 * is skipped rather than scored as a miss.
 */
import type { Engine } from "../core/engine/interface.ts";
import type { BenchQrel, BenchQrels } from "./bench/harness.ts";

interface LiveRow {
  id: string;
  query: string;
  expected_doc_id: string | null;
  expected_doc_ids: unknown;
  tags: string[] | null;
  lang: string | null;
}

export async function loadLiveQrels(engine: Engine, opts: { split?: "dev" | "sealed" } = {}): Promise<BenchQrels> {
  const split = opts.split ?? "dev";
  const { rows } = await engine.query<LiveRow>(
    `SELECT id, query, expected_doc_id, expected_doc_ids, tags, lang
       FROM eval_queries
      WHERE tag = 'good'
        AND ${split === "dev" ? "(split IS NULL OR split = 'dev')" : "split = 'sealed'"}
      ORDER BY id`,
  );
  const ids = new Set<string>();
  const docsOf = (r: LiveRow): string[] => {
    const list = Array.isArray(r.expected_doc_ids) ? r.expected_doc_ids.filter((x): x is string => typeof x === "string") : [];
    return list.length > 0 ? list : r.expected_doc_id ? [r.expected_doc_id] : [];
  };
  for (const r of rows) for (const d of docsOf(r)) ids.add(d);
  const paths = new Map<string, string>();
  if (ids.size > 0) {
    const docs = await engine.query<{ id: string; source_path: string }>(
      `SELECT id, source_path FROM documents WHERE id = ANY($1::text[]) AND deleted_at IS NULL`,
      [[...ids]],
    );
    for (const d of docs.rows) paths.set(d.id, d.source_path);
  }
  const queries: BenchQrel[] = [];
  for (const r of rows) {
    const expected = docsOf(r).map((d) => paths.get(d)).filter((p): p is string => p !== undefined);
    if (expected.length === 0) continue;
    queries.push({
      id: `live:${r.id}`,
      query: r.query,
      expected_paths: [...new Set(expected)],
      tags: r.tags && r.tags.length > 0 ? r.tags : ["live"],
      lang: r.lang ?? "en",
      split,
    });
  }
  return { queries };
}
