/**
 * Auto-think phase — runs a configured set of `think` questions on a schedule
 * and persists each answer as a synthesis DRAFT page under `drafts/think/`, so
 * standing questions ("what's unresolved about X?") get re-answered as the brain
 * grows without a human re-asking them.
 *
 * Reuses the existing think engine (runThink) verbatim — no second synthesis
 * path. Each question is ONE Sonnet call inside runThink (no minions). A single
 * brain-wide budget is enforced across the tick by handing each per-question
 * runThink a maxBudgetUsd of the REMAINING cap and summing actual spend.
 *
 * Anti-loop: drafts are written with the ad-hoc page type "draft" (not in
 * EXTRACTION_ELIGIBLE_TYPES) under the `drafts/` prefix, so the paid facts
 * backfill and the reflections/patterns miners never re-ingest this phase's own
 * output — the same guarantee the reflections/patterns prefix exclusion gives.
 *
 * Cooldown: a DB-native check on the most recent draft's write time (no config
 * table needed). Default 0h (disabled); operator sets MEMRAIN_AUTO_THINK_COOLDOWN_HOURS.
 *
 * Paid Sonnet slice, default-OFF (MEMRAIN_AUTO_THINK). Injected `sonnetFn` bypasses
 * the flag for hermetic tests (no live Bedrock).
 */

import type { Engine } from "./../engine/interface.ts";
import type { Storage } from "../storage.ts";
import type { SearchHit } from "../search/hybrid.ts";
import { putPage } from "../pages.ts";
import { runThink, type ThinkResult } from "./think.ts";
import { renderAnswerWithGaps } from "./think-persist.ts";
import { resolveSonnetFn, resolveFactsModel, type SonnetFn } from "../llm/sonnet.ts";

export interface AutoThinkPhaseResult {
  ran: boolean;
  reason?: string;
  questionsConsidered: number;
  draftsWritten: number;
  spentUsd: number;
  budgetExhausted: boolean;
  pagesHeld: number;
  errors: string[];
}

export interface AutoThinkPhaseOptions {
  sonnetFn?: SonnetFn;
  modelId?: string;
  /** Single tenant to think within + write drafts under. Default "default". */
  sourceId?: string;
  /** Questions to run. Default parsed from MEMRAIN_AUTO_THINK_QUESTIONS (csv). */
  questions?: string[];
  /** Max questions per tick (bounds spend). Default 5. */
  maxQuestions?: number;
  /** Brain-wide USD ceiling for the whole tick. Default 2.0. */
  budgetUsd?: number;
  /** Skip if a draft was written within this many hours. Default 0 (disabled). */
  cooldownHours?: number;
  /** Test seams forwarded into runThink. */
  pagesFn?: (question: string, k: number) => Promise<SearchHit[]>;
  embedFn?: ((text: string) => Promise<number[]>) | null;
}

const SLUG_SEG = /^[a-z0-9][a-z0-9-]*$/;

