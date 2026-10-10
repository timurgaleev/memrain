/**
 * Indexer — turns a markdown document into rows in `documents`, `chunks`,
 * and `embeddings`. Idempotent at the document level: re-indexing the
 * same source_path replaces all of its chunks (and their embeddings via
 * ON DELETE CASCADE).
 *
 * Only ingests in-process strings + filesystem paths. Driven on demand by
 * the `memrain reindex` CLI and the MCP `index` tool (no boot-time watcher).
 *
 * The atomic doc+chunks+entities writer lives in `core/indexer-tx.ts` so
 * the markdown indexer (this file, embeds via Titan) and the code
 * indexer (`core/indexer-code.ts`, graph-only) share one txn shape.
 */
import { auditSecrets, guardSecrets, guardWrite } from "./secret-scan.ts";
import { lstatSync, readFileSync, statSync } from "node:fs";
import { isOperationError } from "./operation-error.ts";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { chunkMarkdown } from "./chunkers/index.ts";
import { MARKDOWN_CHUNKER_VERSION } from "./chunkers/recursive.ts";
import { extractFencedCode } from "./chunkers/fenced-code.ts";
import { chunkCode } from "./chunkers/code.ts";
import { qualifiedSymbolName } from "./code-edges.ts";
import { stripFactsFence } from "./facts-fence.ts";
import { stripTakesFence } from "./synthesis/takes-fence.ts";
import { embedText, EMBED_DIMENSIONS } from "./embedding.ts";
import { isEmbedSkipped } from "./embed-skip.ts";
import {
  GATE_OWNED_KEYS,
  QUARANTINE_OVERRIDE_KEY,
  auditQuarantine,
  hasCurrentQuarantineOverride,
  isNewQuarantineVerdict,
  parseQuarantineOverride,
  quarantineVerdictOf,
  withQuarantineOverride,
  type QuarantineVerdict,
} from "./quarantine.ts";
import {
  assessContentSanity,
  stampSanityMarkers,
  sanityGateEnabled,
  sanityDisposition,
  resolveSanityThresholds,
  resolveOperatorLiterals,
  resolveDisabledPatterns,
  ContentSanityBlockError,
  type ContentSanityResult,
} from "./content-sanity.ts";
import {
  contextualRetrievalEnabled,
  buildContextualPrefix,
  wrapChunkForEmbedding,
  extractFirstTwoSentences,
} from "./search/contextual-embed.ts";
import {
  contextualLlmEnabled,
  generateChunkContext,
  defaultContextualLlmBudget,
  CONTEXTUAL_LLM_LABEL,
} from "./search/contextual-llm.ts";
import { BudgetTracker } from "./budget.ts";
import type { LlmFn } from "./llm/haiku.ts";
import { extractEntities } from "./entities.ts";
import { bumpDocumentClock } from "./generation.ts";
import { guardLocalIndex, type RereadGuard } from "./sources.ts";
import { newWriteTiming, noteWriteTiming, runWithWriteTiming } from "./write-timing.ts";
import { acquireWriteEmbedSlot, writeEmbedWidth } from "./concurrency.ts";
import type { Storage } from "./storage.ts";
import {
  checkLocalWriteOwner,
  writeDocumentTransaction,
  type ChunkWrite,
  type IndexTxResult,
} from "./indexer-tx.ts";

export type IndexResult = IndexTxResult & {
  /** Set when the content-sanity gate hid the written document. */
  quarantined?: QuarantineVerdict;
};

/** Embed one chunk into a vector. Injectable so tests embed offline. */
export type EmbedFn = (
  text: string,
  opts: { modelId: string },
) => Promise<number[]>;

