/**
 * deep-synth — a slower, opt-in Sonnet synthesis CADENCE distinct from the Haiku
 * dream-synthesis tick (atoms→concepts→takes, MEMRAIN_DREAM_SYNTHESIS). Where that
 * chain DERIVES structure with cheap Claude Haiku, deep-synth runs the paid S2
 * `runThink` pipeline (GATHER → SYNTHESIZE) over a small set of standing
 * questions and REPORTS across the corpus with citations.
 *
 * Standing questions: supplied explicitly, else the top `synth_concepts` titles
 * (memrain's own primitive — listConcepts) treated as questions. The auto-think
 * phase runs `think` over each question, budget-capped, default-OFF, and (by
 * default) returns/stages the syntheses rather than committing them. Questions
 * come from memrain's synth_concepts read, and a BudgetTracker driven through a
 * recording wrapper holds the SHARED cap across every question without touching
 * runThink.
 *
 * memrain stance: synthesis READS the corpus + synth_* store; it writes NOTHING
 * back here — the syntheses are RETURNED. No new schema, no migration. A caller
 * (the cycle) decides what, if anything, to persist. Opt-in (MEMRAIN_DEEP_SYNTH),
 * USD-budget-capped, Sonnet injected via `sonnetFn`; NO live Bedrock in tests.
 */
import type { Storage } from "../storage.ts";
import type { SearchHit } from "../search/hybrid.ts";
import { resolveSonnetFn, type SonnetFn, type SonnetUsage } from "../llm/sonnet.ts";
import { resolveModel } from "../llm/resolve-model.ts";
import { BudgetTracker, BudgetExhausted, type BudgetHold } from "../budget.ts";
import { runThink, type ThinkSynthesis, type ThinkResult } from "./think.ts";
import { listConcepts } from "./reads.ts";

export const DEEP_SYNTH_PROMPT_VERSION = "v1-sonnet";

const DEFAULT_MAX_QUESTIONS = 5;
const DEFAULT_BUDGET_USD = 1.0;
/** Per-question output-token cap for the pre-flight estimate — matches runThink's
 *  DEFAULT_OUTPUT_TOKENS so the guard prices the same envelope the call uses. */
const ESTIMATE_OUTPUT_TOKENS = 1500;
/** Conservative input-side allowance (chars) for the pre-flight budget guard:
 *  the think system prompt + a full <pages>/<takes> evidence blob. ~5K tokens at
 *  ~4 chars/token. A fixed floor so a near-empty budget can't slip one more paid
 *  question past. */
const ESTIMATE_INPUT_CHARS = 20_000;

export interface DeepSynthItem {
  question: string;
  synthesis: ThinkSynthesis;
  pagesGathered: number;
  takesGathered: number;
  unverified_quotes?: ThinkResult["unverified_quotes"];
  quote_check?: ThinkResult["quote_check"];
}

export interface DeepSynthOptions {
  /** Standing questions to synthesize. Default: top synth_concepts titles. */
  questions?: string[];
  /** Max questions per run (default 5; MEMRAIN_DEEP_SYNTH_MAX_QUESTIONS overrides). */
  maxQuestions?: number;
  /** USD ceiling for the whole run (default 1.0; MEMRAIN_DEEP_SYNTH_BUDGET_USD). */
  maxBudgetUsd?: number;
  /** Shared budget across questions. Default: a fresh cap from maxBudgetUsd/env. */
  budget?: BudgetTracker;
  /** Test seam — inject a fake model; bypasses the live-run env gate. */
  sonnetFn?: SonnetFn;
  modelId?: string;
  /** Page hits to gather per question (forwarded to runThink). */
  k?: number;
  /**
   * Test seam — inject the page retriever. hybridSearch has no offline
   * query-embedder, so tests supply a deterministic fake here (as in think.ts)
   * rather than hit Bedrock.
   */
  pagesFn?: (question: string, k: number) => Promise<SearchHit[]>;
  /** Stops the run before the next question (the cycle lock was lost). */
  signal?: AbortSignal;
}

export interface DeepSynthResult {
  ran: boolean;
  reason?: string;
  /** Standing questions actually dispatched (may be < available on budget-out). */
  questionsAsked: number;
  /** One entry per question that produced a non-empty synthesis. */
  syntheses: DeepSynthItem[];
  spentUsd: number;
  budgetExhausted: boolean;
}

