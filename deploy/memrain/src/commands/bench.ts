/**
 * `memrain bench` — the agent-facing behaviour bench.
 *
 * Three families, one command, one scoreboard:
 *
 *   push        does the brain volunteer the right pages, and stay quiet
 *               otherwise (the shipped corpus and its pinned numbers)
 *   continuity  is a write from session A recalled by a DIFFERENT client in
 *               session B — and invisible to a client scoped elsewhere
 *   fidelity    does a claim the extractor produced survive the write path
 *               intact, and do the claims the pipeline must discard stay out
 *
 * EXIT CODE IS 0 ON A COMPLETED RUN, whatever the numbers say. The bench
 * reports; the ratchet lives in `tests/bench_*.test.ts`, which fail when a
 * number moves. Putting the gate here as well would give the repo two copies of
 * one threshold, and the copies drift — the second one always loses. Non-zero
 * here means the run did not happen: a bad flag, a malformed corpus, a refused
 * mode.
 *
 * THE COMMAND OWNS ITS DATABASE. A `mkdtempSync` PGLite, migrated from empty,
 * removed in a `finally` — the same shape `eval chronicle` uses. It never
 * touches the operator's brain: every family truncates between fixtures, and a
 * bench that truncated the real brain would be a data-loss bug wearing a
 * benchmark's clothes.
 *
 * ZERO MODEL SPEND, MEASURED. Every paid call in the tree routes through
 * `trackedInvoke`, which books a row into `mcp_spend_log` against whichever
 * engine `Storage.init` last wired up — this command's own temp database. So
 * the ledger is read before and after, and the delta is what the scoreboard
 * prints. Not a comment claiming the run is free: a number that would move if
 * it were not. See `spendLedgerSnapshot` for why the row COUNT is read too.
 *
 * THE ONE PAID MODE: `--live --family fidelity` replays the fidelity corpus
 * against the real extraction model (`runFidelityCorpusLive`), under a hard
 * BudgetTracker cap of $0.50. It is opt-in by flag, prints its own report with
 * Wilson intervals instead of the stub scoreboard, and is never run by tests.
 * `--live` with any other family is refused before anything bills.
 */

import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../core/storage.ts";
import { withStorage } from "./with-storage.ts";
import type { Engine } from "../core/engine/interface.ts";
import { loadCorpus } from "../core/bench/fixtures.ts";
import { runCorpus } from "../core/bench/harness.ts";
import { resetProcessGlobals } from "../core/bench/reset.ts";
import { scorePush } from "../core/bench/push-metrics.ts";
import { loadContinuityCorpus } from "../core/bench/continuity-fixtures.ts";
import { runContinuityCorpus } from "../core/bench/continuity-harness.ts";
import { loadFidelityCorpus } from "../core/bench/fidelity-fixtures.ts";
import {
  runFidelityCorpus,
  runFidelityCorpusLive,
  fidelityFamilyReport,
  formatFidelityLive,
} from "../core/bench/fidelity-harness.ts";
import {
  formatScoreboard,
  scoreboardJson,
  type BenchFamilyReport,
  type BenchReport,
} from "../core/bench/scoreboard.ts";

/** Families that actually run. `all` is a selector, not a family. */
export const BENCH_FAMILIES = ["push", "continuity", "fidelity"] as const;
export type BenchFamily = (typeof BENCH_FAMILIES)[number];

/** What `--family` accepts. */
export type BenchFamilySelector = BenchFamily | "all";

const SELECTORS: readonly string[] = [...BENCH_FAMILIES, "all"];

export function isBenchFamilySelector(s: string): s is BenchFamilySelector {
  return SELECTORS.includes(s);
}

/**
 * Corpus subdirectory per family, relative to the corpus ROOT.
 *
 * `--corpus <root>` points at a directory laid out like the shipped one, not at
 * a single family's fixtures. One rule then covers `--family all` and a single
 * family alike; the alternative — "the directory IS this family's corpus when
 * one family is selected" — makes the same flag mean two things depending on
 * another flag, which is how a grader ends up scoring the wrong fixtures and
 * never finding out.
 */
export const FAMILY_CORPUS_SUBDIR: Readonly<Record<BenchFamily, string>> = {
  push: "corpus",
  continuity: "corpus-continuity",
  fidelity: "corpus-fidelity",
};