export interface IndexFileOptions {
  /** Override the source_path stored in the row (defaults to absolute path). */
  sourcePath?: string;
  /** Override the chunker config. */
  chunker?: { maxChars?: number; minChars?: number };
  /** Override embedding model id (e.g. for tests). */
  embeddingModel?: string;
  /**
   * Override the embedder. Defaults to the real Titan `embedText`; tests
   * inject a deterministic embedder to stay offline (same seam pattern as
   * hybrid search's `embedQuery`).
   */
  embedFn?: EmbedFn;
  /**
   * Paid per-chunk LLM-context tier seam (`contextual-llm.ts`). Injected in
   * tests to exercise the LLM path with a fake — bypasses the env gate and any
   * Bedrock spend. Production leaves this unset; the `MEMRAIN_CONTEXTUAL_LLM` flag
   * drives whether the live utility model runs.
   */
  contextualLlmFn?: LlmFn;
  /**
   * Infer a frontmatter header at ingest for content that lacks one
   * (import-time inference). Default ON. The inferred block is NOT
   * persisted to disk or the body, so re-index MUST re-infer (it is pure +
   * deterministic — the same header every time) — do NOT pass `false` on a
   * reindex, or a headerless doc re-chunks bare and silently loses its inferred
   * type/date/tags. Pass `false` only for a caller whose `text` is NOT a raw
   * markdown file needing path-based inference (e.g. a page-body mirror).
   */
  inferFrontmatter?: boolean;
  /**
   * Trust boundary. When `true` (untrusted caller — the remote MCP `index`
   * inline path and the remote `page_put` mirror), gate-owned frontmatter
   * markers (`quarantine`, `content_flag`, `embed_skip`) are STRIPPED from the
   * incoming content before the content-sanity gate runs, so only the gate
   * itself and trusted local CLIs can set them. Without this a write-scoped
   * caller could plant `quarantine` to hide a page from search, `embed_skip` to
   * keep content out of the vector arm, or a `content_flag.detail` to inject
   * text into the agent-trusted "this looks odd" channel — all on clean
   * content. Fail-closed: pass `true` for anything not strictly local; trusted
   * callers (CLI reindex, sync, capture, cycle) leave it unset.
   */
  remote?: boolean;
  /**
   * Name of the interactive write this index serves (`page_put`, …). When set,
   * one line splitting its latency is logged — chunks reused vs paid, and paid
   * time into Bedrock, inflight-slot wait and spend-ledger work. Sweeps and
   * reindex leave it unset and stay quiet.
   */
  timingLabel?: string;
  /** `indexFile` only: a guard the caller already loaded, in place of one over the configured roots. */
  rereadGuard?: RereadGuard;
}

type ContextualTier = NonNullable<ChunkWrite["contextualTier"]>;

/** Per-index counts behind the `timingLabel` line. */
interface IndexStats {
  chunks: number;
  reused: number;
  llmOk: number;
  llmFallback: number;
  embeds: number;
  fenceEmbeds: number;
  txMs: number;
}

const EMBED_MODEL = "amazon.titan-embed-text-v2:0";

function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function docId(sourcePath: string): string {
  return `doc_${shortHash(sourcePath)}`;
}

/**
 * A source_path carrying a scheme names a ROW, not a file: `page://` and
 * `page-truth://` mirrors, `gmail:` / `gcal:` channel items. Resolving one
 * against the daemon's cwd would invent a filesystem path that never existed
 * and hand the disk probe a doc it would flag as missing forever — strictly
 * worse than the bug this normalization fixes. Two-or-more leading characters
 * keeps a Windows drive letter (`C:\…`) out of the scheme class.
 */
const VIRTUAL_SCHEME = /^[a-z][a-z0-9+.-]+:/i;

/**
 * Canonical form of a filesystem source_path — absolute, with `.`/`..` folded.
 *
 * source_path is the document's natural key (docId hashes it) and the only
 * thing the orphans disk-probe can stat; that probe deliberately looks at
 * absolute paths only, so a doc ingested under a caller-relative path
 * (`memrain index foo.ts`) can never be flagged when its file disappears. The
 * probe is right to narrow — virtual rows have no file — so the canonicalization
 * belongs here, at ingest, where the cwd the path was relative TO is still the
 * cwd we read the file from. Purely lexical (no realpath): a symlinked file is
 * already refused by indexFile.
 */
export function normalizeSourcePath(sourcePath: string): string {
  return VIRTUAL_SCHEME.test(sourcePath) ? sourcePath : resolve(sourcePath);
}

export interface IndexInput {
  /** Where the document came from — used as the natural key. */
  sourcePath: string;
  /** Markdown source. */
  text: string;
  /** Optional file mtime in ms — recorded so the sweep can skip unchanged files. */
  mtimeMs?: number;
  /**
   * Extra document-level metadata merged OVER the body's parsed frontmatter
   * (these keys win). Used by the page bridge to stamp `page_content_hash`
   * so the cycle can detect a stale mirror.
   */
  extraFrontmatter?: Record<string, unknown>;
  /** Owning source (tenant) stamped onto the document. Defaults to 'default'. */
  sourceId?: string | null;
  /** See DocumentWrite.claimUnowned — page-mirror writers only. */
  claimUnowned?: boolean;
  /** See DocumentWrite.expectOwner — the local re-readers only. */
  expectOwner?: string | null;
}

