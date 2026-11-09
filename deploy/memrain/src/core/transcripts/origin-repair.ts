import { createHash } from "node:crypto";
import type { Storage } from "../storage.ts";
import { deadlockSafeTransaction } from "../retry.ts";
import { lockPageSlugs } from "../pages.ts";

export interface AgentSessionOrigin {
  format: string;
  id: string;
  evidence_hash?: string;
}

/** Explicit local log evidence, scoped to one source; preview is the default. */
export async function repairTranscriptOrigin(
  storage: Storage,
  sessions: readonly AgentSessionOrigin[],
  sourceId: string,
  apply: boolean = false,
  planHash?: string,
) {
  if (apply && !planHash) throw new Error("origin repair: plan hash is required for apply");
  const evidence = [...new Map(sessions.map(s => [JSON.stringify([s.format, s.id, s.evidence_hash ?? null]),
    { format: s.format, id: s.id, evidence_hash: s.evidence_hash ?? null }])).entries()]
    .sort(([a], [b]) => a.localeCompare(b)).map(([, s]) => s);
  return deadlockSafeTransaction(storage.engine(), async tx => {
    const params = [sourceId, JSON.stringify(evidence)];
    const pageMatch = `p.source_id = $1 AND p.deleted_at IS NULL AND p.slug LIKE 'transcripts/%'
      AND EXISTS (SELECT 1 FROM jsonb_to_recordset($2::text::jsonb) AS s(format text, id text)
        WHERE p.compiled_truth->>'format' = s.format AND p.compiled_truth->>'conversation_id' = s.id)`;
    const factMatch = `f.source_id = p.source_id AND COALESCE(f.source_markdown_slug, f.source_slug) = p.slug
      AND (f.attributed_to IS NULL OR f.attributed_to = 'user')`;
    if (apply) {
      const targets = await tx.query<{ slug: string }>(`SELECT p.slug FROM pages p WHERE ${pageMatch} ORDER BY p.slug`, params);
      await lockPageSlugs(tx, ...targets.rows.map(p => p.slug));
    }
    const pages = await tx.query<{ slug: string; version: number; content_hash: string; truth_hash: string }>(
      `SELECT p.slug, COALESCE((SELECT MAX(v.version_n) FROM page_versions v WHERE v.slug=p.slug),0)::int AS version,
              p.content_hash, md5(p.compiled_truth::text) AS truth_hash
         FROM pages p WHERE ${pageMatch} ORDER BY p.slug ${apply ? "FOR UPDATE OF p" : ""}`, params);
    const facts = await tx.query<{ id: number; slug: string; attributed_to: string | null; row_hash: string }>(
      `SELECT f.id, p.slug, f.attributed_to, md5(to_jsonb(f)::text) AS row_hash
         FROM entity_facts f JOIN pages p ON ${factMatch} WHERE ${pageMatch}
        ORDER BY f.id ${apply ? "FOR UPDATE OF f" : ""}`, params);
    const hash = createHash("sha256").update(JSON.stringify({ source: sourceId, evidence, pages: pages.rows, facts: facts.rows })).digest("hex");
    if (apply && hash !== planHash) throw new Error("origin repair: stale plan hash; preview again");
    let changed = 0;
    if (apply) {
      // Unique-key collisions roll the whole repair back; never drop a fact to make it fit.
      const result = await tx.query(`UPDATE entity_facts f SET attributed_to = 'other'
        WHERE f.id = ANY($1::bigint[]) RETURNING f.id`, [facts.rows.map(f => f.id)]);
      changed = result.rows.length;
    }
    return { applied: apply, plan_hash: hash,
      pages: pages.rows.map(p => ({ slug: p.slug, facts: facts.rows.filter(f => f.slug === p.slug).length })),
      facts: facts.rows.length, changed,
      receipt: apply ? facts.rows.map(f => ({ id: f.id, old_attributed_to: f.attributed_to, new_attributed_to: "other" })) : [] };
  });
}
