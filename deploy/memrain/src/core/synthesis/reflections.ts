/**
 * Reflections phase — distils recent transcripts into durable `reflections/`
 * pages. Runs BEFORE patterns, so on a fresh brain a single tick can populate
 * reflections/ and then let patterns mine them for cross-session themes.
 *
 * Reads recent prose transcripts pinned to one source_id that no reflection has
 * cited yet, runs ONE Sonnet call to draft short reflections (each citing the
 * transcripts it draws on), and writes one `reflections/<topic-slug>` page per
 * draft via putPage (idempotent). Like patterns, this writes real `pages` — the
 * source and the writes are pinned to a single source_id so one tenant's
 * transcripts can never surface in another tenant's reflection.
 *
 * Idempotency without a watermark: a transcript already cited by a reflection
 * (a `links` row from a reflections/ page to it) is excluded from the next run,
 * so the same transcript is not reflected on twice. When the model answers `[]`
 * (nothing worth reflecting on), every transcript it was sent is parked for good
 * on its content hash and model (synth_failures kind `skipped`), so unchanged
 * text is not paid for again. An answer with no JSON array is asked once more
 * for the array; prose a second time parks the batch with the usual backoff.
 *
 * Paid Sonnet slice, default-OFF (MEMRAIN_REFLECTIONS). Injected `sonnetFn`
 * bypasses the flag for hermetic tests (no live Bedrock).
 */

import type { Engine } from "./../engine/interface.ts";
import type { Storage } from "../storage.ts";
import { putPage } from "../pages.ts";
import { verifyQuotes, unverifiedQuotesFrontmatter } from "./quote-verify.ts";
import { EXTRACTION_ELIGIBLE_TYPES } from "../facts-extract.ts";
import { resolveSonnetFn, resolveFactsModel, type SonnetFn, type SonnetUsage } from "../llm/sonnet.ts";
import type { LlmFn } from "../llm/haiku.ts";
import { sanitizeForPrompt } from "../llm/sanitize.ts";
import { BudgetTracker, BudgetExhausted } from "../budget.ts";
import { callWithTruncationRetry } from "../llm/truncation.ts";
import { filterWorthwhile, worthGateEnabled } from "./worth-gate.ts";
import { quarantineFilterFragment } from "../quarantine.ts";
import { PAGE_MIRROR_PATH_SQL } from "../page-index.ts";
import { recordSynthFailure, recordSynthSkip } from "./synth-failures.ts";

export interface ReflectionsPhaseResult {
  ran: boolean;
  reason?: string;
  transcriptsConsidered: number;
  reflectionsWritten: number;
  /** Transcripts the worth gate screened out before the Sonnet call. */
  worthSkipped: number;
  spentUsd: number;
  budgetExhausted: boolean;
  pagesHeld: number;
  errors: string[];
}

export interface ReflectionsPhaseOptions {
  sonnetFn?: SonnetFn;
  modelId?: string;
  /** Single tenant to read transcripts from + write reflections under. Default "default". */
  sourceId?: string;
  /** Slug prefix reflections are written under. Default from env or "reflections/". */
  reflectionPrefix?: string;
  lookbackDays?: number;
  /** Max transcripts fed to the model (bounds spend). Default 20. */
  maxTranscripts?: number;
  budget?: BudgetTracker;
  /**
   * Pre-screen transcripts with the cached Haiku worth gate before they join
   * the paid Sonnet prompt. Default from MEMRAIN_WORTH_GATE (OFF); fail-open.
   */
  worthGate?: boolean;
  /** Haiku seam for the worth gate (tests). */
  worthLlmFn?: LlmFn;
}

interface TranscriptRef {
  slug: string;
  title: string;
  body: string;
  /** synth_failures key: the page's mirror path and content hash. */
  docId: string;
  contentHash: string;
}

/** The one follow-up sent when the first answer holds no readable JSON array. */
export const REFLECTIONS_REASK =
  "Your reply was not the JSON array asked for above. Reply again with only that JSON array and nothing else. " +
  "If nothing is worth reflecting on, reply [].";

