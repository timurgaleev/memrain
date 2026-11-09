import type { Storage } from "../storage.ts";
import { deletePage } from "../pages.ts";
import { phaseFenceCheck } from "../cycle/phase-context.ts";

export interface AutoEventSnapshot {
  slug: string;
  source_id: string;
  version: number;
  untouched: boolean;
}

const latestVersion = `JOIN LATERAL (
  SELECT version_n, hash_new, written_by, compiled_truth_snapshot FROM page_versions
   WHERE slug = p.slug ORDER BY version_n DESC LIMIT 1
) v ON true`;
const untouched = `v.written_by = 'life-chronicle' AND v.hash_new = p.content_hash
  AND v.compiled_truth_snapshot = p.compiled_truth`;
const automatic = `p.deleted_at IS NULL AND p.type = 'event' AND p.slug LIKE 'life/events/%'
  AND p.compiled_truth->>'captured_via' = 'life-chronicle:auto'`;

export async function readAutoEvents(storage: Storage, origin: string, source: string) {
  const { rows } = await storage.engine().query<AutoEventSnapshot>(
    `SELECT p.slug, p.source_id, v.version_n AS version, (${untouched}) AS untouched
       FROM pages p ${latestVersion}
      WHERE ${automatic} AND p.source_id = $1 AND p.compiled_truth #>> '{event,depth}' = $2
      ORDER BY p.slug LIMIT 1001`, [source, origin],
  );
  return { events: rows.slice(0, 1000), truncated: rows.length > 1000 };
}

export async function retireAutoEvents(storage: Storage, events: AutoEventSnapshot[], keep: ReadonlySet<string>,
  origin: { slug: string; version: number }): Promise<number> {
  let retired = 0;
  for (const event of events) {
    if (!event.untouched || keep.has(event.slug)) continue;
    await phaseFenceCheck();
    const result = await deletePage(storage, event.slug, "life-chronicle:retired", event.source_id,
      { expectedVersion: Number(event.version), expectedOriginVersion: origin });
    if (!result.already_deleted) retired++;
  }
  return retired;
}

/** Each cycle retires at most 100 untouched auto events of deleted source pages. */
export async function retireDeletedSourceEvents(storage: Storage): Promise<number> {
  const { rows } = await storage.engine().query<AutoEventSnapshot & { origin: string; origin_version: number }>(
    `SELECT p.slug, p.source_id, v.version_n AS version, true AS untouched,
            dp.slug AS origin, (SELECT MAX(version_n) FROM page_versions WHERE slug = dp.slug) AS origin_version
       FROM pages p ${latestVersion}
       JOIN pages dp ON dp.slug = p.compiled_truth #>> '{event,depth}' AND dp.source_id = p.source_id
      WHERE ${automatic} AND ${untouched} AND dp.deleted_at IS NOT NULL
      ORDER BY dp.deleted_at, p.slug LIMIT 100`,
  );
  let retired = 0;
  for (const row of rows) retired += await retireAutoEvents(storage, [row], new Set(),
    { slug: row.origin, version: Number(row.origin_version) });
  return retired;
}
