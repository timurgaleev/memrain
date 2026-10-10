/**
 * Latent-contradiction probe (Item 3) — a paid, default-OFF Sonnet cycle phase
 * that judges pairs of facts that plausibly conflict and records the SUSPECTED
 * contradictions in `synth_contradictions` (migration 064). This is the
 * LLM-derived complement to the deterministic `contradicts` graph edges the
 * `find_contradictions` tool reads: the graph surfaces conflicts an author
 * asserted; this surfaces conflicts the probe suspects.
 *
 * Architecture guard: reads entity_facts, writes ONLY to synth_contradictions.
 * A finding is advisory — it never mutates a fact, take, or edge.
 *
 * Safety: opt-in (`MEMRAIN_PROBE_CONTRADICTIONS=1`); paired candidates are
 * date-pre-filtered (a lookback window) and hard-capped (`maxPairs`) BEFORE any
 * LLM call; budget-capped (BudgetTracker with a pre-call reservation);
 * cached BOTH ways (positives via synth_contradictions.pair_key, every verdict
 * — negative included — via the TTL'd synth_contradiction_verdicts cache, so a
 * negative pair is not re-spent until its verdict expires); fail-open (a
 * per-pair judge/parse error is collected + skipped). Each run appends one
 * trend row (Wilson 95% CI over the contradiction rate + cost) to
 * synth_contradiction_runs. Sonnet injected via `sonnetFn`; NO live Bedrock in
 * tests.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Engine } from "../engine/interface.ts";
import { resolveSonnetFn, resolveFactsModel, type SonnetFn, type SonnetUsage } from "../llm/sonnet.ts";
import { sanitizeForPrompt } from "../llm/sanitize.ts";
import { BudgetTracker, BudgetExhausted } from "../budget.ts";
import { callWithTruncationRetry } from "../llm/truncation.ts";
import { parseModelJson } from "../llm/json-output.ts";
import { excludeEmptyExtractionTombstone } from "./takes.ts";

export const PROBE_CONTRADICTIONS_PROMPT_VERSION = "v2-sonnet";

const DEFAULT_MAX_PAIRS = 40;
const DEFAULT_LOOKBACK_DAYS = 365;
const DEFAULT_BUDGET_USD = 1.0;
const SEVERITIES = ["low", "medium", "high"] as const;
type Severity = (typeof SEVERITIES)[number];

/** What kind of row each side of a pair points at. */
export type PairSideKind = "fact" | "take" | "page";

/** A candidate pair of claims that plausibly conflict. */
export interface CandidatePair {
  a_ref: string;
  a_text: string;
  b_ref: string;
  b_text: string;
  source_id: string | null;
  /** Side kinds — default 'fact' (the pre-073 fact/fact pair shape). */
  a_kind?: PairSideKind;
  b_kind?: PairSideKind;
  /** YYYY-MM-DD each side dates from (a fact's valid_from, else the day it was
   *  written; a take's generation day). Null/absent renders "(date unknown)". */
  a_date?: string | null;
  b_date?: string | null;
}

/** Typed resolution proposals — advisory; the probe never auto-applies. */
export const RESOLUTION_KINDS = ["supersede", "debate", "synthesize", "manual"] as const;
export type ResolutionKind = (typeof RESOLUTION_KINDS)[number];

export interface ProbeContradictionsOptions {
  /** Injected Sonnet seam (tests). Default: the real Bedrock callSonnet. */
  sonnetFn?: SonnetFn;
  modelId?: string;
  /** Hard cap on judged pairs per run (bounds spend). Default 40. */
  maxPairs?: number;
  /** Only pair facts written within this many days. Default 365. */
  lookbackDays?: number;
  /** Shared USD budget. Default: a fresh cap from env. */
  budget?: BudgetTracker;
  /** Test seam — inject candidate pairs. Default: same-entity fact pairs. */
  pairsFn?: (engine: Engine, maxPairs: number, lookbackDays: number) => Promise<CandidatePair[]>;
  promptVersion?: string;
}

