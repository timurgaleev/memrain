/**
 * Takes synthesis phases — written ONLY to `synth_takes` / `synth_take_grades`.
 *
 *   propose_takes — scan corpus documents, extract opinionated gradeable claims
 *     ("takes": a prediction/judgment/bet that could turn out wrong), queue them.
 *   grade_takes   — evidence-ground each queued take into a confidence verdict.
 *
 * Architecture guard: both read the authored vault (documents/chunks) but write
 * exclusively to the synth_* namespace. propose_takes only QUEUES (status
 * 'queued'); nothing here ever mutates a note or auto-applies a verdict.
 *
 * Safety: opt-in; budget-capped (`maxDocs` / `maxTakes`); idempotent
 * (take_key UNIQUE — including the zero-yield tombstone row, so a document
 * with no claims is paid for once, not every run; grade keyed on
 * (take_id, prompt_version, evidence_sig));
 * fail-open (per-item LLM error logs + skips).
 *
 * LLM injected via `opts.llmFn`. NO live Bedrock in tests.
 */
import { createHash } from "node:crypto";
import type { Engine } from "../engine/interface.ts";
import { Storage } from "../storage.ts";
import { hybridSearch } from "../search/hybrid.ts";
import { resolveLlmFn, type LlmFn, type LlmCallResult } from "../llm/haiku.ts";
import {
  resolveSonnetFn,
  resolveFactsModel,
  type SonnetFn,
  type SonnetCallResult,
  type SonnetUsage,
} from "../llm/sonnet.ts";
import { callWithTruncationRetry, type TruncationRetryResult } from "../llm/truncation.ts";
import { parseModelJson } from "../llm/json-output.ts";
import { sanitizeForPrompt } from "../llm/sanitize.ts";
import { BudgetTracker, BudgetExhausted } from "../budget.ts";
import { contentHash16 } from "./atoms.ts";
import { embedText } from "../embedding.ts";
import { resolveTake } from "./takes-canon.ts";
import { normalizeScope } from "../source-scope.ts";
import { resolveModel } from "../llm/resolve-model.ts";
import { clearSynthFailure, filterBackedOff, recordSynthFailure } from "./synth-failures.ts";
import { quarantineFilterFragment } from "../quarantine.ts";
import { guardFields } from "../secret-scan.ts";

export const PROPOSE_TAKES_PROMPT_VERSION = "v1-nova";

/**
 * `claim_text` of the tombstone row written when a document extracts ZERO
 * gradeable claims. Idempotency is keyed on a `synth_takes` row existing for
 * (source_ref, source_hash, prompt_version), and a claim-free document writes
 * no row — so only documents that produced a take were ever memoized, and
 * unchanged claim-free prose was re-sent to the model on every run. The
 * tombstone records that tuple with nothing else attached.
 *
 * It is a memo, not a belief: status 'rejected' + active=false + holder
 * 'brain' put it behind the lifecycle fences the read paths already apply
 * (think's gather, drift, salience, the grade pool, and the holder allow-list
 * every remote token carries). A content edit (new source_hash) or a
 * PROPOSE_TAKES_PROMPT_VERSION bump misses it and re-extracts.
 */
export const EMPTY_EXTRACTION_TOMBSTONE_TEXT = "(no gradeable claims)";

/**
 * WHERE fragment (leading ` AND `) that keeps the zero-yield tombstone out of a
 * read over `synth_takes`. Binds {@link EMPTY_EXTRACTION_TOMBSTONE_TEXT} as the
 * next placeholder — pass the query's live params array and it appends to it,
 * so the index can never drift from the fragment. `col` is the claim column,
 * qualified when the query aliases the table (`t.claim_text`).
 *
 * The lifecycle columns above are not enough on their own: they only fence the
 * paths that filter on status/active, and the operator-facing reads
 * deliberately span EVERY lifecycle state — `list_takes` with no filter,
 * `takes_search`, the scorecard's `total_takes`, the `grade_completion`
 * denominator. Those surface or count the memo unless it is excluded by claim
 * text, which is what this does. A brain that parks the zero-yield memo in a
 * table of its own gets that for free; memrain keeps one `synth_takes` table for
 * proposals, operator fence rows and memos alike, so the exclusion has to be
 * explicit. Every such read imports this rather than restating the predicate.
 */
export function excludeEmptyExtractionTombstone(col: string, params: unknown[]): string {
  params.push(EMPTY_EXTRACTION_TOMBSTONE_TEXT);
  return ` AND ${col} <> $${params.length}`;
}

export const GRADE_TAKES_PROMPT_VERSION = "v1-nova";
/** Distinct version so ensemble grades never collide with single-pass utility-tier
 *  grades under the (take_id, prompt_version, evidence_sig) uniqueness key. */
export const GRADE_ENSEMBLE_PROMPT_VERSION = "v1-sonnet-ensemble";

// Lives beside the prompt versions above: `estimateJudgeUsage` sizes the budget
// gate off this text, so it has to be in hand before the first grading call.
const GRADE_SYSTEM_PROMPT = `You are grading a single forecasting take against
evidence. Decide whether the claim turned out:
- correct      (the world matches the claim)
- incorrect    (the world clearly contradicts it)
- partial      (some right, some wrong)
- unresolvable (insufficient evidence; outcome still pending)

Output ONLY one JSON object:
  {"verdict": ("correct"|"incorrect"|"partial"|"unresolvable"),
   "confidence": (0..1), "reasoning": (<=400 chars)}

If evidence is sparse, return verdict="unresolvable" with low confidence.`;

const DEFAULT_ENSEMBLE_JUDGES = 3;
const DEFAULT_ENSEMBLE_BUDGET_USD = 1.0;

/** Estimate one judge's token usage for the pre-call budget gate. Derived from
 *  the ACTUAL prompt size (~4 chars/token) so a large injected-evidence blob
 *  can't slip a call past a near-empty budget — a fixed constant would. */
function estimateJudgeUsage(claim: string, evidence: string): SonnetUsage {
  const inputChars = GRADE_SYSTEM_PROMPT.length + claim.length + evidence.length + 64;
  return { inputTokens: Math.ceil(inputChars / 4), outputTokens: 400 };
}

/** Ensemble opt-in — a paid Sonnet path, OFF unless the operator sets the flag. */
export function takeEnsembleEnabled(): boolean {
  return process.env.MEMRAIN_TAKE_ENSEMBLE === "1";
}

