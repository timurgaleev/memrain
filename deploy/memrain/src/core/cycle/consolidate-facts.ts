/**
 * consolidate-facts — deterministic, LLM-FREE dream-cycle phase that folds an
 * entity's near-duplicate facts into a single consolidated "take" fact.
 *
 * memrain's consolidate model: the "take" is a promoted row in the SAME
 * `entity_facts` ledger (memrain has no
 * per-fact `takes` table with tenant scoping; synth_takes is the LLM-synthesis
 * surface and carries no source_id), so consolidation stays inside the facts
 * ledger and inherits its source_id tenant scoping for free.
 *
 * Per (source_id, entity_slug) bucket of UNCONSOLIDATED, live, embedded facts:
 *   1. Skip if fewer than `minFactsPerBucket` (default 3).
 *   2. Skip if the OLDEST fact is younger than `minOldestAgeMs` (default 24h) —
 *      let a burst settle before consolidating it.
 *   3. Cluster greedily by embedding cosine (head-based, threshold 0.85).
 *   4. For each cluster of >= 2: write ONE consolidated take fact
 *      (written_by 'facts-consolidate', confidence = cluster average, the
 *      highest-confidence member's text as the claim, and that member's KIND so
 *      the take ages like the claim it quotes) and mark every contributing fact
 *      `consolidated = true`. NEVER delete — the contributing rows stay for
 *      audit, just excluded from future passes.
 *
 * FALLS-OPEN: a per-bucket failure is collected in `errors[]` and the phase
 * continues; it never throws (the cycle marks it `warn` when errors[] is
 * non-empty, same envelope as embed-facts). Default-OFF: the phase is not in
 * ALL_PHASES, so a normal cycle never runs it; it runs only when explicitly
 * requested via `--phases consolidate-facts`.
 */
import type { Engine } from "../engine/interface.ts";
import { findLiveClaim, type ClaimIdentity } from "../facts.ts";
import { DEFAULT_FACT_KIND } from "../facts-decay.ts";
import { phaseFenceCheck } from "./phase-context.ts";

/** Author stamped on a promoted take — also half its claim identity. */
const CONSOLIDATE_WRITER = "facts-consolidate";

export interface ConsolidateFactsOptions {
  /** Greedy cosine cluster threshold. Default 0.85. */
  clusterThreshold?: number;
  /** Minimum unconsolidated facts in a bucket before it consolidates. Default 3. */
  minFactsPerBucket?: number;
  /** Minimum age (ms) of the OLDEST fact in a bucket before consolidating. Default 24h. */
  minOldestAgeMs?: number;
  /** Cap on buckets processed per run. Default 200. */
  maxBuckets?: number;
  /** Cap on facts fetched per bucket. Default 100. */
  maxFactsPerBucket?: number;
  /** Clock seam for the age gate (tests). Defaults to now. */
  now?: Date;
}

export interface ConsolidateFactsResult {
  bucketsScanned: number;
  bucketsProcessed: number;
  bucketsSkipped: number;
  takesWritten: number;
  factsConsolidated: number;
  errors: { source_id: string; entity_slug: string; message: string }[];
}

interface BucketRow {
  source_id: string;
  entity_slug: string;
  count: number;
}

interface FactCandidate {
  id: number;
  fact: string;
  confidence: number;
  /** mig037 `kind`; the promoted take inherits the quoted member's. */
  kind: string | null;
  embedding: number[];
  written_at: string;
}

const DEFAULT_THRESHOLD = 0.85;
const DEFAULT_MIN_PER_BUCKET = 3;
const DEFAULT_MIN_OLDEST_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_BUCKETS = 200;
const DEFAULT_MAX_FACTS_PER_BUCKET = 100;

/** Cosine similarity of two equal-length numeric vectors. 0 on any degeneracy. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (denom === 0) return 0;
  return dot / denom;
}

/**
 * Greedy head-based clustering: walk facts (caller passes them written_at DESC);
 * each fact joins the first existing cluster whose HEAD is within `threshold`
 * cosine, else starts a new cluster. Deterministic given a stable input order.
 */
