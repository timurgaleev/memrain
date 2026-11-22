/**
 * `memrain extract-conversation-facts` — parse a chat transcript into turns and
 * extract structured facts from each via paid Bedrock Sonnet, bounded by a USD
 * budget. Opt-in, default-OFF (set MEMRAIN_FACTS_EXTRACTION=1 to run live), an
 * agent-layer slice the operator chose to enable.
 *
 * Pipeline: parseConversation (deterministic) → per-turn Sonnet extraction
 * (budget-gated) → addFact into entity_facts. Stops cleanly when the budget is
 * exhausted; partial progress is kept.
 *
 * A turn the model declines to read (a refusal or a content filter) is read
 * once more as two halves, so one passage does not cost the facts around it;
 * what still declines is counted, never logged by its text. A fact restating a
 * claim the speaker asked to keep quiet is stored private.
 */
import { readFileSync } from "node:fs";
import { Storage } from "../core/storage.ts";
import { withStorage } from "./with-storage.ts";
import { loadConfig } from "../core/config.ts";
import { parseConversation } from "../core/conversation-parser.ts";
import {
  DEFAULT_EXTRACTION_MAX_TOKENS,
  EXTRACT_WINDOW_CHARS,
  extractFactsFromTurn,
  markKeptQuiet,
  splitDeclinedWindow,
  writeExtractedFacts,
  type ExtractTurnResult,
  type ExtractedFact,
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
  /** Facts the model returned that failed to write (a subset of factsSkipped). */
  factsFailed: number;
  /** Turns the model declined to read in part or whole, even as two halves. */
  declinedWindows: number;
  /** Facts stored private because their speaker asked to keep the claim quiet. */
  keptQuiet: number;
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
      factsFailed: 0,
      declinedWindows: 0,
      keptQuiet: 0,
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
  const modelId = resolveFactsModel(opts.modelId, "facts_extract");

  let factsWritten = 0;
  let factsSkipped = 0;
  let factsFailed = 0;
  let declinedWindows = 0;
  let keptQuiet = 0;
  let exhausted = false;

  // One budgeted extractor call. "refused": the cap leaves no room for a
  // worst-case call; "error": the call threw (the text is skipped);
  // `overCap`: the call was paid for but pushed the run past its cap, so its
  // facts are still written and the run stops.
  type TurnCall = { result: ExtractTurnResult; overCap: boolean } | "refused" | "error";
  const callTurn = async (text: string, observationDate: string | null): Promise<TurnCall> => {
    // Pre-flight: don't dispatch a paid call when the worst-case cost would
    // breach the cap (also stops unpriced models — reserve returns null).
    const hold = budget.reserve(modelId, WORST_CASE_USAGE);
    if (hold === null) return "refused";
    let result: ExtractTurnResult;
    try {
      result = await budget.track(() => extractFactsFromTurn(text, {
        ...(opts.sonnetFn ? { sonnetFn: opts.sonnetFn } : {}),
        modelId,
        observationDate,
        // The hold above sized ONE call against the cap; a truncation retry is
        // a second paid call, so the hold widens to the projected TOTAL or the
        // retry is dropped.
        canAffordRetry: (projected) => budget.widen(hold, modelId, projected),
      }));
    } catch {
      // A model/network error skips this text; never abort the batch.
      budget.release(hold);
      return "error";
    }
    try {
      budget.settle(hold, result.modelId, result.usage);
    } catch (e) {
      if (e instanceof BudgetExhausted) return { result, overCap: true };
      throw e;
    }
    return { result, overCap: false };
  };

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
    // The keep-quiet match reads the text the facts came from, speaker label
    // included: an assistant's "I will keep that quiet" names no claim.
    const write = async (text: string, facts: readonly ExtractedFact[]): Promise<void> => {
      const marked = markKeptQuiet(text, facts);
      keptQuiet += marked.filter((f) => f.keep_private === true).length;
      const w = await writeExtractedFacts(storage, marked, writeOpts);
      factsWritten += w.written;
      factsSkipped += w.skipped;
      factsFailed += w.failed;
    };

    const first = await callTurn(turn, validFrom);
    if (first === "refused") {
      exhausted = true;
      break;
    }
    if (first === "error") continue;
    if (first.result.outcome !== "declined") {
      await write(turn, first.result.facts);
      if (first.overCap) {
        exhausted = true;
        break;
      }
      continue;
    }
    // Declined: read the turn once more as two halves, each under the
    // speaker's label. No further splitting.
    const halves = first.overCap ? null : splitDeclinedWindow(msg.text.slice(0, EXTRACT_WINDOW_CHARS));
    if (halves === null) {
      declinedWindows += 1;
      if (first.overCap) {
        exhausted = true;
        break;
      }
      continue;
    }
    let stillDeclined = false;
    for (const half of halves) {
      const text = `${msg.speaker}: ${half.text}`;
      const r = await callTurn(text, validFrom);
      if (r === "refused") {
        exhausted = true;
        stillDeclined = true;
        break;
      }
      if (r === "error") continue;
      if (r.result.outcome === "declined") stillDeclined = true;
      else await write(text, r.result.facts);
      if (r.overCap) {
        exhausted = true;
        break;
      }
    }
    if (stillDeclined) declinedWindows += 1;
    if (exhausted) break;
  }

  return {
    ran: true,
    turns: messages.length,
    factsWritten,
    factsSkipped,
    factsFailed,
    declinedWindows,
    keptQuiet,
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
          ` (${report.factsSkipped} skipped, ${report.factsFailed} failed), spent $${report.spentUsd.toFixed(4)}` +
          (report.declinedWindows > 0 ? `, ${report.declinedWindows} turn(s) declined by the model` : "") +
          (report.keptQuiet > 0 ? `, ${report.keptQuiet} fact(s) kept private on request` : "") +
          (report.budgetExhausted ? " [budget exhausted]" : ""),
      );
    }
    // A fact that failed to write is data lost, not a deliberate skip.
    if (report.factsFailed > 0) process.exitCode = 1;
  });
}