function ensembleJudgeCount(): number {
  const raw = process.env.MEMRAIN_TAKE_ENSEMBLE_JUDGES;
  if (raw === undefined || raw.trim() === "") return DEFAULT_ENSEMBLE_JUDGES;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 9) {
    throw new Error(`MEMRAIN_TAKE_ENSEMBLE_JUDGES must be an integer 1..9, got: ${JSON.stringify(raw)}`);
  }
  return n;
}

function ensembleBudgetUsd(): number {
  const raw = process.env.MEMRAIN_TAKE_ENSEMBLE_BUDGET_USD;
  if (raw === undefined || raw.trim() === "") return DEFAULT_ENSEMBLE_BUDGET_USD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`MEMRAIN_TAKE_ENSEMBLE_BUDGET_USD must be a positive number, got: ${JSON.stringify(raw)}`);
  }
  return n;
}

const DEFAULT_MAX_DOCS = 25;
const DEFAULT_MAX_TAKES = 25;
const MIN_DOC_CHARS = 400;
const MAX_DOC_CHARS_TO_LLM = 50_000;

/** Output cap for one extraction (a JSON array of claims) and for one judge
 *  verdict (a single JSON object). Named because the truncation-retry helper
 *  derives the second, larger cap from them. */
const PROPOSE_MAX_TOKENS = 1200;
const GRADE_MAX_TOKENS = 500;

/**
 * Adapt a utility-tier result to the shape the shared truncation-retry helper
 * takes. Both transports report `stopReason` identically; the only difference
 * is that the utility tier's usage is optional (an injected fake reports none),
 * and a call the transport never priced counts as zero — the same assumption
 * the rest of this phase already makes about un-metered utility calls.
 */
function asRetryable(r: LlmCallResult): SonnetCallResult {
  return {
    text: r.text,
    modelId: r.modelId,
    usage: r.usage ?? { inputTokens: 0, outputTokens: 0 },
    ...(r.stopReason ? { stopReason: r.stopReason } : {}),
  };
}

/**
 * Retry predicate for the utility-tier calls in this module. They run outside
 * any BudgetTracker — only the paid ensemble carries one — so there is no USD
 * cap for the second call to exceed, and the extra call is bounded by maxDocs /
 * maxTakes. Refusing the retry instead would be worse than pointless: these
 * calls run at temperature 0, so the next RUN would truncate in the identical
 * place and the document could never be captured at all.
 */
function utilityTierCanRetry(): boolean {
  return true;
}

/** Default minimum take age before it is graded — ~6 months. A take needs time
 *  to be resolvable; grading a claim minutes after it was written wastes a paid
 *  judge on a verdict that is almost always 'unresolvable'. */
const DEFAULT_GRADE_MIN_AGE_DAYS = 182;

/** Resolve the grade age gate (days) from `MEMRAIN_GRADE_MIN_AGE_DAYS`. A blank
 *  env keeps the 6-month default; `0` disables the gate (grade immediately). */
export function gradeMinAgeDays(
  raw: string | undefined = process.env.MEMRAIN_GRADE_MIN_AGE_DAYS,
): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_GRADE_MIN_AGE_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(
      `MEMRAIN_GRADE_MIN_AGE_DAYS must be a non-negative number, got: ${JSON.stringify(raw)}`,
    );
  }
  return n;
}

/** Auto-resolve gate: when ON, a high-confidence judge verdict is APPLIED to
 *  the take's resolution tuple (resolved_by='memrain:grade_takes') instead of
 *  staying advisory. Default OFF — calibration measures the human unless the
 *  operator explicitly delegates resolution to the judge. */
export function takeAutoResolveEnabled(): boolean {
  return process.env.MEMRAIN_TAKE_AUTO_RESOLVE === "1";
}

/** Single-model verdicts auto-apply only at/above this confidence
 *  (conservative by design). */
const DEFAULT_AUTO_RESOLVE_THRESHOLD = 0.95;
/** Ensemble verdicts auto-apply only when UNANIMOUS and at/above this
 *  confidence — agreement substitutes for part of the confidence bar. */
const DEFAULT_ENSEMBLE_APPLY_THRESHOLD = 0.85;

/** Opt-in claim embedding at propose time (feeds `think`'s take VECTOR stream).
 *  Default-OFF: an un-embedded take still recalls via the keyword stream, so the
 *  vector index is a pure enhancement the operator turns on when they want it. */
export function takeEmbedEnabled(): boolean {
  return process.env.MEMRAIN_TAKE_EMBED === "1";
}

export const TAKE_KINDS = ["prediction", "judgment", "bet"] as const;
export type TakeKind = (typeof TAKE_KINDS)[number];

export const TAKE_VERDICTS = ["correct", "incorrect", "partial", "unresolvable"] as const;
export type TakeVerdict = (typeof TAKE_VERDICTS)[number];

// --- propose_takes ----------------------------------------------------------

export interface ProposeTakesOptions {
  maxDocs?: number;
  llmFn?: LlmFn;
  modelId?: string;
  promptVersion?: string;
  /**
   * Inject a claim embedder (tests). Default: the Bedrock Titan path when
   * `MEMRAIN_TAKE_EMBED=1`, else null (no embedding — the column stays NULL and
   * the take recalls via the keyword stream only). Fail-soft per take.
   */
  embed?: ((text: string) => Promise<number[]>) | null;
}

export interface ProposeTakesResult {
  documentsScanned: number;
  documentsProcessed: number;
  takesQueued: number;
  /** Idempotency rows written for documents that extracted zero claims. */
  tombstonesWritten: number;
  /** Takes marked inactive because their document no longer yields claims. */
  takesRetired: number;
  errors: string[];
}

interface ParsedTake {
  claim_text: string;
  kind: TakeKind;
  weight: number;
  domain?: string;
}

interface SourceDoc {
  id: string;
  text: string;
  contentHash16: string;
}

const PROPOSE_SYSTEM_PROMPT = `Extract gradeable claims from the note below.

A "gradeable claim" is a prediction, recommendation, or interpretive judgment
that could turn out wrong over time. NOT gradeable: pure facts, direct quotes
without endorsement, restatements.

For each claim output an object:
  {"claim_text": (<=200 chars), "kind": ("prediction"|"judgment"|"bet"),
   "weight": (0..1 from hedging language: "I bet"=0.7-0.85, "I think"=0.5-0.7,
   "maybe"=0.3-0.5), "domain": (short tag, e.g. "tactics","macro","hiring")}

Output ONLY a JSON array. No prose. If no gradeable claims, return [].`;

export function takeKey(
  sourceRef: string,
  sourceHash16: string,
  promptVersion: string,
  claim: string,
): string {
  return createHash("sha256")
    .update(`${sourceRef} ${sourceHash16} ${promptVersion} ${claim}`)
    .digest("hex");
}

