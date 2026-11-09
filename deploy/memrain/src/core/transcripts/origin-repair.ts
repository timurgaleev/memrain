import type { Storage } from "../storage.ts";
import { deadlockSafeTransaction } from "../retry.ts";

export interface AgentSessionOrigin {
  format: string;
  id: string;
}

/** Explicit local log evidence, scoped to one source; preview is the default. */
export async function repairTranscriptOrigin(
  storage: Storage,
  sessions: readonly AgentSessionOrigin[],
  sourceId: string,
  apply: boolean = false,
) {
  return deadlockSafeTransaction(storage.engine(), async tx => {
    const params = [sourceId, JSON.stringify(sessions)];
    const pageMatch = `p.source_id = $1 AND p.deleted_at IS NULL AND p.slug LIKE 'transcripts/%'
      AND EXISTS (SELECT 1 FROM jsonb_to_recordset($2::text::jsonb) AS s(format text, id text)
        WHERE p.compiled_truth->>'format' = s.format AND p.compiled_truth->>'conversation_id' = s.id)`;
    const factMatch = `f.source_id = p.source_id AND COALESCE(f.source_markdown_slug, f.source_slug) = p.slug
      AND (f.attributed_to IS NULL OR f.attributed_to = 'user')`;
    const pages = await tx.query<{ slug: string; facts: number }>(
      `SELECT p.slug, (SELECT COUNT(*)::int FROM entity_facts f WHERE ${factMatch}) AS facts
         FROM pages p WHERE ${pageMatch} ORDER BY p.slug`, params);
    let changed = 0;
    if (apply) {
      // Unique-key collisions roll the whole repair back; never drop a fact to make it fit.
      const result = await tx.query(`UPDATE entity_facts f SET attributed_to = 'other'
        FROM pages p WHERE ${pageMatch} AND ${factMatch} RETURNING f.id`, params);
      changed = result.rows.length;
    }
    return { applied: apply, pages: pages.rows, facts: pages.rows.reduce((n, p) => n + p.facts, 0), changed };
  });
}
