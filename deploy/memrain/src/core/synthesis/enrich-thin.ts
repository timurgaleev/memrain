/**
 * Enrich-thin phase — trickle-develops a few thin (stub) real pages per source
 * per tick via grounded synthesis, so the brain gets SMARTER over time, not just
 * bigger. Reads short real pages that have neighbour evidence (their outbound +
 * inbound wikilinks), runs ONE Sonnet call per stub to expand it USING ONLY that
 * evidence (each expansion cites the neighbours as [[slug]] wikilinks), and
 * rewrites the page in place via putPage (idempotent, source_id-pinned).
 *
 * DELIBERATE: memrain has no server-side subagent / minion runtime, so a
 * per-source minion fan-out becomes a single Sonnet call per thin page here
 * (no tool loop). Grounding evidence is gathered
 * deterministically from the `links` graph rather than a live retrieval agent.
 *
 * Anti-loop: the candidate query excludes the synthesis-written prefixes
 * (reflections/, patterns/, drafts/, drift-reports/, wiki/agents/) so an
 * enrichment never re-develops a synthesis page; and once a stub is expanded past
 * the thin threshold it is no longer a candidate on the next tick.
 *
 * Paid Sonnet slice, default-OFF (MEMRAIN_ENRICH_THIN). Injected `sonnetFn`
 * bypasses the flag for hermetic tests (no live Bedrock).
 */

import type { Engine } from "./../engine/interface.ts";
import type { Storage } from "../storage.ts";
import { putPage } from "../pages.ts";
import { resolveSonnetFn, resolveFactsModel, type SonnetFn, type SonnetUsage } from "../llm/sonnet.ts";
import { sanitizeForPrompt } from "../llm/sanitize.ts";
import { BudgetTracker, BudgetExhausted } from "../budget.ts";
import { callWithTruncationRetry } from "../llm/truncation.ts";
import { parseModelJson } from "../llm/json-output.ts";
import { quarantineFilterFragment } from "../quarantine.ts";
import { PAGE_MIRROR_PATH_SQL } from "../page-index.ts";

export interface EnrichThinPhaseResult {
  ran: boolean;
  reason?: string;
  thinPagesConsidered: number;
  pagesEnriched: number;
  pagesSkippedInsufficient: number;
  spentUsd: number;
  budgetExhausted: boolean;
  errors: string[];
}

export interface EnrichThinPhaseOptions {
  sonnetFn?: SonnetFn;
  modelId?: string;
  /** Single tenant to read stubs from + write enrichments under. Default "default". */
  sourceId?: string;
  /** Page types eligible for enrichment. Default person/company/concept/note. */
  types?: string[];
  /** Bodies shorter than this many chars are "thin". Default 400. */
  thinThreshold?: number;
  /** Max stubs developed per tick (bounds spend). Default 3. */
  maxPages?: number;
  budget?: BudgetTracker;
  /** Hours to wait between paid runs per tenant (default 12; env
   *  MEMRAIN_ENRICH_THIN_COOLDOWN_HOURS). Stops re-paying to expand the same stub
   *  every tick when its expansion keeps getting rejected (stays thin). */
  cooldownHours?: number;
}

/** Default cooldown between paid enrich runs per tenant. */
const DEFAULT_ENRICH_COOLDOWN_HOURS = 12;
function resolveEnrichCooldownHours(v: number | undefined): number {
  if (typeof v === "number" && v >= 0) return v;
  const raw = (process.env.MEMRAIN_ENRICH_THIN_COOLDOWN_HOURS ?? "").trim();
  if (raw === "") return DEFAULT_ENRICH_COOLDOWN_HOURS;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_ENRICH_COOLDOWN_HOURS;
}