/** Parse the LLM proposal output. Tolerant; never throws. */
export function parseTakesResponse(raw: string): ParsedTake[] {
  const parsed = parseModelJson(raw, "[");
  if (!Array.isArray(parsed)) return [];
  const out: ParsedTake[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    const claim = typeof o.claim_text === "string" ? o.claim_text.trim() : "";
    if (!claim || claim.length > 500) continue;
    const rawKind = typeof o.kind === "string" ? o.kind : "";
    const kind: TakeKind = (TAKE_KINDS as readonly string[]).includes(rawKind)
      ? (rawKind as TakeKind)
      : "judgment";
    const wRaw = typeof o.weight === "number" ? o.weight : 0.5;
    const weight = Math.max(0, Math.min(1, Number.isFinite(wRaw) ? wRaw : 0.5));
    const domain =
      typeof o.domain === "string" && o.domain.trim().length > 0
        ? o.domain.trim().slice(0, 100)
        : undefined;
    const t: ParsedTake = { claim_text: claim, kind, weight };
    if (domain !== undefined) t.domain = domain;
    out.push(t);
  }
  return out;
}

/**
 * True only when `raw` is a cleanly parsed EMPTY JSON array — the well-behaved
 * "no gradeable claims" answer the prompt asks for. `parseTakesResponse` returns
 * [] for that AND for malformed / truncated / prose output, so the zero-yield
 * tombstone needs the stricter test: memoizing a transient parse failure would
 * permanently suppress a document that does carry claims. It is
 * deliberately stricter than `parseTakesResponse` (which reads through the
 * shared decoder): only a closed fence is unwrapped and nothing is salvaged, so
 * a reply the decoder would still read — an unclosed fence, a thinking block —
 * stays retryable rather than being memoized as empty.
 *
 * The whole (de-fenced, trimmed) response has to BE the empty array. Seeking
 * to the first `[` the way the tolerant parser does would read
 * "Unable to parse the source; returning fallback []" as a clean extraction —
 * a model announcing its own failure, memoized forever and taking the
 * document's real claims down with it via the retirement pass. Prose around
 * the array is a parse failure, and a parse failure must stay retryable.
 */
export function isWellFormedEmptyExtraction(raw: string): boolean {
  let cleaned = raw.trim();
  if (cleaned.length === 0) return false;
  // No `\s*` after the info tag: with it, the whitespace run and the lazy body
  // split the same characters n+1 ways and an unclosed fence goes quadratic
  // (0.9 ms at 2 K to 59.5 ms at 16 K before the run came out).
  const fence = cleaned.match(/```(?:json)?([\s\S]*?)```/);
  if (fence && fence[1] !== undefined) cleaned = fence[1].trim();
  try {
    const parsed: unknown = JSON.parse(cleaned);
    return Array.isArray(parsed) && parsed.length === 0;
  } catch {
    return false;
  }
}

async function discoverTakeDocuments(
  engine: Engine,
  maxDocs: number,
  promptVersion: string,
  model: string,
): Promise<SourceDoc[]> {
  const { rows } = await engine.query<{ id: string; text: string }>(
    `SELECT d.id,
            string_agg(c.content, E'\n\n' ORDER BY c.chunk_index) AS text
       FROM documents d
       JOIN chunks c ON c.document_id = d.id
      WHERE d.deleted_at IS NULL
        AND ${quarantineFilterFragment("d")}
      GROUP BY d.id
      ORDER BY d.updated_at DESC`,
  );
  const candidates: SourceDoc[] = [];
  for (const r of rows) {
    const text = r.text ?? "";
    if (text.length < MIN_DOC_CHARS) continue;
    candidates.push({ id: r.id, text, contentHash16: contentHash16(text) });
  }
  if (candidates.length === 0) return [];

  // Pair via unnest (tuple match, not the cross-product of two ANY() arrays).
  // The idempotency key includes prompt_version: a prompt bump re-scans every
  // doc; the same prompt over unchanged content skips. A zero-yield scan is
  // memoized by a tombstone row carrying the same tuple as a real take, so
  // this one lookup covers both cases — it matches ANY row for the tuple.
  const refs = candidates.map((c) => c.id);
  const hashes = candidates.map((c) => c.contentHash16);
  const { rows: existing } = await engine.query<{ source_ref: string; source_hash: string }>(
    `SELECT DISTINCT t.source_ref, t.source_hash
       FROM synth_takes t
       JOIN unnest($1::text[], $2::text[]) AS w(source_ref, source_hash)
         ON t.source_ref = w.source_ref AND t.source_hash = w.source_hash
      WHERE t.prompt_version = $3`,
    [refs, hashes, promptVersion],
  );
  const done = new Set(existing.map((e) => `${e.source_ref} ${e.source_hash}`));
  const open = candidates.filter((c) => !done.has(`${c.id} ${c.contentHash16}`));
  // Before the slice, so a document parked after a failed call gives up its slot.
  return (await filterBackedOff(engine, "propose_takes", open, model)).slice(0, maxDocs);
}

/** Claims already extracted from this document (any hash / prompt version),
 *  fed back to the extractor as already-captured so it never re-proposes the
 *  same take after a content edit or prompt bump. Tombstone rows carry no
 *  claim, so they are excluded rather than handed to the model as one. */
async function existingClaimsForDoc(engine: Engine, sourceRef: string): Promise<string[]> {
  const params: unknown[] = [sourceRef];
  const noTombstone = excludeEmptyExtractionTombstone("claim_text", params);
  try {
    const { rows } = await engine.query<{ claim_text: string }>(
      `SELECT DISTINCT claim_text FROM synth_takes
        WHERE source_ref = $1${noTombstone}
        ORDER BY claim_text ASC
        LIMIT 50`,
      params,
    );
    return rows.map((r) => r.claim_text);
  } catch {
    return [];
  }
}

