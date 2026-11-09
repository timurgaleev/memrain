import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Engine } from "./engine/interface.ts";
import type { Storage } from "./storage.ts";
import { canonicalPath, isDeniedPath, isUnderRoot } from "./path_guard.ts";
import { loadRereadGuard } from "./sources.ts";
import { chunkMarkdown, MARKDOWN_CHUNKER_VERSION } from "./chunkers/recursive.ts";
import { chunkCode, CODE_CHUNKER_VERSION } from "./chunkers/code.ts";
import { extractFencedCode } from "./chunkers/fenced-code.ts";
import { stripFactsFence } from "./facts-fence.ts";
import { stripTakesFence } from "./synthesis/takes-fence.ts";
import { guardSecrets } from "./secret-scan.ts";
import { applyInference } from "./frontmatter-inference.ts";
import { compiledTruthHash, pageSourcePath, pageTruthSourcePath, serializeCompiledTruth } from "./page-index.ts";
import { contextualLlmEnabled } from "./search/contextual-llm.ts";
import { contextualRetrievalEnabled } from "./search/contextual-embed.ts";
import { resolveOperatorLiterals } from "./content-sanity.ts";
import { awsRegion } from "./llm/gateway.ts";
import { DEFAULT_MODEL_ID, EMBED_DIMENSIONS } from "./embedding.ts";
import { EMBEDDING_PRICING, worstCaseUsd, type ModelPricing } from "./budget.ts";
import { OperationError } from "./operation-error.ts";

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_CANDIDATES = 10_000;

export interface RechunkOptions {
  source: "vault" | "code" | "all";
  vault?: string;
  codePaths?: string[];
  limit?: number;
  maxCostUsd?: number;
  embeddingModel?: string;
}

export interface RechunkSelection {
  source: RechunkOptions["source"];
  vault: string | null;
  code_paths: string[];
  limit: number;
  max_cost_usd: number;
  model: string;
  region: string;
  embedding_price: ModelPricing | null;
  max_attempts: 1;
  dimensions: number;
  markdown_version: number;
  code_version: number;
  settings: Record<string, string>;
}

interface DocumentRow {
  id: string;
  source_path: string;
  source_id: string | null;
  chunker_version: number;
  last_indexed_mtime: number | null;
  frontmatter: Record<string, unknown> | null;
}

export interface RechunkTarget {
  document_id: string;
  source_path: string;
  source_id: string | null;
  kind: "code" | "markdown" | "page" | "truth";
  current_version: number;
  target_version: number;
  snapshot_hash: string;
  input_hash: string;
  cost_upper_bound_usd: number;
  page_slug?: string;
}

export interface RechunkPlan {
  selection: RechunkSelection;
  targets: RechunkTarget[];
  held: Array<{ document_id: string; reason: string }>;
  selected: number;
  candidates: number;
  truncated: boolean;
  cost_upper_bound_usd: number;
  applicable: boolean;
  plan_hash: string;
}

export interface RechunkInput {
  text: string;
  mtimeMs?: number;
  extraFrontmatter?: Record<string, unknown>;
  inputHash: string;
  pageSlug?: string;
}

export function rechunkHash(value: unknown): string {
  const stable = (v: unknown): unknown => Array.isArray(v) ? v.map(stable)
    : v !== null && typeof v === "object"
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, stable(x)]))
      : v;
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function selectionFor(storage: Storage, opts: RechunkOptions): RechunkSelection {
  const limit = opts.limit ?? 25;
  const maxCost = opts.maxCostUsd ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("rechunk limit must be 1..1000");
  if (!Number.isFinite(maxCost) || maxCost < 0) throw new Error("rechunk max-cost-usd must be finite and non-negative");
  if (!["vault", "code", "all"].includes(opts.source)) throw new Error("invalid rechunk source");
  const settings = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => /^(?:MEMRAIN|MEMEX)_(?:CHUNK_|CONTEXTUAL_|MAX_FENCES|CONTENT_SANITY|SECRET_|CODE_SECRET|SANITY_|NO_SANITY|PAGE_WARN_BYTES|PAGE_BLOCK_BYTES|MAX_MARKUP_RATIO)/.test(key))
    .map(([key, value]) => [key, rechunkHash(value)]));
  const model = opts.embeddingModel ?? storage.config()?.embedding.model ?? DEFAULT_MODEL_ID;
  const price = EMBEDDING_PRICING.find(row => model.toLowerCase().includes(row.match))?.price ?? null;
  return { source: opts.source, vault: opts.vault ? canonicalPath(resolve(opts.vault)) : null,
    code_paths: [...new Set((opts.codePaths ?? []).map(p => canonicalPath(resolve(p))))].sort(),
    limit, max_cost_usd: maxCost, model, region: awsRegion(), embedding_price: price, max_attempts: 1,
    dimensions: EMBED_DIMENSIONS, markdown_version: MARKDOWN_CHUNKER_VERSION, code_version: CODE_CHUNKER_VERSION,
    settings: { ...settings, sanity_literals: rechunkHash(resolveOperatorLiterals()) } };
}