function liveEnabled(): boolean {
  const v = (process.env["MEMRAIN_DEEP_SYNTH"] ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

function defaultBudget(): number {
  const raw = (process.env["MEMRAIN_DEEP_SYNTH_BUDGET_USD"] ?? "").trim();
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BUDGET_USD;
}

function defaultMaxQuestions(): number {
  const raw = (process.env["MEMRAIN_DEEP_SYNTH_MAX_QUESTIONS"] ?? "").trim();
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 50 ? n : DEFAULT_MAX_QUESTIONS;
}

/** Worst-case usage for the per-question pre-call budget gate, derived from a
 *  fixed evidence allowance + the question text (~4 chars/token). */
function estimateUsage(question: string): SonnetUsage {
  return {
    inputTokens: Math.ceil((ESTIMATE_INPUT_CHARS + question.length) / 4),
    outputTokens: ESTIMATE_OUTPUT_TOKENS,
  };
}

/**
 * Derive standing questions from the top synth_concepts titles (by atom_count).
 * Deterministic, no LLM. Fail-open to [] on a pre-045 brain (listConcepts already
 * swallows the missing-table error). Blank titles are dropped.
 */
async function deriveStandingQuestions(
  storage: Storage,
  limit: number,
): Promise<string[]> {
  const concepts = await listConcepts(storage.engine(), limit);
  return concepts
    .map((c) => (typeof c.title === "string" ? c.title.trim() : ""))
    .filter((t) => t.length > 0)
    .slice(0, limit);
}

/**
 * Run one deep-synthesis cadence pass. Default-OFF: a live (paid) run needs
 * MEMRAIN_DEEP_SYNTH=1; tests inject a sonnetFn, which both bypasses the gate and
 * avoids spend. The phase owns ONE BudgetTracker shared across every question:
 * a `reserve` pre-flight holds each question's estimate (or skips a question
 * that can't be afforded), and a recording wrapper around the model seam settles
 * that hold with each real call's usage (so runThink stays untouched).
 * Fail-open: a question whose synthesis is empty or whose model call errors is
 * skipped, not thrown.
 */
export async function runDeepSynthPhase(
  storage: Storage,
  opts: DeepSynthOptions = {},
): Promise<DeepSynthResult> {
  if (!opts.sonnetFn && !liveEnabled()) {
    return blank("default-OFF: set MEMRAIN_DEEP_SYNTH=1 to run paid Sonnet deep synthesis");
  }

  const maxQuestions = opts.maxQuestions ?? defaultMaxQuestions();
  const supplied = (opts.questions ?? [])
    .map((q) => (typeof q === "string" ? q.trim() : ""))
    .filter((q) => q.length > 0);
  const questions = (
    supplied.length > 0 ? supplied : await deriveStandingQuestions(storage, maxQuestions)
  ).slice(0, maxQuestions);

  if (questions.length === 0) {
    return { ...blank("no standing questions (empty synth_concepts and none supplied)"), ran: true };
  }

  const modelId = resolveModel("deep", opts.modelId);
  const budget = opts.budget ?? new BudgetTracker(opts.maxBudgetUsd ?? defaultBudget(), "deep-synth");

  // Recording wrapper: charge each real (paid) call to the SHARED phase budget
  // AFTER it returns, so the cap holds across questions without editing runThink.
  // The question's first call settles its hold; any further call is recorded.
  // A ceiling hit is captured (not rethrown) so the current synthesis is still
  // returned and the loop stops cleanly on the next iteration.
  let budgetHit = false;
  let questionHold: BudgetHold | null = null;
  const baseSonnet = resolveSonnetFn(opts.sonnetFn);
  const recordingSonnet: SonnetFn = async (input) => {
    const resp = await baseSonnet(input);
    try {
      if (questionHold && !questionHold.done) budget.settle(questionHold, resp.modelId, resp.usage);
      else budget.record(resp.modelId, resp.usage);
    } catch (e) {
      if (e instanceof BudgetExhausted) budgetHit = true;
      else throw e;
    }
    return resp;
  };

  const syntheses: DeepSynthItem[] = [];
  let questionsAsked = 0;
  let budgetExhausted = false;

  for (const question of questions) {
    if (opts.signal?.aborted) break;
    // Pre-flight: don't dispatch a paid think when the worst-case cost would
    // breach the shared cap (also stops unpriced models — reserve → null).
    const hold = budget.reserve(modelId, estimateUsage(question));
    if (hold === null) {
      budgetExhausted = true;
      break;
    }
    questionHold = hold;
    questionsAsked += 1;
    let res: Awaited<ReturnType<typeof runThink>>;
    try {
      res = await runThink(storage, {
        question,
        sonnetFn: recordingSonnet,
        modelId,
        ...(opts.k !== undefined ? { k: opts.k } : {}),
        ...(opts.pagesFn ? { pagesFn: opts.pagesFn } : {}),
      });
    } finally {
      // A question whose call failed before costing gives its hold back.
      budget.release(hold);
    }
    if (res.synthesis) {
      syntheses.push({
        question,
        synthesis: res.synthesis,
        pagesGathered: res.pagesGathered,
        takesGathered: res.takesGathered,
        ...(res.unverified_quotes !== undefined ? { unverified_quotes: res.unverified_quotes } : {}),
        ...(res.quote_check !== undefined ? { quote_check: res.quote_check } : {}),
      });
    }
    // The wrapper tipped the shared ceiling on this question — its synthesis is
    // kept (already paid for); stop before spending on the next one.
    if (budgetHit) {
      budgetExhausted = true;
      break;
    }
  }

  return {
    ran: true,
    questionsAsked,
    syntheses,
    spentUsd: Number(budget.totalSpent().toFixed(6)),
    budgetExhausted,
  };
}

function blank(reason: string): DeepSynthResult {
  return {
    ran: false,
    reason,
    questionsAsked: 0,
    syntheses: [],
    spentUsd: 0,
    budgetExhausted: false,
  };
}