function autoThinkEnabled(): boolean {
  const v = (process.env.MEMRAIN_AUTO_THINK ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

function defaultBudget(): number {
  const raw = (process.env.MEMRAIN_AUTO_THINK_BUDGET_USD ?? "").trim();
  const n = Number.parseFloat(raw);
  // An explicit 0 is a real cap ("spend nothing"), not a fallback to the default.
  return Number.isFinite(n) && n >= 0 ? n : 2.0;
}

function resolveIntConfig(v: number | undefined, envKey: string, def: number): number {
  if (typeof v === "number" && v > 0) return Math.floor(v);
  const n = Number.parseInt((process.env[envKey] ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

/** Default cooldown between paid runs per tenant. Non-zero by default so a
 *  cycle ticking every few minutes can't re-pay the same questions every tick;
 *  the operator lowers it (or 0) via MEMRAIN_AUTO_THINK_COOLDOWN_HOURS. */
const DEFAULT_COOLDOWN_HOURS = 12;
function resolveCooldownHours(v: number | undefined): number {
  if (typeof v === "number" && v >= 0) return v;
  const raw = (process.env.MEMRAIN_AUTO_THINK_COOLDOWN_HOURS ?? "").trim();
  if (raw === "") return DEFAULT_COOLDOWN_HOURS;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_COOLDOWN_HOURS;
}

function resolveQuestions(opt: string[] | undefined): string[] {
  const clean = (arr: string[]): string[] =>
    Array.from(new Set(arr.map((q) => q.trim()).filter((q) => q.length > 0)));
  if (Array.isArray(opt) && opt.length > 0) {
    const c = clean(opt.filter((q): q is string => typeof q === "string"));
    if (c.length > 0) return c;
  }
  const raw = (process.env.MEMRAIN_AUTO_THINK_QUESTIONS ?? "").trim();
  if (raw) return clean(raw.split(","));
  return [];
}

/** Deterministic SLUG_SEG-valid segment from an arbitrary question. */
function questionSlug(question: string): string {
  const seg = question
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    // Measured linear through questionSlug: 1.9 ms at 2 M chars of `-` plus a
    // rejecting `x`, ratio 1.97 on a doubling. `-` is itself in `[^a-z0-9]`, so
    // the collapse on the line above leaves every hyphen run exactly one char
    // long — the run this quantifier needs to square on cannot reach it.
    // eslint-disable-next-line regexp/no-super-linear-move
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    // Same collapse, and this one only ever sees the 60-char slice above it.
    // eslint-disable-next-line regexp/no-super-linear-move
    .replace(/-+$/g, "");
  if (SLUG_SEG.test(seg)) return seg;
  // Fallback: hash-ish digest when the question has no usable ascii-alnum.
  let h = 0;
  for (let i = 0; i < question.length; i++) h = (h * 31 + question.charCodeAt(i)) >>> 0;
  return `q-${h.toString(36)}`;
}

/** Newest draft write time for this tenant, or null when none written yet. */
async function lastDraftAt(engine: Engine, sourceId: string): Promise<number | null> {
  const { rows } = await engine.query<{ updated_at: string }>(
    `SELECT updated_at
       FROM pages
      WHERE deleted_at IS NULL
        AND source_id = $1
        AND slug LIKE 'drafts/think/%'
      ORDER BY updated_at DESC
      LIMIT 1`,
    [sourceId],
  );
  const first = rows[0];
  if (!first) return null;
  const t = Date.parse(first.updated_at);
  return Number.isFinite(t) ? t : null;
}

function renderDraftBody(question: string, result: ThinkResult): string {
  const s = result.synthesis;
  const answer = s ? renderAnswerWithGaps(s.answer, s.gaps) : "";
  return `> Auto-think draft — generated by the maintenance cycle, not human-authored.

**Question:** ${question}

## Answer
${answer}
`;
}

/**
 * Run the auto-think phase. Injected `sonnetFn` (tests) bypasses the flag gate
 * and is forwarded to runThink so no live Bedrock call is made.
 */
export async function autoThinkPhase(
  storage: Storage,
  opts: AutoThinkPhaseOptions = {},
): Promise<AutoThinkPhaseResult> {
  const base: AutoThinkPhaseResult = {
    ran: false,
    questionsConsidered: 0,
    draftsWritten: 0,
    spentUsd: 0,
    budgetExhausted: false,
    pagesHeld: 0,
    errors: [],
  };

  if (!opts.sonnetFn && !autoThinkEnabled()) {
    return { ...base, reason: "MEMRAIN_AUTO_THINK disabled" };
  }

  const questions = resolveQuestions(opts.questions);
  if (questions.length === 0) {
    return { ...base, reason: "no questions configured (MEMRAIN_AUTO_THINK_QUESTIONS)" };
  }

  const engine = storage.engine();
  const sourceId = opts.sourceId ?? "default";
  const cooldownHours = resolveCooldownHours(opts.cooldownHours);
  const maxQuestions = resolveIntConfig(opts.maxQuestions, "MEMRAIN_AUTO_THINK_MAX", 5);

  if (cooldownHours > 0) {
    const last = await lastDraftAt(engine, sourceId);
    if (last !== null && Date.now() - last < cooldownHours * 3_600_000) {
      return { ...base, reason: `cooldown active (${cooldownHours}h)` };
    }
  }

  const cap = opts.budgetUsd !== undefined && opts.budgetUsd >= 0 ? opts.budgetUsd : defaultBudget();
  const model = resolveFactsModel(opts.modelId);
  // Live mode hands runThink the real Sonnet fn so it is gated by MEMRAIN_AUTO_THINK,
  // not MEMRAIN_THINK; tests inject their fake through the same seam.
  const sonnetFn = resolveSonnetFn(opts.sonnetFn, { modelId: model });

  const limit = Math.min(questions.length, maxQuestions);
  let spent = 0;
  base.ran = true;

  for (const q of questions.slice(0, limit)) {
    base.questionsConsidered += 1;

    const remaining = cap - spent;
    if (remaining <= 0) {
      base.budgetExhausted = true;
      break;
    }

    let result: ThinkResult;
    try {
      result = await runThink(storage, {
        question: q,
        sonnetFn,
        modelId: model,
        maxBudgetUsd: remaining,
        // Scope retrieval to THIS tenant: the answer is persisted as a page
        // pinned to `sourceId`, so pages/takes from another tenant must never
        // feed it (they would become durably attributed to this source).
        sourceIds: [sourceId],
        ...(opts.pagesFn ? { pagesFn: opts.pagesFn } : {}),
        ...(opts.embedFn !== undefined ? { embedFn: opts.embedFn } : {}),
      });
    } catch (e) {
      base.errors.push(`${q}: ${String(e instanceof Error ? e.message : e)}`);
      continue;
    }

    spent += result.spentUsd;
    base.spentUsd = Number(spent.toFixed(6));
    if (result.budgetExhausted) base.budgetExhausted = true;

    // An empty synthesis (no answer / malformed output) is never persisted — the
    // same silent-success guard the CLI/MCP think paths enforce.
    if (!result.synthesis || result.synthesis.answer.trim().length === 0) {
      if (result.budgetExhausted) break;
      continue;
    }

    const slug = `drafts/think/${questionSlug(q)}`;
    try {
      const pageWrite = await putPage(storage, {
        slug,
        type: "draft",
        title: `Auto-think: ${q}`.slice(0, 200),
        markdown_body: renderDraftBody(q, result),
        source_id: sourceId,
        written_by: "auto-think",
        onlyOverwriteWriter: "auto-think",
        allowAdHocType: true,
      });
      if (pageWrite.held) base.pagesHeld += 1;
      else base.draftsWritten += 1;
    } catch (e) {
      base.errors.push(`${slug}: ${String(e instanceof Error ? e.message : e)}`);
    }
    if (result.budgetExhausted) break;
  }

  return base;
}