export async function rechunkSnapshot(engine: Engine, id: string): Promise<string> {
  const row = await engine.query(
    `SELECT to_jsonb(d) AS document,
       (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM chunks c WHERE c.document_id = d.id) AS chunks,
       (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.chunk_id, e.model) FROM embeddings e
          JOIN chunks c ON c.id = e.chunk_id WHERE c.document_id = d.id) AS embeddings
       FROM documents d WHERE d.id = $1`, [id]);
  return rechunkHash(row.rows);
}

export async function loadRechunkInput(engine: Engine, target: Pick<RechunkTarget, "document_id" | "source_path" | "source_id" | "kind">,
  selection: RechunkSelection): Promise<RechunkInput> {
  if (target.kind === "page" || target.kind === "truth") {
    const { rows } = await engine.query<{
      slug: string; title: string | null; markdown_body: string; compiled_truth: Record<string, unknown>;
      content_hash: string; source_id: string; version: number;
    }>(`SELECT p.slug, p.title, p.markdown_body, p.compiled_truth, p.content_hash, p.source_id,
         (SELECT COALESCE(MAX(v.version_n), 0) FROM page_versions v WHERE v.slug = p.slug)::int AS version
       FROM pages p WHERE p.deleted_at IS NULL AND p.source_id = $1
         AND CASE WHEN p.source_id = 'default' THEN $2 || p.slug ELSE $2 || p.source_id || '/' || p.slug END = $3`,
    [target.source_id, target.kind === "truth" ? "page-truth://" : "page://", target.source_path]);
    const page = rows[0];
    if (!page || rows.length !== 1) throw new Error("canonical_page_owner_missing");
    const truth = target.kind === "truth";
    const path = truth ? pageTruthSourcePath(page.slug, page.source_id) : pageSourcePath(page.slug, page.source_id);
    if (path !== target.source_path) throw new Error("canonical_page_path_changed");
    const text = truth ? serializeCompiledTruth(page.title, page.slug, page.compiled_truth)
      : page.title && !/^\s*#\s/.test(page.markdown_body)
        ? `# ${page.title}\n\n${page.markdown_body}` : page.markdown_body;
    if (!text.trim()) throw new Error("empty_page_mirror_requires_separate_removal");
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("source_too_large");
    return { text, pageSlug: page.slug, inputHash: rechunkHash(page), extraFrontmatter: truth
      ? { page_truth_hash: compiledTruthHash(text) }
      : { page_content_hash: page.content_hash, page_title: page.title ?? "" } };
  }
  const { rows } = await engine.query<DocumentRow>(
    "SELECT id, source_path, source_id, chunker_version, last_indexed_mtime, frontmatter FROM documents WHERE id = $1 AND deleted_at IS NULL",
    [target.document_id]);
  const row = rows[0];
  if (!row || row.source_id !== target.source_id || row.source_path !== target.source_path) throw new Error("document_changed");
  const roots = target.kind === "code" ? selection.code_paths : selection.vault ? [selection.vault] : [];
  const guard = await loadRereadGuard(engine, roots);
  const allowed = guard(row.source_path, { sourceId: row.source_id, lastIndexedMtime: row.last_indexed_mtime });
  if (!allowed.ok || isDeniedPath(allowed.canonical)) throw new Error("file_read_refused");
  const fd = openSync(allowed.canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("source_not_bounded_file");
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (bytes.length > MAX_BYTES || stat.mtimeMs !== after.mtimeMs || stat.size !== after.size) throw new Error("file_changed_during_read");
    return { text: bytes.toString("utf8"), mtimeMs: Math.floor(stat.mtimeMs), inputHash: rechunkHash({
      digest: createHash("sha256").update(bytes).digest("hex"), dev: stat.dev, ino: stat.ino, size: stat.size, mtime: stat.mtimeMs,
    }) };
  } finally { closeSync(fd); }
}

