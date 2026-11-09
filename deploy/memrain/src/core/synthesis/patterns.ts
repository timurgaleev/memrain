/**
 * Patterns phase — cross-session theme detection.
 *
 * Reads recent "reflection" pages (slug prefix, within a lookback window), runs
 * ONE Sonnet call to surface themes that recur across >= min_evidence distinct
 * reflections, and writes one `patterns/<topic-slug>` page per theme (idempotent
 * via putPage).
 *
 * DELIBERATE design choices:
 *   - Single Sonnet call returning structured JSON, then memrain writes the pages
 *     directly — no minion/subagent tool loop, no reverse-write to a filesystem
 *     mirror (memrain is DB-canonical).
 *   - Reflection source is a configurable slug prefix (memrain has no fixed
 *     `wiki/personal/reflections/` convention).
 *
 * ARCHITECTURE NOTE: this is the ONE synthesis phase that writes real `pages`
 * (every other synth_* phase writes only the synth_* namespace, mig 045). The
 * operator explicitly authorized this behavior. Reads and
 * writes are pinned to a single source_id so one tenant's reflections can never
 * be mined into another tenant's pattern page.
 *
 * Paid Sonnet slice, default-OFF (MEMRAIN_PATTERNS). Injected `sonnetFn` bypasses
 * the flag for hermetic tests (no live Bedrock).
 */

import type { Engine } from "./../engine/interface.ts";
import type { Storage } from "../storage.ts";
import { putPage } from "../pages.ts";
import { verifyQuotes, unverifiedQuotesFrontmatter } from "./quote-verify.ts";
import { resolveSonnetFn, resolveFactsModel, type SonnetFn, type SonnetUsage } from "../llm/sonnet.ts";
import { sanitizeForPrompt } from "../llm/sanitize.ts";
import { BudgetTracker, BudgetExhausted } from "../budget.ts";
import { callWithTruncationRetry } from "../llm/truncation.ts";
import { parseModelJson } from "../llm/json-output.ts";

export interface PatternsPhaseResult {
  ran: boolean;
  reason?: string;
  reflectionsConsidered: number;
  patternsWritten: number;
  spentUsd: number;
  budgetExhausted: boolean;
  pagesHeld: number;
  errors: string[];
}

export interface PatternsPhaseOptions {
  sonnetFn?: SonnetFn;
  modelId?: string;
  /** Single tenant to read reflections from + write patterns under. Default "default". */
  sourceId?: string;
  /** Slug prefix identifying reflection pages. Default from env or "reflections/". */
  reflectionPrefix?: string;
  lookbackDays?: number;
  minEvidence?: number;
  /** Max reflections fed to the model (bounds spend). Default 100. */
  maxReflections?: number;
  budget?: BudgetTracker;
}

interface ReflectionRef {
  slug: string;
  title: string;
  excerpt: string;
}

interface PatternDraft {
  topic_slug: string;
  title: string;
  body: string;
  evidence: string[];
}

const SLUG_SEG = /^[a-z0-9][a-z0-9-]*$/;

