/**
 * `memrain search stats [--days N] [--json]` — windowed search observability
 * from the search_telemetry rollup (migration 089): call volume, cache hit
 * rate, intent/mode mix, budget pressure, rank-1 drift.
 *
 * `memrain search tune [--apply] [--json]` — the observe→recommend→apply loop:
 * reads the same stats plus the active mode and prints structured
 * recommendations; `--apply` writes them through `memrain config`
 * (runtime_config, migration 088) with paste-ready reverts.
 */
import { Storage } from "../core/storage.ts";
import { withStorage } from "./with-storage.ts";
import { loadConfig } from "../core/config.ts";
import { LEGACY_CLI_WORD } from "../core/brand.ts";
import type { Engine } from "../core/engine/interface.ts";
import {
  readSearchStats,
  type StatsWindow,
} from "../core/search/telemetry.ts";
import { readShadowStats, type ShadowStats } from "../core/search/shadow.ts";
import {
  resolveSearchMode,
  MODE_BUNDLES,
  type SearchMode,
} from "../core/search/mode.ts";
import { resolveSemanticCacheConfig } from "../core/search/query-cache.ts";
import {
  setRuntimeConfig,
  unsetRuntimeConfig,
} from "../core/runtime-config.ts";

export interface SearchStatsOptions {
  days?: number;
  json?: boolean;
  configPath?: string;
}

export async function runSearchStats(opts: SearchStatsOptions = {}): Promise<number> {
  const storage = new Storage(loadConfig(opts.configPath));
  return withStorage(storage, async () => {
    const stats = await readSearchStats(storage.engine(), {
      ...(opts.days !== undefined ? { days: opts.days } : {}),
    });
    // Shadow ranking rollup (MEMRAIN_RANK_SHADOW); empty when it never ran.
    const shadow = await readShadowStats(storage.engine(), opts.days ?? 7).catch(() => [] as ShadowStats[]);
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            schema_version: 1,
            active_mode: resolveSearchMode(),
            ...stats,
            shadow,
          },
          null,
          2,
        ),
      );
      return 0;
    }
    printStatsText(stats);
    for (const sh of shadow) {
      console.log(
        `  Shadow ${sh.flag}: ${sh.count} searches, first page would change in ` +
          `${(sh.rank1_changed_rate * 100).toFixed(1)}%, top-5 overlap ${sh.mean_jaccard5.toFixed(2)}`,
      );
    }
    return 0;
  });
}

function printStatsText(stats: StatsWindow): void {
  console.log(`Search stats over the last ${stats.window_days} days:`);
  console.log("");
  console.log(`  Total searches:        ${stats.total_calls}`);
  if (stats.total_calls === 0) {
    console.log("");
    console.log(
      "No telemetry recorded yet. Run a few searches and re-check (the rollup flushes every 60s).",
    );
    return;
  }
  const hitRatePct = (stats.cache_hit_rate * 100).toFixed(1);
  console.log(
    `  Cache hit rate:        ${hitRatePct}%  (${stats.cache_hits} hit / ${stats.cache_misses} miss)`,
  );
  console.log(`  Avg results returned:  ${stats.avg_results.toFixed(1)}`);
  console.log(`  Avg tokens delivered:  ${stats.avg_tokens.toFixed(0)}  (char/4 heuristic)`);
  console.log(`  Budget drops total:    ${stats.total_budget_dropped}`);
  if (stats.avg_rank1_score !== null && stats.rank1_count > 0) {
    const d = stats.rank1_distribution;
    console.log(
      `  Avg rank-1 score:      ${stats.avg_rank1_score.toFixed(4)}  ` +
        `(${stats.rank1_count} samples; weak:${d.lt_solid} keyword:${d.solid} strong:${d.high})`,
    );
    console.log(
      `                         (top-result match quality by evidence class; downward drift = retrieval regressing)`,
    );
  }
  console.log("");
  console.log("  Mode distribution:");
  for (const [m, c] of Object.entries(stats.mode_distribution).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${m.padEnd(14)} ${c} (${((c / stats.total_calls) * 100).toFixed(1)}%)`);
  }
  console.log("");
  console.log("  Intent distribution:");
  for (const [i, c] of Object.entries(stats.intent_distribution).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${i.padEnd(14)} ${c} (${((c / stats.total_calls) * 100).toFixed(1)}%)`);
  }
  if (stats.oldest_seen || stats.newest_seen) {
    console.log("");
    console.log(`  Window: ${stats.oldest_seen ?? "?"} → ${stats.newest_seen ?? "?"}`);
  }
}

export interface TuneRecommendation {
  knob: string;
  current: unknown;
  suggested: unknown;
  reason: string;
  apply_command: string;
}

/**
 * Pure recommendation engine (exported for tests). Maps a fixed rule set onto
 * memrain knobs; every apply command routes through the DB-plane `memrain config`,
 * so `--apply` needs no redeploy.
 */
