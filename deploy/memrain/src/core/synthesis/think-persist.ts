/**
 * think persistence — `think --save` / `--take` core. The CLI/MCP flags live
 * with their own surfaces; these are the functions they call:
 *
 *   persistThinkSynthesis  write the synthesis as a real `synthesis/<slug>`
 *                          page (putPage, idempotent) + one synthesis_evidence
 *                          row per validated citation (migration 075), so a
 *                          think answer stops evaporating with the process.
 *   saveThinkTake          queue the answer's headline claim as a synth_takes
 *                          row pinned to an anchor page, entering the normal
 *                          propose→grade→calibrate loop.
 *   renderAnswerWithGaps   the one renderer every think surface (page, CLI,
 *                          auto-think draft) goes through, so gaps render once.
 *
 * Both refuse empty input and never throw for a per-row failure (warnings
 * carry the misses). No LLM calls — persistence is free.
 */
import { unverifiedQuotesFrontmatter } from "./quote-verify.ts";
import type { Storage } from "../storage.ts";
import type { Engine } from "../engine/interface.ts";
import { putPage } from "../pages.ts";
import { contentHash16 } from "./atoms.ts";
import { takeKey } from "./takes.ts";
import { flagRowAt, holdIfQuarantined, type RowHeld } from "../write-gate-rows.ts";
import { stripGapsSection, type ThinkResult } from "./think.ts";
import { MODEL_DERIVED_TIER, evidenceTier, lowerPageTier, type DerivationEvidence } from "../trust-derived.ts";
import { lowerTier, principalTier, type TrustTier } from "../trust-tier.ts";
import { recordDerivationOrigins } from "../owner-only.ts";

/** Prompt-version marker for operator-committed think takes. */
export const THINK_TAKE_PROMPT_VERSION = "think-take-v1";

export interface PersistSynthesisResult {
  /** The saved page slug; "" when nothing was persisted. */
  slug: string;
  evidenceInserted: number;
  pagesHeld: number;
  warnings: string[];
}

/**
 * Render a think answer with its gaps appended exactly once.
 *
 * Gaps live in the structured `gaps` array and every surface prints that array
 * itself; a model that also leaves a "## Gaps" section in the prose would make
 * them show up twice. The strip belongs here rather than at each call site —
 * the saved page, the CLI and the auto-think draft all render through this, so
 * a new surface cannot reintroduce the double render by forgetting it.
 *
 * `heading`/`bullet` carry the caller's format (markdown page vs. console).
 */
export function renderAnswerWithGaps(
  answer: string,
  gaps: readonly string[],
  opts: { heading?: string; bullet?: string } = {},
): string {
  const body = stripGapsSection(answer ?? "");
  if (gaps.length === 0) return body;
  const heading = opts.heading ?? "## Gaps";
  const bullet = opts.bullet ?? "- ";
  return `${body}\n\n${heading}\n${gaps.map((g) => `${bullet}${g}`).join("\n")}`;
}

/** Deterministic synthesis page slug: synthesis/<question-slug>-<date>. */
export function synthesisSlugFor(question: string, date: Date = new Date()): string {
  const day = date.toISOString().slice(0, 10);
  const safe =
    question
      .toLowerCase()
      .replace(/[^a-z0-9\s]+/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 60)
      // Measured linear through synthesisSlugFor: 0.19 ms on a 256 K question
      // of dashes, 1.6 ms on a 256 K `a ` run ending in dashes, ratio 2.0 on a
      // doubling. The `.slice(0, 60)` on the line above is the whole argument —
      // this quantifier never sees more than 60 characters.
      // eslint-disable-next-line regexp/no-super-linear-move
      .replace(/-+$/g, "") || "untitled";
  return `synthesis/${safe}-${day}`;
}


/**
 * Persist a think result as a synthesis page + citation evidence rows.
 * An empty/missing answer is never persisted (returns slug="" + warning).
 */
