import type { Engine } from "./engine/interface.ts";
import type { OpsCheckResult } from "./doctor-ops.ts";
import { legacySlugifyTarget, slugifyTarget } from "./links.ts";

const SCAN_LIMIT = 1000;

/** Bounded formation census; old ASCII-only keys cannot recover discarded letters. */
export async function checkMixedScriptTargets(engine: Engine): Promise<OpsCheckResult & {
  scanned: number; truncated: boolean;
  candidates: Array<{ source_id: string; old_key: string; new_key: string; old_resolves: boolean; new_resolves: boolean; ambiguous: boolean }>;
}> {
  const pages = await engine.query<{ slug: string; title: string; source_id: string }>(
    "SELECT slug,title,source_id FROM pages WHERE deleted_at IS NULL AND title IS NOT NULL ORDER BY slug LIMIT $1", [SCAN_LIMIT + 1]);
  const links = await engine.query<{ target_slug: string; source_id: string }>(
    "SELECT DISTINCT target_slug,source_id FROM links ORDER BY source_id,target_slug LIMIT $1", [SCAN_LIMIT + 1]);
  const candidates = new Map<string, { source_id: string; old_key: string; new_key: string }>();
  const consider = (name: string, source: string, prefix = "") => {
    const oldKey = prefix + legacySlugifyTarget(name);
    const newKey = prefix + slugifyTarget(name);
    if (oldKey !== newKey) candidates.set(`${source}\0${oldKey}\0${newKey}`, { source_id: source, old_key: oldKey, new_key: newKey });
  };
  for (const p of pages.rows.slice(0, SCAN_LIMIT)) consider(p.title, p.source_id,
    p.title.includes("/") ? "" : p.slug.slice(0, p.slug.lastIndexOf("/") + 1));
  for (const l of links.rows.slice(0, SCAN_LIMIT)) consider(l.target_slug, l.source_id);
  const entries = [...candidates.values()];
  const live = await engine.query<{ slug: string; source_id: string }>(
    "SELECT slug,source_id FROM pages WHERE deleted_at IS NULL AND slug=ANY($1::text[])", [entries.flatMap(c => [c.old_key, c.new_key])]);
  const keys = new Set(live.rows.map(p => `${p.source_id}\0${p.slug}`));
  const resolutions = entries.map(c => ({ ...c, old_resolves: keys.has(`${c.source_id}\0${c.old_key}`), new_resolves: keys.has(`${c.source_id}\0${c.new_key}`) }));
  const rows = resolutions.map(c => ({ ...c, ambiguous: (c.old_resolves && c.new_resolves) ||
    resolutions.some(other => other.source_id === c.source_id && other.old_key === c.old_key && other.new_key !== c.new_key) }));
  const truncated = pages.rows.length > SCAN_LIMIT || links.rows.length > SCAN_LIMIT;
  return { ok: true, status: rows.length > 0 || truncated ? "warn" : "ok", scanned: Math.min(pages.rows.length, SCAN_LIMIT) + Math.min(links.rows.length, SCAN_LIMIT),
    truncated, candidates: rows.slice(0, 20),
    detail: `${rows.length} mixed-script formation difference(s) in bounded census; exact live keys checked; ${rows.filter(c => c.ambiguous).length} ambiguous. Stored keys unchanged; discarded letters in old ASCII-only targets cannot be recovered.${truncated ? " Scan truncated." : ""}` };
}
