/**
 * Ratings of search results and the per-page weights learned from them
 * (migration 174). Both engines run the same SQL.
 *
 * A rating is stored under the page's own source with a hash of the
 * principal, never the principal or the question. Each new rating recomputes
 * its page's weight from the raw rows, taking each principal's latest vote per
 * signal, so voting twice replaces a vote instead of adding one. Raw rows past
 * FEEDBACK_RETENTION_DAYS are deleted on the way; a page nobody rates again
 * keeps the weight they produced.
 */
import { createHash } from "node:crypto";
import type { Engine } from "../engine/interface.ts";
import { FEEDBACK_MAX_PER_HOUR, FEEDBACK_RETENTION_DAYS } from "./settings.ts";
import { aggregateWeight, editedWeight, type FeedbackSignal, type Vote, type VoterTier } from "./weights.ts";

export interface Rating {
  sourceId: string;
  slug: string;
  /** Who rated: `operator`, `member:<id>`, `client:<id>`. Only its hash is kept. */
  principal: string;
  tier: VoterTier;
  rating: -1 | 0 | 1;
  signal: FeedbackSignal;
  /** The chat message the rating came from, when there is one. */
  queryId?: string | null;
}

export type RecordResult =
  | { ok: true; weight: number }
  | { ok: false; error: "rate_limited" | "not_found" };

export function principalHash(principal: string): string {
  return createHash("sha256").update(`memrain-feedback:${principal}`).digest("hex");
}

interface VoteRow {
  rating: number | string;
  tier: VoterTier;
  signal: FeedbackSignal;
  stale: boolean;
  age_days: number | string;
}

export async function recordRating(engine: Engine, r: Rating): Promise<RecordResult> {
  const ph = principalHash(r.principal);
  return engine.transaction(async (tx) => {
    const page = await tx.query<{ content_hash: string }>(
      `SELECT content_hash FROM pages WHERE slug = $1 AND source_id = $2 AND deleted_at IS NULL`,
      [r.slug, r.sourceId],
    );
    const contentHash = page.rows[0]?.content_hash;
    if (contentHash === undefined) return { ok: false, error: "not_found" };
    // scope: upstream keyed by the caller's own principal hash; returns only a count
    const recent = await tx.query<{ n: number | string }>(
      `SELECT count(*)::int AS n FROM retrieval_feedback WHERE principal_hash = $1 AND created_at > NOW() - interval '1 hour'`,
      [ph],
    );
    if (Number(recent.rows[0]?.n ?? 0) >= FEEDBACK_MAX_PER_HOUR) return { ok: false, error: "rate_limited" };
    // Two raters of one page recompute its weight one after the other.
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`memrain:feedback:${r.sourceId}:${r.slug}`]);
    await tx.query(
      `INSERT INTO retrieval_feedback (source_id, slug, principal_hash, tier, query_id, rating, signal, content_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [r.sourceId, r.slug, ph, r.tier, r.queryId ?? null, r.rating, r.signal, contentHash],
    );
    // scope: operator-only retention by age over every source
    await tx.query(
      `DELETE FROM retrieval_feedback WHERE created_at < NOW() - make_interval(days => $1::int)`,
      [FEEDBACK_RETENTION_DAYS],
    );
    const rows = await tx.query<VoteRow>(
      `SELECT DISTINCT ON (principal_hash, signal)
              rating, tier, signal, (content_hash IS DISTINCT FROM $3) AS stale,
              EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400.0 AS age_days
         FROM retrieval_feedback
        WHERE source_id = $1 AND slug = $2
        ORDER BY principal_hash, signal, created_at DESC, id DESC`,
      [r.sourceId, r.slug, contentHash],
    );
    const votes: Vote[] = rows.rows.map((v) => ({
      rating: Number(v.rating) as Vote["rating"],
      tier: v.tier,
      signal: v.signal,
      stale: v.stale === true,
      ageDays: Number(v.age_days),
    }));
    const weight = aggregateWeight(votes);
    await tx.query(
      `INSERT INTO retrieval_weights (source_id, slug, weight, n, content_hash, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (source_id, slug) DO UPDATE
         SET weight = EXCLUDED.weight, n = EXCLUDED.n, content_hash = EXCLUDED.content_hash, updated_at = NOW()`,
      [r.sourceId, r.slug, weight, votes.length, contentHash],
    );
    return { ok: true, weight };
  });
}

/**
 * The weight of each live page among `slugs` that has one, read against the
 * page's own source; a page edited since its weight was learned reads halfway
 * back to neutral. Pages without a weight are absent (neutral).
 */
export async function readWeights(engine: Engine, slugs: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (slugs.length === 0) return out;
  const r = await engine.query<{ slug: string; weight: number | string; stale: boolean }>(
    `SELECT w.slug, w.weight, (w.content_hash IS DISTINCT FROM p.content_hash) AS stale
       FROM retrieval_weights w
       JOIN pages p ON p.slug = w.slug AND p.source_id = w.source_id
      WHERE w.slug = ANY($1::text[]) AND p.deleted_at IS NULL`,
    [[...new Set(slugs)]],
  );
  for (const row of r.rows) {
    const w = Number(row.weight);
    out.set(row.slug, row.stale === true ? editedWeight(w) : w);
  }
  return out;
}

/**
 * Changes whenever any weight changes: part of the query-cache key while
 * feedback is on, so a cached ordering never outlives the weights it used.
 */
export async function feedbackGeneration(engine: Engine): Promise<string> {
  // scope: operator-only a cache-key fingerprint over every source; returns a count and a time
  const r = await engine.query<{ n: number | string; at: string | null }>(
    `SELECT count(*)::int AS n, max(updated_at)::text AS at FROM retrieval_weights`,
  );
  return `${Number(r.rows[0]?.n ?? 0)}@${r.rows[0]?.at ?? "-"}`;
}
