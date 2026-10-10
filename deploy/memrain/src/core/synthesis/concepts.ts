/**
 * synthesize_concepts synthesis phase — global clustering of atoms into concept
 * pages, written ONLY to `synth_concepts` (+ the `synth_concept_atoms`
 * provenance link). Reads `synth_atoms`; never touches authored notes.
 *
 * Algorithm (adapted to memrain tables):
 *   1. Read all atoms with concept tags from `synth_atoms`.
 *   2. Group by concept tag.
 *   3. Filter to groups with >= 2 atoms; tier by count (T1 >=10, T2 >=5, T3 >=2).
 *   4. T1/T2: Claude Haiku synthesizes a 1-paragraph narrative. T3: deterministic stub.
 *   5. Upsert one `synth_concepts` row per group + provenance links.
 *
 * Safety: opt-in; budget-capped via `maxConcepts` (cost guard on LLM calls);
 * idempotent (concept_slug UNIQUE → upsert; provenance links re-inserted with
 * ON CONFLICT DO NOTHING); fail-open (an LLM error falls back to the
 * deterministic narrative, never aborts).
 */
import type { Engine } from "../engine/interface.ts";
import type { Storage } from "../storage.ts";
import { putPage } from "../pages.ts";
import { guardFields } from "../secret-scan.ts";
import { resolveLlmFn, type LlmFn } from "../llm/haiku.ts";
import { resolveModel } from "../llm/resolve-model.ts";
import { BudgetTracker } from "../budget.ts";
import { synthPagesEnabled, slugifyTitle } from "./atoms.ts";

const DEFAULT_MAX_CONCEPTS = 30;
/** Output side of the pre-call estimate: exactly the maxTokens this phase asks
 *  for, so it cannot be an under-estimate. The INPUT side is measured from the
 *  prompt actually built (see estimateUsage) rather than guessed — a fixed
 *  guess was an under-estimate at the prompt's permitted upper range (10 titles
 *  + 5 bodies of 500 chars is ~4.5k chars), which would let a call slip past a
 *  near-empty budget. That is the exact failure this guard exists to prevent. */
const CONCEPT_MAX_OUTPUT_TOKENS = 400;

const SYSTEM_PROMPT = `You write a 1-paragraph executive summary of a concept,
based on multiple atomic insights that reference it.

Output ONLY the summary paragraph (3-5 sentences). No headers, no JSON, no
preamble. Synthesize what the atoms collectively SAY about the concept; do not
enumerate them.`;

/** ~4 chars/token, rounded up, plus the system prompt. */
function estimateUsage(prompt: string): { inputTokens: number; outputTokens: number } {
  return {
    inputTokens: Math.ceil((prompt.length + SYSTEM_PROMPT.length) / 4) + 64,
    outputTokens: CONCEPT_MAX_OUTPUT_TOKENS,
  };
}

/** Default USD ceiling for one concepts run. Override with
 *  MEMRAIN_CONCEPTS_BUDGET_USD; the phase is opt-in and cheap, so the default is
 *  a ceiling that a healthy run never reaches rather than a tight leash. */
const DEFAULT_CONCEPTS_BUDGET_USD = 0.5;

function conceptsBudgetUsd(): number {
  const raw = process.env.MEMRAIN_CONCEPTS_BUDGET_USD;
  if (raw === undefined || raw.trim() === "") return DEFAULT_CONCEPTS_BUDGET_USD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`MEMRAIN_CONCEPTS_BUDGET_USD must be a positive number, got: ${JSON.stringify(raw)}`);
  }
  return n;
}

const TIER_T1_MIN = 10;
const TIER_T2_MIN = 5;
const TIER_T3_MIN = 2;

export type ConceptTier = "T1" | "T2" | "T3";

export interface SynthesizeConceptsOptions {
  /** Max concept groups to LLM-synthesize this run (cost guard). Default 30. */
  maxConcepts?: number;
  /**
   * USD ceiling for this run's paid calls. `maxConcepts` bounds the CALL COUNT,
   * which is not a spend bound: a long-tail corpus makes 30 calls cost whatever
   * 30 calls happen to cost, and nothing stops the phase from spending against a
   * model whose price is unknown. Absent → no USD ceiling (unchanged behaviour).
   */
  budget?: BudgetTracker;
  llmFn?: LlmFn;
  modelId?: string;
  /**
   * Storage handle for the concept page mirror (`concepts/<slug>` via putPage)
   * so concept narratives are retrievable through normal search. Absent →
   * rows only. Gated globally by MEMRAIN_SYNTH_PAGES (default ON).
   */
  storage?: Storage;
}