/** Newest enrichment write time for this tenant, or null when none. */
async function lastEnrichAt(
  engine: Engine,
  sourceId: string,
): Promise<number | null> {
  const { rows } = await engine.query<{ last: string | null }>(
    `SELECT max(pv.written_at) AS last
       FROM page_versions pv
       JOIN pages p ON p.slug = pv.slug
      WHERE pv.written_by = 'enrichment'
        AND p.source_id = $1
        AND p.deleted_at IS NULL`,
    [sourceId],
  );
  const raw = rows[0]?.last;
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

const DEFAULT_TYPES = ["person", "company", "concept", "note"];

function enrichEnabled(): boolean {
  const v = (process.env.MEMRAIN_ENRICH_THIN ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

function defaultBudget(): number {
  const raw = (process.env.MEMRAIN_ENRICH_THIN_BUDGET_USD ?? "").trim();
  const n = Number.parseFloat(raw);
  // An explicit 0 is a real cap ("spend nothing"), not a fallback to the default.
  return Number.isFinite(n) && n >= 0 ? n : 1.0;
}

function resolveIntConfig(v: number | undefined, envKey: string, def: number): number {
  if (typeof v === "number" && v > 0) return Math.floor(v);
  const n = Number.parseInt((process.env[envKey] ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

function resolveTypes(opt: string[] | undefined): string[] {
  if (Array.isArray(opt) && opt.length > 0) {
    const clean = opt.filter((t): t is string => typeof t === "string" && t.length > 0);
    if (clean.length > 0) return clean;
  }
  const raw = (process.env.MEMRAIN_ENRICH_THIN_TYPES ?? "").trim();
  if (raw) {
    const parts = raw.split(",").map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0);
    if (parts.length > 0) return parts;
  }
  return [...DEFAULT_TYPES];
}

/** Cheap pre-call token estimate: ~4 chars/token in + the output cap. */
function estimateUsage(chars: number, maxOutputTokens: number): SonnetUsage {
  return { inputTokens: Math.ceil(chars / 4), outputTokens: maxOutputTokens };
}

interface ThinPage {
  slug: string;
  type: string;
  title: string | null;
  body: string;
}

interface EvidenceRef {
  slug: string;
  title: string;
  body: string;
}

async function gatherThinPages(
  engine: Engine,
  sourceId: string,
  types: string[],
  threshold: number,
  limit: number,
): Promise<ThinPage[]> {
  const { rows } = await engine.query<{ slug: string; type: string; title: string | null; markdown_body: string | null }>(
    `SELECT slug, type, title, markdown_body
       FROM pages
      WHERE deleted_at IS NULL
        AND source_id = $1
        AND type = ANY($2::text[])
        AND slug NOT LIKE 'reflections/%'
        AND slug NOT LIKE 'patterns/%'
        AND slug NOT LIKE 'drafts/%'
        AND slug NOT LIKE 'drift-reports/%'
        AND slug NOT LIKE 'wiki/agents/%'
        AND length(btrim(coalesce(markdown_body, ''))) < $3
      ORDER BY length(btrim(coalesce(markdown_body, ''))) ASC, updated_at ASC
      LIMIT $4`,
    [sourceId, types, threshold, limit],
  );
  return rows.map((r) => ({
    slug: r.slug,
    type: r.type,
    title: r.title,
    body: r.markdown_body ?? "",
  }));
}

async function gatherEvidence(
  engine: Engine,
  slug: string,
  sourceId: string,
  limit: number,
): Promise<EvidenceRef[]> {
  const { rows } = await engine.query<{ slug: string; title: string | null; markdown_body: string | null }>(
    `SELECT p.slug, p.title, p.markdown_body
       FROM pages p
      WHERE p.deleted_at IS NULL
        AND p.source_id = $2
        AND p.slug <> $1
        AND length(btrim(coalesce(p.markdown_body, ''))) >= 40
        -- Text the gate quarantined in search is not fed to the model either.
        AND NOT EXISTS (
          SELECT 1 FROM documents qd
           WHERE qd.source_path = ${PAGE_MIRROR_PATH_SQL}
             AND NOT (${quarantineFilterFragment("qd")})
        )
        AND (
          p.slug IN (SELECT target_slug FROM links WHERE source_slug = $1)
          OR p.slug IN (SELECT source_slug FROM links WHERE target_slug = $1)
        )
      ORDER BY length(btrim(coalesce(p.markdown_body, ''))) DESC
      LIMIT $3`,
    [slug, sourceId, limit],
  );
  return rows.map((r) => ({
    slug: r.slug,
    title: r.title ?? r.slug,
    body: r.markdown_body ?? "",
  }));
}

function buildPrompt(page: ThinPage, evidence: EvidenceRef[]): string {
  const title = sanitizeForPrompt(page.title ?? page.slug, 120).text;
  const stub = sanitizeForPrompt(page.body, 600).text;
  const corpus = evidence
    .map((e, i) => `### ${i + 1}. [[${e.slug}]] — ${sanitizeForPrompt(e.title, 120).text}\n${sanitizeForPrompt(e.body, 900).text}`)
    .join("\n\n---\n\n");
  return `You develop a THIN stub page in a personal knowledge brain into a fuller,
well-grounded page. Expand it using ONLY the neighbouring evidence provided —
never invent facts, dates, or relationships that are not supported below. Cite
the neighbours you draw on as [[<slug>]] wikilinks. Keep it factual and concise
(2-5 short markdown paragraphs). Do not add a title heading in the body.

Return ONLY a JSON object (no prose):
{
  "title": "A clear page title",
  "markdown": "the expanded page body in markdown, citing [[<slug>]] neighbours"
}
If the evidence is too thin to say anything grounded, return {"markdown": ""}.

PAGE TO DEVELOP
Slug: ${page.slug}
Current title: ${title}
Current stub:
${stub.length > 0 ? stub : "(empty stub)"}

NEIGHBOURING EVIDENCE
${corpus}`;
}

interface EnrichDraft {
  title: string | null;
  markdown: string;
}

function parseEnrichment(text: string): EnrichDraft | null {
  const obj = parseModelJson(text, "{");
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  const markdown = typeof o.markdown === "string" ? o.markdown.trim() : "";
  const title = typeof o.title === "string" && o.title.trim().length > 0 ? o.title.trim() : null;
  if (markdown.length === 0) return null;
  return { title, markdown };
}

/**
 * Run the enrich-thin phase. Injected `sonnetFn` (tests) bypasses the flag gate.
 */
export async function enrichThinPhase(
  storage: Storage,
  opts: EnrichThinPhaseOptions = {},
): Promise<EnrichThinPhaseResult> {
  const base: EnrichThinPhaseResult = {
    ran: false,
    thinPagesConsidered: 0,
    pagesEnriched: 0,
    pagesSkippedInsufficient: 0,
    spentUsd: 0,
    budgetExhausted: false,
    errors: [],
  };

  if (!opts.sonnetFn && !enrichEnabled()) {
    return { ...base, reason: "MEMRAIN_ENRICH_THIN disabled" };
  }

  const engine = storage.engine();
  const sourceId = opts.sourceId ?? "default";
  const types = resolveTypes(opts.types);
  const threshold = resolveIntConfig(opts.thinThreshold, "MEMRAIN_ENRICH_THIN_THRESHOLD", 400);
  const maxPages = resolveIntConfig(opts.maxPages, "MEMRAIN_ENRICH_THIN_MAX_PAGES", 3);

  // Cooldown gate: a stub whose expansion keeps getting rejected stays thin and
  // would be re-picked (and re-paid) every tick — bound that to once per window.
  // Bypassed when a sonnetFn is injected (hermetic tests).
  const cooldownHours = resolveEnrichCooldownHours(opts.cooldownHours);
  if (!opts.sonnetFn && cooldownHours > 0) {
    const last = await lastEnrichAt(engine, sourceId);
    if (last !== null && Date.now() - last < cooldownHours * 3_600_000) {
      return { ...base, reason: `cooldown active (${cooldownHours}h)` };
    }
  }

  let thin: ThinPage[];
  try {
    thin = await gatherThinPages(engine, sourceId, types, threshold, maxPages);
  } catch (e) {
    return { ...base, reason: "gather failed", errors: [String(e instanceof Error ? e.message : e)] };
  }
  base.thinPagesConsidered = thin.length;

  if (thin.length === 0) {
    return { ...base, reason: "no thin pages in scope" };
  }

  const budget = opts.budget ?? new BudgetTracker(defaultBudget(), "enrich-thin");
  const model = resolveFactsModel(opts.modelId);
  const sonnetFn = resolveSonnetFn(opts.sonnetFn, { modelId: model });
  const maxTokens = 1200;

  let ran = false;
  for (const page of thin) {
    let evidence: EvidenceRef[];
    try {
      evidence = await gatherEvidence(engine, page.slug, sourceId, 6);
    } catch (e) {
      base.errors.push(`${page.slug} evidence: ${String(e instanceof Error ? e.message : e)}`);
      continue;
    }
    if (evidence.length < 1) {
      base.pagesSkippedInsufficient += 1;
      continue;
    }

    const prompt = buildPrompt(page, evidence);
    // Budget preflight — hold the estimate, or stop the loop before dispatching a call we can't afford.
    const hold = budget.reserve(model, estimateUsage(prompt.length, maxTokens));
    if (hold === null) {
      base.budgetExhausted = true;
      break;
    }

    ran = true;
    let draft: EnrichDraft | null;
    try {
      const call = await callWithTruncationRetry(
        "enrich-thin",
        maxTokens,
        (cap) =>
          sonnetFn({
            system: "Return only the requested JSON object.",
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
      draft = parseEnrichment(resp.text);
    } catch (e) {
      budget.release(hold);
      base.errors.push(`${page.slug}: ${String(e instanceof Error ? e.message : e)}`);
      if (base.budgetExhausted) break;
      continue;
    }

    // Only accept an expansion that actually grew the stub — a shorter/equal body
    // is not "development" and would churn the version history for nothing.
    if (!draft || draft.markdown.length <= page.body.trim().length) {
      if (base.budgetExhausted) break;
      continue;
    }

    try {
      await putPage(storage, {
        slug: page.slug,
        type: page.type,
        title: draft.title ?? page.title ?? undefined,
        markdown_body: draft.markdown,
        source_id: sourceId,
        written_by: "enrichment",
        allowAdHocType: true,
      });
      base.pagesEnriched += 1;
    } catch (e) {
      base.errors.push(`${page.slug} write: ${String(e instanceof Error ? e.message : e)}`);
    }
    if (base.budgetExhausted) break;
  }

  return { ...base, ran };
}
