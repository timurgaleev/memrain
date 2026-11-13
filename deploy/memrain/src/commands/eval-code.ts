/**
 * `memrain eval code [--json]` — the fixed code-retrieval eval against the
 * configured brain (see src/eval/code-retrieval.ts). Each search embeds its
 * query once with Titan, so a run costs one embedding per question per run.
 *
 * Exit 0 when the questions were scored, 1 when the code index is not ready
 * and a score would mean nothing.
 */
import { Storage } from "../core/storage.ts";
import { withStorage } from "./with-storage.ts";
import { loadConfig } from "../core/config.ts";
import { runCodeRetrievalEval, type CodeRetrievalOptions } from "../eval/code-retrieval.ts";

export interface EvalCodeOptions extends CodeRetrievalOptions {
  json?: boolean;
  configPath?: string;
  /** An open Storage the caller owns. */
  storage?: Storage;
}

export async function runEvalCode(opts: EvalCodeOptions): Promise<number> {
  const storage = opts.storage ?? new Storage(loadConfig(opts.configPath));
  return withStorage(storage, async () => {
    const report = await runCodeRetrievalEval(storage, opts);
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
    } else if (report.state === "unknown") {
      console.log(`code index is ${report.readiness}: nothing scored (zero hits would mean unknown, not absent)`);
    } else {
      const pct = report.hit_at_k === null ? "n/a" : `${(report.hit_at_k * 100).toFixed(0)}%`;
      console.log(
        `code retrieval: hit@${report.k} ${pct} over ${report.scored} indexed question(s) of ` +
          `${report.questions.length}; top-1 stable across ${report.runs} runs: ${report.top1_stable}`,
      );
      for (const q of report.questions) {
        const state = !q.indexed ? "NOT INDEXED" : q.hit ? `hit @${q.rank}` : "miss";
        console.log(`  ${q.id} ${state.padEnd(12)} ${q.symbol} (${q.path})`);
      }
    }
    return report.state === "scored" ? 0 : 1;
  }, { owned: opts.storage === undefined });
}
