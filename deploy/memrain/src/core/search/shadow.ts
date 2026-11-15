/**
 * Shadow ranking: measure a ranking flag on live traffic without changing
 * what anyone gets back.
 *
 * With MEMRAIN_RANK_SHADOW=<FLAG>, a search keeps a copy of its fused, hydrated
 * candidates and, once its own result is decided, runs the post-fusion stages
 * over the copy a second time with that flag flipped. It records whether the
 * first page would have changed and how much the top five pages would have
 * overlapped, as per-day sums in search_telemetry_shadow (migration 166). No
 * query text, page id or score is stored.
 *
 * Only flags the post-fusion stages read can be shadowed (no second retrieval
 * is ever made), the copy is ranked after the caller's result is ready and is
 * never awaited by it, and a call whose pipeline could spend (the paid
 * rerank, the graph rerank) or that opted out of telemetry is not shadowed.
 * Every failure is swallowed: the shadow must never break a search.
 */
import type { Engine } from "../engine/interface.ts";
import type { RankingFlag } from "./ranking-flags.ts";
import { runPostFusionStages } from "./stages/pipeline.ts";
import type { Hit, RankFlags, StageInput } from "./stages/types.ts";

const SHADOWABLE: Partial<Record<RankingFlag, keyof RankFlags>> = {
  METADATA_GATE: "metadataGate",
  ENTITY_TRUTH_SOFT: "entityTruthSoft",
  EXACT_LOOKUP: "exactLookup",
};

/** The flag to shadow, or null when unset or not a post-fusion flag. */
export function shadowFlag(env: NodeJS.ProcessEnv = process.env): RankingFlag | null {
  const raw = env.MEMRAIN_RANK_SHADOW?.trim().toUpperCase();
  if (!raw) return null;
  return raw in SHADOWABLE ? (raw as RankingFlag) : null;
}

export interface ShadowComparison {
  rank1Changed: boolean;
  /** Jaccard overlap of the distinct top-5 documents; 1 when both are empty. */
  jaccard5: number;
}

function topDocs(hits: readonly { documentId: string }[]): string[] {
  const out: string[] = [];
  for (const h of hits) {
    if (!out.includes(h.documentId)) out.push(h.documentId);
    if (out.length === 5) break;
  }
  return out;
}

export function compareTop5(main: readonly { documentId: string }[], shadow: readonly { documentId: string }[]): ShadowComparison {
  const a = topDocs(main);
  const b = topDocs(shadow);
  const union = new Set([...a, ...b]);
  const shared = a.filter((d) => b.includes(d)).length;
  return { rank1Changed: a[0] !== b[0], jaccard5: union.size === 0 ? 1 : shared / union.size };
}

const pending = new Set<Promise<void>>();

/** Wait for every shadow ranking still in flight (tests, and a CLI before exit). */
export async function flushShadowTelemetry(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending]);
}

async function record(engine: Engine, flag: RankingFlag, cmp: ShadowComparison): Promise<void> {
  await engine.query(
    `INSERT INTO search_telemetry_shadow (date, flag, count, rank1_changed, sum_jaccard5)
     VALUES ($1, $2, 1, $3, $4)
     ON CONFLICT (date, flag) DO UPDATE SET
       count = search_telemetry_shadow.count + 1,
       rank1_changed = search_telemetry_shadow.rank1_changed + EXCLUDED.rank1_changed,
       sum_jaccard5 = search_telemetry_shadow.sum_jaccard5 + EXCLUDED.sum_jaccard5,
       last_seen = NOW()`,
    [new Date().toISOString().slice(0, 10), flag, cmp.rank1Changed ? 1 : 0, cmp.jaccard5],
  );
}

/** A private copy of the candidates: stages score in place. */
export function shadowCopy(hits: readonly Hit[]): Hit[] {
  return hits.map((h) => ({ ...h }));
}

/**
 * Rank `copy` with `flag` flipped, put it through `finish` (the steps the
 * caller's result took after the stages), compare it with the caller's `main`
 * result and record the comparison. Starts in the background and returns at once.
 */
export function startShadow(
  flag: RankingFlag,
  copy: Hit[],
  input: StageInput,
  main: readonly { documentId: string }[],
  finish: (hits: Hit[]) => Promise<readonly { documentId: string }[]> = async (hits) => hits,
): void {
  const key = SHADOWABLE[flag];
  if (!key) return;
  const run = (async () => {
    try {
      const ranked = await runPostFusionStages(copy, {
        ...input,
        rank: { ...input.rank, [key]: !input.rank[key] },
        explainAcc: null,
      });
      await record(input.engine, flag, compareTop5(main, await finish(ranked)));
    } catch {
      // Observational only.
    }
  })();
  pending.add(run);
  void run.finally(() => pending.delete(run));
}

export interface ShadowStats {
  flag: string;
  count: number;
  /** Share of shadowed searches whose first page would have changed. */
  rank1_changed_rate: number;
  mean_jaccard5: number;
}

/** Per-flag shadow rates over the trailing `days`, for `memrain search stats`. */
export async function readShadowStats(engine: Engine, days = 7): Promise<ShadowStats[]> {
  const cutoff = new Date(Date.now() - Math.max(1, Math.min(365, days)) * 86_400_000).toISOString().slice(0, 10);
  const { rows } = await engine.query<{ flag: string; count: number; changed: number; jaccard: number }>(
    `SELECT flag, SUM(count)::int AS count, SUM(rank1_changed)::int AS changed, SUM(sum_jaccard5)::float8 AS jaccard
       FROM search_telemetry_shadow WHERE date >= $1 GROUP BY flag ORDER BY flag`,
    [cutoff],
  );
  return rows
    .filter((r) => Number(r.count) > 0)
    .map((r) => ({
      flag: r.flag,
      count: Number(r.count),
      rank1_changed_rate: Number(r.changed) / Number(r.count),
      mean_jaccard5: Number(r.jaccard) / Number(r.count),
    }));
}