export function buildTuneRecommendations(
  stats: StatsWindow,
  mode: SearchMode,
  env: NodeJS.ProcessEnv = process.env,
): TuneRecommendation[] {
  const recs: TuneRecommendation[] = [];

  // 1. Budget pressure: the active bundle caps tokens and the cap is biting.
  const bundleBudget = MODE_BUNDLES[mode].tokenBudget;
  if (bundleBudget !== undefined && stats.total_calls > 0) {
    const dropPerCall = stats.total_budget_dropped / stats.total_calls;
    if (dropPerCall > 2) {
      recs.push({
        knob: "MEMRAIN_SEARCH_MODE",
        current: mode,
        suggested: "tokenmax",
        reason:
          `Avg ${dropPerCall.toFixed(1)} results dropped per search by the ` +
          `${bundleBudget}-token budget. tokenmax removes the cap (note: it also ` +
          `turns on paid query expansion).`,
        apply_command: "memrain config set MEMRAIN_SEARCH_MODE tokenmax",
      });
    }
  }

  // 2. Very high cache hit rate with the semantic arm on → tighten freshness.
  const sem = resolveSemanticCacheConfig(env);
  if (
    sem.enabled &&
    stats.cache_hit_rate > 0.85 &&
    stats.cache_hits + stats.cache_misses > 50 &&
    sem.similarity < 0.94
  ) {
    recs.push({
      knob: "MEMRAIN_QUERY_CACHE_SIM",
      current: sem.similarity,
      suggested: 0.94,
      reason:
        `Cache hit rate is ${(stats.cache_hit_rate * 100).toFixed(1)}%. Raising the ` +
        `semantic similarity floor to 0.94 buys tighter freshness at small recall cost.`,
      apply_command: "memrain config set MEMRAIN_QUERY_CACHE_SIM 0.94",
    });
  }

  // 3. tokenmax pays a Haiku expansion call per query — balanced keeps the
  //    deterministic + rerank stages without that per-query spend.
  if (mode === "tokenmax") {
    recs.push({
      knob: "MEMRAIN_SEARCH_MODE",
      current: "tokenmax",
      suggested: "balanced",
      reason:
        "tokenmax runs paid LLM query expansion on every search. balanced keeps " +
        "rerank/graph/cosine/relational with a 12000-token cap and no per-query expansion spend.",
      apply_command: "memrain config set MEMRAIN_SEARCH_MODE balanced",
    });
  }

  // 4. Query cache killed but there is real traffic — a free win to restore.
  if (env["MEMRAIN_QUERY_CACHE"] === "0" && stats.total_calls > 5) {
    recs.push({
      knob: "MEMRAIN_QUERY_CACHE",
      current: "0",
      suggested: "(unset)",
      reason:
        "The exact-match query cache is disabled (MEMRAIN_QUERY_CACHE=0) but searches are " +
        "flowing. The cache is a free win (zero LLM cost, big latency drop on repeats). " +
        "If the container env sets it, the env override still wins until removed there.",
      apply_command: "memrain config unset MEMRAIN_QUERY_CACHE",
    });
  }

  return recs;
}

/** Parse an apply command and write it through runtime_config (in-process).
 *  The command word may be the current CLI name or the pre-rename one. */
export async function applyTuneRecommendation(
  engine: Engine,
  rec: TuneRecommendation,
): Promise<void> {
  const parts = rec.apply_command.split(/\s+/);
  if ((parts[0] !== "memrain" && parts[0] !== LEGACY_CLI_WORD) || parts[1] !== "config") return;
  if (parts[2] === "set" && parts.length === 5) {
    await setRuntimeConfig(engine, parts[3]!, parts[4]!);
  } else if (parts[2] === "unset" && parts.length === 4) {
    await unsetRuntimeConfig(engine, parts[3]!);
  }
}

export function buildRevertCommand(rec: TuneRecommendation): string {
  const parts = rec.apply_command.split(/\s+/);
  if (parts[2] === "set" || parts[2] === "unset") {
    return `memrain config set ${parts[3]} ${String(rec.current)}`;
  }
  return rec.apply_command;
}

export interface SearchTuneOptions {
  apply?: boolean;
  json?: boolean;
  configPath?: string;
}

export async function runSearchTune(opts: SearchTuneOptions = {}): Promise<number> {
  const storage = new Storage(loadConfig(opts.configPath));
  return withStorage(storage, async () => {
    const engine = storage.engine();
    const mode = resolveSearchMode();
    const stats = await readSearchStats(engine, { days: 7 });

    if (stats.total_calls < 20) {
      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              ok: true,
              status: "insufficient_data",
              total_calls: stats.total_calls,
              recommendations: [],
              message:
                "Not enough search activity in the last 7 days to tune (need >= 20 calls).",
            },
            null,
            2,
          ),
        );
        return 0;
      }
      console.log("Not enough search activity in the last 7 days to tune.");
      console.log(`Total searches: ${stats.total_calls} (need >= 20 for confident recommendations).`);
      return 0;
    }

    const recs = buildTuneRecommendations(stats, mode);

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            status: recs.length === 0 ? "no_recommendations" : "has_recommendations",
            total_calls: stats.total_calls,
            cache_hit_rate: stats.cache_hit_rate,
            active_mode: mode,
            recommendations: recs,
            applied: opts.apply ? recs.map((r) => r.apply_command) : [],
          },
          null,
          2,
        ),
      );
      if (opts.apply) {
        for (const r of recs) await applyTuneRecommendation(engine, r);
      }
      return 0;
    }

    console.log(`Search tune (last 7 days, active mode: ${mode}):`);
    console.log("");
    if (recs.length === 0) {
      console.log("  No recommendations. Your search config looks well-tuned.");
      return 0;
    }
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i]!;
      console.log(`  ${i + 1}. ${r.knob}: ${String(r.current)} → ${String(r.suggested)}`);
      console.log(`     ${r.reason}`);
      console.log(`     Apply: ${r.apply_command}`);
      console.log("");
    }
    if (opts.apply) {
      console.log("Applying recommendations:");
      const reverts: string[] = [];
      for (const r of recs) {
        await applyTuneRecommendation(engine, r);
        console.log(`  applied: ${r.apply_command}`);
        reverts.push(buildRevertCommand(r));
      }
      console.log("");
      console.log("To revert these changes:");
      for (const cmd of reverts) console.log(`  ${cmd}`);
    } else {
      console.log("Run `memrain search tune --apply` to apply these changes.");
    }
    return 0;
  });
}
