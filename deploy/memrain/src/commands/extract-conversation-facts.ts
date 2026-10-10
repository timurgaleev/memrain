/**
 * `memrain extract-conversation-facts` — parse a chat transcript into turns and
 * extract structured facts from each via paid Bedrock Sonnet, bounded by a USD
 * budget. Opt-in, default-OFF (set MEMRAIN_FACTS_EXTRACTION=1 to run live), an
 * agent-layer slice the operator chose to enable.
 *
 * Pipeline: parseConversation (deterministic) → per-turn Sonnet extraction
 * (budget-gated) → addFact into entity_facts. Stops cleanly when the budget is
 * exhausted; partial progress is kept.
 */
import { readFileSync } from "node:fs";
import { Storage } from "../core/storage.ts";
import { withStorage } from "./with-storage.ts";
import { loadConfig } from "../core/config.ts";
import { parseConversation } from "../core/conversation-parser.ts";
import {
  DEFAULT_EXTRACTION_MAX_TOKENS,
  extractFactsFromTurn,
  writeExtractedFacts,
} from "../core/facts-extract.ts";
import { isOwnerSpeaker } from "../core/facts-owner.ts";
import { isPasteOnly } from "../core/transcripts/pasted-content.ts";
import { BudgetTracker, BudgetExhausted } from "../core/budget.ts";
import { resolveFactsModel, type SonnetFn } from "../core/llm/sonnet.ts";

/** Conservative worst-case usage for the pre-flight budget guard: the sanitizer
 *  caps a turn at ~12K chars (~3K input tokens) + the extractor's output cap,
 *  rounded up. Keeps the cap a near-strict pre-call ceiling. */
const WORST_CASE_USAGE = { inputTokens: 4000, outputTokens: DEFAULT_EXTRACTION_MAX_TOKENS };

export interface ExtractConvFactsOptions {
  /** Raw transcript text. */
  text: string;
  /** Provenance slug stamped on each written fact. */
  sourceSlug?: string;
  /** Fallback YYYY-MM-DD for time-only transcript formats. */
  dateContext?: string;
  /** USD ceiling for the run. Default 1.0 (MEMRAIN_FACTS_BUDGET_USD overrides). */
  maxBudgetUsd?: number;
  /** Test seam — inject a fake model; bypasses the live-run env gate. */
  sonnetFn?: SonnetFn;
  modelId?: string;
  /** Owner entity slug; omitted → MEMRAIN_OWNER_ENTITY. */
  ownerEntity?: string;
}

export interface ExtractConvFactsReport {
  ran: boolean;
  reason?: string;
  turns: number;
  factsWritten: number;
  factsSkipped: number;
  spentUsd: number;
  budgetExhausted: boolean;
}

function liveEnabled(): boolean {
  const v = (process.env["MEMRAIN_FACTS_EXTRACTION"] ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

/**
 * Calendar date a turn was spoken, for the fact's validity anchor. Without it
 * every fact from a backfilled transcript claims to have become true on the day
 * it was extracted. An epoch-anchored parse (a time-only format with no
 * `dateContext`) carries no real date, so it keeps the NULL fallback rather
 * than asserting 1970.
 */
function turnValidFrom(timestamp: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}/.test(timestamp)) return null;
  if (timestamp.startsWith("1970-")) return null;
  return timestamp.slice(0, 10);
}

function defaultBudget(): number {
  const raw = (process.env["MEMRAIN_FACTS_BUDGET_USD"] ?? "").trim();
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 1.0;
}