export function clusterFacts(
  facts: FactCandidate[],
  threshold: number,
): FactCandidate[][] {
  const clusters: FactCandidate[][] = [];
  for (const f of facts) {
    let placed = false;
    for (const c of clusters) {
      if (cosineSimilarity(f.embedding, c[0]!.embedding) >= threshold) {
        c.push(f);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push([f]);
  }
  return clusters;
}

/** Parse the pgvector text form (`[0.1,0.2,...]`, valid JSON) into number[]. */
function parseEmbedding(raw: unknown): number[] | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) && v.every((n) => typeof n === "number") ? v : null;
  } catch {
    return null;
  }
}

export async function consolidateFactsPhase(
  engine: Engine,
  opts: ConsolidateFactsOptions = {},
): Promise<ConsolidateFactsResult> {
  const threshold = opts.clusterThreshold ?? DEFAULT_THRESHOLD;
  const minPerBucket = opts.minFactsPerBucket ?? DEFAULT_MIN_PER_BUCKET;
  const minOldestAgeMs = opts.minOldestAgeMs ?? DEFAULT_MIN_OLDEST_AGE_MS;
  const maxBuckets = opts.maxBuckets ?? DEFAULT_MAX_BUCKETS;
  const maxFacts = opts.maxFactsPerBucket ?? DEFAULT_MAX_FACTS_PER_BUCKET;
  const now = opts.now ?? new Date();

  const result: ConsolidateFactsResult = {
    bucketsScanned: 0,
    bucketsProcessed: 0,
    bucketsSkipped: 0,
    takesWritten: 0,
    factsConsolidated: 0,
    errors: [],
  };

  const buckets = await engine.query<BucketRow>(
    `SELECT source_id, entity_slug, COUNT(*)::int AS count
       FROM entity_facts
      WHERE consolidated = false
        AND forgotten_at IS NULL
        AND embedding IS NOT NULL
        AND btrim(fact) <> ''
        -- dimensional ontology rows have their own read path, not consolidation.
        AND dimension IS NULL
        -- an assistant's suggestion is not a claim the operator holds (mig130).
        AND attributed_to IS DISTINCT FROM 'assistant'
      GROUP BY source_id, entity_slug
     HAVING COUNT(*) >= $1
      ORDER BY source_id, entity_slug
      LIMIT $2`,
    [minPerBucket, maxBuckets],
  );
  result.bucketsScanned = buckets.rows.length;

  for (const b of buckets.rows) {
    await phaseFenceCheck();
    try {
      const processed = await consolidateBucket(engine, b, {
        threshold,
        minPerBucket,
        minOldestAgeMs,
        maxFacts,
        now,
      });
      if (processed.skipped) {
        result.bucketsSkipped += 1;
      } else {
        result.bucketsProcessed += 1;
        result.takesWritten += processed.takesWritten;
        result.factsConsolidated += processed.factsConsolidated;
      }
    } catch (e) {
      result.errors.push({
        source_id: b.source_id,
        entity_slug: b.entity_slug,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return result;
}

interface BucketOutcome {
  skipped: boolean;
  takesWritten: number;
  factsConsolidated: number;
}

async function consolidateBucket(
  engine: Engine,
  bucket: BucketRow,
  cfg: {
    threshold: number;
    minPerBucket: number;
    minOldestAgeMs: number;
    maxFacts: number;
    now: Date;
  },
): Promise<BucketOutcome> {
  const rows = await engine.query<{
    id: number;
    fact: string;
    confidence: number;
    kind: string | null;
    embedding: string;
    written_at: string;
  }>(
    `SELECT id, fact, confidence, kind, embedding::text AS embedding,
            written_at::text AS written_at
       FROM entity_facts
      WHERE source_id = $1 AND entity_slug = $2
        AND consolidated = false
        AND forgotten_at IS NULL
        AND embedding IS NOT NULL
        AND btrim(fact) <> ''
        -- dimensional ontology rows have their own read path, not consolidation.
        AND dimension IS NULL
        AND attributed_to IS DISTINCT FROM 'assistant'
      ORDER BY written_at DESC
      LIMIT $3`,
    [bucket.source_id, bucket.entity_slug, cfg.maxFacts],
  );

  const candidates: FactCandidate[] = [];
  for (const r of rows.rows) {
    const embedding = parseEmbedding(r.embedding);
    if (!embedding) continue; // an unparseable vector sits out this pass
    candidates.push({
      id: r.id,
      fact: r.fact,
      confidence: r.confidence,
      kind: r.kind,
      embedding,
      written_at: r.written_at,
    });
  }
  if (candidates.length < cfg.minPerBucket) {
    return { skipped: true, takesWritten: 0, factsConsolidated: 0 };
  }

  // Age gate: the OLDEST candidate must be at least minOldestAgeMs old.
  let oldestMs = Infinity;
  for (const c of candidates) {
    const t = Date.parse(c.written_at);
    if (Number.isFinite(t) && t < oldestMs) oldestMs = t;
  }
  if (cfg.now.getTime() - oldestMs < cfg.minOldestAgeMs) {
    return { skipped: true, takesWritten: 0, factsConsolidated: 0 };
  }

  const clusters = clusterFacts(candidates, cfg.threshold);
  let takesWritten = 0;
  let factsConsolidated = 0;
  for (const cluster of clusters) {
    if (cluster.length < 2) continue;
    const out = await promoteCluster(engine, bucket, cluster);
    takesWritten += out.takeWritten ? 1 : 0;
    factsConsolidated += out.factsConsolidated;
  }
  return { skipped: false, takesWritten, factsConsolidated };
}

/**
 * Promote one cluster to a consolidated take + mark its members consolidated,
 * atomically. Idempotent: the take is written only when no live row already
 * holds that claim, decided by the LEDGER's claim identity (`findLiveClaim`:
 * subject + source + writer + text) — the same call `addFact` collapses a
 * restatement with, so a take and an ordinary fact cannot disagree about what
 * "already on file" means.
 */
async function promoteCluster(
  engine: Engine,
  bucket: BucketRow,
  cluster: FactCandidate[],
): Promise<{ takeWritten: boolean; factsConsolidated: number }> {
  const best = cluster.reduce((a, b) => (b.confidence > a.confidence ? b : a));
  const avg =
    cluster.reduce((s, f) => s + f.confidence, 0) / cluster.length;
  const ids = cluster.map((f) => f.id);

  const identity: ClaimIdentity = {
    entity_slug: bucket.entity_slug,
    source_id: bucket.source_id,
    fact: best.fact,
    written_by: CONSOLIDATE_WRITER,
  };

  return engine.transaction(async (tx) => {
    // The consolidated_into pointer (mig085) targets the promoted take; on an
    // idempotent re-run the take is already on file, so its id comes from the
    // same lookup that decides whether to write one at all.
    let takeId = await findLiveClaim(tx, identity);
    const takeWritten = takeId === null;
    if (takeId === null) {
      const ins = await tx.query<{ id: number }>(
        `INSERT INTO entity_facts
           (entity_slug, fact, kind, confidence, written_by, source_id,
            consolidated, consolidated_at)
         VALUES ($1, $2, $3, $4, $5, $6, true, NOW())
         RETURNING id`,
        [
          bucket.entity_slug,
          best.fact,
          // The take restates ONE member verbatim, so it is that member's kind
          // of claim and ages on that member's half-life. A take used to land
          // with the column blank, which decay cannot see: every consolidated
          // row was immortal while its members aged out beneath it.
          best.kind ?? DEFAULT_FACT_KIND,
          avg,
          CONSOLIDATE_WRITER,
          bucket.source_id,
        ],
      );
      takeId = ins.rows[0]?.id ?? null;
    }
    // Mark the contributing facts consolidated (never delete) and point them
    // at their take. Scoped by id + the bucket's source_id so a concurrent
    // cross-tenant row can never be swept. `consolidated = false` guard keeps
    // it idempotent.
    const upd = await tx.query<{ id: number }>(
      `UPDATE entity_facts
          SET consolidated = true, consolidated_at = NOW(),
              consolidated_into = COALESCE($3, consolidated_into)
        WHERE id = ANY($1::bigint[]) AND source_id = $2 AND consolidated = false
        RETURNING id`,
      [ids, bucket.source_id, takeId],
    );
    return { takeWritten, factsConsolidated: upd.rows.length };
  });
}
