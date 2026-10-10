/**
 * Drift phase — flags takes whose underlying evidence has SHIFTED since the take
 * was made, so a stale opinion doesn't quietly keep its weight after the source
 * it rested on changed.
 *
 * Detection (deterministic, no LLM): a take is a drift candidate when its source
 * document has been re-ingested (documents.updated_at) AFTER the take was
 * generated. Only soft-band takes (weight 0.3..0.85) are considered — hard facts
 * (>0.85) don't drift and very-low hunches (<0.3) aren't actionable yet. Rejected
 * takes are skipped. Every candidate is tenant-scoped through the take's source
 * document's source_id.
 *
 * Judge (ONE Sonnet call — a single-LLM judge):
 * the current source text for each candidate is gathered and a single batched
 * call decides, per take, whether the claim STILL HOLDS. Drifted takes (claim no
 * longer supported) are written into one `drift-reports/<date>` page for operator
 * review — this phase never mutates a take's weight itself.
 *
 * DELIBERATE: memrain has no minion runtime, so the
 * per-take judge fan-out becomes one batched Sonnet call.
 *
 * Anti-loop: the report is written with the ad-hoc page type "drift-report" (not
 * in EXTRACTION_ELIGIBLE_TYPES) under the `drift-reports/` prefix, so the paid
 * facts backfill and the reflections/patterns miners never re-ingest it.
 *
 * Paid Sonnet slice, default-OFF (MEMRAIN_DRIFT). Injected `sonnetFn` bypasses the
 * flag for hermetic tests (no live Bedrock).
 */

import { resolveModel } from "../llm/resolve-model.ts";
import type { Engine } from "./../engine/interface.ts";
import type { Storage } from "../storage.ts";
import { putPage } from "../pages.ts";
import { resolveSonnetFn, type SonnetFn, type SonnetUsage } from "../llm/sonnet.ts";
import { sanitizeForPrompt } from "../llm/sanitize.ts";
import { BudgetTracker, BudgetExhausted } from "../budget.ts";
import { callWithTruncationRetry } from "../llm/truncation.ts";
import { parseModelJson } from "../llm/json-output.ts";
import { quarantineFilterFragment } from "../quarantine.ts";

export interface DriftPhaseResult {
  ran: boolean;
  reason?: string;
  candidatesConsidered: number;
  driftedFlagged: number;
  reportSlug?: string;
  spentUsd: number;
  budgetExhausted: boolean;
  errors: string[];
}

export interface DriftPhaseOptions {
  sonnetFn?: SonnetFn;
  modelId?: string;
  /** Single tenant to scan takes for + write the report under. Default "default". */
  sourceId?: string;
  /** Max drift candidates judged per tick (bounds spend). Default 12. */
  maxCandidates?: number;
  budget?: BudgetTracker;
  /** Hours to wait between paid runs per tenant (default 12; env
   *  MEMRAIN_DRIFT_COOLDOWN_HOURS). Stops re-judging + re-paying the same shifted
   *  takes every cycle tick until their evidence resolves. */
  cooldownHours?: number;
}

/** Default cooldown between paid drift runs per tenant. */
const DEFAULT_DRIFT_COOLDOWN_HOURS = 12;
function resolveDriftCooldownHours(v: number | undefined): number {
  if (typeof v === "number" && v >= 0) return v;
  const raw = (process.env.MEMRAIN_DRIFT_COOLDOWN_HOURS ?? "").trim();
  if (raw === "") return DEFAULT_DRIFT_COOLDOWN_HOURS;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DRIFT_COOLDOWN_HOURS;
}

/** Newest drift-report write time for this tenant, or null when none. */
async function lastDriftReportAt(
  engine: Engine,
  sourceId: string,
): Promise<number | null> {
  const { rows } = await engine.query<{ updated_at: string }>(
    `SELECT updated_at FROM pages
      WHERE deleted_at IS NULL AND source_id = $1 AND slug LIKE 'drift-reports/%'
      ORDER BY updated_at DESC LIMIT 1`,
    [sourceId],
  );
  const first = rows[0];
  if (!first) return null;
  const t = Date.parse(first.updated_at);
  return Number.isFinite(t) ? t : null;
}

const SLUG_SEG = /^[a-z0-9][a-z0-9-]*$/;

