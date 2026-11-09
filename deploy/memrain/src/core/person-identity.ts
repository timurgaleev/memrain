import type { Engine } from "./engine/interface.ts";
import type { PageRow } from "./pages.ts";
import type { OpsCheckResult } from "./doctor-ops.ts";
import { extractAliasNorms, normalizeAlias } from "./page-aliases.ts";
import { nameVariantMatch, personNameBucketKeys, readPersonNames, type PersonName } from "./name-variants.ts";
import { stripCodeBlocks } from "./links.ts";

export interface EntityIdentity {
  aliases: string[];
  redirected_from: string[];
  possible_duplicates: { slug: string; title: string }[];
  truncated: boolean;
}

const sameName = (a: string, b: string) => nameVariantMatch(a, b) === "strong" || nameVariantMatch(b, a) === "strong";

export async function readEntityIdentity(engine: Engine, page: PageRow): Promise<EntityIdentity> {
  const source = page.source_id ?? "default";
  const redirects = await engine.query<{ alias_slug: string }>(
    `SELECT alias_slug FROM slug_aliases WHERE canonical_slug = $1 AND source_id = $2
      ORDER BY alias_slug COLLATE "C" LIMIT 101`, [page.slug, source],
  );
  const names = page.type.trim().toLowerCase() === "person" && page.title
    ? await readPersonNames(engine, [source]) : { people: [], truncated: false };
  const duplicates = names.people.filter(p => p.slug !== page.slug && sameName(page.title!, p.title));
  return { aliases: extractAliasNorms(page.compiled_truth), redirected_from: redirects.rows.slice(0, 100).map(r => r.alias_slug),
    possible_duplicates: duplicates.slice(0, 10).map(p => ({ slug: p.slug, title: p.title })),
    truncated: names.truncated || redirects.rows.length > 100 || duplicates.length > 10 };
}

export async function checkPersonNameDuplicates(engine: Engine): Promise<OpsCheckResult> {
  const { people, truncated } = await readPersonNames(engine);
  const pairs: string[] = [];
  let comparisons = 0;
  const buckets = new Map<string, PersonName[]>();
  const seen = new Set<string>();
  // A diagnostic never spends unbounded time on a common-surname corpus.
  scan: for (const person of people) {
    for (const key of personNameBucketKeys(person.title)) {
      const scopedKey = `${person.source_id}\0${key}`;
      const prior = buckets.get(scopedKey) ?? [];
      for (const other of prior) {
        const pair = `${other.slug}\0${person.slug}`;
        if (seen.has(pair)) continue;
        seen.add(pair);
        if (++comparisons > 20000 || pairs.length >= 20) break scan;
        if (sameName(other.title, person.title)) pairs.push(`${person.source_id}:${other.slug} ~ ${person.slug}`);
      }
      buckets.set(scopedKey, [...prior, person]);
    }
  }
  const partial = truncated || comparisons > 20000 || pairs.length >= 20;
  return { ok: true, status: pairs.length || partial ? "warn" : "ok", detail:
    `${pairs.length} possible duplicate person pair(s)${partial ? ' (scan truncated)' : ''}: ${pairs.join('; ') || 'none'}; review identities before merging; no changes made` };
}

export async function suggestAliases(engine: Engine, opts: { sourceIds?: string[]; limit?: number } = {}) {
  const limit = opts.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("aliases suggest: --limit must be in [1, 200]");
  const { people, truncated } = await readPersonNames(engine, opts.sourceIds);
  const candidates: { slug: string; source_id: string; alias: string }[] = [];
  let partial = truncated;
  for (const person of people) {
    const { rows } = await engine.query<{ body: string; compiled_truth: Record<string, unknown>; clipped: boolean }>(
      `SELECT left(markdown_body, 65536) AS body, compiled_truth, length(markdown_body) > 65536 AS clipped
        FROM pages WHERE slug = $1 AND source_id = $2 AND deleted_at IS NULL`, [person.slug, person.source_id],
    );
    const row = rows[0];
    if (!row) continue;
    partial ||= row.clipped;
    const seen = new Set([normalizeAlias(person.title), ...extractAliasNorms(row.compiled_truth)]);
    const title = person.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?:^|[\\n.!?]\\s*)${title}\\s*[,;(]?\\s*(?:aka|a\\.k\\.a\\.|он же|она же)\\s+["«“]?([\\p{L}][\\p{L} '-]{1,199})(?=["»”.,;:!?)\\n]|$)`, "gimu");
    for (const match of stripCodeBlocks(row.body).matchAll(pattern)) {
      const alias = match[1]!.trim();
      const norm = normalizeAlias(alias);
      if (seen.has(norm)) continue;
      seen.add(norm);
      candidates.push({ slug: person.slug, source_id: person.source_id, alias });
      if (candidates.length > limit) return { candidates: candidates.slice(0, limit), truncated: true };
    }
  }
  return { candidates, truncated: partial };
}