export interface ProbeContradictionsResult {
  pairsScanned: number;
  /** Judge calls made (cache hits and budget stops excluded): judged +
   *  parseFailures + judgeErrors. The trend row's rate denominator. */
  attempted: number;
  /** Calls that returned a parseable verdict. */
  judged: number;
  /** Calls that threw (gateway error, refusal, timeout). */
  judgeErrors: number;
  /** Calls whose reply held no parseable verdict — neither a negative nor cached. */
  parseFailures: number;
  /** More than a quarter of the attempted calls produced no verdict, so the
   *  run's contradiction rate does not describe the pairs it scanned. */
  judgeFailed: boolean;
  contradictionsFound: number;
  cacheHits: number;
  budgetExhausted: boolean;
  /** Set when the phase was a clean no-op (default-OFF) rather than a failure. */
  skippedReason?: string;
  /** The trend row id written for this run (absent when the phase no-op'd). */
  runId?: string;
  errors: string[];
}

/** Output cap for one judge verdict — a two-field JSON object, so this is
 *  generous; a cut-off verdict is retried once with more room. */
const JUDGE_MAX_TOKENS = 250;

const JUDGE_SYSTEM_PROMPT = `You compare two claims (A and B) recorded in a
personal knowledge brain and decide whether they CONTRADICT — i.e. they cannot
both be true of the same subject at the same time. A later claim that simply
SUPERSEDES an earlier one (a value that changed over time) is NOT a
contradiction unless both are asserted as currently true.

Output ONLY one JSON object:
  {"contradicts": (true|false),
   "severity": ("low"|"medium"|"high"),
   "axis": (<=40 chars naming what they disagree on, e.g. "timing","value","stance"),
   "confidence": (0..1),
   "resolution_kind": ("supersede"|"debate"|"synthesize"|"manual"),
   "resolution_command": (<=120 chars; a short suggestion, or "")}

resolution_kind: "supersede" when one side is clearly outdated by the other,
"debate" when both are defensible positions worth keeping, "synthesize" when
they should be merged into one reconciled statement, "manual" otherwise.

Each claim is labelled with the day it dates from, "(from: YYYY-MM-DD)", or
"(date unknown)". Rules:
- Time check first. A time-ordered update needs evidence of two DIFFERENT
  times: different (from:) dates, different dates written in the text, or
  explicit change wording ("now", "previously", "grew from").
- Never infer an order from the values themselves (a larger or smaller number),
  from the kind of claim, or from which claim is listed first.
- When both claims carry the same date, or nothing dates either claim, time
  does not explain the difference: two different values for the same fact
  about the same subject are a contradiction.
- A conflict needs a value for the same attribute on BOTH sides. Silence is not
  a conflict: when one claim does not mention what the other states, return
  contradicts=false.

If they are compatible or merely a time-ordered update, return contradicts=false.`;

/** "(from: YYYY-MM-DD)" for a dated side, "(date unknown)" otherwise. */
function dateTag(date: string | null | undefined): string {
  return typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) ? `(from: ${date})` : "(date unknown)";
}

/** The judge's user message: each claim labelled with the day it dates from. */
export function buildJudgeUserMessage(pair: CandidatePair): string {
  return (
    `A ${dateTag(pair.a_date)}: ${sanitizeForPrompt(pair.a_text).text}\n\n` +
    `B ${dateTag(pair.b_date)}: ${sanitizeForPrompt(pair.b_text).text}`
  );
}

/** Deterministic idempotency key: hash(a_ref + b_ref + prompt_version). */
export function pairKey(aRef: string, bRef: string, promptVersion: string): string {
  return createHash("sha256").update(`${aRef}\u0000${bRef}\u0000${promptVersion}`).digest("hex");
}

/** Estimate one judge call's usage for the pre-call budget gate, from the actual
 *  prompt size (~4 chars/token) so a large claim pair can't slip past a thin budget. */
function estimatePairUsage(a: string, b: string): SonnetUsage {
  const inputChars = JUDGE_SYSTEM_PROMPT.length + a.length + b.length + 100;
  return { inputTokens: Math.ceil(inputChars / 4), outputTokens: 200 };
}

export interface ParsedJudgment {
  contradicts: boolean;
  severity: Severity;
  axis: string;
  confidence: number;
  /** The judge's typed-resolution hint; "" when it emitted none / an invalid one. */
  resolution_kind: ResolutionKind | "";
  resolution_command: string;
}

