/**
 * `_meta.brain_hot_memory` MCP injection helper.
 *
 * Lets the dispatcher attach "what the brain learned in the last few days" as
 * best-effort `_meta` on a tool-call response: the live facts written to the
 * entity_facts ledger in the last 72 hours, ranked by
 * confidence × 0.5^(ageHours/24).
 *
 * SAFETY (why this is opt-in + operator-only):
 *   - Fact text can carry private claims. The dispatcher attaches the payload
 *     only to an unscoped operator call, and it is empty unless
 *     MEMRAIN_HOT_MEMORY_META=1. A caller that passes `sourceIds` gets only
 *     facts from those sources.
 *   - Best-effort: the dispatcher wraps this in try/catch and NEVER fails a tool
 *     call on an error here.
 *   - Short TTL cache so a burst of tool calls costs one query, not N; a fact
 *     write or forget drops it (`invalidateHotMemoryMeta`) so the next call
 *     reflects the change.
 */
import type { Storage } from "./storage.ts";
import { andSourceScope } from "./source-scope.ts";
import { factSourceEligibleSql } from "./quarantine.ts";
import { packFactText } from "./fact-text.ts";

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_TOP_K = 10;
const MAX_TOP_K = 25;
/** Confidence half-life: a fact's decay weight halves every this-many hours. */
const DECAY_HALF_LIFE_HOURS = 24;
/** Facts older than this (hours) are never surfaced regardless of confidence. */
const MAX_AGE_HOURS = 72;

interface CacheEntry {
  expiresAt: number;
  payload: HotMemoryPayload | undefined;
}

interface HotMemoryPayload {
  brain_hot_memory: { facts: { id: number; entity_slug: string; fact: string; written_at: string; confidence: number }[] };
}

const _cache = new Map<string, CacheEntry>();

/**
 * Feature gate. Default OFF — the injection surfaces raw fact text, so it stays
 * dark until an operator opts in with MEMRAIN_HOT_MEMORY_META=1.
 */
export function hotMemoryMetaEnabled(
  env: string | undefined = process.env["MEMRAIN_HOT_MEMORY_META"],
): boolean {
  return env === "1";
}

/** Drop the cached payload so the next call reads the ledger again. */
export function invalidateHotMemoryMeta(): void {
  _cache.clear();
}

/**
 * Build the `_meta.brain_hot_memory` payload, or undefined when there is
 * nothing to inject (disabled, no recent facts). Cached for a short TTL.
 */
export async function getBrainHotMemoryMeta(
  storage: Storage,
  opts: { topK?: number; ttlMs?: number; now?: number; sourceIds?: string[] } = {},
): Promise<Record<string, unknown> | undefined> {
  if (!hotMemoryMetaEnabled()) return undefined;
  const now = opts.now ?? Date.now();
  const ttl = Math.max(1000, opts.ttlMs ?? DEFAULT_TTL_MS);
  const topK = Math.max(1, Math.min(opts.topK ?? DEFAULT_TOP_K, MAX_TOP_K));
  const scopeKey = opts.sourceIds === undefined ? "*" : JSON.stringify([...opts.sourceIds].sort());
  const cacheKey = `k${topK}|${scopeKey}`;

  const cached = _cache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    if (!cached.payload) return undefined;
    const params: unknown[] = [cached.payload.brain_hot_memory.facts.map(f => f.id)];
    const scope = andSourceScope("source_id", opts.sourceIds, params);
    const live = await storage.engine().query<{ id: number | string }>(
      `SELECT id FROM entity_facts WHERE id = ANY($1::bigint[])
         AND forgotten_at IS NULL AND ${factSourceEligibleSql()}${scope}`, params,
    );
    const ids = new Set(live.rows.map(r => Number(r.id)));
    const facts = cached.payload.brain_hot_memory.facts.filter(f => ids.has(f.id));
    return facts.length ? { brain_hot_memory: { facts } } : undefined;
  }

  const nowIso = new Date(now).toISOString();
  const params: unknown[] = [nowIso, MAX_AGE_HOURS, DECAY_HALF_LIFE_HOURS, topK];
  const scope = andSourceScope("source_id", opts.sourceIds, params);
  const collapseKey = "entity_slug, COALESCE(attributed_to, ''), memrain_fact_claim_key(fact)";
  const r = await storage.engine().query<{
    id: number | string;
    entity_slug: string;
    fact: string;
    attributed_to: string | null;
    collapsed_count: number;
    written_at: string | Date;
    score: number | string;
  }>(
    `WITH eligible AS (
       SELECT * FROM entity_facts
        WHERE forgotten_at IS NULL AND ${factSourceEligibleSql()}
          AND dimension IS NULL
          AND written_at >= $1::timestamptz - make_interval(hours => $2::int)${scope}
     ), collapsed AS (
       SELECT DISTINCT ON (${collapseKey}) *,
              (count(*) OVER (PARTITION BY ${collapseKey}))::int AS collapsed_count
         FROM eligible ORDER BY ${collapseKey}, written_at DESC, id DESC
     )
     SELECT id, entity_slug, fact, attributed_to, collapsed_count, written_at,
            (confidence * power(0.5,
              GREATEST(0, EXTRACT(EPOCH FROM ($1::timestamptz - written_at)) / 3600.0) / $3
            ))::float8 AS score
       FROM collapsed
      ORDER BY score DESC, written_at DESC, id DESC
      LIMIT $4`,
    params,
  );
  if (r.rows.length === 0) {
    _cache.set(cacheKey, { expiresAt: now + ttl, payload: undefined });
    return undefined;
  }

  const payload = {
    brain_hot_memory: {
      facts: r.rows.map((row) => ({
        id: Number(row.id),
        entity_slug: row.entity_slug,
        fact: packFactText(row),
        collapsed_count: row.collapsed_count,
        written_at: row.written_at instanceof Date ? row.written_at.toISOString() : row.written_at,
        confidence: Number(Number(row.score).toFixed(3)),
      })),
    },
  };
  _cache.set(cacheKey, { expiresAt: now + ttl, payload });
  return payload;
}

/** Test helper: clear the TTL cache. */
export function __resetHotMemoryMetaCacheForTests(): void {
  invalidateHotMemoryMeta();
}