export interface SynthesizeConceptsResult {
  atomsSeen: number;
  groupsFound: number;
  conceptsWritten: number;
  /** Concept pages written via putPage (0 when no storage / gated off). */
  pagesWritten: number;
  tierCounts: Record<ConceptTier, number>;
  /** True when a USD ceiling stopped at least one call. The run still
   *  completes — the affected concepts keep their deterministic narrative. */
  budgetHit: boolean;
  errors: string[];
}

interface AtomRow {
  id: number;
  title: string;
  body: string;
  concepts: unknown;
}

interface ConceptGroup {
  slug: string;
  tier: ConceptTier;
  atomIds: number[];
  titles: string[];
  bodies: string[];
}

function tierFor(count: number): ConceptTier {
  if (count >= TIER_T1_MIN) return "T1";
  if (count >= TIER_T2_MIN) return "T2";
  return "T3";
}

/** Normalize a stored `concepts` JSONB into a clean string[]. Never throws. */
function parseConcepts(raw: unknown): string[] {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(v)) return [];
  return v
    .filter((c): c is string => typeof c === "string" && c.trim().length > 0)
    .map((c) => c.trim().toLowerCase());
}

/** Deterministic narrative for T3 groups (and LLM-failure fallback). */
export function deterministicNarrative(group: ConceptGroup): string {
  const n = group.titles.length;
  const top = group.titles.slice(0, 5).map((t) => `- ${t}`).join("\n");
  return `${group.tier} concept. ${n} atom${n === 1 ? "" : "s"} reference this.\nTop mentions:\n${top}`;
}