export async function proposeTakesPhase(
  engine: Engine,
  opts: ProposeTakesOptions = {},
): Promise<ProposeTakesResult> {
  const maxDocs = opts.maxDocs ?? DEFAULT_MAX_DOCS;
  const promptVersion = opts.promptVersion ?? PROPOSE_TAKES_PROMPT_VERSION;
  const llm = resolveLlmFn(opts.llmFn, opts.modelId ? { modelId: opts.modelId } : {});
  // `undefined` → env-gated default; an explicit `null` (or OFF flag) → skip.
  const embed =
    opts.embed !== undefined
      ? opts.embed
      : takeEmbedEnabled()
        ? (t: string) => embedText(t)
        : null;
  const result: ProposeTakesResult = {
    documentsScanned: 0,
    documentsProcessed: 0,
    takesQueued: 0,
    tombstonesWritten: 0,
    takesRetired: 0,
    errors: [],
  };

  // The model the backoff is keyed on — the one `llm` will call.
  const backoffModel = resolveModel("utility", opts.modelId);
  const docs = await discoverTakeDocuments(engine, maxDocs, promptVersion, backoffModel);
  result.documentsScanned = docs.length;

  for (const doc of docs) {
    let text: string;
    let modelId: string;
    let truncated: boolean;
    // Already-captured claims for this doc dedup the extractor's output at the
    // prompt layer — a re-proposal of a known claim is instructed away.
    const existingClaims = await existingClaimsForDoc(engine, doc.id);
    const capturedBlock =
      existingClaims.length > 0
        ? `\n\nALREADY CAPTURED (do NOT re-propose these claims or trivial rephrasings):\n${existingClaims
            .map((c) => `- ${sanitizeForPrompt(c).text}`)
            .join("\n")}`
        : "";
    const user = `Source: ${doc.id}\n\n---\n\n${doc.text.slice(0, MAX_DOC_CHARS_TO_LLM)}${capturedBlock}`;
    try {
      const call = await callWithTruncationRetry(
        "propose_takes",
        PROPOSE_MAX_TOKENS,
        async (cap) =>
          asRetryable(await llm({ system: PROPOSE_SYSTEM_PROMPT, user, maxTokens: cap })),
        utilityTierCanRetry,
      );
      text = call.resp.text;
      modelId = call.resp.modelId;
      truncated = call.truncated;
    } catch (e) {
      result.errors.push(`${doc.id}: ${e instanceof Error ? e.message : String(e)}`);
      await recordSynthFailure(engine, {
        docId: doc.id, phase: "propose_takes", contentHash: doc.contentHash16, model: backoffModel, kind: "llm_error",
      });
      continue;
    }

    const takes = parseTakesResponse(text);
    result.documentsProcessed += 1;
    if (takes.length > 0 || isWellFormedEmptyExtraction(text)) {
      await clearSynthFailure(engine, doc.id, "propose_takes");
    } else {
      await recordSynthFailure(engine, {
        docId: doc.id, phase: "propose_takes", contentHash: doc.contentHash16, model: backoffModel,
        kind: truncated ? "truncated" : "unparseable",
      });
    }

    // Memoize the empty case. A document that yields no claims gets no row from
    // the loop below, so without this its idempotency tuple is never recorded
    // and the next run re-pays for the same unchanged prose. Only reached after
    // a SUCCESSFUL call — the LLM-error path `continue`s above — and only for a
    // cleanly parsed `[]`: parseTakesResponse also returns [] for malformed or
    // truncated output, and tombstoning that would permanently suppress a
    // document that does carry claims, so that case is logged and retried.
    if (takes.length === 0) {
      if (!isWellFormedEmptyExtraction(text)) {
        // An answer the cap cut in half lands here too — its array never closes,
        // so it parses to the same [] a claim-free document gives. The stop
        // reason is what separates them, and saying which one this was points
        // the operator at a ceiling they can raise instead of a broken model.
        // Either way it is NOT memoized: the tombstone would suppress this
        // document's real claims for good.
        result.errors.push(
          truncated
            ? `${doc.id}: extractor output truncated at the output cap even after a larger-cap retry; not memoized, retried after backoff`
            : `${doc.id}: extractor output not parseable as claims; not memoized, retried after backoff`,
        );
        continue;
      }
      // Keyed by the same tuple as a real take (takeKey over source_ref +
      // content hash + prompt version), so the discovery lookup treats it as a
      // cache hit with no extra query and the take_key UNIQUE index is the
      // conflict target. Every column that fences a row out of the corpus is
      // set: 'rejected' keeps it out of the review queue and the grade pool,
      // active=false out of think/drift/salience, and holder 'brain' out of
      // every token whose takes-holder allow-list is floored to ['world'].
      const tombstoneKey = takeKey(
        doc.id,
        doc.contentHash16,
        promptVersion,
        EMPTY_EXTRACTION_TOMBSTONE_TEXT,
      );
      // The memo and the retirement are one fact about this document — "this
      // content yields nothing, so the claims the old content produced are no
      // longer backed" — and they must land together. Split across two commits
      // a crash (or a failing statement) between them leaves the document
      // memoized forever WHILE its stranded takes stay active: it is never
      // rediscovered, so nothing ever retires them. One transaction makes the
      // bad state unreachable; if either half fails the whole scan is simply
      // retried next run, which is the pre-tombstone cost and nothing worse.
      //
      // Retirement itself: takes an earlier scan distilled from the OLD content
      // are no longer supported by anything in the corpus, so `think` would keep
      // citing a position the note has since dropped. Marked inactive (the
      // mig090 lifecycle axis), never deleted: grades, resolutions and the
      // calibration record survive. Only LLM-proposed rows are touched — a
      // fence row (row_num NOT NULL) is canon-owned by syncTakesFromFence —
      // and only rows from a DIFFERENT content hash, so takes extracted from
      // this same text under another prompt version stay live. A tombstone
      // left by an earlier scan is already inactive, so it never counts as a
      // retirement.
      try {
        const retiredCount = await engine.transaction(async (tx) => {
          await tx.query(
            `INSERT INTO synth_takes
               (take_key, source_ref, source_hash, prompt_version, claim_text,
                kind, holder, weight, domain, status, active, model_id)
             VALUES ($1, $2, $3, $4, $5, 'fact', 'brain', 0, NULL, 'rejected', false, $6)
             ON CONFLICT (take_key) DO NOTHING`,
            [tombstoneKey, doc.id, doc.contentHash16, promptVersion, EMPTY_EXTRACTION_TOMBSTONE_TEXT, modelId],
          );
          const { rows: retired } = await tx.query<{ id: number }>(
            `UPDATE synth_takes
                SET active = false
              WHERE source_ref = $1
                AND source_hash <> $2
                AND row_num IS NULL
                AND active
            RETURNING id`,
            [doc.id, doc.contentHash16],
          );
          return retired.length;
        });
        result.tombstonesWritten += 1;
        result.takesRetired += retiredCount;
      } catch (e) {
        result.errors.push(
          `${doc.id} tombstone+retire: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      continue;
    }

    for (const parsedTake of takes) {
      // The model can lift a credential out of its source text into a claim.
      let take: typeof parsedTake;
      try {
        take = { ...parsedTake, ...(await guardFields(engine, doc.id, null, "take claim", { claim_text: parsedTake.claim_text })) };
      } catch (e) {
        result.errors.push(`${doc.id} take write: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      const key = takeKey(doc.id, doc.contentHash16, promptVersion, take.claim_text);
      // Embed the claim so `think`'s take VECTOR stream can rank it (opt-in;
      // fail-soft — an embed error leaves the column NULL, keyword recall intact).
      let embedding: string | null = null;
      if (embed) {
        try {
          embedding = JSON.stringify(await embed(take.claim_text));
        } catch (e) {
          result.errors.push(`${doc.id} take embed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      try {
        await engine.query(
          `INSERT INTO synth_takes
             (take_key, source_ref, source_hash, prompt_version, claim_text, kind, weight, domain, status, model_id, embedding)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'queued', $9, $10::vector)
           ON CONFLICT (take_key) DO NOTHING`,
          [key, doc.id, doc.contentHash16, promptVersion, take.claim_text, take.kind, take.weight, take.domain ?? null, modelId, embedding],
        );
        result.takesQueued += 1;
      } catch (e) {
        result.errors.push(`${doc.id} take write: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  return result;
}

// --- grade_takes ------------------------------------------------------------

export interface GradeTakesOptions {
  maxTakes?: number;
  llmFn?: LlmFn;
  modelId?: string;
  promptVersion?: string;
  /**
   * Minimum take age (days) before it is eligible for grading. Default: 6
   * months (`MEMRAIN_GRADE_MIN_AGE_DAYS`, then 182). `0` disables the gate.
   */
  minAgeDays?: number;
  /**
   * Inject evidence retrieval (tests). Default: hybrid search over the corpus,
   * restricted to the take's tenant AND to pages newer than the take (`since` =
   * the take's generated_at date), keyword-scan fallback on error.
   */
  evidenceFn?: (claim: string, sourceId?: string, since?: string) => Promise<string>;
  /** Test seam forwarded to the default hybrid evidence retriever's query
   *  embedder (keeps tests off Bedrock). Production leaves unset. */
  evidenceEmbedQuery?: (text: string) => Promise<number[]>;
  /**
   * Opt-in multi-judge Sonnet ensemble (default from MEMRAIN_TAKE_ENSEMBLE). When
   * on, each take is graded by N Sonnet judges (temperature-diversified) and the
   * verdict is the majority vote with the median confidence — replacing the
   * single-pass utility-tier call. Paid; budget-capped; falls back to single-pass off.
   */
  ensemble?: boolean;
  /** Injected Sonnet seam (tests). Default: the real Bedrock callSonnet. */
  sonnetFn?: SonnetFn;
  /** Shared USD budget for the ensemble run. Default: a fresh cap from env. */
  budget?: BudgetTracker;
  /** Judges per take (default from MEMRAIN_TAKE_ENSEMBLE_JUDGES, then 3). */
  judges?: number;
  /**
   * Gated auto-resolve (default from MEMRAIN_TAKE_AUTO_RESOLVE, OFF): apply a
   * high-confidence verdict to the take's resolution tuple. Never overwrites
   * an existing (human) resolution; 'unresolvable' never applies.
   */
  autoResolve?: boolean;
  /** Single-model confidence bar for auto-apply (default 0.95). */
  autoResolveThreshold?: number;
  /** Ensemble bar: unanimous verdict at/above this confidence (default 0.85). */
  ensembleApplyThreshold?: number;
  /** resolved_by stamp for auto-applied resolutions. */
  autoResolveLabel?: string;
}

export interface EnsembleGrade {
  verdict: TakeVerdict;
  confidence: number;
  reasoning: string;
  /** How many judges actually returned a parseable verdict. */
  judgeCount: number;
  /** True when every parseable vote agreed on the winning verdict. */
  unanimous: boolean;
}

export interface EnsembleResult {
  /** The aggregated grade, or null when judges ran but none parsed (the caller
   *  writes an `unresolvable` fallback — NOT the same as budget-out). */
  grade: EnsembleGrade | null;
  /** Judges actually dispatched. 0 = budget gated before any call → the phase
   *  stops (no spend, nothing to write). >0 with grade=null = spend happened
   *  but no parseable verdict → write the fallback and keep going. A judge's
   *  truncation retry counts with its judge, not as a second one. */
  callsMade: number;
  /**
   * Judges whose output was STILL cut off by the output cap after the
   * larger-cap retry. Their verdict was never emitted, so a null grade with
   * this above zero means "unread", not "the judges disagreed" — the caller
   * must not memoize that as a verdict.
   */
  truncatedJudges: number;
  /** A reserve() refusal or a settle() ceiling hit occurred this take. */
  budgetHit: boolean;
  /** The Sonnet model the judges ran on (for the model_id provenance column). */
  graderModel: string;
}

/** Majority verdict + median confidence among the winning votes. Ties break
 *  toward the verdict with the greatest summed confidence, then by TAKE_VERDICTS
 *  order (deterministic). */
export function aggregateVerdicts(votes: readonly ParsedVerdict[]): ParsedVerdict | null {
  if (votes.length === 0) return null;
  const tally = new Map<TakeVerdict, { count: number; confSum: number }>();
  for (const v of votes) {
    const t = tally.get(v.verdict) ?? { count: 0, confSum: 0 };
    t.count += 1;
    t.confSum += v.confidence;
    tally.set(v.verdict, t);
  }
  let winner: TakeVerdict = votes[0]!.verdict;
  let best = { count: -1, confSum: -1 };
  for (const verdict of TAKE_VERDICTS) {
    const t = tally.get(verdict);
    if (!t) continue;
    if (
      t.count > best.count ||
      (t.count === best.count && t.confSum > best.confSum)
    ) {
      winner = verdict;
      best = t;
    }
  }
  const winning = votes.filter((v) => v.verdict === winner);
  const sorted = winning.map((v) => v.confidence).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const confidence =
    sorted.length % 2 === 1
      ? sorted[mid]!
      : (sorted[mid - 1]! + sorted[mid]!) / 2;
  const reasoning = winning[0]!.reasoning;
  return { verdict: winner, confidence, reasoning };
}

/**
 * Grade one take with an N-judge Sonnet ensemble. Each judge is a fresh Sonnet
 * call (first at temperature 0 for a stable anchor, the rest diversified) over
 * the SAME sanitized claim + evidence. Budget-gated: a pre-call `reserve`
 * skips a judge that can't be afforded, a judge cut off by the output cap
 * retries once with more room when the budget covers it, and `settle` enforces
 * the hard ceiling. Returns null when the budget leaves no room for even one judge, or
 * when no judge produced a parseable verdict. Propagates BudgetExhausted so the
 * phase loop stops (partial progress) exactly like the facts extractor.
 */
export async function gradeTakeEnsemble(
  claim: string,
  evidence: string,
  opts: {
    sonnetFn: SonnetFn;
    budget: BudgetTracker;
    judges: number;
    modelId?: string;
  },
): Promise<EnsembleResult> {
  const user = `Claim: ${sanitizeForPrompt(claim).text}\n\nEvidence:\n${sanitizeForPrompt(evidence).text}`;
  const probeModel = resolveFactsModel(opts.modelId);
  const estUsage = estimateJudgeUsage(claim, evidence);
  const votes: ParsedVerdict[] = [];
  let graderModel = probeModel;
  let callsMade = 0;
  let truncatedJudges = 0;
  let budgetHit = false;
  for (let i = 0; i < opts.judges; i++) {
    const hold = opts.budget.reserve(probeModel, estUsage);
    if (hold === null) {
      budgetHit = true;
      break;
    }
    // A verdict the cap cut in half parses to nothing, so the judge's spend
    // buys silence. Retry it once with more room — but only if the SHARED
    // ensemble budget covers both calls; when it doesn't, the truncation is
    // reported (truncatedJudges) instead of paying twice for the same cut.
    let call: TruncationRetryResult;
    try {
      call = await callWithTruncationRetry(
        "grade_takes_ensemble",
        GRADE_MAX_TOKENS,
        (cap) =>
          opts.sonnetFn({
            system: GRADE_SYSTEM_PROMPT,
            user,
            maxTokens: cap,
            temperature: i === 0 ? 0 : 0.6,
          }),
        (projected) => opts.budget.widen(hold, probeModel, projected),
      );
    } catch (e) {
      opts.budget.release(hold);
      throw e;
    }
    const resp = call.resp;
    callsMade += 1;
    if (call.truncated) truncatedJudges += 1;
    graderModel = resp.modelId;
    let overCap = false;
    try {
      // Both calls were paid for when a retry ran — price the sum.
      opts.budget.settle(hold, resp.modelId, call.usage);
    } catch (e) {
      if (e instanceof BudgetExhausted) {
        budgetHit = true;
        overCap = true;
      } else {
        throw e;
      }
    }
    const parsed = parseVerdictResponse(resp.text);
    if (parsed) votes.push(parsed);
    if (overCap) break; // this call already tipped the ceiling — stop.
  }
  const agg = aggregateVerdicts(votes);
  const unanimous =
    agg !== null && votes.every((v) => v.verdict === agg.verdict);
  return {
    grade: agg ? { ...agg, judgeCount: votes.length, unanimous } : null,
    callsMade,
    truncatedJudges,
    budgetHit,
    graderModel,
  };
}

export interface GradeTakesResult {
  takesScanned: number;
  gradesWritten: number;
  cacheHits: number;
  /** Verdicts applied to the take's resolution tuple by gated auto-resolve. */
  autoApplied: number;
  errors: string[];
}

interface ParsedVerdict {
  verdict: TakeVerdict;
  confidence: number;
  reasoning: string;
}

export function evidenceSignature(evidence: string, modelId: string): string {
  return createHash("sha256").update(`${modelId}|${evidence}`).digest("hex");
}

/** Parse a single-object verdict. Tolerant; returns null on failure. */
export function parseVerdictResponse(raw: string): ParsedVerdict | null {
  const parsed = parseModelJson(raw, "{");
  if (typeof parsed !== "object" || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  const rawV = typeof o.verdict === "string" ? o.verdict : "";
  if (!(TAKE_VERDICTS as readonly string[]).includes(rawV)) return null;
  const cRaw = typeof o.confidence === "number" ? o.confidence : Number.parseFloat(String(o.confidence ?? ""));
  if (!Number.isFinite(cRaw)) return null;
  const confidence = Math.max(0, Math.min(1, cRaw));
  const reasoning = typeof o.reasoning === "string" ? o.reasoning.slice(0, 400) : "";
  return { verdict: rawV as TakeVerdict, confidence, reasoning };
}

/**
 * Hybrid evidence retriever — full hybrid search over the corpus for chunks
 * matching the claim, restricted to the take's own tenant and (crucially) to
 * pages whose content date is NEWER than the take: a forecast can only be
 * graded against the world AFTER it was made (hybrid search over pages newer
 * than the take's since_date). Bypasses the query cache
 * (grade queries are one-off) and throws on failure so the caller can fall
 * back to the keyword scan.
 */
export async function hybridEvidence(
  storage: Storage,
  claim: string,
  opts: {
    sourceId?: string;
    /** ISO date — only evidence with content date >= this participates. */
    since?: string;
    /** Test seam — deterministic query embedder (no Bedrock). */
    embedQuery?: (text: string) => Promise<number[]>;
  } = {},
): Promise<string> {
  const hits = await hybridSearch(storage, claim.slice(0, 300), {
    k: 5,
    noCache: true,
    ...(opts.sourceId ? { sourceIds: [opts.sourceId] } : {}),
    ...(opts.since ? { since: opts.since } : {}),
    ...(opts.embedQuery ? { embedQuery: opts.embedQuery } : {}),
  });
  if (hits.length === 0) return `No corpus evidence found for claim: ${claim}`;
  return hits
    .map((h, i) => `[${i + 1}] (${h.sourcePath}) ${h.content.slice(0, 800)}`)
    .join("\n\n");
}

/**
 * Keyword fallback — the pre-073 deterministic scan (no LLM, no Bedrock).
 * Kept as the fail-soft floor under the hybrid retriever: hybrid needs the
 * full search stack; a brain where that path errors still grades against
 * SOMETHING rather than nothing. Fail-soft: returns a claim-only stub on error.
 */
async function keywordEvidence(
  engine: Engine,
  claim: string,
  sourceId?: string,
): Promise<string> {
  try {
    // Escape LIKE wildcards so a `%`/`_` in the (LLM-derived) claim can't turn
    // the predicate into a match-everything scan.
    const needle = claim.slice(0, 60).replace(/[\\%_]/g, "\\$&");
    // Scope the evidence to the take's OWN source when known — a take must never
    // be graded against another tenant's chunks. Unscoped
    // (operator / legacy) takes keep the whole-corpus scan.
    const params: unknown[] = [needle];
    let scope = "";
    if (typeof sourceId === "string" && sourceId.length > 0) {
      params.push(sourceId);
      scope = ` AND EXISTS (SELECT 1 FROM documents d WHERE d.id = chunks.document_id AND d.source_id = $${params.length})`;
    }
    const { rows } = await engine.query<{ content: string }>(
      `SELECT content FROM chunks
        WHERE content ILIKE '%' || $1 || '%' ESCAPE '\\'${scope}
        ORDER BY length(content) ASC
        LIMIT 5`,
      params,
    );
    if (rows.length === 0) return `No corpus evidence found for claim: ${claim}`;
    return rows.map((r, i) => `[${i + 1}] ${r.content.slice(0, 800)}`).join("\n\n");
  } catch {
    return `Evidence retrieval failed; claim only: ${claim}`;
  }
}

/** Default retriever: hybrid (tenant-scoped, newer-than-the-take) with the
 *  keyword scan as the error floor. */
async function defaultEvidence(
  engine: Engine,
  claim: string,
  sourceId?: string,
  since?: string,
  embedQuery?: (text: string) => Promise<number[]>,
): Promise<string> {
  try {
    return await hybridEvidence(new Storage(engine), claim, {
      ...(sourceId ? { sourceId } : {}),
      ...(since ? { since } : {}),
      ...(embedQuery ? { embedQuery } : {}),
    });
  } catch {
    return keywordEvidence(engine, claim, sourceId);
  }
}

export async function gradeTakesPhase(
  engine: Engine,
  opts: GradeTakesOptions = {},
): Promise<GradeTakesResult> {
  const maxTakes = opts.maxTakes ?? DEFAULT_MAX_TAKES;
  const minAgeDays = opts.minAgeDays ?? gradeMinAgeDays();
  const useEnsemble = opts.ensemble ?? takeEnsembleEnabled();
  const promptVersion =
    opts.promptVersion ??
    (useEnsemble ? GRADE_ENSEMBLE_PROMPT_VERSION : GRADE_TAKES_PROMPT_VERSION);
  const llm = resolveLlmFn(opts.llmFn, opts.modelId ? { modelId: opts.modelId } : {});
  const evidenceFn =
    opts.evidenceFn ??
    ((claim: string, sourceId?: string, since?: string) =>
      defaultEvidence(engine, claim, sourceId, since, opts.evidenceEmbedQuery));
  // Ensemble path (paid Sonnet): one shared budget + injectable model seam.
  const sonnetFn = useEnsemble ? resolveSonnetFn(opts.sonnetFn) : null;
  const budget = useEnsemble
    ? opts.budget ?? new BudgetTracker(ensembleBudgetUsd(), "take-ensemble")
    : null;
  const judges = opts.judges ?? ensembleJudgeCount();
  // Gated auto-resolve: default OFF, conservative bar.
  const autoResolve = opts.autoResolve ?? takeAutoResolveEnabled();
  const autoResolveThreshold = opts.autoResolveThreshold ?? DEFAULT_AUTO_RESOLVE_THRESHOLD;
  const ensembleApplyThreshold = opts.ensembleApplyThreshold ?? DEFAULT_ENSEMBLE_APPLY_THRESHOLD;
  const autoResolveLabel = opts.autoResolveLabel ?? "memrain:grade_takes";
  const result: GradeTakesResult = {
    takesScanned: 0,
    gradesWritten: 0,
    cacheHits: 0,
    autoApplied: 0,
    errors: [],
  };

  // Takes old enough to be resolvable, with no grade yet for this prompt
  // version, oldest first. Status IN ('queued','graded'): a 'graded' take (one
  // already graded under a DIFFERENT prompt version) is still eligible for a
  // re-grade under the current version — the age gate + NOT EXISTS keep it
  // from being re-graded under the SAME version. `accepted`/`rejected` are
  // operator-terminal and excluded.
  const { rows: takes } = await engine.query<{
    id: number;
    take_key: string;
    claim_text: string;
    source_id: string | null;
    generated_at: string | Date;
  }>(
    // The take's own source (via source_ref -> documents) scopes its evidence, so
    // a take is never graded against another tenant's chunks. generated_at feeds
    // the evidence retriever's newer-than-the-take date restriction.
    // Pool (unresolved ACTIVE takes): 'accepted' joins the
    // eligible statuses because operator-authored fence rows enter as
    // 'accepted' and are exactly the takes calibration wants judged; only
    // 'rejected' stays out. A resolved or superseded take is never re-graded.
    `SELECT t.id, t.take_key, t.claim_text, d.source_id, t.generated_at
       FROM synth_takes t
       LEFT JOIN documents d ON d.id = t.source_ref
      WHERE t.status IN ('queued', 'graded', 'accepted')
        AND t.active
        AND t.resolved_at IS NULL
        AND t.generated_at <= now() - ($2 * interval '1 day')
        AND NOT EXISTS (
          SELECT 1 FROM synth_take_grades g
           WHERE g.take_id = t.id AND g.prompt_version = $1
        )
      ORDER BY t.id ASC
      LIMIT $3`,
    [promptVersion, minAgeDays, maxTakes],
  );

  for (const take of takes) {
    result.takesScanned += 1;
    let evidence: string;
    // Evidence must postdate the take: pass the take's creation date so the
    // retriever only surfaces pages written after the claim was made.
    const sinceIso = (() => {
      const d = new Date(take.generated_at);
      return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
    })();
    try {
      evidence = await evidenceFn(take.claim_text, take.source_id ?? undefined, sinceIso);
    } catch (e) {
      result.errors.push(`take ${take.id} evidence: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    let verdict: ParsedVerdict | null;
    let modelId: string;
    let graderModel: string | null = null;
    let judgeCount: number | null = null;
    let ensembleBudgetHit = false;
    let ensembleUnanimous = false;
    let usedEnsemble = false;
    // The judge's output was still cut off after its larger-cap retry AND no
    // verdict could be read out of it — see the guard below.
    let truncatedNoVerdict = false;
    try {
      if (sonnetFn && budget) {
        const ens = await gradeTakeEnsemble(take.claim_text, evidence, {
          sonnetFn,
          budget,
          judges,
          modelId: opts.modelId,
        });
        // No judge was even affordable → stop the phase (nothing spent, nothing
        // to write; the take is re-graded next run). Partial progress.
        if (ens.callsMade === 0) {
          result.errors.push(`take ${take.id} ensemble: budget exhausted before grading`);
          break;
        }
        modelId = ens.graderModel;
        judgeCount = ens.grade?.judgeCount ?? 0;
        graderModel = `ensemble:${judgeCount}`;
        ensembleUnanimous = ens.grade?.unanimous ?? false;
        usedEnsemble = true;
        // Judges ran but none parsed → verdict stays null so the unresolvable
        // fallback below writes a row (a real spend must not vanish silently).
        verdict = ens.grade
          ? { verdict: ens.grade.verdict, confidence: ens.grade.confidence, reasoning: ens.grade.reasoning }
          : null;
        truncatedNoVerdict = verdict === null && ens.truncatedJudges > 0;
        ensembleBudgetHit = ens.budgetHit;
      } else {
        const call = await callWithTruncationRetry(
          "grade_takes",
          GRADE_MAX_TOKENS,
          async (cap) =>
            asRetryable(
              await llm({
                system: GRADE_SYSTEM_PROMPT,
                user: `Claim: ${sanitizeForPrompt(take.claim_text).text}\n\nEvidence:\n${sanitizeForPrompt(evidence).text}`,
                maxTokens: cap,
              }),
            ),
          utilityTierCanRetry,
        );
        verdict = parseVerdictResponse(call.resp.text);
        modelId = call.resp.modelId;
        truncatedNoVerdict = verdict === null && call.truncated;
      }
    } catch (e) {
      result.errors.push(`take ${take.id} judge: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    // A verdict the output cap cut in half is not a verdict, and the
    // unresolvable fallback below must not stand in for one here: that row
    // memoizes (take_id, prompt_version, evidence_sig), so the take would never
    // be judged again over a failure the operator can fix by raising the cap.
    // Report it and leave the take in the pool. (A truncated response that
    // still parsed a whole verdict object is kept — the answer closed.)
    if (truncatedNoVerdict) {
      result.errors.push(
        `take ${take.id} judge: output truncated at the output cap; not graded, retried next run`,
      );
      // Skipping the write must not skip the budget stop below.
      if (ensembleBudgetHit) break;
      continue;
    }
    // A parse failure becomes a low-confidence unresolvable row so the operator
    // sees the failure rather than the take silently disappearing.
    const v: ParsedVerdict = verdict ?? {
      verdict: "unresolvable",
      confidence: 0,
      reasoning: "judge_output_parse_failed",
    };

    const sig = evidenceSignature(evidence, modelId);
    try {
      // The judge quotes its evidence, and evidence is corpus text.
      const { reasoning } = await guardFields(engine, `take:${take.id}`, null, "take grade", { reasoning: v.reasoning });
      const { rows: written } = await engine.query<{ id: number }>(
        `INSERT INTO synth_take_grades
           (take_id, prompt_version, evidence_signature, verdict, confidence, reasoning, model_id, grader_model, judge_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (take_id, prompt_version, evidence_signature) DO NOTHING
         RETURNING id`,
        [take.id, promptVersion, sig, v.verdict, v.confidence, reasoning, modelId, graderModel, judgeCount],
      );
      if (written.length > 0) result.gradesWritten += 1;
      else result.cacheHits += 1;
      // Advance the lifecycle: a graded take leaves the 'queued' pool so
      // `list_takes(status='queued')` stops surfacing it forever. Idempotent
      // (WHERE status='queued'); 'accepted'/'rejected' are operator-terminal
      // and never downgraded here.
      await engine.query(
        `UPDATE synth_takes SET status = 'graded' WHERE id = $1 AND status = 'queued'`,
        [take.id],
      );
      // Gated auto-resolve: apply the verdict to the take's resolution tuple.
      // Eligibility: the gate is ON, a NEW grade row was
      // written, the verdict is decisive ('unresolvable' never applies), and
      // it clears the bar — single-model needs confidence >= 0.95; an
      // ensemble needs unanimity AND confidence >= 0.85. onlyIfUnresolved
      // guarantees a human resolution is never overwritten.
      if (autoResolve && written.length > 0 && v.verdict !== "unresolvable") {
        const eligible = usedEnsemble
          ? ensembleUnanimous && v.confidence >= ensembleApplyThreshold
          : v.confidence >= autoResolveThreshold;
        if (eligible) {
          try {
            const applied = await resolveTake(
              engine,
              take.take_key,
              {
                quality: v.verdict,
                resolvedBy: autoResolveLabel,
                source: `grade_takes:${promptVersion}`,
              },
              { onlyIfUnresolved: true },
            );
            if (applied.resolved) result.autoApplied += 1;
          } catch (e) {
            result.errors.push(
              `take ${take.id} auto-resolve: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }
      }
    } catch (e) {
      result.errors.push(`take ${take.id} grade write: ${e instanceof Error ? e.message : String(e)}`);
    }

    // The budget ceiling was reached grading this take — its grade is written;
    // stop before spending on the next one.
    if (ensembleBudgetHit) break;
  }

  return result;
}

// --- set_take_status --------------------------------------------------------

/**
 * Operator review action: flip a take's review status (accepted/rejected).
 * Tenant-scoped exactly like `listTakes` — when `sourceIds` is supplied the
 * update only lands if the take's source document belongs to one of those
 * tenants, so a caller can never touch a take that isn't theirs (a cross-tenant
 * take_key is a silent no-op). An empty scope updates nothing; `undefined`
 * leaves it unscoped (admin/internal). Returns whether a row was actually updated.
 */
/** Review statuses a take may be moved into by an operator action. */
export const TAKE_REVIEW_STATUSES = ["accepted", "rejected"] as const;

export async function setTakeStatus(
  engine: Engine,
  take_key: string,
  status: string,
  sourceIds?: string[],
): Promise<{ updated: boolean }> {
  // Validate at the function boundary too, not just the dispatch handler — any
  // non-MCP caller (CLI, a future internal path) gets the same guarantee that
  // only a review status can be written.
  if (!(TAKE_REVIEW_STATUSES as readonly string[]).includes(status)) {
    throw new Error(
      `setTakeStatus: status must be one of ${TAKE_REVIEW_STATUSES.join("|")}, got ${JSON.stringify(status)}`,
    );
  }
  const scoped = normalizeScope(sourceIds);
  const params: unknown[] = [status, take_key];
  let sourceFilter = "";
  if (scoped !== undefined && scoped.length === 0) {
    sourceFilter = " AND FALSE";
  } else if (scoped !== undefined) {
    params.push(scoped);
    sourceFilter = ` AND EXISTS (
          SELECT 1 FROM documents d
           WHERE d.id = synth_takes.source_ref
             AND d.source_id = ANY($${params.length}::text[])
        )`;
  }
  const { rows } = await engine.query<{ take_key: string }>(
    `UPDATE synth_takes SET status = $1
       WHERE take_key = $2${sourceFilter}
     RETURNING take_key`,
    params,
  );
  return { updated: rows.length > 0 };
}