function driftEnabled(): boolean {
  const v = (process.env.MEMRAIN_DRIFT ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

function defaultBudget(): number {
  const raw = (process.env.MEMRAIN_DRIFT_BUDGET_USD ?? "").trim();
  const n = Number.parseFloat(raw);
  // An explicit 0 is a real cap ("spend nothing"), not a fallback to the default.
  return Number.isFinite(n) && n >= 0 ? n : 1.0;
}

function resolveIntConfig(v: number | undefined, envKey: string, def: number): number {
  if (typeof v === "number" && v > 0) return Math.floor(v);
  const n = Number.parseInt((process.env[envKey] ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

function estimateUsage(chars: number, maxOutputTokens: number): SonnetUsage {
  return { inputTokens: Math.ceil(chars / 4), outputTokens: maxOutputTokens };
}

interface DriftCandidate {
  takeId: number;
  claim: string;
  weight: number;
  sourceRef: string;
  sourcePath: string;
  evidence: string;
}

async function gatherCandidates(
  engine: Engine,
  sourceId: string,
  limit: number,
): Promise<DriftCandidate[]> {
  // Takes whose source document changed after the take was generated. The
  // current source text is stitched from the document's chunks (bounded).
  const { rows } = await engine.query<{
    take_id: number;
    claim_text: string;
    weight: number;
    source_ref: string;
    source_path: string;
    evidence: string | null;
  }>(
    `SELECT t.id AS take_id, t.claim_text, t.weight,
            t.source_ref, d.source_path,
            (SELECT string_agg(c.content, E'\\n' ORDER BY c.chunk_index)
               FROM chunks c
              WHERE c.document_id = d.id) AS evidence
       FROM synth_takes t
       JOIN documents d ON d.id = t.source_ref
      WHERE d.source_id = $1
        -- A source the gate quarantined is not re-read into a drift check.
        AND ${quarantineFilterFragment("d")}
        AND t.status <> 'rejected'
        AND t.weight >= 0.3 AND t.weight <= 0.85
        AND d.updated_at > t.generated_at
      ORDER BY t.weight DESC, t.id ASC
      LIMIT $2`,
    [sourceId, limit],
  );
  return rows
    .filter((r) => (r.evidence ?? "").trim().length > 0)
    .map((r) => ({
      takeId: Number(r.take_id),
      claim: String(r.claim_text),
      weight: Number(r.weight),
      sourceRef: String(r.source_ref),
      sourcePath: String(r.source_path),
      evidence: String(r.evidence ?? ""),
    }));
}

function buildPrompt(candidates: DriftCandidate[]): string {
  const blocks = candidates
    .map(
      (c) =>
        `### take ${c.takeId} (weight ${c.weight})\nClaim: ${sanitizeForPrompt(c.claim, 400).text}\nCurrent source evidence:\n${sanitizeForPrompt(c.evidence, 1200).text}`,
    )
    .join("\n\n---\n\n");
  return `You audit opinionated CLAIMS ("takes") against the CURRENT text of the
source each was drawn from. The source has changed since the take was made — your
job is to decide, per take, whether the claim STILL HOLDS given the current
evidence, or whether the evidence has DRIFTED away from it.

Return ONLY a JSON array (no prose), one item per take:
{
  "take_id": <number>,
  "holds": true | false,          // false = the current evidence no longer supports the claim
  "reason": "one sentence grounded in the current evidence"
}
Judge only from the evidence shown. If the evidence is silent on the claim,
treat it as still holding (holds=true) — absence is not contradiction.

TAKES
${blocks}`;
}

interface Verdict {
  takeId: number;
  holds: boolean;
  reason: string;
}

function parseVerdicts(text: string, validIds: Set<number>): Verdict[] {
  const arr = parseModelJson(text, "[");
  if (!Array.isArray(arr)) return [];
  const out: Verdict[] = [];
  for (const it of arr) {
    if (typeof it !== "object" || it === null) continue;
    const o = it as Record<string, unknown>;
    const takeId = typeof o.take_id === "number" ? o.take_id : Number(o.take_id);
    if (!Number.isFinite(takeId) || !validIds.has(takeId)) continue;
    const holds = o.holds === true || o.holds === "true";
    const reason = typeof o.reason === "string" ? o.reason.trim() : "";
    out.push({ takeId, holds, reason });
  }
  return out;
}

function reportSlugFor(): string {
  const date = new Date().toISOString().slice(0, 10);
  const seg = date.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const safe = SLUG_SEG.test(seg) ? seg : "report";
  return `drift-reports/${safe}`;
}

function renderReport(
  drifted: Array<{ candidate: DriftCandidate; reason: string }>,
): string {
  const rows = drifted
    .map(
      ({ candidate, reason }) =>
        `### take ${candidate.takeId} — \`${candidate.sourcePath}\` (weight ${candidate.weight})\n> ${sanitizeForPrompt(candidate.claim, 400).text}\n\n${reason || "Evidence no longer supports this claim."}`,
    )
    .join("\n\n");
  return `> Drift report — generated by the maintenance cycle. These takes rest on
> a source that changed after the take was made, and the current evidence no
> longer supports the claim. Review and re-weight or resolve them.

## Drifted takes (${drifted.length})
${rows}
`;
}

/**
 * Run the drift phase. Injected `sonnetFn` (tests) bypasses the flag gate.
 */
export async function driftPhase(
  storage: Storage,
  opts: DriftPhaseOptions = {},
): Promise<DriftPhaseResult> {
  const base: DriftPhaseResult = {
    ran: false,
    candidatesConsidered: 0,
    driftedFlagged: 0,
    spentUsd: 0,
    budgetExhausted: false,
    errors: [],
  };

  if (!opts.sonnetFn && !driftEnabled()) {
    return { ...base, reason: "MEMRAIN_DRIFT disabled" };
  }

  const engine = storage.engine();
  const sourceId = opts.sourceId ?? "default";
  const maxCandidates = resolveIntConfig(opts.maxCandidates, "MEMRAIN_DRIFT_MAX_CANDIDATES", 12);

  // Cooldown gate: don't re-judge (and re-pay for) the same shifted takes every
  // tick. Bypassed when a sonnetFn is injected (hermetic tests).
  const cooldownHours = resolveDriftCooldownHours(opts.cooldownHours);
  if (!opts.sonnetFn && cooldownHours > 0) {
    const last = await lastDriftReportAt(engine, sourceId);
    if (last !== null && Date.now() - last < cooldownHours * 3_600_000) {
      return { ...base, reason: `cooldown active (${cooldownHours}h)` };
    }
  }

  let candidates: DriftCandidate[];
  try {
    candidates = await gatherCandidates(engine, sourceId, maxCandidates);
  } catch (e) {
    return { ...base, reason: "gather failed", errors: [String(e instanceof Error ? e.message : e)] };
  }
  base.candidatesConsidered = candidates.length;

  if (candidates.length === 0) {
    return { ...base, reason: "no takes with shifted evidence in scope" };
  }

  const budget = opts.budget ?? new BudgetTracker(defaultBudget(), "drift");
  const model = resolveModel("reasoning", opts.modelId, "drift");
  const sonnetFn = resolveSonnetFn(opts.sonnetFn, { modelId: model });
  const maxTokens = 1200;

  const prompt = buildPrompt(candidates);
  const hold = budget.reserve(model, estimateUsage(prompt.length, maxTokens));
  if (hold === null) {
    return { ...base, reason: "budget exhausted before judging", budgetExhausted: true };
  }

  let verdicts: Verdict[];
  try {
    const call = await callWithTruncationRetry(
      "drift",
      maxTokens,
      (cap) =>
        sonnetFn({
          system: "Return only the requested JSON array.",
          user: prompt,
          maxTokens: cap,
          temperature: 0,
        }),
      (projected) => budget.widen(hold, model, projected),
    );
    const resp = call.resp;
    try {
      budget.settle(hold, resp.modelId, call.usage);
    } catch (e) {
      if (e instanceof BudgetExhausted) base.budgetExhausted = true;
      else throw e;
    }
    base.spentUsd = budget.totalSpent();
    verdicts = parseVerdicts(resp.text, new Set(candidates.map((c) => c.takeId)));
  } catch (e) {
    budget.release(hold);
    return { ...base, ran: true, spentUsd: budget.totalSpent(), errors: [String(e instanceof Error ? e.message : e)] };
  }

  const byId = new Map(candidates.map((c) => [c.takeId, c]));
  const drifted = verdicts
    .filter((v) => !v.holds)
    .map((v) => ({ candidate: byId.get(v.takeId)!, reason: v.reason }))
    .filter((d) => d.candidate !== undefined);
  base.driftedFlagged = drifted.length;

  if (drifted.length === 0) {
    return { ...base, ran: true };
  }

  const slug = reportSlugFor();
  try {
    await putPage(storage, {
      slug,
      type: "drift-report",
      title: `Drift report ${new Date().toISOString().slice(0, 10)}`,
      markdown_body: renderReport(drifted),
      source_id: sourceId,
      written_by: "drift",
      allowAdHocType: true,
    });
    base.reportSlug = slug;
  } catch (e) {
    base.errors.push(`${slug}: ${String(e instanceof Error ? e.message : e)}`);
  }

  return { ...base, ran: true };
}
