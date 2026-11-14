import type { Engine } from "./engine/interface.ts";
import { andSourceScope } from "./source-scope.ts";
import { documentRankSql, factRankSql, pageRankSql, tierOfRank, type TrustTier } from "./trust-tier.ts";

export interface ExternalTrust { trust?: "external" }

/** Escaping also covers forged closing tags and pre-escaped entities. */
export function frameExternal(text: string): string {
  return `<external_content trust="external">\n${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}\n</external_content>`;
}

export interface TrustSelection {
  chunks?: readonly string[];
  pages?: readonly string[];
  facts?: readonly (number | string)[];
  events?: readonly number[];
}

export interface TrustTiers {
  chunks: Map<string, TrustTier>;
  pages: Map<string, TrustTier>;
  facts: Map<number, TrustTier>;
  events: Map<number, TrustTier>;
}

/** Only IDs already selected by an authorized read enter this lookup. Re-scope
 *  here too; neither principals nor source identities leave this module. */
export async function readTrustTiers(engine: Engine, selected: TrustSelection, sourceIds?: readonly string[]): Promise<TrustTiers> {
  const params: unknown[] = [];
  const arms: string[] = [];
  const add = (ids: readonly unknown[] | undefined, kind: string, table: string, key: string, scope: string, rank: string, numeric = false) => {
    if (!ids?.length) return;
    params.push(ids);
    const idParam = `$${params.length}::${numeric ? "bigint" : "text"}[]`;
    const filter = andSourceScope(scope, sourceIds, params);
    arms.push(`SELECT '${kind}' AS kind, ${key}::text AS id, (${rank})::int AS rank FROM ${table}
      WHERE ${key} = ANY(${idParam})${filter}`);
  };
  add(selected.chunks, "chunks", "chunks c JOIN documents d ON d.id = c.document_id", "c.id", "d.source_id", documentRankSql("d"));
  add(selected.pages, "pages", "pages pg", "pg.slug", "pg.source_id", pageRankSql("pg"));
  add(selected.facts, "facts", "entity_facts r", "r.id", "r.source_id",
    factRankSql("r", "tt_p.slug IN (r.source_slug, r.source_markdown_slug)"), true);
  add(selected.events, "events", "timeline_events r", "r.id", "r.source_id", factRankSql("r", "tt_p.slug = r.slug", false), true);
  const rows = arms.length ? (await engine.query<{ kind: string; id: string; rank: number }>(arms.join(" UNION ALL "), params)).rows : [];
  const pick = <K>(kind: string, key: (id: string) => K) =>
    new Map(rows.filter(r => r.kind === kind).map(r => [key(r.id), tierOfRank(Number(r.rank))] as const));
  return { chunks: pick("chunks", String), pages: pick("pages", String), facts: pick("facts", Number), events: pick("events", Number) };
}

/** The rows below the owner tier: exactly the ones the outside-content frame wraps. */
export async function readExternalTrust(engine: Engine, selected: TrustSelection, sourceIds?: readonly string[]): Promise<{
  chunks: Set<string>; pages: Set<string>; facts: Set<number>; events: Set<number>;
}> {
  const tiers = await readTrustTiers(engine, selected, sourceIds);
  const below = <K>(m: Map<K, TrustTier>) => new Set([...m].filter(([, t]) => t !== "owner").map(([k]) => k));
  return { chunks: below(tiers.chunks), pages: below(tiers.pages), facts: below(tiers.facts), events: below(tiers.events) };
}

/**
 * Search hits carry both fields: `trust_tier` always, and the legacy framing
 * flag `trust: "external"` exactly when the tier is below owner, which is also
 * when frameMarkedContent wraps the content. A chunk the lookup cannot see
 * (deleted since retrieval) keeps the shape markExternalChunks gave it: no
 * label and no frame.
 */
export async function markChunkTrust<T extends { chunkId: string }>(engine: Engine, hits: readonly T[], sourceIds?: readonly string[]): Promise<Array<T & ExternalTrust & { trust_tier?: TrustTier }>> {
  const tiers = await readTrustTiers(engine, { chunks: hits.map(h => h.chunkId) }, sourceIds);
  return hits.map((h) => {
    const tier = tiers.chunks.get(h.chunkId);
    if (tier === undefined) return h;
    return tier === "owner" ? { ...h, trust_tier: tier } : { ...h, trust: "external" as const, trust_tier: tier };
  });
}

export async function markExternalChunks<T extends { chunkId: string }>(engine: Engine, hits: readonly T[], sourceIds?: readonly string[]): Promise<Array<T & ExternalTrust>> {
  const external = await readExternalTrust(engine, { chunks: hits.map(h => h.chunkId) }, sourceIds);
  return hits.map(h => external.chunks.has(h.chunkId) ? { ...h, trust: "external" } : h);
}

export function frameMarkedContent<T extends { content: string } & ExternalTrust>(hit: T): T {
  return hit.trust === "external" ? { ...hit, content: frameExternal(hit.content) } : hit;
}