/**
 * Index a single in-memory markdown string.
 *
 * Embeds BEFORE the txn so a Bedrock failure doesn't half-write. Re-indexing
 * the same sourcePath replaces all prior chunks (cascade also wipes their
 * embeddings + entity_mentions).
 */
// Cap any single document at 5 MiB. Enforced at BOTH ingest entry points — the
// file path (`indexFile` below) AND this in-memory content path, which the
// remote MCP write passes caller-supplied content straight into, bypassing the
// file-size check. Without the content-path cap the remote `index` tool, page
// mirror, and embed-stale could store an unbounded document (the live brain
// accumulated 18–30 MB-frontmatter voicenote/gcal docs this way → cycle OOM).
const MAX_INDEX_FILE_BYTES = 5 * 1024 * 1024;

export async function indexDocument(
  storage: Storage,
  input: IndexInput,
  opts: IndexFileOptions = {},
): Promise<IndexResult> {
  if (!opts.timingLabel) return indexDocumentBody(storage, input, opts, null);
  const started = performance.now();
  const stats: IndexStats = {
    chunks: 0, reused: 0, llmOk: 0, llmFallback: 0, embeds: 0, fenceEmbeds: 0, txMs: 0,
  };
  const timing = newWriteTiming();
  let status = "error";
  try {
    const result = await runWithWriteTiming(timing, () =>
      indexDocumentBody(storage, input, opts, stats),
    );
    status = "ok";
    return result;
  } finally {
    // Logged for a failed write too — those are the ones worth decomposing.
    // The path is JSON-quoted: a source id is operator-set and not otherwise
    // screened for control characters, so it must not be able to split the line.
    const ms = (n: number) => Math.round(n);
    console.log(
      `[memrain] index-timing op=${opts.timingLabel} status=${status} path=${JSON.stringify(input.sourcePath)}` +
        ` chunks=${stats.chunks} reused=${stats.reused} llm_ok=${stats.llmOk}` +
        ` llm_fallback=${stats.llmFallback} embeds=${stats.embeds} fence_embeds=${stats.fenceEmbeds}` +
        ` ms_total=${ms(performance.now() - started)} ms_bedrock=${ms(timing.sendMs - timing.queueMs)}` +
        ` ms_slot=${ms(timing.slotMs)} ms_queue=${ms(timing.queueMs)} ms_ledger=${ms(timing.ledgerMs)}` +
        ` ms_tx=${ms(stats.txMs)}`,
    );
  }
}