/** Parse a single judgment object. Tolerant; returns null on failure. */
export function parseJudgment(raw: string): ParsedJudgment | null {
  const parsed = parseModelJson(raw, "{");
  if (typeof parsed !== "object" || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.contradicts !== "boolean") return null;
  const severity: Severity = (SEVERITIES as readonly string[]).includes(String(o.severity))
    ? (o.severity as Severity)
    : "low";
  const cRaw = typeof o.confidence === "number" ? o.confidence : Number.parseFloat(String(o.confidence ?? ""));
  const confidence = Number.isFinite(cRaw) ? Math.max(0, Math.min(1, cRaw)) : 0;
  const axis = typeof o.axis === "string" ? o.axis.slice(0, 40) : "";
  const resolution_kind: ResolutionKind | "" = (RESOLUTION_KINDS as readonly string[]).includes(
    String(o.resolution_kind),
  )
    ? (o.resolution_kind as ResolutionKind)
    : "";
  const resolution_command = typeof o.resolution_command === "string" ? o.resolution_command.slice(0, 120) : "";
  return { contradicts: o.contradicts, severity, axis, confidence, resolution_kind, resolution_command };
}

/**
 * Deterministic typed-resolution classifier. The judge's hint wins when
 * present — it has
 * semantic context this structural pass doesn't; otherwise the pair shape
 * decides: a take against a fact is the supersession locus, two takes are a
 * debate, two facts about one entity want a synthesized reconciliation.
 */
export function classifyResolution(
  pair: Pick<CandidatePair, "a_kind" | "b_kind">,
  judgeHint: ResolutionKind | "",
): ResolutionKind {
  if (judgeHint) return judgeHint;
  const a = pair.a_kind ?? "fact";
  const b = pair.b_kind ?? "fact";
  if (a === "take" && b === "take") return "debate";
  if (a === "take" || b === "take") return "supersede";
  if (a === "fact" && b === "fact") return "synthesize";
  return "manual";
}

/** Paste-ready advisory command for the chosen resolution. Never auto-run. */
export function renderResolutionCommand(pair: CandidatePair, kind: ResolutionKind): string {
  const a = pair.a_kind ?? "fact";
  const b = pair.b_kind ?? "fact";
  switch (kind) {
    case "supersede": {
      // Prefer rejecting the take side (a fact is corpus-grounded; the take is
      // the opinion that aged out).
      const takeRef = a === "take" ? pair.a_ref : b === "take" ? pair.b_ref : pair.a_ref;
      return `set_take_status take_key=${takeRef} status=rejected  # superseded`;
    }
    case "debate":
      return `# debate: keep both ${pair.a_ref} and ${pair.b_ref}; regrade after new evidence`;
    case "synthesize":
      return `# synthesize: reconcile ${a} ${pair.a_ref} with ${b} ${pair.b_ref} into one statement`;
    case "manual":
    default:
      return `# manual review: ${pair.a_ref} vs ${pair.b_ref}`;
  }
}

/**
 * Wilson 95% score interval over a contradiction rate: `found` positives in
 * `judged` trials. Returns [0, 0]..[l, u] clamped to [0, 1]; zero trials yields
 * the maximally-uninformative [0, 1].
 */
export function wilsonInterval(
  found: number,
  judged: number,
  z = 1.96,
): { lower: number; upper: number } {
  if (judged <= 0) return { lower: 0, upper: 1 };
  const p = found / judged;
  const z2 = z * z;
  const denom = 1 + z2 / judged;
  const center = p + z2 / (2 * judged);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * judged)) / judged);
  return {
    lower: Math.max(0, (center - margin) / denom),
    upper: Math.min(1, (center + margin) / denom),
  };
}

/**
 * Default candidate generator — three deterministic streams, concatenated and
 * capped at maxPairs (facts first: the same-entity locus has the best prior):
 *
 *   1. fact/fact  — DISTINCT facts sharing an entity_slug (pre-073 behaviour).
 *   2. take/take  — two takes in the SAME domain from DIFFERENT source docs
 *                   (the cross-slug opinion-collision case).
 *   3. take/fact  — a take whose claim mentions a fact's entity name (the
 *                   opinion-vs-record case).
 *
 * All streams are same-tenant only and lookback-bounded at the SQL layer so we
 * never materialize an O(n^2) product. Fail-soft to [] per stream.
 */
