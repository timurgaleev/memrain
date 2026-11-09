import type { Engine } from "./engine/interface.ts";
import { andSourceScope } from "./source-scope.ts";
import { readLimit } from "./bounded-read.ts";

export async function listQuarantined(engine: Engine, opts: { limit?: number; sourceIds?: string[] } = {}) {
  const limit = readLimit(opts.limit);
  const params: unknown[] = [limit + 1];
  const scope = andSourceScope("d.source_id", opts.sourceIds, params);
  const { rows } = await engine.query<{ id: string; source_id: string | null; source_path: string; reason: string }>(
    `SELECT d.id, d.source_id, d.source_path,
      CASE WHEN d.frontmatter->'quarantine'->>'reason' IN ('junk_pattern', 'literal_substring')
        THEN d.frontmatter->'quarantine'->>'reason' ELSE 'unknown' END AS reason
      FROM documents d WHERE d.deleted_at IS NULL AND COALESCE(d.frontmatter, '{}'::jsonb) ? 'quarantine'${scope}
      ORDER BY d.source_id COLLATE "C" NULLS LAST, d.source_path COLLATE "C", d.id COLLATE "C" LIMIT $1`, params);
  return { items: rows.slice(0, limit), truncated: rows.length > limit };
}
