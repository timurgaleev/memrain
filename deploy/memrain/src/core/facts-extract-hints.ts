import type { Storage } from "./storage.ts";
import { liveEdgeSql } from "./links.ts";
import { makeSlugResolver } from "./slug-canonicalize.ts";

/** Source-local names already attached to the page, never a whole-brain lookup. */
export async function pageEntityHints(storage: Storage, slug: string, sourceId: string): Promise<string[]> {
  const page = await storage.engine().query<{ compiled_truth: Record<string, unknown> }>(
    "SELECT compiled_truth FROM pages WHERE slug = $1 AND source_id = $2 AND deleted_at IS NULL", [slug, sourceId],
  );
  const truth = page.rows[0]?.compiled_truth ?? {};
  const resolve = makeSlugResolver(storage, slug, { sourceIds: [sourceId] });
  const hints = new Set<string>();
  let considered = 0;
  for (const key of ["participants", "attendees", "people", "who"]) {
    const values = truth[key];
    if (!Array.isArray(values)) continue;
    for (const value of values.slice(0, 40)) {
      if (considered++ >= 40) break;
      if (typeof value !== "string" || !value.trim() || value.length > 256 || /[<>]/.test(value)) continue;
      hints.add((await resolve.resolve(value)).slug);
    }
  }
  if (hints.size < 40) {
    const links = await storage.engine().query<{ target_slug: string }>(
      `SELECT DISTINCT target_slug FROM links WHERE source_slug = $1 AND source_id = $2
         AND ${liveEdgeSql("links")} ORDER BY target_slug LIMIT 40`, [slug, sourceId],
    );
    for (const row of links.rows) {
      hints.add(row.target_slug);
      if (hints.size === 40) break;
    }
  }
  return [...hints];
}