async function estimateCost(input: RechunkInput, target: RechunkTarget, selection: RechunkSelection): Promise<number> {
  if (target.kind === "code") return 0;
  if (contextualLlmEnabled()) throw new Error("contextual_llm_requires_separate_budgeted_command");
  if (selection.embedding_price === null) throw new Error("unpriced_embedding_model");
  let text = guardSecrets(input.text, "rechunk preview").text;
  if (target.kind === "markdown") text = applyInference(target.source_path, text).content;
  const chunks = chunkMarkdown(stripTakesFence(stripFactsFence(text))).chunks;
  // Prefix title/synopsis are each capped to 300 UTF-16 units; 3000 ASCII bytes
  // cover their UTF-8 encoding and the fixed wrapper without needing a model.
  const prefix = contextualRetrievalEnabled() ? " ".repeat(3000) : "";
  let total = chunks.reduce((sum, chunk) => sum + worstCaseUsd({ operation: "embedding", model: selection.model,
    worstCase: { input: prefix + chunk, maxOutputTokens: 0 } })!, 0);
  for (const fence of extractFencedCode(text)) {
    const parsed = await chunkCode(fence.source, `fence.${fence.lang}`, fence.lang);
    for (const symbol of parsed.symbols) {
      if (symbol.kind === "module") continue;
      total += worstCaseUsd({ operation: "embedding", model: selection.model,
        worstCase: { input: symbol.body, maxOutputTokens: 0 } })!;
    }
  }
  return total;
}

export async function buildRechunkPlan(storage: Storage, opts: RechunkOptions): Promise<RechunkPlan> {
  const selection = selectionFor(storage, opts);
  const { rows } = await storage.engine().query<DocumentRow>(
    `SELECT id, source_path, source_id, chunker_version, last_indexed_mtime, frontmatter FROM documents
      WHERE deleted_at IS NULL AND chunker_version < CASE WHEN frontmatter->>'kind' = 'code' THEN $1::int ELSE $2::int END
      ORDER BY source_id NULLS FIRST, id LIMIT $3`, [CODE_CHUNKER_VERSION, MARKDOWN_CHUNKER_VERSION, MAX_CANDIDATES + 1]);
  const targets: RechunkTarget[] = [];
  const held: RechunkPlan["held"] = [];
  let candidates = 0;
  for (const row of rows.slice(0, MAX_CANDIDATES)) {
    const kind = row.frontmatter?.kind === "code" ? "code" : row.source_path.startsWith("page-truth://") ? "truth"
      : row.source_path.startsWith("page://") ? "page" : "markdown";
    if (kind === "code" && selection.source === "vault") continue;
    if (kind !== "code" && selection.source === "code") continue;
    if ((kind === "page" || kind === "truth") && selection.source !== "all") continue;
    if (kind === "code" && !isUnderRoot(canonicalPath(row.source_path), selection.code_paths)) continue;
    if (kind === "markdown" && (!selection.vault || !isUnderRoot(canonicalPath(row.source_path), [selection.vault]))) continue;
    candidates++;
    if (targets.length >= selection.limit) continue;
    const target: RechunkTarget = { document_id: row.id, source_path: row.source_path, source_id: row.source_id, kind,
      current_version: Number(row.chunker_version), target_version: kind === "code" ? CODE_CHUNKER_VERSION : MARKDOWN_CHUNKER_VERSION,
      snapshot_hash: "", input_hash: "", cost_upper_bound_usd: 0 };
    try {
      const canonicalId = `doc_${createHash("sha256").update(row.source_path).digest("hex").slice(0, 16)}`;
      if (row.id !== canonicalId) throw new Error("legacy_document_identity_requires_repair");
      if (row.frontmatter?.quarantine) throw new Error("quarantined_source");
      const input = await loadRechunkInput(storage.engine(), target, selection);
      const cost = await estimateCost(input, target, selection);
      targets.push({ ...target, snapshot_hash: await rechunkSnapshot(storage.engine(), row.id), input_hash: input.inputHash,
        cost_upper_bound_usd: cost, ...(input.pageSlug ? { page_slug: input.pageSlug } : {}) });
    } catch (error) {
      const reason = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "source_unavailable_or_unpriced";
      held.push({ document_id: row.id, reason });
    }
  }
  const cost = targets.reduce((sum, target) => sum + target.cost_upper_bound_usd, 0);
  const body = { selection, targets, held, selected: targets.length, candidates,
    truncated: rows.length > MAX_CANDIDATES || candidates > targets.length + held.length,
    cost_upper_bound_usd: cost, applicable: cost <= selection.max_cost_usd && !held.some(h =>
      h.reason === "unpriced_embedding_model" || h.reason === "contextual_llm_requires_separate_budgeted_command") };
  return { ...body, plan_hash: rechunkHash(body) };
}

export function staleRechunkPlan(): OperationError {
  return new OperationError("conflict", "rechunk plan changed", "Run --dry-run again and review its plan_hash.");
}