async function indexDocumentBody(
  storage: Storage,
  input: IndexInput,
  opts: IndexFileOptions,
  stats: IndexStats | null,
): Promise<IndexResult> {
  if (!input.sourcePath || !input.text) {
    throw new Error("indexDocument: sourcePath and text are required");
  }
  const byteLength = Buffer.byteLength(input.text, "utf-8");
  if (byteLength > MAX_INDEX_FILE_BYTES) {
    throw new Error(
      `indexDocument: ${input.sourcePath} is ${byteLength} bytes — exceeds the ` +
        `${MAX_INDEX_FILE_BYTES} byte cap. Split it, or remove large embedded ` +
        `assets (e.g. an inline transcript stored in the frontmatter header).`,
    );
  }
  // A local re-read the owner fence will refuse is refused before it embeds.
  await checkLocalWriteOwner(storage.raw(), {
    documentId: docId(input.sourcePath),
    sourcePath: input.sourcePath,
    sourceId: input.sourceId ?? null,
    ...(input.claimUnowned === true ? { claimUnowned: true } : {}),
    ...(input.expectOwner !== undefined ? { expectOwner: input.expectOwner } : {}),
  });

  // Infer a frontmatter header at ingest for content that has none (import-time
  // inference — a per-file pure step, NOT a recurring cycle phase). A doc that
  // already starts with `---` is returned untouched.
  // Credentials never reach a chunk or an embedding, whatever path the text
  // came in on (a vault file, /ingest, a capture, a page mirror).
  const secrets = await guardWrite(storage.engine(), input.sourcePath, input.sourceId ?? null, () =>
    guardSecrets(input.text, input.sourcePath));
  if (secrets.findings.length > 0) {
    await auditSecrets(storage.engine(), secrets.findings, input.sourcePath, input.sourceId ?? null);
  }
  let text = secrets.text;
  if (opts.inferFrontmatter !== false) {
    const { applyInference } = await import("./frontmatter-inference.ts");
    const { content: inferred, inferred: meta } = applyInference(input.sourcePath, text);
    if (!meta.skipped) text = inferred;
  }

  // Strip the `## Facts` and `## Takes` fences before chunking: each is a
  // structured metadata table projected into its own store (entity_facts via
  // facts-reconcile; synth_takes via takes-canon), not prose. Indexing a fence
  // as chunk text would duplicate it as noisy search content — and for takes it
  // would leak operator opinions (including non-`world` holders capped by the
  // takes read-path) into chunks retrievable by any read-scope principal. Both
  // fence syncs read the raw body on their own paths, so stripping here is safe.
  // Frontmatter sits above the fences, so stripping leaves parsing intact.
  const parsed = chunkMarkdown(stripTakesFence(stripFactsFence(text)), opts.chunker);
  const id = docId(input.sourcePath);
  const model = opts.embeddingModel ?? EMBED_MODEL;
  const embed = opts.embedFn ?? embedText;

  let baseFrontmatter = input.extraFrontmatter
    ? { ...parsed.frontmatter, ...input.extraFrontmatter }
    : parsed.frontmatter;

  // Trust boundary (#1699): strip gate-owned markers from UNTRUSTED input so
  // only the content-sanity gate below and trusted local CLIs can set them.
  if (opts.remote === true) {
    const stripKeys = GATE_OWNED_KEYS.filter(
      (k) => Object.hasOwn(baseFrontmatter, k),
    );
    if (stripKeys.length > 0) {
      const cleaned = { ...baseFrontmatter };
      for (const k of stripKeys) delete cleaned[k];
      baseFrontmatter = cleaned;
    }
  }

  // Content-sanity gate (deterministic, free): stamp quarantine / content_flag
  // / embed_skip markers BEFORE embedding so scraper junk, oversize dumps, and
  // markup-heavy boilerplate can't enter the vector index. Junk is HIDDEN
  // (quarantine + embed_skip) by default; `MEMRAIN_SANITY_DISPOSITION=reject`
  // turns it into an explicit hard-block error. Oversize soft-blocks (embed_skip
  // + content_flag); markup-heavy flags. Kill switch: `MEMRAIN_NO_SANITY=1`.
  let frontmatter = baseFrontmatter;
  let sanityTrip: ContentSanityResult | null = null;
  if (sanityGateEnabled()) {
    const sanityBody = parsed.chunks.join("\n\n");
    const sanityTitle =
      parsed.title ??
      (typeof baseFrontmatter["title"] === "string"
        ? (baseFrontmatter["title"] as string)
        : "");
    let sanity = assessContentSanity({
      body: sanityBody,
      title: sanityTitle,
      page_kind: baseFrontmatter["kind"] === "code" ? "code" : undefined,
      extra_literals: resolveOperatorLiterals(),
      disabled_patterns: resolveDisabledPatterns(),
      ...resolveSanityThresholds(),
    });
    // An operator's `quarantine clear` keeps holding while the title and body
    // it was bound to are unchanged. The incoming header can carry it only
    // from a trusted caller (remote writes had it stripped above); otherwise
    // the stored document's override is carried forward. Read only on a trip,
    // so a clean write costs no extra statement.
    if (sanity.shouldQuarantine || sanity.flag_reason === "markup_heavy") {
      const bound = { title: sanityTitle, body: sanityBody };
      if (!hasCurrentQuarantineOverride({ ...bound, frontmatter: baseFrontmatter })) {
        const stored = parseQuarantineOverride(
          (await storedFrontmatter(storage, id))?.[QUARANTINE_OVERRIDE_KEY],
        );
        if (stored && hasCurrentQuarantineOverride({ ...bound, frontmatter: { [QUARANTINE_OVERRIDE_KEY]: stored } })) {
          baseFrontmatter = { ...baseFrontmatter, [QUARANTINE_OVERRIDE_KEY]: stored };
        }
      }
      sanity = withQuarantineOverride(sanity, { ...bound, frontmatter: baseFrontmatter });
    }
    if (sanity.shouldQuarantine && sanityDisposition() === "reject") {
      await auditQuarantine(storage.engine(), sanity, input.sourcePath, input.sourceId ?? null);
      throw new ContentSanityBlockError(sanity);
    }
    if (sanity.shouldQuarantine) sanityTrip = sanity;
    frontmatter = stampSanityMarkers(baseFrontmatter, sanity);
  }

  // Embed BEFORE we touch the DB — if Bedrock fails, we don't half-write. A page
  // marked `embed_skip` is indexed + keyword-searchable but never embedded: its
  // chunks land with a null vector so the vector arm skips them.
  const skipEmbed = isEmbedSkipped(frontmatter);
  // Contextual-retrieval wrapper (opt-in, default-OFF): prepend a document-level
  // <context>{title}\n{synopsis}</context> header to each chunk's EMBEDDING INPUT
  // only — the canonical chunk text written below is untouched. Code docs bypass
  // wrapping. The deterministic synopsis = the first two sentences of the page's
  // opening chunk. The PAID per-chunk LLM tier (MEMRAIN_CONTEXTUAL_LLM) instead
  // asks a utility model to situate EACH chunk within the whole document; a null
  // result (budget/err) falls back to the deterministic prefix (fail-open).
  const isCode = frontmatter["kind"] === "code";
  const ctxTitle =
    parsed.title ??
    (typeof frontmatter["title"] === "string" ? (frontmatter["title"] as string) : null);
  // Either flag (or an injected llmFn) turns wrapping on; the LLM tier is a
  // superset that upgrades the synopsis, so it must build the deterministic
  // prefix too (its fallback path).
  const llmActive =
    (contextualLlmEnabled() || opts.contextualLlmFn !== undefined) && !isCode && !skipEmbed;
  const wrapActive =
    (contextualRetrievalEnabled() || llmActive) && !isCode;
  const deterministicPrefix = wrapActive
    ? buildContextualPrefix(ctxTitle, extractFirstTwoSentences(parsed.chunks[0] ?? ""), { isCode })
    : null;
  const docText = llmActive ? parsed.chunks.join("\n\n") : "";
  // Fresh budget per document at index time (a new doc is a small, bounded run);
  // the whole-corpus backfill is where a single shared budget matters.
  const ctxBudget = llmActive
    ? new BudgetTracker(defaultContextualLlmBudget(), CONTEXTUAL_LLM_LABEL)
    : undefined;
  // Unchanged-chunk embedding reuse: re-indexing a doc rewrites all its chunks
  // (indexer-tx deletes + reinserts), but a chunk whose RAW text is byte-identical
  // to one the document already had — under the same embedding model and width —
  // hasn't changed meaning, so its stored vector is reused instead of paying
  // Bedrock (and the paid contextual-LLM tier) again. The key is the chunk TEXT,
  // not its position: inserting a section mid-page shifts every later chunk's
  // index, and positional reuse re-paid for all of them. Prose chunks and
  // fenced-code symbols are keyed apart — a symbol body is embedded raw, a prose
  // chunk through its contextual wrapper, so the same text can carry two
  // different vectors. The lookup is scoped to THIS document, which is also what
  // keeps it inside one tenant; a global contextual-mode flip still needs a full
  // `reindex --contextual`. Width is checked alongside model: MEMRAIN_EMBED_DIM can
  // change the dimension without changing the Titan model id, and mixing widths
  // inside one document breaks the `<=>` scan. Under contextual retrieval a
  // reused chunk keeps its prior document-level context (title/synopsis) even if
  // an earlier chunk or the title changed — an accepted precision tradeoff.
  const priorProse = new Map<string, { vec: number[]; tier: ContextualTier | undefined }>();
  const priorFence = new Map<string, number[]>();
  if (!skipEmbed) {
    try {
      const priorRows = await storage.engine().query<{
        content: string;
        chunk_source: string | null;
        contextual_embedded: boolean | null;
        contextual_tier: ContextualTier | null;
        vec: string | null;
        model: string | null;
      }>(
        `SELECT c.content, c.chunk_source, c.contextual_embedded, c.contextual_tier,
                e.vector::text AS vec, e.model
           FROM chunks c LEFT JOIN embeddings e ON e.chunk_id = c.id
          WHERE c.document_id = $1`,
        [id],
      );
      for (const r of priorRows.rows) {
        if (r.vec === null || r.model !== model) continue;
        const fenced = r.chunk_source === "fenced_code";
        // A symbol is written RAW here, but `reindex --contextual` wraps fenced
        // chunks too: its vector is from a different embedding regime and must
        // be recomputed, not carried over.
        if (fenced && r.contextual_embedded === true) continue;
        const vec = JSON.parse(r.vec) as number[];
        if (vec.length !== EMBED_DIMENSIONS) continue;
        if (fenced) priorFence.set(r.content, vec);
        else priorProse.set(r.content, { vec, tier: r.contextual_tier ?? undefined });
      }
    } catch {
      // A read failure just means no reuse this pass — re-embed everything.
      priorProse.clear();
      priorFence.clear();
    }
  }

  // Chunks are situated and embedded in parallel, bounded by the write-path
  // ceiling every concurrent write shares (`MEMRAIN_EMBED_MAX_INFLIGHT`). Serially,
  // a page paid ~1.3 s of Bedrock per chunk, one chunk after another.
  // `vectors` is indexed, never pushed: completion order is not chunk order.
  const vectors: (number[] | null)[] = Array.from<number[] | null>({ length: parsed.chunks.length }).fill(null);
  // The tier each vector was produced under, so a later re-embed can respect it.
  const tiers: (ContextualTier | undefined)[] = Array.from<ContextualTier | undefined>({ length: parsed.chunks.length });
  // What a chunk embedded without the LLM tier gets: the deterministic prefix
  // when wrapping is on, raw text otherwise.
  const baseTier: ContextualTier = wrapActive ? "deterministic" : "none";
  let budgetRefusedChunks = 0;

  // A stored vector for byte-identical text is reused instead of paid for again.
  // Checked before a write slot is taken: a chunk with nothing to pay for must
  // not queue behind the paid ones.
  const reusable = (i: number) => priorProse.get(parsed.chunks[i]!) ?? null;

  const vectorFor = async (i: number): Promise<void> => {
    const chunk = parsed.chunks[i]!;
    let prefix = deterministicPrefix;
    if (llmActive) {
      // The budget is shared by the chunks in flight: each checks it before its
      // own call, so a run can overshoot the cap by at most the ceiling's width.
      const llmCtx = await generateChunkContext(docText, chunk, {
        ...(opts.contextualLlmFn ? { llmFn: opts.contextualLlmFn } : {}),
        ...(ctxBudget ? { budget: ctxBudget } : {}),
      });
      if (llmCtx) {
        prefix = buildContextualPrefix(ctxTitle, llmCtx, { isCode });
        tiers[i] = "llm";
      }
      if (stats) {
        if (llmCtx) stats.llmOk++;
        else stats.llmFallback++;
      }
    }
    const embedInput = wrapChunkForEmbedding(chunk, prefix, { isCode });
    try {
      if (stats) stats.embeds++;
      tiers[i] ??= baseTier;
      vectors[i] = await embed(embedInput, { modelId: model });
    } catch (e) {
      // A spent daily budget must not destroy the note. Every other embed
      // failure still aborts before the DB is touched (the half-write guard
      // above) — but a cap is policy, not an outage, and losing the caller's
      // text to enforce it is the wrong trade. The chunk lands with a null
      // vector: written, keyword-searchable, and picked up by `memrain embed`
      // once the budget rolls over.
      if (!(isOperationError(e) && e.code === "budget_exhausted")) throw e;
      budgetRefusedChunks++;
      // No vector yet: `memrain embed` fills it later with the deterministic
      // prefix at most, so that is the tier this chunk will end up with.
      tiers[i] = baseTier;
    }
  };

  // Half-write guard, parallel form: after the first hard failure no further
  // chunk starts, the ones already in flight settle, and only then does the
  // failure propagate — before anything is written. Workers never reject, so
  // no sibling failure can surface later as an unhandled rejection.
  let hardError: { error: unknown } | null = null;
  let nextChunk = 0;
  const worker = async (): Promise<void> => {
    while (hardError === null && nextChunk < parsed.chunks.length) {
      const i = nextChunk++;
      // With embedding off there is nothing to pay for (the LLM tier is off too).
      if (skipEmbed) continue;
      const reused = reusable(i);
      if (reused) {
        vectors[i] = reused.vec;
        tiers[i] = reused.tier;
        if (stats) stats.reused++;
        continue;
      }
      const slotStart = performance.now();
      const release = await acquireWriteEmbedSlot();
      noteWriteTiming("slotMs", performance.now() - slotStart);
      try {
        // A sibling may have failed while this worker waited for its slot.
        if (hardError === null) await vectorFor(i);
      } catch (e) {
        hardError ??= { error: e };
      } finally {
        release();
      }
    }
  };
  // Only an interactive write (one that names itself for the timing line) fans
  // out. Sweeps, reindex and the cycle keep their one-chunk-at-a-time pace: they
  // are not waiting on anyone, and fanning them out would multiply their Bedrock
  // rate and take slots from the writes an agent is blocked on.
  const width = opts.timingLabel ? writeEmbedWidth() : 1;
  const workers = Math.min(width, parsed.chunks.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  if (hardError !== null) throw (hardError as { error: unknown }).error;

  if (budgetRefusedChunks > 0) {
    console.warn(
      `[memrain] daily budget exhausted mid-index: ${budgetRefusedChunks} chunk(s) of ` +
        `'${input.sourcePath}' stored WITHOUT embeddings — keyword-searchable now, ` +
        `run \`memrain embed\` after the budget rolls over to vectorise them`,
    );
  }

  const chunkWrites: ChunkWrite[] = parsed.chunks.map((text, i) => {
    // Frontmatter tags only attach to chunk 0 — they're document-level signals,
    // not chunk-level. Body wikilinks/hashtags/dates attach to the chunk they
    // appear in.
    const fm = i === 0 ? frontmatter : {};
    return {
      text,
      embedding: vectors[i] ?? null,
      ...(tiers[i] ? { contextualTier: tiers[i] } : {}),
      entities: extractEntities(text, fm),
    };
  });

  // Fenced-code extraction (chunk_source='fenced_code'): lift each ```lang fence
  // whose tag maps to a supported grammar, tree-sitter-chunk it, and append the
  // symbols as extra searchable chunks so a code example ranks as code, not
  // prose. Skipped when the whole doc is already code (symbol-chunked elsewhere)
  // or embeddings are off. Bounded by MEMRAIN_MAX_FENCES_PER_PAGE; a parse failure
  // on one fence is swallowed so it can never fail the page ingest.
  if (!skipEmbed && !isCode) {
    for (const fence of extractFencedCode(text)) {
      try {
        const parsedCode = await chunkCode(fence.source, `fence.${fence.lang}`, fence.lang);
        for (const sym of parsedCode.symbols) {
          let vec = priorFence.get(sym.body);
          if (vec) {
            if (stats) stats.reused++;
          } else {
            if (stats) stats.fenceEmbeds++;
            const release = await acquireWriteEmbedSlot();
            try {
              vec = await embed(sym.body, { modelId: model });
            } finally {
              release();
            }
          }
          chunkWrites.push({
            text: sym.body,
            startLine: sym.startLine,
            endLine: sym.endLine,
            embedding: vec,
            symbolName: sym.name,
            symbolNameQualified: qualifiedSymbolName(sym.parentSymbolPath, sym.name),
            symbolType: sym.kind,
            parentSymbolPath: sym.parentSymbolPath,
            docComment: sym.docComment,
            language: fence.lang,
            chunkSource: "fenced_code",
            contextualTier: "none",
            entities: [],
          });
        }
      } catch {
        // parse timeout / grammar error — skip this fence, keep the page.
      }
    }
  }

  if (stats) stats.chunks = parsed.chunks.length;
  // Read before the write replaces it: a trip is audited only when it changes
  // the stored verdict, and only once the document has committed.
  const priorFrontmatter = sanityTrip ? await storedFrontmatter(storage, id) : null;
  const txStart = performance.now();
  const written = await writeDocumentTransaction(
    storage,
    {
      documentId: id,
      sourcePath: input.sourcePath,
      // Title column: the H1, else the frontmatter `title` (an explicit header
      // or one synthesized by ingest inference) — folding a frontmatter title
      // into the title column so an inferred title for a headerless, H1-less
      // doc still reaches `documents.title`.
      title:
        parsed.title ??
        (typeof frontmatter["title"] === "string"
          ? (frontmatter["title"] as string)
          : null),
      frontmatter,
      mtimeMs: input.mtimeMs ?? null,
      embeddingModel: model,
      chunkerVersion: MARKDOWN_CHUNKER_VERSION,
      sourceId: input.sourceId ?? null,
      ...(input.claimUnowned === true ? { claimUnowned: true } : {}),
      ...(input.expectOwner !== undefined ? { expectOwner: input.expectOwner } : {}),
    },
    chunkWrites,
  );
  if (stats) stats.txMs = performance.now() - txStart;
  if (sanityTrip && isNewQuarantineVerdict(priorFrontmatter, sanityTrip)) {
    await auditQuarantine(storage.engine(), sanityTrip, input.sourcePath, input.sourceId ?? null);
  }
  const quarantined = quarantineVerdictOf(frontmatter);
  return quarantined ? { ...written, quarantined } : written;
}

async function storedFrontmatter(
  storage: Storage,
  id: string,
): Promise<Record<string, unknown> | null> {
  const r = await storage
    .engine()
    .query<{ frontmatter: Record<string, unknown> | null }>(
      "SELECT frontmatter FROM documents WHERE id = $1",
      [id],
    );
  return r.rows[0]?.frontmatter ?? null;
}

/**
 * Index a file on disk. Reads the file, calls indexDocument with absolute
 * path as sourcePath (or the override). The file-size cap (defense-in-depth
 * before readFileSync) shares MAX_INDEX_FILE_BYTES with indexDocument above.
 */
export async function indexFile(
  storage: Storage,
  filePath: string,
  opts: IndexFileOptions = {},
): Promise<IndexResult> {
  // lstat to detect symlinks BEFORE the size check — a symlink to
  // /dev/zero would stat as 0 bytes and then hang readFileSync.
  let lstat;
  try {
    lstat = lstatSync(filePath);
  } catch {
    throw new Error(`indexFile: file not found: ${filePath}`);
  }
  if (lstat.isSymbolicLink()) {
    throw new Error(
      `indexFile: ${filePath} is a symlink — refusing to follow ` +
        `(use the canonical path)`,
    );
  }
  if (!lstat.isFile()) {
    throw new Error(`indexFile: ${filePath} is not a regular file`);
  }
  if (lstat.size > MAX_INDEX_FILE_BYTES) {
    throw new Error(
      `indexFile: ${filePath} is ${lstat.size} bytes — exceeds ` +
        `${MAX_INDEX_FILE_BYTES} byte cap (skip via vault config)`,
    );
  }
  // Re-stat via the regular statSync purely so the IndexResult timestamp
  // matches what the rest of the codebase computes elsewhere.
  // Normalize the read path, not the override: an explicit `sourcePath` is
  // the caller declaring the row's identity (the page mirror's `page://…`),
  // and second-guessing it here would rewrite a key it owns.
  const sourcePath = opts.sourcePath ?? normalizeSourcePath(filePath);
  // A remote inline `index` may have labelled a row with this path first, and
  // the write keeps a row's owner: reading the file into it would hand the file
  // to whoever wrote the label.
  const expectOwner = await guardLocalIndex(storage.raw(), sourcePath, opts.rereadGuard);
  const stat = statSync(filePath);
  const text = readFileSync(filePath, "utf8");
  return indexDocument(
    storage,
    {
      sourcePath,
      text,
      mtimeMs: Math.floor(stat.mtimeMs),
      expectOwner,
    },
    opts,
  );
}

/**
 * Remove a document (and, via ON DELETE CASCADE, its chunks + embeddings +
 * entity_mentions) by its source_path. Idempotent — deleting an absent
 * document is a no-op. Returns whether a row was removed. Bumps the
 * generation clock so the query cache invalidates.
 */
export async function removeDocument(
  storage: Storage,
  sourcePath: string,
): Promise<{ removed: boolean }> {
  if (!sourcePath) throw new Error("removeDocument: sourcePath is required");
  const id = docId(sourcePath);
  const engine = storage.raw();
  let removed = false;
  await engine.transaction(async (tx) => {
    const r = await tx.query<{ id: string }>(
      "DELETE FROM documents WHERE id = $1 RETURNING id",
      [id],
    );
    removed = r.rows.length > 0;
    if (removed) await bumpDocumentClock(tx);
  });
  return { removed };
}