function patternsEnabled(): boolean {
  const v = (process.env.MEMRAIN_PATTERNS ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

function defaultBudget(): number {
  const raw = (process.env.MEMRAIN_PATTERNS_BUDGET_USD ?? "").trim();
  const n = Number.parseFloat(raw);
  // An explicit 0 is a real cap ("spend nothing"), not a fallback to the default.
  return Number.isFinite(n) && n >= 0 ? n : 1.0;
}

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

async function gatherReflections(
  engine: Engine,
  prefix: string,
  lookbackDays: number,
  sourceId: string,
  limit: number,
): Promise<ReflectionRef[]> {
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
  const { rows } = await engine.query<{ slug: string; title: string | null; markdown_body: string | null }>(
    `SELECT slug, title, markdown_body
       FROM pages
      WHERE slug LIKE $1
        AND deleted_at IS NULL
        AND source_id = $2
        AND updated_at >= $3::timestamptz
      ORDER BY updated_at DESC
      LIMIT $4`,
    [prefix.replace(/([%_])/g, "\\$1") + "%", sourceId, since, limit],
  );
  return rows.map((r) => ({
    slug: r.slug,
    title: r.title ?? r.slug,
    excerpt: (r.markdown_body ?? "").slice(0, 600),
  }));
}

function buildPrompt(reflections: ReflectionRef[], minEvidence: number): string {
  const today = new Date().toISOString().slice(0, 10);
  const corpus = reflections
    .map((r, i) => `### ${i + 1}. [[${r.slug}]] — ${sanitizeForPrompt(r.title, 120).text}\n${sanitizeForPrompt(r.excerpt, 600).text}`)
    .join("\n\n---\n\n");
  return `You surface recurring THEMES across a person's recent reflections.

A "pattern" is a recurring theme, anxiety, decision pattern, relationship dynamic,
or self-knowledge motif that appears in at least ${minEvidence} DISTINCT reflections.
NOT a single insight. NOT a list of unrelated topics. NOT a daily digest.

Return ONLY a JSON array (no prose), each item:
{
  "topic_slug": "kebab-case-topic",        // lowercase a-z0-9 + hyphens only
  "title": "Human-readable pattern title",
  "body": "1-3 short paragraphs of markdown; cite the reflections as [[<slug>]] wikilinks",
  "evidence": ["<reflection slug>", "..."] // >= ${minEvidence} distinct reflection slugs
}
Emit [] if no theme has >= ${minEvidence} distinct reflections. Never invent a slug
that is not in the reflections below.

Today: ${today}. Reflections in scope: ${reflections.length}.

REFLECTIONS
${corpus}`;
}

function parsePatterns(text: string, validSlugs: Set<string>, minEvidence: number): PatternDraft[] {
  const arr = parseModelJson(text, "[");
  if (!Array.isArray(arr)) return [];
  const out: PatternDraft[] = [];
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
    if (evidence.length < minEvidence) continue;
    out.push({ topic_slug: topic, title, body, evidence });
  }
  return out;
}

/**
 * Run the patterns phase. Injected `sonnetFn` (tests) bypasses the flag gate.
 */
export async function patternsPhase(
  storage: Storage,
  opts: PatternsPhaseOptions = {},
): Promise<PatternsPhaseResult> {
  const base: PatternsPhaseResult = {
    ran: false,
    reflectionsConsidered: 0,
    patternsWritten: 0,
    spentUsd: 0,
    budgetExhausted: false,
    pagesHeld: 0,
    errors: [],
  };

  if (!opts.sonnetFn && !patternsEnabled()) {
    return { ...base, reason: "MEMRAIN_PATTERNS disabled" };
  }

  const engine = storage.engine();
  const sourceId = opts.sourceId ?? "default";
  const prefix = resolvePrefix(opts.reflectionPrefix);
  const lookbackDays = resolveIntConfig(opts.lookbackDays, "MEMRAIN_PATTERNS_LOOKBACK_DAYS", 30);
  const minEvidence = resolveIntConfig(opts.minEvidence, "MEMRAIN_PATTERNS_MIN_EVIDENCE", 3);
  const maxReflections = resolveIntConfig(opts.maxReflections, "MEMRAIN_PATTERNS_MAX_REFLECTIONS", 100);

  let reflections: ReflectionRef[];
  try {
    reflections = await gatherReflections(engine, prefix, lookbackDays, sourceId, maxReflections);
  } catch (e) {
    return { ...base, reason: "gather failed", errors: [String(e instanceof Error ? e.message : e)] };
  }
  base.reflectionsConsidered = reflections.length;

  if (reflections.length < minEvidence) {
    return { ...base, reason: `only ${reflections.length} reflections (need >= ${minEvidence})` };
  }

  const budget = opts.budget ?? new BudgetTracker(defaultBudget(), "patterns");
  const model = resolveFactsModel(opts.modelId);
  const sonnetFn = resolveSonnetFn(opts.sonnetFn, { modelId: model });
  const maxTokens = 1500;

  const prompt = buildPrompt(reflections, minEvidence);
  // Budget preflight — hold the estimate, or skip the call when the cap leaves no room.
  const hold = budget.reserve(model, estimateUsage(prompt.length, maxTokens));
  if (hold === null) {
    return { ...base, reason: "budget exhausted before mining", budgetExhausted: true };
  }

  let drafts: PatternDraft[];
  try {
    const call = await callWithTruncationRetry(
      "patterns",
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
    const validSlugs = new Set(reflections.map((r) => r.slug));
    drafts = parsePatterns(resp.text, validSlugs, minEvidence);
  } catch (e) {
    budget.release(hold);
    return { ...base, ran: true, spentUsd: budget.totalSpent(), errors: [String(e instanceof Error ? e.message : e)] };
  }

  let written = 0;
  for (const d of drafts) {
    const slug = `patterns/${d.topic_slug}`;
    const evidenceMd = d.evidence.map((s) => `- [[${s}]]`).join("\n");
    const quotes = verifyQuotes(d.body, reflections.filter(r => d.evidence.includes(r.slug)).map(r => r.excerpt));
    const body = `${unverifiedQuotesFrontmatter(quotes.unverified_quotes)}${quotes.answer}\n\n## Evidence\n${evidenceMd}\n`;
    try {
      const pageWrite = await putPage(storage, {
        slug,
        type: "note",
        title: d.title,
        markdown_body: body,
        source_id: sourceId,
        written_by: "patterns",
        written_by_principal: "operator",
        onlyOverwriteWriter: "patterns",
      });
      if (pageWrite.held) base.pagesHeld += 1;
      else written += 1;
    } catch (e) {
      base.errors.push(`${slug}: ${String(e instanceof Error ? e.message : e)}`);
    }
  }

  return { ...base, ran: true, patternsWritten: written };
}
