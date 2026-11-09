import type { Engine } from "./engine/interface.ts";
import { andSourceScope } from "./source-scope.ts";
import { eligibleFactSql, readLimit } from "./bounded-read.ts";
import { claimsDiverge } from "./fact-divergence.ts";

interface CandidateFact { id: number; source_id: string; entity_slug: string; attributed_to: string | null; fact: string; missing: boolean }
type Candidate = { kind: "missing_entity_page"; source_id: string; entity_slug: string; fact_id: number }
  | { kind: "similar_facts"; source_id: string; entity_slug: string; fact_ids: number[]; similarity: number };

export async function extractionReview(engine: Engine, opts: { limit?: number; sourceIds?: string[] } = {}) {
  const limit = readLimit(opts.limit);
  const params: unknown[] = [];
  const scope = andSourceScope("f.source_id", opts.sourceIds, params);
  const { rows } = await engine.query<CandidateFact>(`SELECT f.id, f.source_id, f.entity_slug, f.attributed_to, f.fact,
      NOT EXISTS (SELECT 1 FROM pages p WHERE p.slug = f.entity_slug AND p.source_id = f.source_id AND p.deleted_at IS NULL) AS missing
    FROM entity_facts f WHERE ${eligibleFactSql("f", true)} AND length(f.fact) <= 4096${scope}
    ORDER BY f.written_at DESC, f.id DESC LIMIT 201`, params);
  const pool = rows.slice(0, 200).map(row => ({ ...row, id: Number(row.id) }));
  const candidates: Candidate[] = [];
  const missing = new Set<string>();
  for (const row of pool) {
    const key = JSON.stringify([row.source_id, row.entity_slug]);
    if (row.missing && !missing.has(key)) {
      missing.add(key);
      candidates.push({ kind: "missing_entity_page", source_id: row.source_id, entity_slug: row.entity_slug, fact_id: row.id });
    }
  }
  const words = pool.map(row => new Set(row.fact.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []));
  for (let i = 0; i < pool.length && candidates.length <= limit; i++) {
    for (let j = i + 1; j < pool.length && candidates.length <= limit; j++) {
      const a = pool[i]!; const b = pool[j]!;
      if (a.source_id !== b.source_id || a.entity_slug !== b.entity_slug || a.attributed_to !== b.attributed_to || claimsDiverge(a.fact, b.fact)) continue;
      const intersection = [...words[i]!].filter(word => words[j]!.has(word)).length;
      const union = words[i]!.size + words[j]!.size - intersection;
      const score = union ? intersection / union : 0;
      if (score >= 0.85) candidates.push({ kind: "similar_facts", source_id: a.source_id, entity_slug: a.entity_slug,
        fact_ids: [a.id, b.id], similarity: Math.round(score * 1000) / 1000 });
    }
  }
  return { candidates: candidates.slice(0, limit), truncated: candidates.length > limit, scanned: pool.length, scan_truncated: rows.length > 200 };
}