export async function persistThinkSynthesis(
  storage: Storage,
  opts: {
    question: string;
    result: ThinkResult;
    /** Owning tenant for the saved page. Default "default". */
    sourceId?: string;
  },
): Promise<PersistSynthesisResult> {
  const s = opts.result.synthesis;
  if (!s || s.answer.trim().length === 0) {
    return { slug: "", evidenceInserted: 0, pagesHeld: 0, warnings: ["SYNTHESIS_EMPTY_NOT_PERSISTED"] };
  }
  const warnings: string[] = [];
  const slug = synthesisSlugFor(opts.question);
  // `s.answer` is the quote-checked text; quotes found in no evidence are
  // listed in frontmatter so a reviewer can find them without rereading.
  const body = `${unverifiedQuotesFrontmatter(opts.result.unverified_quotes)}# ${opts.question}\n${renderAnswerWithGaps(s.answer, s.gaps)}`;

  const pageWrite = await putPage(storage, {
    slug,
    type: "synthesis",
    allowAdHocType: true,
    title: opts.question.slice(0, 200),
    markdown_body: body,
    source_id: opts.sourceId ?? "default",
    written_by: "think",
        written_by_principal: "operator",
    onlyOverwriteWriter: "think",
  });

  if (pageWrite.held) {
    return { slug: "", evidenceInserted: 0, pagesHeld: 1, warnings: ["SYNTHESIS_AUTHORED_EDIT_HELD"] };
  }

  const engine = storage.engine();
  const sourceId = opts.sourceId ?? "default";
  // Model output, so at most an agent's, and no more trusted than what the model read.
  await lowerPageTier(engine, slug, sourceId, await derivedTier(engine, opts.result.evidence));
  // It also carries where its inputs came from, so an answer built on an
  // owner-only source stays closed with it.
  if (opts.result.evidence) await recordDerivationOrigins(engine, "page", slug, sourceId, opts.result.evidence);
  let inserted = 0;
  for (let i = 0; i < s.citations.length; i++) {
    const c = s.citations[i]!;
    try {
      const { rows } = await engine.query<{ id: number }>(
        `INSERT INTO synthesis_evidence (synthesis_slug, ref, kind, citation_index)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (synthesis_slug, kind, ref) DO NOTHING
         RETURNING id`,
        [slug, c.ref, c.kind, i],
      );
      if (rows.length > 0) inserted += 1;
    } catch (e) {
      warnings.push(`evidence ${c.kind}:${c.ref}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { slug, evidenceInserted: inserted, pagesHeld: 0, warnings };
}

export interface SaveThinkTakeResult {
  take_key: string;
  /** false = an identical take already existed (idempotent no-op), or it was held. */
  inserted: boolean;
  /** Set when the write gate held the take for the owner. */
  held?: RowHeld;
}

/**
 * Queue a take distilled from a think run, pinned to an anchor page slug.
 * Enters the synth_takes review queue as status 'queued' — it is graded and
 * calibrated like any proposed take, never auto-accepted.
 */
export async function saveThinkTake(
  engine: Engine,
  opts: {
    claim: string;
    /** The anchor/synthesis page slug the take is provenanced to. */
    anchorSlug: string;
    /** Conviction weight 0..1. Default 0.6. */
    weight?: number;
    domain?: string;
    /** Provenance model id (the think run's model). Default "operator". */
    modelId?: string;
    /** The credential that asked for the take; the operator when absent. */
    principal?: string | null;
    /** What the think run read; the take is no more trusted than the least trusted of it. */
    evidence?: DerivationEvidence;
  },
): Promise<SaveThinkTakeResult> {
  const claim = (opts.claim ?? "").trim();
  if (!claim) throw new Error("saveThinkTake: claim must be non-empty");
  if (!opts.anchorSlug || opts.anchorSlug.trim().length === 0) {
    throw new Error("saveThinkTake: anchorSlug must be non-empty");
  }
  const weight = Math.max(0, Math.min(1, opts.weight ?? 0.6));
  const sourceHash = contentHash16(claim);
  const key = takeKey(opts.anchorSlug, sourceHash, THINK_TAKE_PROMPT_VERSION, claim);
  // The take is model output drawn from the evidence: its tier, and the tier
  // the gate assesses it at, is the lowest of the writer, what it read, and an agent's.
  const tier = lowerTier(principalTier(opts.principal ?? null), await derivedTier(engine, opts.evidence));
  const origin = { page: opts.anchorSlug, principal: opts.principal ?? null, floor: tier };
  const held = await holdIfQuarantined(engine, {
    table: "synth_takes",
    fields: [{ field: "claim", text: claim.slice(0, 500) }],
    slug: opts.anchorSlug,
    payload: {
      take_key: key, source_ref: opts.anchorSlug, source_hash: sourceHash, prompt_version: THINK_TAKE_PROMPT_VERSION,
      claim_text: claim.slice(0, 500), kind: "judgment", weight, domain: opts.domain ?? null, status: "queued",
      model_id: opts.modelId ?? "operator",
    },
  }, origin);
  if (held !== null) return { take_key: key, inserted: false, held };
  const { rows } = await engine.query<{ id: number }>(
    `INSERT INTO synth_takes
       (take_key, source_ref, source_hash, prompt_version, claim_text, kind, weight, domain, status, model_id, trust_tier)
     VALUES ($1, $2, $3, $4, $5, 'judgment', $6, $7, 'queued', $8, $9)
     ON CONFLICT (take_key) DO NOTHING
     RETURNING id`,
    [
      key,
      opts.anchorSlug,
      sourceHash,
      THINK_TAKE_PROMPT_VERSION,
      claim.slice(0, 500),
      weight,
      opts.domain ?? null,
      opts.modelId ?? "operator",
      tier,
    ],
  );
  if (rows.length > 0) {
    if (opts.evidence) await recordDerivationOrigins(engine, "take", String(rows[0]!.id), null, opts.evidence);
    await flagRowAt(engine, { table: "synth_takes", targetId: key, fields: [{ field: "claim", text: claim.slice(0, 500) }] }, origin);
  }
  return { take_key: key, inserted: rows.length > 0 };
}

/** A model-derived row's ceiling: an agent's, lowered to the least trusted of what it read. */
async function derivedTier(engine: Engine, evidence: DerivationEvidence | undefined): Promise<TrustTier> {
  const read = evidence ? await evidenceTier(engine, evidence) : undefined;
  return read ? lowerTier(MODEL_DERIVED_TIER, read) : MODEL_DERIVED_TIER;
}