export async function synthesizeConceptsPhase(
  engine: Engine,
  opts: SynthesizeConceptsOptions = {},
): Promise<SynthesizeConceptsResult> {
  const maxConcepts = opts.maxConcepts ?? DEFAULT_MAX_CONCEPTS;
  // Default the ceiling ON. The cycle spreads its synthesis options straight
  // through, so a phase that only honours an explicitly-passed tracker has no
  // ceiling in production — which is where the money is actually spent.
  const budget = opts.budget ?? new BudgetTracker(conceptsBudgetUsd(), "synthesize-concepts");
  const budgetModel = resolveModel("utility", opts.modelId, "concepts");
  // One BudgetExhausted stops every later paid call. Without this an unpriced
  // model throws on settle without adding to spend, so reserve keeps passing
  // and the phase repeats the same unpriced call up to maxConcepts.
  let paidCallsStopped = false;
  // The call runs on the same model the budget prices.
  const llm = resolveLlmFn(opts.llmFn, { modelId: budgetModel });
  const writePages = opts.storage !== undefined && synthPagesEnabled();
  const result: SynthesizeConceptsResult = {
    atomsSeen: 0,
    groupsFound: 0,
    conceptsWritten: 0,
    pagesWritten: 0,
    tierCounts: { T1: 0, T2: 0, T3: 0 },
    budgetHit: false,
    errors: [],
  };

  const { rows } = await engine.query<AtomRow>(
    `SELECT id, title, body, concepts FROM synth_atoms`,
  );
  result.atomsSeen = rows.length;
  if (rows.length === 0) return result;

  const groups = new Map<string, { atomIds: number[]; titles: string[]; bodies: string[] }>();
  for (const r of rows) {
    for (const slug of parseConcepts(r.concepts)) {
      const g = groups.get(slug) ?? { atomIds: [], titles: [], bodies: [] };
      g.atomIds.push(Number(r.id));
      g.titles.push(r.title);
      g.bodies.push(r.body);
      groups.set(slug, g);
    }
  }

  const eligible: ConceptGroup[] = [];
  for (const [slug, g] of groups) {
    if (g.titles.length < TIER_T3_MIN) continue;
    eligible.push({ slug, tier: tierFor(g.titles.length), ...g });
  }
  result.groupsFound = eligible.length;

  // Deterministic ordering: larger groups first (most-referenced concepts get
  // the LLM budget), then alphabetical for a stable tie-break.
  eligible.sort((a, b) =>
    b.titles.length - a.titles.length || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0),
  );

  let llmCalls = 0;
  for (const group of eligible) {
    let narrative = deterministicNarrative(group);
    let modelId = opts.modelId ?? "deterministic";
    const wantLlm = group.tier === "T1" || group.tier === "T2";
    if (wantLlm && !paidCallsStopped && llmCalls < maxConcepts) {
      // Build the prompt FIRST so the pre-call estimate is measured from the
      // bytes actually sent, not from a guess about their upper bound.
      const user =
        `Concept: ${group.slug}\n` +
        `${group.titles.length} atoms reference this.\n\n` +
        `Atom titles:\n${group.titles.slice(0, 10).map((t) => `- ${t}`).join("\n")}\n\n` +
        `Atom bodies:\n${group.bodies.slice(0, 5).map((b, i) => `${i + 1}. ${b.slice(0, 500)}`).join("\n\n")}`;
      const est = estimateUsage(user);
      const hold = budget.reserve(budgetModel, est);
      if (hold === null) {
        // No room for this call — and no room for any later one either, since
        // spend only grows. Stop paying; the rest keep their deterministic text.
        result.budgetHit = true;
        paidCallsStopped = true;
      } else {
        llmCalls += 1;
        try {
          const resp = await llm({
            system: SYSTEM_PROMPT,
            user,
            maxTokens: CONCEPT_MAX_OUTPUT_TOKENS,
          });
          const txt = resp.text.trim();
          if (txt.length > 0) {
            narrative = txt;
            modelId = resp.modelId;
          }
          // Record the ACTUAL spend. Without this the tracker never accumulates
          // and the pre-call check can never fire — a guard that guards nothing.
          // A gateway that reports no usage still cost money: charge the
          // estimate rather than nothing.
          try {
            budget.settle(hold, resp.modelId, resp.usage ?? est);
          } catch (be) {
            // Cap reached, or the model has no pricing. Either way this run must
            // stop paying — an unpriced model adds nothing to `spent`, so
            // without the flag the phase would repeat it up to maxConcepts.
            result.budgetHit = true;
            paidCallsStopped = true;
            result.errors.push(
              `${group.slug}: paid calls stopped — ${be instanceof Error ? be.message : String(be)}`,
            );
          }
        } catch (e) {
          budget.release(hold);
          // Fail-open: keep the deterministic narrative.
          result.errors.push(`${group.slug}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    let title = (group.slug.split("/").pop() ?? group.slug).replace(/-/g, " ");
    try {
      // The narrative is model output over atom text, which can carry a credential.
      ({ title, narrative } = await guardFields(engine, group.slug, null, "concept", { title, narrative }));
      await engine.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO synth_concepts (concept_slug, title, narrative, tier, atom_count, generated_at, model_id)
           VALUES ($1, $2, $3, $4, $5, now(), $6)
           ON CONFLICT (concept_slug) DO UPDATE SET
             title = EXCLUDED.title,
             narrative = EXCLUDED.narrative,
             tier = EXCLUDED.tier,
             atom_count = EXCLUDED.atom_count,
             generated_at = EXCLUDED.generated_at,
             model_id = EXCLUDED.model_id`,
          [group.slug, title, narrative, group.tier, group.titles.length, modelId],
        );
        for (const atomId of group.atomIds) {
          await tx.query(
            `INSERT INTO synth_concept_atoms (concept_slug, atom_id)
             VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [group.slug, atomId],
          );
        }
      });
      result.conceptsWritten += 1;
      result.tierCounts[group.tier] += 1;
    } catch (e) {
      result.errors.push(`${group.slug} write: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    // Page mirror — concepts become retrievable through normal search (the
    // cycle's mirror phase indexes pages). Idempotent putPage upsert; a page
    // failure never loses the synth_concepts row.
    if (writePages && opts.storage) {
      const pageSlug = `concepts/${slugifyTitle(group.slug)}`;
      const mentions = group.titles.slice(0, 10).map((t) => `- ${t}`).join("\n");
      try {
        await putPage(opts.storage, {
          slug: pageSlug,
          type: "concept",
          title,
          markdown_body: `${narrative}\n\n## Atoms (${group.titles.length})\n${mentions}\n`,
          written_by: "synthesize-concepts",
        });
        result.pagesWritten += 1;
      } catch (e) {
        result.errors.push(`${group.slug} page: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  return result;
}
