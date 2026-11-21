/**
 * `memrain think` — answer a question by paid Sonnet synthesis across the brain,
 * bounded by a USD budget. Opt-in, default-OFF (set MEMRAIN_THINK=1 to run live),
 * the deep-synthesis slice of the agent layer.
 *
 * Thin CLI wrapper over runThink: open storage, synthesize, print the answer
 * (or the structured report with --json). Persistence wiring: `--save` writes
 * the synthesis to a synthesis/<slug> page +
 * synthesis_evidence rows; `--take "<claim>"` queues a take pinned to the
 * saved page (or the first --anchor). `--since/--until/--anchor/--rounds/
 * --model/--with-calibration` map 1:1 onto ThinkOptions.
 */
import { Storage } from "../core/storage.ts";
import { withStorage } from "./with-storage.ts";
import { loadConfig } from "../core/config.ts";
import { runThink } from "../core/synthesis/think.ts";
import {
  persistThinkSynthesis,
  renderAnswerWithGaps,
  saveThinkTake,
} from "../core/synthesis/think-persist.ts";
import type { SonnetFn } from "../core/llm/sonnet.ts";
import type { SearchHit } from "../core/search/hybrid.ts";

export interface ThinkCliArgs {
  question: string;
  k?: number;
  maxTakes?: number;
  maxBudgetUsd?: number;
  json?: boolean;
  /** Persist the synthesis as a synthesis/<slug> page + evidence rows. */
  save?: boolean;
  /** Queue this claim as a take pinned to the saved page / first anchor. */
  take?: string;
  since?: string;
  until?: string;
  anchors?: string[];
  rounds?: number;
  modelId?: string;
  withCalibration?: boolean;
  configPath?: string;
  /** Test seam — inject a fake model; bypasses the live-run env gate. */
  sonnetFn?: SonnetFn;
  /** Test seam — deterministic page retriever (no Bedrock embedding). */
  pagesFn?: (question: string, k: number) => Promise<SearchHit[]>;
}

export async function runThinkCli(args: ThinkCliArgs): Promise<void> {
  const storage = new Storage(loadConfig(args.configPath));
  return withStorage(storage, async () => {
    const report = await runThink(storage, {
      question: args.question,
      ...(args.k !== undefined ? { k: args.k } : {}),
      ...(args.maxTakes !== undefined ? { maxTakes: args.maxTakes } : {}),
      ...(args.maxBudgetUsd !== undefined ? { maxBudgetUsd: args.maxBudgetUsd } : {}),
      ...(args.since !== undefined ? { since: args.since } : {}),
      ...(args.until !== undefined ? { until: args.until } : {}),
      ...(args.anchors && args.anchors.length > 0 ? { anchors: args.anchors } : {}),
      ...(args.rounds !== undefined ? { rounds: args.rounds } : {}),
      ...(args.modelId !== undefined ? { modelId: args.modelId } : {}),
      ...(args.withCalibration ? { withCalibration: true } : {}),
      ...(args.sonnetFn ? { sonnetFn: args.sonnetFn } : {}),
      ...(args.pagesFn ? { pagesFn: args.pagesFn } : {}),
    });

    // Persistence side-effects run BEFORE the report prints so their outcome
    // can be included; both are no-ops when the synthesis is empty.
    let savedSlug: string | null = null;
    const saveWarnings: string[] = [];
    if (args.save) {
      const saved = await persistThinkSynthesis(storage, {
        question: args.question,
        result: report,
      });
      savedSlug = saved.slug || null;
      saveWarnings.push(...saved.warnings);
    }
    let takeSaved: { take_key: string; inserted: boolean } | null = null;
    if (args.take !== undefined) {
      const anchorSlug = savedSlug ?? args.anchors?.[0];
      if (!anchorSlug) {
        console.error(
          "memrain think: --take needs an anchor page — pass --save (pins to the saved synthesis) or --anchor <slug>",
        );
        process.exitCode = 1;
      } else {
        takeSaved = await saveThinkTake(storage.engine(), {
          claim: args.take,
          anchorSlug,
          ...(args.modelId !== undefined ? { modelId: args.modelId } : {}),
          ...(report.evidence ? { evidence: report.evidence } : {}),
        });
      }
    }

    if (args.json) {
      console.log(
        JSON.stringify({
          ...report,
          ...(args.save ? { saved_slug: savedSlug, save_warnings: saveWarnings } : {}),
          ...(takeSaved !== null ? { take: takeSaved } : {}),
        }),
      );
      return;
    }
    if (!report.ran) {
      console.log(`think: skipped — ${report.reason}`);
      return;
    }
    if (!report.synthesis) {
      console.log(
        `think: no synthesis (${report.synthesisStatus}): ${report.reason ?? "model output did not parse"}` +
          ` (${report.pagesGathered} pages, ${report.takesGathered} takes, spent $${report.spentUsd.toFixed(4)})`,
      );
      if (report.fallback) {
        console.log(`\n[extractive fallback, not a synthesized answer]\n${report.fallback.answer}`);
      }
      return;
    }
    const s = report.synthesis;
    console.log(renderAnswerWithGaps(s.answer, s.gaps, { heading: "Gaps:", bullet: "  - " }));
    console.log(
      `\n[${report.pagesGathered} pages, ${report.takesGathered} takes, ` +
        `${s.citations.length} citations, spent $${report.spentUsd.toFixed(4)}` +
        (report.budgetExhausted ? ", budget exhausted" : "") +
        `]`,
    );
    if (savedSlug) console.log(`saved: ${savedSlug}`);
    if (saveWarnings.length > 0) console.log(`save warnings: ${saveWarnings.join(", ")}`);
    if (takeSaved) {
      console.log(
        takeSaved.inserted
          ? `take queued (${takeSaved.take_key})`
          : "take already existed",
      );
    }
  });
}