/** Where the shipped fixtures live — the parent of the three subdirectories. */
export const SHIPPED_CORPUS_ROOT = join(import.meta.dir, "..", "core", "bench");

export interface BenchOptions {
  /** Default `all`. */
  family?: BenchFamilySelector;
  /** Corpus root. Defaults to the shipped one. */
  corpus?: string;
  /** Emit `scoreboardJson` instead of the human block. */
  json?: boolean;
  /** The paid fidelity lane; refused for every other family — see `LIVE_REFUSAL`. */
  live?: boolean;
}

/**
 * Environment knobs that turn a "free" bench into a paid one.
 *
 * All three are model gates the injected stubs do NOT cover: fact dedup embeds
 * every candidate with a real Titan call unless `dedup.embed` is injected
 * (`src/core/facts.ts:233`), its LLM classifier is a second paid step, and the
 * worth gate (`src/core/synthesis/worth-gate.ts:21`) calls a judge before
 * synthesis. The bench clears them in its own process rather than trusting
 * whatever shell it was started from: "free unless your environment says
 * otherwise" is not a property anyone can rely on.
 */
const PAID_ENV_KNOBS = [
  "MEMRAIN_FACTS_DEDUP",
  "MEMRAIN_FACTS_DEDUP_LLM",
  "MEMRAIN_WORTH_GATE",
] as const;

function clearPaidEnvKnobs(): void {
  for (const k of PAID_ENV_KNOBS) delete process.env[k];
}

/**
 * Why `--live` without `--family fidelity` is refused rather than run.
 *
 * Only the fidelity family has a live lane. Refusing the rest by name says so
 * BEFORE anything bills, instead of quietly running the stub arm.
 */
export const LIVE_REFUSAL =
  "memrain bench: --live runs only with --family fidelity.\n" +
  "  A live-model arm cannot be pinned (model output is not deterministic), " +
  "cannot run in CI,\n" +
  "  and costs real money per run; only the extractor's fidelity lane has one, " +
  "capped at $0.50.";

/** One family's fixture directory, checked before anything opens a database. */
function corpusDirFor(root: string, family: BenchFamily): string {
  const dir = join(root, FAMILY_CORPUS_SUBDIR[family]);
  if (!existsSync(dir)) {
    throw new Error(
      `memrain bench: no ${family} corpus at ${dir} ` +
        `(--corpus takes the ROOT holding ${Object.values(FAMILY_CORPUS_SUBDIR).join("/")})`,
    );
  }
  return dir;
}

/** Ledger state at one instant: what was billed, and how many calls billed it. */
export interface SpendLedgerSnapshot {
  /** Rows in `mcp_spend_log` — one per completed paid call. */
  calls: number;
  /** Their total, in USD. */
  usd: number;
}

/**
 * Read the whole ledger, not one client's day.
 *
 * `daySpendUsd` filters on `client_id`, and a bench runs with no client in
 * scope — `bookSpend` books it NULL, the same as any operator-side call — so
 * the per-client reader structurally cannot see a bench's own spend, and
 * asserting zero through it would assert nothing at all. The unfiltered sum
 * can. (Rows written FOR a client do carry its id since the spend context
 * landed; that is exactly the spend a bench never produces.)
 *
 * `calls` is read alongside the amount because an UNPRICED model books a $0 row
 * (`budget.ts:522-529`): a run that really called Bedrock and a run that made
 * no call at all are both "$0.0000" by amount, and only the count tells them
 * apart. That is exactly the illusion this bench exists to refuse.
 */
export async function spendLedgerSnapshot(engine: Engine): Promise<SpendLedgerSnapshot> {
  const r = await engine.query<{ calls: number; cents: number }>(
    `SELECT count(*)::int AS calls, COALESCE(SUM(spend_cents), 0)::float8 AS cents
       FROM mcp_spend_log`,
  );
  const row = r.rows[0];
  return { calls: Number(row?.calls ?? 0), usd: Number(row?.cents ?? 0) / 100 };
}