interface ReflectionDraft {
  topic_slug: string;
  title: string;
  body: string;
  evidence: string[];
}

const SLUG_SEG = /^[a-z0-9][a-z0-9-]*$/;

/** Output cap for the reflections call — also the bound on the JSON-array scan
 *  below (see REFLECTIONS_ARRAY). */
const REFLECTIONS_MAX_TOKENS = 1500;

/**
 * The JSON array the model was asked for, salvaged out of any wrapping prose.
 * The span is bounded by the phase's own output cap (REFLECTIONS_MAX_TOKENS at
 * the 4-chars-per-token estimate this codebase uses), so a reply that fits the
 * cap parses exactly as before. Unbounded, `/\[[\s\S]*\]/` re-scanned to the
 * end of the string from every `[`: a 16 K run of `[` measured 97 ms through
 * reflectionsPhase, ratio 3.76-4.25 on a doubling (quadratic).
 */
const REFLECTIONS_ARRAY = new RegExp(`\\[[\\s\\S]{0,${REFLECTIONS_MAX_TOKENS * 4}}\\]`);

/** Converse stop reasons for an answer the model declined to give. */
const DECLINED_STOP_REASONS: ReadonlySet<string> = new Set(["content_filtered", "guardrail_intervened", "refusal"]);

function reflectionsEnabled(): boolean {
  const v = (process.env.MEMRAIN_REFLECTIONS ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

function defaultBudget(): number {
  const raw = (process.env.MEMRAIN_REFLECTIONS_BUDGET_USD ?? "").trim();
  const n = Number.parseFloat(raw);
  // An explicit 0 is a real cap ("spend nothing"), not a fallback to the default.
  return Number.isFinite(n) && n >= 0 ? n : 1.0;
}

// Keep the write prefix in lockstep with what the patterns phase mines, so a
// reflection written here is a valid patterns source next tick.
function resolvePrefix(opt: string | undefined): string {
  const p = (opt ?? process.env.MEMRAIN_PATTERNS_REFLECTION_PREFIX ?? "reflections/").trim();
  return p.length > 0 ? p : "reflections/";
}

function resolveIntConfig(v: number | undefined, envKey: string, def: number): number {
  if (typeof v === "number" && v > 0) return Math.floor(v);
  const n = Number.parseInt((process.env[envKey] ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

function estimateUsage(chars: number, maxOutputTokens: number): SonnetUsage {
  return { inputTokens: Math.ceil(chars / 4), outputTokens: maxOutputTokens };
}

async function gatherTranscripts(
  engine: Engine,
  lookbackDays: number,
  sourceId: string,
  limit: number,
  model: string,
): Promise<TranscriptRef[]> {
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
  const { rows } = await engine.query<{ slug: string; title: string | null; markdown_body: string | null; doc_id: string; content_hash: string }>(
    `SELECT p.slug, p.title, p.markdown_body, ${PAGE_MIRROR_PATH_SQL} AS doc_id, p.content_hash
       FROM pages p
      WHERE p.deleted_at IS NULL
        AND p.type = ANY($1::text[])
        AND p.source_id = $2
        AND p.slug NOT LIKE 'reflections/%'
        AND p.slug NOT LIKE 'patterns/%'
        AND p.slug NOT LIKE 'wiki/agents/%'
        AND length(btrim(p.markdown_body)) >= 200
        AND p.updated_at >= $3::timestamptz
        -- Text the gate quarantined in search is not fed to the model either.
        AND NOT EXISTS (
          SELECT 1 FROM documents qd
           WHERE qd.source_path = ${PAGE_MIRROR_PATH_SQL}
             AND NOT (${quarantineFilterFragment("qd")})
        )
        AND NOT EXISTS (
          SELECT 1 FROM links l
           WHERE l.target_slug = p.slug AND l.source_slug LIKE 'reflections/%'
        )
        -- Parked: the model found nothing in this text, or kept answering in
        -- prose (synth-failures.ts). An edit or another model re-opens it.
        AND NOT EXISTS (
          SELECT 1 FROM synth_failures f
           WHERE f.phase = 'reflections' AND f.doc_id = ${PAGE_MIRROR_PATH_SQL}
             AND f.content_hash = p.content_hash AND f.model = $5
             AND f.next_eligible_at > now()
        )
      ORDER BY p.updated_at DESC
      LIMIT $4`,
    [[...EXTRACTION_ELIGIBLE_TYPES], sourceId, since, limit, model],
  );
  return rows.map((r) => ({
    slug: r.slug,
    title: r.title ?? r.slug,
    body: r.markdown_body ?? "",
    docId: r.doc_id,
    contentHash: r.content_hash,
  }));
}

function buildPrompt(transcripts: TranscriptRef[]): string {
  const today = new Date().toISOString().slice(0, 10);
  const corpus = transcripts
    .map((t, i) => `### ${i + 1}. [[${t.slug}]]\n${sanitizeForPrompt(t.body, 1200).text}`)
    .join("\n\n---\n\n");
  return `You distil a person's recent transcripts into durable REFLECTIONS.

A reflection captures a specific insight, tension, decision, or feeling worth
remembering — grounded in the transcripts, not a summary of all of them.

Return ONLY a JSON array (no prose), each item:
{
  "topic_slug": "kebab-case-topic",        // lowercase a-z0-9 + hyphens only
  "title": "Human-readable reflection title",
  "body": "1-3 short markdown paragraphs; cite the transcripts as [[<slug>]] wikilinks",
  "evidence": ["<transcript slug>", "..."] // the transcript slugs this draws on
}
Emit [] if nothing is worth reflecting on. Never invent a slug that is not in
the transcripts below.

Today: ${today}. Transcripts in scope: ${transcripts.length}.

TRANSCRIPTS
${corpus}`;
}

/**
 * `empty` is the model's own "nothing worth reflecting on" (a JSON `[]`);
 * `unreadable` is an answer with no JSON array in it, prose included. Both
 * yield no drafts, but only the first may park the transcripts for good.
 */
type ReflectionsParse = { status: "ok" | "empty" | "unreadable"; drafts: ReflectionDraft[] };

function parseReflections(text: string, validSlugs: Set<string>): ReflectionsParse {
  let arr: unknown;
  try {
    const m = text.match(REFLECTIONS_ARRAY);
    arr = JSON.parse(m ? m[0] : text);
  } catch {
    return { status: "unreadable", drafts: [] };
  }
  if (!Array.isArray(arr)) return { status: "unreadable", drafts: [] };
  if (arr.length === 0) return { status: "empty", drafts: [] };
  const out: ReflectionDraft[] = [];
  for (const it of arr) {
    if (typeof it !== "object" || it === null) continue;
    const o = it as Record<string, unknown>;
    const topic = typeof o.topic_slug === "string" ? o.topic_slug.trim().toLowerCase() : "";
    const title = typeof o.title === "string" ? o.title.trim() : "";
    const body = typeof o.body === "string" ? o.body.trim() : "";
    const evidence = Array.isArray(o.evidence)
      ? Array.from(new Set(o.evidence.filter((s): s is string => typeof s === "string" && validSlugs.has(s))))
      : [];
    if (!SLUG_SEG.test(topic) || title.length === 0 || body.length === 0) continue;
    if (evidence.length < 1) continue;
    out.push({ topic_slug: topic, title, body, evidence });
  }
  return { status: "ok", drafts: out };
}

/**
 * Run the reflections phase. Injected `sonnetFn` (tests) bypasses the flag gate.
 */
export async function reflectionsPhase(
  storage: Storage,
  opts: ReflectionsPhaseOptions = {},
): Promise<ReflectionsPhaseResult> {
  const base: ReflectionsPhaseResult = {
    ran: false,
    transcriptsConsidered: 0,
    reflectionsWritten: 0,
    worthSkipped: 0,
    spentUsd: 0,
    budgetExhausted: false,
    pagesHeld: 0,
    errors: [],
  };

  if (!opts.sonnetFn && !reflectionsEnabled()) {
    return { ...base, reason: "MEMRAIN_REFLECTIONS disabled" };
  }

  const engine = storage.engine();
  const sourceId = opts.sourceId ?? "default";
  const prefix = resolvePrefix(opts.reflectionPrefix);
  const lookbackDays = resolveIntConfig(opts.lookbackDays, "MEMRAIN_REFLECTIONS_LOOKBACK_DAYS", 14);
  const maxTranscripts = resolveIntConfig(opts.maxTranscripts, "MEMRAIN_REFLECTIONS_MAX_TRANSCRIPTS", 20);

  const model = resolveFactsModel(opts.modelId);
  let transcripts: TranscriptRef[];
  try {
    transcripts = await gatherTranscripts(engine, lookbackDays, sourceId, maxTranscripts, model);
  } catch (e) {
    return { ...base, reason: "gather failed", errors: [String(e instanceof Error ? e.message : e)] };
  }
  base.transcriptsConsidered = transcripts.length;

  if (transcripts.length === 0) {
    return { ...base, reason: "no un-reflected transcripts in scope" };
  }

  // Worth gate (opt-in): drop low-signal transcripts BEFORE they join the paid
  // Sonnet prompt. Fail-open — gate errors keep the transcript.
  if (opts.worthGate ?? worthGateEnabled()) {
    const gate = await filterWorthwhile(
      engine,
      transcripts.map((t) => ({ ref: t.slug, content: t.body })),
      opts.worthLlmFn ? { llmFn: opts.worthLlmFn } : {},
    );
    base.worthSkipped = gate.skipped;
    base.errors.push(...gate.errors);
    transcripts = transcripts.filter((t) => gate.kept.has(t.slug));
    if (transcripts.length === 0) {
      return { ...base, reason: "all transcripts screened out by the worth gate" };
    }
  }

  const budget = opts.budget ?? new BudgetTracker(defaultBudget(), "reflections");
  const sonnetFn = resolveSonnetFn(opts.sonnetFn, { modelId: model });
  const maxTokens = REFLECTIONS_MAX_TOKENS;

  const prompt = buildPrompt(transcripts);
  const validSlugs = new Set(transcripts.map((t) => t.slug));
  // One budgeted call (with its truncation retry); null when the cap leaves no room.
  const ask = async (user: string) => {
    const hold = budget.reserve(model, estimateUsage(user.length, maxTokens));
    if (hold === null) return null;
    try {
      const call = await budget.track(() => callWithTruncationRetry(
        "reflections",
        maxTokens,
        (cap) =>
          sonnetFn({
            system: "Return only the requested JSON array.",
            user,
            maxTokens: cap,
            temperature: 0,
          }),
        (projected) => budget.widen(hold, model, projected),
      ));
      try {
        budget.settle(hold, call.resp.modelId, call.usage);
      } catch (e) {
        if (e instanceof BudgetExhausted) base.budgetExhausted = true;
        else throw e;
      }
      return call;
    } catch (e) {
      budget.release(hold);
      throw e;
    }
  };

  let parsed: ReflectionsParse;
  try {
    const first = await ask(prompt);
    if (first === null) {
      return { ...base, reason: "budget exhausted before reflecting", budgetExhausted: true };
    }
    parsed = parseReflections(first.resp.text, validSlugs);
    // An answer in prose (no JSON array at all) is asked once more for the
    // array, so "nothing here" can be recorded instead of paid for every run.
    // A cut-off answer is not prose; never more than one follow-up. A refused or
    // filtered answer, or broken JSON (a `{` in it), would not come back as the array either.
    const declined = DECLINED_STOP_REASONS.has(first.resp.stopReason ?? "") || first.resp.text.includes("{");
    if (parsed.status === "unreadable" && !first.truncated && first.resp.text.trim() !== "" && declined) {
      // No follow-up, but the batch must not be paid for again every run: park it with the usual backoff.
      for (const t of transcripts) {
        await recordSynthFailure(engine, { docId: t.docId, phase: "reflections", contentHash: t.contentHash, model, kind: "unparseable" });
      }
      base.errors.push("model declined or answered with broken JSON; transcripts parked");
    } else if (parsed.status === "unreadable" && !first.truncated && first.resp.text.trim() !== "") {
      const second = await ask(`${prompt}\n\n${REFLECTIONS_REASK}`);
      if (second === null) base.budgetExhausted = true;
      else {
        parsed = parseReflections(second.resp.text, validSlugs);
        if (parsed.status === "unreadable" && !second.truncated) {
          // Still prose: park the transcripts with the usual backoff.
          for (const t of transcripts) {
            await recordSynthFailure(engine, { docId: t.docId, phase: "reflections", contentHash: t.contentHash, model, kind: "unparseable" });
          }
          base.errors.push("model answered without the JSON array twice; transcripts parked");
        }
      }
    }
    base.spentUsd = budget.totalSpent();
  } catch (e) {
    return { ...base, ran: true, spentUsd: budget.totalSpent(), errors: [String(e instanceof Error ? e.message : e)] };
  }

  if (parsed.status === "empty") {
    for (const t of transcripts) {
      await recordSynthSkip(engine, { docId: t.docId, phase: "reflections", contentHash: t.contentHash, model });
    }
  } else if (parsed.status === "ok" && parsed.drafts.length === 0) {
    // An array none of whose entries is usable (no valid slug, no cited
    // transcript) would be paid for again every run: back off as for prose.
    for (const t of transcripts) {
      await recordSynthFailure(engine, { docId: t.docId, phase: "reflections", contentHash: t.contentHash, model, kind: "unparseable" });
    }
    base.errors.push("no usable reflection in the answer; transcripts parked");
  }
  const drafts = parsed.drafts;

  let written = 0;
  const cited = new Set<string>();
  // Evidence of a draft that was held or failed to write stays open for the next run.
  const pending = new Set<string>();
  for (const d of drafts) {
    const slug = `${prefix}${d.topic_slug}`;
    const sourcesMd = d.evidence.map((s) => `- [[${s}]]`).join("\n");
    const quotes = verifyQuotes(d.body, transcripts.filter(t => d.evidence.includes(t.slug)).map(t => t.body));
    const body = `${unverifiedQuotesFrontmatter(quotes.unverified_quotes)}${quotes.answer}\n\n## Sources\n${sourcesMd}\n`;
    try {
      const pageWrite = await putPage(storage, {
        slug,
        type: "note",
        title: d.title,
        markdown_body: body,
        source_id: sourceId,
        written_by: "reflection",
        written_by_principal: "operator",
        onlyOverwriteWriter: "reflection",
      });
      if (pageWrite.held) {
        base.pagesHeld += 1;
        for (const s of d.evidence) pending.add(s);
      } else {
        written += 1;
        for (const s of d.evidence) cited.add(s);
      }
    } catch (e) {
      base.errors.push(`${slug}: ${String(e instanceof Error ? e.message : e)}`);
      for (const s of d.evidence) pending.add(s);
    }
  }
  // A transcript the model read but no written reflection cites is neither linked
  // from a reflection nor parked, so it would be sent again every run. A draft that
  // failed to write leaves its evidence open for the next run.
  if (written > 0) {
    for (const t of transcripts) {
      if (cited.has(t.slug) || pending.has(t.slug)) continue;
      await recordSynthSkip(engine, { docId: t.docId, phase: "reflections", contentHash: t.contentHash, model });
    }
  }

  return { ...base, ran: true, reflectionsWritten: written };
}