/**
 * Only a live claim is worth a paid verdict: a forgotten or superseded fact
 * (forgotten_at set) and a fact already folded into a consolidated one are
 * retired, and a take that is inactive, rejected, superseded, resolved or whose
 * document was deleted is no longer a standing position.
 */
function liveFact(f: string): string {
  return `${f}.forgotten_at IS NULL AND ${f}.consolidated = false`;
}

function liveTake(t: string): string {
  return `${t}.active
          AND ${t}.status <> 'rejected'
          AND ${t}.superseded_by IS NULL
          AND ${t}.resolved_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM documents dd
             WHERE dd.id = ${t}.source_ref AND dd.deleted_at IS NOT NULL
          )`;
}

/** The day a fact dates from: when it became true, else when it was written. */
function factDate(f: string): string {
  return `COALESCE(${f}.valid_from, ${f}.written_at::date)::text`;
}

async function defaultPairs(
  engine: Engine,
  maxPairs: number,
  lookbackDays: number,
): Promise<CandidatePair[]> {
  const out: CandidatePair[] = [];

  // Stream 1 — same-entity fact pairs.
  try {
    const { rows } = await engine.query<CandidatePair>(
      `SELECT f1.id::text AS a_ref, f1.fact AS a_text,
              f2.id::text AS b_ref, f2.fact AS b_text,
              f1.source_id AS source_id,
              'fact' AS a_kind, 'fact' AS b_kind,
              ${factDate("f1")} AS a_date, ${factDate("f2")} AS b_date
         FROM entity_facts f1
         JOIN entity_facts f2
           ON f2.entity_slug = f1.entity_slug
          AND f2.id > f1.id
          AND f2.fact <> f1.fact
          -- Same-tenant only: never pair two tenants' facts that share a slug
          -- (e.g. both hold people/alice-smith), which would leak one tenant's
          -- private fact text into the other's find_contradictions read.
          AND f2.source_id IS NOT DISTINCT FROM f1.source_id
        WHERE f1.written_at >= now() - ($1 * interval '1 day')
          AND f2.written_at >= now() - ($1 * interval '1 day')
          -- dimensional ontology rows have their own read path, not the probe.
          AND f1.dimension IS NULL AND f2.dimension IS NULL
          AND ${liveFact("f1")} AND ${liveFact("f2")}
        ORDER BY f1.entity_slug ASC, f1.id ASC, f2.id ASC
        LIMIT $2`,
      [lookbackDays, maxPairs],
    );
    out.push(...rows);
  } catch {
    /* stream fail-soft */
  }
  if (out.length >= maxPairs) return out.slice(0, maxPairs);

  // Stream 2 — cross-slug take pairs in the same domain, same tenant.
  try {
    const { rows } = await engine.query<CandidatePair>(
      `SELECT t1.take_key AS a_ref, t1.claim_text AS a_text,
              t2.take_key AS b_ref, t2.claim_text AS b_text,
              d1.source_id AS source_id,
              'take' AS a_kind, 'take' AS b_kind,
              t1.generated_at::date::text AS a_date, t2.generated_at::date::text AS b_date
         FROM synth_takes t1
         JOIN synth_takes t2
           ON t2.domain = t1.domain
          AND t2.id > t1.id
          AND t2.source_ref <> t1.source_ref
          AND t2.claim_text <> t1.claim_text
         LEFT JOIN documents d1 ON d1.id = t1.source_ref
         LEFT JOIN documents d2 ON d2.id = t2.source_ref
        WHERE t1.domain IS NOT NULL
          AND d2.source_id IS NOT DISTINCT FROM d1.source_id
          AND t1.generated_at >= now() - ($1 * interval '1 day')
          AND t2.generated_at >= now() - ($1 * interval '1 day')
          AND ${liveTake("t1")} AND ${liveTake("t2")}
        ORDER BY t1.domain ASC, t1.id ASC, t2.id ASC
        LIMIT $2`,
      [lookbackDays, maxPairs - out.length],
    );
    out.push(...rows);
  } catch {
    /* stream fail-soft (pre-045 brain / no takes) */
  }
  if (out.length >= maxPairs) return out.slice(0, maxPairs);

  // Stream 3 — take vs fact where the claim names the fact's entity. Unlike
  // stream 2 (which needs a domain, and the memo carries none), nothing here
  // rules the zero-yield memo out, so it is fenced by claim text — a paid judge
  // spent on "(no gradeable claims)" vs a fact can only return noise.
  const takeFactParams: unknown[] = [lookbackDays, maxPairs - out.length];
  const noTombstone = excludeEmptyExtractionTombstone("t.claim_text", takeFactParams);
  try {
    const { rows } = await engine.query<CandidatePair>(
      `SELECT t.take_key AS a_ref, t.claim_text AS a_text,
              f.id::text AS b_ref, f.fact AS b_text,
              f.source_id AS source_id,
              'take' AS a_kind, 'fact' AS b_kind,
              t.generated_at::date::text AS a_date, ${factDate("f")} AS b_date
         FROM synth_takes t
         LEFT JOIN documents d ON d.id = t.source_ref
         JOIN entity_facts f
           -- Facts default to the 'default' legacy tenant while an unstamped
           -- document reads NULL — coalesce so the legacy world still pairs.
           ON f.source_id IS NOT DISTINCT FROM COALESCE(d.source_id, 'default')
        WHERE t.generated_at >= now() - ($1 * interval '1 day')
          AND f.written_at >= now() - ($1 * interval '1 day')
          -- dimensional ontology rows have their own read path, not the probe.
          AND f.dimension IS NULL
          AND ${liveFact("f")} AND ${liveTake("t")}
          AND length(regexp_replace(f.entity_slug, '.*/', '')) > 3
          AND t.claim_text ILIKE
              '%' || replace(regexp_replace(f.entity_slug, '.*/', ''), '-', ' ') || '%'
          ${noTombstone}
        ORDER BY t.id ASC, f.id ASC
        LIMIT $2`,
      takeFactParams,
    );
    out.push(...rows);
  } catch {
    /* stream fail-soft */
  }
  return out.slice(0, maxPairs);
}