async function runFamily(
  storage: Storage,
  family: BenchFamily,
  dir: string,
): Promise<BenchFamilyReport> {
  switch (family) {
    case "push": {
      const run = await runCorpus(storage, loadCorpus(dir));
      return { family: "push", scores: scorePush(run.scored) };
    }
    case "continuity": {
      // The probes reduce to the same `ScoredTurn` shape the push corpus does,
      // and are scored by the same `scorePush`. Continuity's "leak rate" IS
      // `falseFireRate` over probes labelled to return nothing; a second scorer
      // would be a second arithmetic to keep correct for no new information.
      const run = await runContinuityCorpus(storage, loadContinuityCorpus(dir));
      return { family: "continuity", scores: scorePush(run.scored) };
    }
    case "fidelity": {
      // Fidelity cannot be expressed as a set score — `distortionRate` grades
      // fields on rows that already matched — so the family owns its own
      // reducer rather than borrowing `scorePush`.
      const run = await runFidelityCorpus(storage, loadFidelityCorpus(dir));
      return fidelityFamilyReport(run);
    }
  }
}

/**
 * Run the selected families against an already-open Storage.
 *
 * Split out from `runBenchCli` so a test can hand in its own database and read
 * the report object instead of parsing printed text — and so the spend
 * assertion can bracket exactly this call.
 */
export async function runBenchOnStorage(
  storage: Storage,
  opts: BenchOptions = {},
): Promise<BenchReport> {
  const root = opts.corpus ?? SHIPPED_CORPUS_ROOT;
  const selector = opts.family ?? "all";
  const families: BenchFamily[] =
    selector === "all" ? [...BENCH_FAMILIES] : [selector];

  // Resolve every directory before running any of them: a typo'd `--corpus`
  // should cost a message, not a completed push family followed by a failure.
  const dirs = families.map((f) => corpusDirFor(root, f));

  clearPaidEnvKnobs();

  const before = await spendLedgerSnapshot(storage.engine());
  const reports: BenchFamilyReport[] = [];
  for (let i = 0; i < families.length; i++) {
    // Each family truncates between its own fixtures, but the in-process caches
    // and the facts queue outlive a TRUNCATE. Clearing them here keeps a family
    // from starting inside the previous family's warm state.
    await resetProcessGlobals(storage.engine());
    reports.push(await runFamily(storage, families[i]!, dirs[i]!));
  }
  const after = await spendLedgerSnapshot(storage.engine());

  if (after.calls > before.calls) {
    process.stderr.write(
      `[bench] WARNING: ${after.calls - before.calls} paid model call(s) were booked ` +
        `during a stub run — the arm that made them is not stubbed.\n`,
    );
  }

  return {
    corpus: opts.corpus ?? "shipped",
    mode: "stub",
    spendUsd: after.usd - before.usd,
    families: reports,
  };
}

/**
 * The command. Returns the process exit code.
 *
 * 0 whenever the run completed — the numbers never decide this. Non-zero only
 * when the bench refused to run.
 */
export async function runBenchCli(opts: BenchOptions = {}): Promise<number> {
  // Refused first, so the refusal costs no database and no billing. Exit 1 is
  // the same code every other usage error in this CLI returns: the bench has no
  // second failure kind to distinguish, because a bad SCORE never fails here.
  if (opts.live && opts.family !== "fidelity") {
    process.stderr.write(`${LIVE_REFUSAL}\n`);
    return 1;
  }

  const tmp = mkdtempSync(join(tmpdir(), "memrain-bench-"));
  const storage = new Storage({ dbPath: join(tmp, "db") });
  try {
    return await withStorage(storage, async () => {
      if (opts.live) {
        const root = opts.corpus ?? SHIPPED_CORPUS_ROOT;
        const dir = corpusDirFor(root, "fidelity");
        clearPaidEnvKnobs();
        const run = await runFidelityCorpusLive(storage, loadFidelityCorpus(dir));
        process.stdout.write(
          opts.json
            ? `${JSON.stringify(
                {
                  mode: "live",
                  modelId: run.modelId,
                  capUsd: run.capUsd,
                  spendUsd: run.spentUsd,
                  scores: run.scores,
                  recallCI: run.recallCI,
                  precisionCI: run.precisionCI,
                  fixturesSkipped: run.fixturesSkipped,
                },
                null,
                2,
              )}\n`
            : `${formatFidelityLive(run)}\n`,
        );
        return 0;
      }
      const report = await runBenchOnStorage(storage, opts);
      process.stdout.write(
        opts.json
          ? `${JSON.stringify(scoreboardJson(report), null, 2)}\n`
          : `${formatScoreboard(report)}\n`,
      );
      return 0;
    });
  } finally {
    // Outside withStorage so the scratch directory goes even when the database
    // never opened — it is this command's, not the engine's.
    rmSync(tmp, { recursive: true, force: true });
  }
}