export async function runExtractConversationFacts(
  storage: Storage,
  opts: ExtractConvFactsOptions,
): Promise<ExtractConvFactsReport> {
  // Default-OFF: a live (paid) run requires the explicit env gate. Tests inject
  // a sonnetFn, which both bypasses the gate and avoids any spend.
  if (!opts.sonnetFn && !liveEnabled()) {
    return {
      ran: false,
      reason:
        "default-OFF: set MEMRAIN_FACTS_EXTRACTION=1 to run paid Sonnet extraction",
      turns: 0,
      factsWritten: 0,
      factsSkipped: 0,
      spentUsd: 0,
      budgetExhausted: false,
    };
  }

  const messages = parseConversation(opts.text, {
    ...(opts.dateContext ? { dateContext: opts.dateContext } : {}),
  });
  const cap = opts.maxBudgetUsd ?? defaultBudget();
  const budget = new BudgetTracker(cap, "extract-conversation-facts");
  // The model id is resolved up front so the pre-flight guard prices the same
  // model the call will use (a strict-as-possible pre-call ceiling).
  const modelId = resolveFactsModel(opts.modelId);

  let factsWritten = 0;
  let factsSkipped = 0;
  let exhausted = false;

  for (const msg of messages) {
    const turn = `${msg.speaker}: ${msg.text}`.trim();
    if (!turn) continue;
    // A turn that is nothing but a paste carries no words of the speaker's
    // own; the extractor would see an empty turn, so it is not paid for.
    if (isPasteOnly(msg.text)) continue;
    const validFrom = turnValidFrom(msg.timestamp);
    const writeOpts = {
      ...(opts.sourceSlug ? { sourceSlug: opts.sourceSlug } : {}),
      ...(validFrom ? { validFrom } : {}),
      firstParty: isOwnerSpeaker(msg.speaker),
      ...(opts.ownerEntity ? { ownerEntity: opts.ownerEntity } : {}),
    };
    // Pre-flight: don't dispatch a paid call when the worst-case cost would
    // breach the cap (also stops unpriced models — reserve returns null).
    const hold = budget.reserve(modelId, WORST_CASE_USAGE);
    if (hold === null) {
      exhausted = true;
      break;
    }
    let result;
    try {
      result = await extractFactsFromTurn(turn, {
        ...(opts.sonnetFn ? { sonnetFn: opts.sonnetFn } : {}),
        modelId,
        observationDate: validFrom,
        // The hold above sized ONE call against the cap; a truncation retry is
        // a second paid call, so the hold widens to the projected TOTAL or the
        // retry is dropped.
        canAffordRetry: (projected) => budget.widen(hold, modelId, projected),
      });
    } catch {
      // A model/network error skips this turn; never abort the batch.
      budget.release(hold);
      continue;
    }
    try {
      budget.settle(hold, result.modelId, result.usage);
    } catch (e) {
      if (e instanceof BudgetExhausted) {
        exhausted = true;
        // Still persist this last turn's facts (already paid for), then stop.
        const w = await writeExtractedFacts(storage, result.facts, writeOpts);
        factsWritten += w.written;
        factsSkipped += w.skipped;
        break;
      }
      throw e;
    }
    const w = await writeExtractedFacts(storage, result.facts, writeOpts);
    factsWritten += w.written;
    factsSkipped += w.skipped;
  }

  return {
    ran: true,
    turns: messages.length,
    factsWritten,
    factsSkipped,
    spentUsd: Number(budget.totalSpent().toFixed(6)),
    budgetExhausted: exhausted,
  };
}

export interface ExtractConvFactsCliArgs {
  /** Path to a transcript file. */
  file: string;
  sourceSlug?: string;
  dateContext?: string;
  maxBudgetUsd?: number;
  json?: boolean;
}

/** CLI entry: read a transcript file, run extraction, print the report. */
export async function runExtractConversationFactsCli(
  args: ExtractConvFactsCliArgs,
): Promise<void> {
  const text = readFileSync(args.file, "utf8");
  const storage = new Storage(loadConfig());
  return withStorage(storage, async () => {
    const report = await runExtractConversationFacts(storage, {
      text,
      ...(args.sourceSlug ? { sourceSlug: args.sourceSlug } : {}),
      ...(args.dateContext ? { dateContext: args.dateContext } : {}),
      ...(args.maxBudgetUsd !== undefined ? { maxBudgetUsd: args.maxBudgetUsd } : {}),
    });
    if (args.json) {
      console.log(JSON.stringify(report));
    } else if (!report.ran) {
      console.log(`extract-conversation-facts: skipped — ${report.reason}`);
    } else {
      console.log(
        `extract-conversation-facts: ${report.turns} turns, ${report.factsWritten} facts written` +
          ` (${report.factsSkipped} skipped), spent $${report.spentUsd.toFixed(4)}` +
          (report.budgetExhausted ? " [budget exhausted]" : ""),
      );
    }
  });
}