function probeEnabled(): boolean {
  const v = (process.env.MEMRAIN_PROBE_CONTRADICTIONS ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

function defaultBudget(): number {
  const raw = (process.env.MEMRAIN_PROBE_CONTRADICTIONS_BUDGET_USD ?? "").trim();
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BUDGET_USD;
}

/** Verdict-cache TTL in days (default 30; MEMRAIN_PROBE_VERDICT_TTL_DAYS). */
function verdictTtlDays(): number {
  const n = Number((process.env.MEMRAIN_PROBE_VERDICT_TTL_DAYS ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : 30;
}

/** Unexpired cached verdict for a pair, or null. Fail-soft (pre-073 brain). */
async function getCachedVerdict(
  engine: Engine,
  pairKeyHash: string,
): Promise<{ contradicts: boolean } | null> {
  try {
    const { rows } = await engine.query<{ contradicts: boolean }>(
      `SELECT contradicts FROM synth_contradiction_verdicts
        WHERE pair_key = $1 AND expires_at > now()`,
      [pairKeyHash],
    );
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

/** Upsert a verdict (positive or negative) with a fresh TTL. Fail-soft. */
async function putCachedVerdict(
  engine: Engine,
  pairKeyHash: string,
  judgment: ParsedJudgment,
  modelId: string,
  ttlDays: number,
): Promise<void> {
  try {
    await engine.query(
      `INSERT INTO synth_contradiction_verdicts
         (pair_key, contradicts, verdict, model_id, judged_at, expires_at)
       VALUES ($1, $2, $3::text::jsonb, $4, now(), now() + ($5 * interval '1 day'))
       ON CONFLICT (pair_key) DO UPDATE SET
         contradicts = EXCLUDED.contradicts,
         verdict = EXCLUDED.verdict,
         model_id = EXCLUDED.model_id,
         judged_at = EXCLUDED.judged_at,
         expires_at = EXCLUDED.expires_at`,
      [pairKeyHash, judgment.contradicts, JSON.stringify(judgment), modelId, ttlDays],
    );
  } catch {
    /* cache write is best-effort */
  }
}

export interface ContradictionRunRow {
  ran_at: string;
  found: number;
  judged: number;
  wilson_ci_lower: number;
  wilson_ci_upper: number;
  cost_usd: number;
  /** Judge calls that threw; 0 on rows written before migration 131. */
  judge_errors: number;
  /** Judge replies with no parseable verdict; 0 on rows before migration 131. */
  parse_failures: number;
  /** The run's rate is unreliable: over a quarter of its calls gave no verdict. */
  judge_failed: boolean;
}

/**
 * Most-recent contradiction-probe run (Wilson-CI trend row), or null if the
 * probe has never run. Read-side for the `contradiction-trend` doctor check —
 * the runs table was written but never read back before.
 */
export async function latestContradictionRun(
  engine: Engine,
): Promise<ContradictionRunRow | null> {
  const r = await engine.query<ContradictionRunRow>(
    `SELECT ran_at::text AS ran_at, found, judged,
            wilson_ci_lower, wilson_ci_upper, cost_usd,
            judge_errors, parse_failures, judge_failed
       FROM synth_contradiction_runs
      ORDER BY ran_at DESC
      LIMIT 1`,
  );
  return r.rows[0] ?? null;
}

/**
 * Run the probe. Default-OFF: a live (paid) run needs MEMRAIN_PROBE_CONTRADICTIONS=1;
 * tests inject a sonnetFn (bypasses the gate, no spend).
 */
export async function probeContradictionsPhase(
  engine: Engine,
  opts: ProbeContradictionsOptions = {},
): Promise<ProbeContradictionsResult> {
  const result: ProbeContradictionsResult = {
    pairsScanned: 0,
    attempted: 0,
    judged: 0,
    judgeErrors: 0,
    parseFailures: 0,
    judgeFailed: false,
    contradictionsFound: 0,
    cacheHits: 0,
    budgetExhausted: false,
    errors: [],
  };
  if (!opts.sonnetFn && !probeEnabled()) {
    result.skippedReason = "default-OFF: set MEMRAIN_PROBE_CONTRADICTIONS=1 to run the paid probe";
    return result;
  }

  const maxPairs = opts.maxPairs ?? DEFAULT_MAX_PAIRS;
  const lookbackDays = opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const promptVersion = opts.promptVersion ?? PROBE_CONTRADICTIONS_PROMPT_VERSION;
  const budget = opts.budget ?? new BudgetTracker(defaultBudget(), "probe-contradictions");
  const probeModel = resolveFactsModel(opts.modelId);
  const sonnetFn = resolveSonnetFn(opts.sonnetFn, { modelId: probeModel });
  const pairsFn = opts.pairsFn ?? defaultPairs;

  const ttlDays = verdictTtlDays();
  const startedAt = Date.now();
  const pairs = await pairsFn(engine, maxPairs, lookbackDays);
  result.pairsScanned = pairs.length;

  for (const pair of pairs) {
    const key = pairKey(pair.a_ref, pair.b_ref, promptVersion);

    // Cache 1: a stored (positive) finding under this prompt version → skip.
    try {
      const { rows: existing } = await engine.query<{ id: number }>(
        `SELECT id FROM synth_contradictions WHERE pair_key = $1`,
        [key],
      );
      if (existing.length > 0) {
        result.cacheHits += 1;
        continue;
      }
    } catch (e) {
      result.errors.push(`pair ${pair.a_ref}/${pair.b_ref} cache check: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    // Cache 2: an unexpired verdict (negative included) → skip, no re-spend.
    // Positives always have a synth_contradictions row (written in the same
    // pass), so a hit here is almost always a cached negative.
    if (await getCachedVerdict(engine, key)) {
      result.cacheHits += 1;
      continue;
    }

    // Budget pre-flight — stop the whole phase once a pair can't be afforded.
    // The estimate is held until settle, so a tracker shared with other
    // callers cannot be spent twice against the same headroom.
    const hold = budget.reserve(probeModel, estimatePairUsage(pair.a_text, pair.b_text));
    if (hold === null) {
      result.budgetExhausted = true;
      break;
    }

    let judgment: ParsedJudgment | null;
    let usedModel: string;
    let overCap = false;
    try {
      const call = await callWithTruncationRetry(
        "contradictions",
        JUDGE_MAX_TOKENS,
        (cap) =>
          sonnetFn({
            system: JUDGE_SYSTEM_PROMPT,
            user: buildJudgeUserMessage(pair),
            maxTokens: cap,
            temperature: 0,
          }),
        (projected) => budget.widen(hold, probeModel, projected),
      );
      const resp = call.resp;
      usedModel = resp.modelId;
      try {
        budget.settle(hold, resp.modelId, call.usage);
      } catch (e) {
        if (e instanceof BudgetExhausted) {
          result.budgetExhausted = true;
          overCap = true;
        } else {
          throw e;
        }
      }
      judgment = parseJudgment(resp.text);
    } catch (e) {
      budget.release(hold);
      result.attempted += 1;
      result.judgeErrors += 1;
      result.errors.push(`pair ${pair.a_ref}/${pair.b_ref} judge: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    result.attempted += 1;

    // A reply with no parseable verdict is a failed judgment, not a negative:
    // it stays out of the rate and out of the verdict cache, so the pair is
    // judged again next run.
    if (!judgment) {
      result.parseFailures += 1;
      result.errors.push(`pair ${pair.a_ref}/${pair.b_ref} parse: no verdict in judge reply`);
      if (overCap) break;
      continue;
    }
    result.judged += 1;

    // Cache every parsed verdict — negatives included — so an unchanged pair
    // is not re-spent until the TTL expires.
    await putCachedVerdict(engine, key, judgment, usedModel, ttlDays);

    // Only a SUSPECTED contradiction is stored as a finding, now with a typed
    // resolution proposal (judge hint wins; structural classifier otherwise).
    if (judgment.contradicts) {
      const kind = classifyResolution(pair, judgment.resolution_kind);
      const command =
        judgment.resolution_command.length > 0
          ? judgment.resolution_command
          : renderResolutionCommand(pair, kind);
      try {
        await engine.query(
          `INSERT INTO synth_contradictions
             (pair_key, a_ref, a_kind, a_text, b_ref, b_kind, b_text,
              severity, axis, confidence, resolution_kind, resolution_command,
              source_id, prompt_version, model_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
           ON CONFLICT (pair_key) DO NOTHING`,
          [
            key, pair.a_ref, pair.a_kind ?? "fact", pair.a_text,
            pair.b_ref, pair.b_kind ?? "fact", pair.b_text,
            judgment.severity, judgment.axis, judgment.confidence,
            kind, command,
            pair.source_id, promptVersion, usedModel,
          ],
        );
        result.contradictionsFound += 1;
      } catch (e) {
        result.errors.push(`pair ${pair.a_ref}/${pair.b_ref} write: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    if (overCap) break; // this call tipped the ceiling — stop.
  }

  // Calls that produced no verdict are counted, not hidden: past a quarter of
  // the attempts the rate below no longer describes the pairs scanned.
  result.judgeFailed = result.judgeErrors + result.parseFailures > result.attempted / 4;

  // One trend row per run (Wilson 95% CI over the contradiction rate among the
  // verdicts this run returned). Best-effort — a trend write failure never
  // fails the probe.
  const runId = `probe-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}-${randomUUID().slice(0, 8)}`;
  const ci = wilsonInterval(result.contradictionsFound, result.judged);
  try {
    await engine.query(
      `INSERT INTO synth_contradiction_runs
         (run_id, model_id, prompt_version, pairs_scanned, judged, found,
          cache_hits, wilson_ci_lower, wilson_ci_upper, cost_usd, duration_ms,
          judge_errors, parse_failures, judge_failed)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (run_id) DO NOTHING`,
      [
        runId, probeModel, promptVersion, result.pairsScanned, result.judged,
        result.contradictionsFound, result.cacheHits, ci.lower, ci.upper,
        Number(budget.totalSpent().toFixed(6)), Date.now() - startedAt,
        result.judgeErrors, result.parseFailures, result.judgeFailed,
      ],
    );
    result.runId = runId;
  } catch (e) {
    result.errors.push(`trend row write: ${e instanceof Error ? e.message : String(e)}`);
  }

  return result;
}
