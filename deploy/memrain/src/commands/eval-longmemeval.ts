/**
 * `memrain eval longmemeval` — the LongMemEval-S benchmark, answered from
 * Memrain's retrieval and judged by Bedrock Claude (see
 * src/eval/longmemeval/harness.ts and docs/eval.md).
 *
 *   --dry-run [--max-usd N] [--limit N]       worst-case estimate, no paid call
 *   --out DIR --max-usd N [--limit N]         run, or resume the run in DIR
 *        [--answer-model ID] [--judge-model ID] [--dir CACHE]
 *   --out DIR --settle RESERVATION --usd N    record the billed amount of a call
 *                                             a crashed run never settled
 *
 * --limit N takes the first N questions in dataset file order, not a sample.
 *
 * Exit: 0 every selected question was scored; 1 refused, stopped (cap, price,
 * unsafe setting, bad dataset) or some questions were interrupted; 2 usage, a
 * mismatched ledger or a run directory in use; 75 a download or paid call
 * failed — try again later (the failed question is not repeated).
 */
import { readFileSync } from "node:fs";
import {
  DatasetFetchError,
  LONGMEMEVAL_S_CLEANED,
  defaultCacheDir,
  ensureDataset,
  parseDataset,
  type LmeQuestion,
} from "../eval/longmemeval/dataset.ts";
import {
  ResumeMismatch,
  RunLocked,
  estimateLongMemEval,
  runLongMemEval,
  settleReservation,
  type LmeBedrock,
  type LmeModels,
} from "../eval/longmemeval/harness.ts";
import { bedrockBoundary } from "../eval/longmemeval/bedrock.ts";

export const EX_TEMPFAIL = 75;

export interface EvalLongMemEvalOptions {
  out?: string;
  maxUsd?: number;
  dryRun?: boolean;
  limit?: number;
  settle?: string;
  usd?: number;
  /** Dataset cache directory; defaults outside the repository. */
  cacheDir?: string;
  answerModel?: string;
  judgeModel?: string;
  /** Seams for offline tests. */
  bedrock?: LmeBedrock;
  fetchFn?: typeof fetch;
  loadQuestions?: () => Promise<{ questions: LmeQuestion[]; dataset: { url: string; sha256: string } }>;
}

function usage(message: string): number {
  console.error(`memrain eval longmemeval: ${message}`);
  return 2;
}

export async function runEvalLongMemEval(opts: EvalLongMemEvalOptions): Promise<number> {
  if (opts.settle !== undefined) {
    if (!opts.out) return usage("--settle needs --out <run dir>");
    if (opts.usd === undefined || !Number.isFinite(opts.usd) || opts.usd < 0) {
      return usage("--settle needs --usd <billed amount>");
    }
    try {
      settleReservation(opts.out, opts.settle, opts.usd);
    } catch (e) {
      return usage(e instanceof Error ? e.message : String(e));
    }
    console.log(`settled ${opts.settle} at $${opts.usd}`);
    return 0;
  }
  if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1)) {
    return usage("--limit must be a positive integer");
  }
  if (opts.maxUsd !== undefined && (!Number.isFinite(opts.maxUsd) || opts.maxUsd <= 0)) {
    return usage("--max-usd must be a positive number");
  }
  if (!opts.dryRun) {
    if (opts.maxUsd === undefined) return usage("a paid run needs --max-usd (use --dry-run to price it first)");
    if (!opts.out) return usage("a paid run needs --out <run dir>");
  }
  const models: Partial<LmeModels> = {
    ...(opts.answerModel ? { answer: opts.answerModel } : {}),
    ...(opts.judgeModel ? { judge: opts.judgeModel } : {}),
  };

  let loaded: { questions: LmeQuestion[]; dataset: { url: string; sha256: string } };
  try {
    loaded = opts.loadQuestions
      ? await opts.loadQuestions()
      : await loadPinned(opts.cacheDir ?? defaultCacheDir(), opts.fetchFn);
  } catch (e) {
    console.error(`memrain eval longmemeval: ${e instanceof Error ? e.message : String(e)}`);
    return e instanceof DatasetFetchError ? EX_TEMPFAIL : 1;
  }

  try {
    if (opts.dryRun) {
      const estimate = estimateLongMemEval({
        questions: loaded.questions,
        models,
        ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
        ...(opts.maxUsd !== undefined ? { maxUsd: opts.maxUsd } : {}),
      });
      console.log(JSON.stringify({ dataset: loaded.dataset, ...estimate }, null, 2));
      return 0;
    }
    const result = await runLongMemEval({
      questions: loaded.questions,
      dataset: loaded.dataset,
      outDir: opts.out!,
      maxUsd: opts.maxUsd!,
      models,
      bedrock: opts.bedrock ?? bedrockBoundary(),
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      log: (line) => console.error(`[longmemeval] ${line}`),
    });
    console.log(JSON.stringify({ outcome: result.outcome, ...(result.message ? { message: result.message } : {}), ...result.summary }, null, 2));
    if (result.outcome === "complete") return 0;
    console.error(`memrain eval longmemeval: stopped (${result.outcome}): ${result.message ?? ""}`);
    return result.outcome === "call_failed" ? EX_TEMPFAIL : 1;
  } catch (e) {
    console.error(`memrain eval longmemeval: ${e instanceof Error ? e.message : String(e)}`);
    return e instanceof ResumeMismatch || e instanceof RunLocked ? 2 : 1;
  }
}

async function loadPinned(
  cacheDir: string,
  fetchFn: typeof fetch | undefined,
): Promise<{ questions: LmeQuestion[]; dataset: { url: string; sha256: string } }> {
  const path = await ensureDataset(LONGMEMEVAL_S_CLEANED, { cacheDir, ...(fetchFn ? { fetchFn } : {}) });
  return {
    questions: parseDataset(readFileSync(path, "utf8")),
    dataset: { url: LONGMEMEVAL_S_CLEANED.url, sha256: LONGMEMEVAL_S_CLEANED.sha256 },
  };
}
