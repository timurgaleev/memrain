/**
 * Tiers of rows derived from other rows, for the derivations no insert trigger
 * can see whole (migration 184 covers a row that names one origin).
 *
 * A concept page is built from many atoms, a think synthesis or take from the
 * pages, facts, events and takes the model read, a consolidated fact from its
 * members. Each takes the least trusted tier among its inputs. Pages are only
 * ever lowered here: the page trigger (158) already keeps a later write from
 * raising a page, so a derivation recomputed from better inputs stays at the
 * lower tier it once had.
 */
import type { Engine } from "./engine/interface.ts";
import { readTrustTiers } from "./trust-frame.ts";
import { factRankSql, isTrustTier, lowerTier, tierOfRank, type TrustTier } from "./trust-tier.ts";

type Queryable = Pick<Engine, "query">;

/** What a think run placed in the model's context. */
export interface DerivationEvidence {
  pages: readonly string[];
  takes: readonly string[];
  facts: readonly number[];
  events: readonly number[];
}

/** Lowers a page's recorded tier to `tier`; never raises it. */
export async function lowerPageTier(q: Queryable, slug: string, sourceId: string, tier: TrustTier): Promise<void> {
  await q.query(
    `UPDATE pages SET trust_tier = memrain_min_trust_tier(COALESCE(trust_tier, 'owner'), $3)
      WHERE slug = $1 AND source_id = $2 AND trust_tier IS DISTINCT FROM memrain_min_trust_tier(COALESCE(trust_tier, 'owner'), $3)`,
    [slug, sourceId, tier],
  );
}

/**
 * Lowers a concept page to its least trusted atom. An atom's tier is the lower
 * of the one it recorded (184) and the tier of the page or document it names
 * now, so an atom written before 184 counts too.
 */
export async function lowerConceptPageTier(q: Queryable, conceptSlug: string, pageSlug: string): Promise<void> {
  await q.query(
    // scope: operator-only lowers the tier of a concept page the synthesis cycle just wrote
    `WITH low AS (
       SELECT memrain_rank_trust_tier(MIN(memrain_trust_rank(
                memrain_min_trust_tier(COALESCE(a.trust_tier, 'owner'), memrain_ref_trust_tier(a.source_ref, NULL))))) AS tier
         FROM synth_concept_atoms ca JOIN synth_atoms a ON a.id = ca.atom_id
        WHERE ca.concept_slug = $1)
     UPDATE pages p SET trust_tier = memrain_min_trust_tier(COALESCE(p.trust_tier, 'owner'), low.tier)
       FROM low
      WHERE p.slug = $2 AND low.tier IS NOT NULL
        AND p.trust_tier IS DISTINCT FROM memrain_min_trust_tier(COALESCE(p.trust_tier, 'owner'), low.tier)`,
    [conceptSlug, pageSlug],
  );
}

/** The least trusted effective tier among the facts; undefined for none. */
export async function minFactTier(q: Queryable, ids: readonly number[]): Promise<TrustTier | undefined> {
  if (ids.length === 0) return undefined;
  const r = await q.query<{ rank: number | null }>(
    // scope: upstream fact ids the calling writer already selected in its own scope
    `SELECT MIN(${factRankSql("r", "tt_p.slug IN (r.source_slug, r.source_markdown_slug)")})::int AS rank
       FROM entity_facts r WHERE r.id = ANY($1::bigint[])`,
    [[...ids]],
  );
  const rank = r.rows[0]?.rank;
  return rank === null || rank === undefined ? undefined : tierOfRank(Number(rank));
}

/**
 * The least trusted tier among a derivation's inputs; undefined when it read
 * nothing that resolves. A take counts at the lower of its recorded tier and
 * the tier of the page it names.
 */
export async function evidenceTier(engine: Engine, evidence: DerivationEvidence): Promise<TrustTier | undefined> {
  const tiers = await readTrustTiers(engine, { pages: evidence.pages, facts: evidence.facts, events: evidence.events });
  const found: TrustTier[] = [...tiers.pages.values(), ...tiers.facts.values(), ...tiers.events.values()];
  if (evidence.takes.length > 0) {
    const r = await engine.query<{ tier: string | null }>(
      // scope: upstream take keys the think run already read under the caller's scope
      `SELECT memrain_min_trust_tier(COALESCE(trust_tier, 'owner'), memrain_ref_trust_tier(source_ref, NULL)) AS tier
         FROM synth_takes WHERE take_key = ANY($1::text[])`,
      [[...evidence.takes]],
    );
    for (const row of r.rows) if (isTrustTier(row.tier)) found.push(row.tier);
  }
  return found.length === 0 ? undefined : found.reduce(lowerTier);
}
