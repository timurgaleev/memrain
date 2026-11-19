/**
 * Contextual re-embed — a whole-corpus, from-DB re-embed that applies the
 * contextual-retrieval wrapper (`core/search/contextual-embed.ts`) to every
 * embeddable chunk's EMBEDDING INPUT. Driven by `memrain reindex --contextual`.
 *
 * WHY from the DB, not disk: the wrapper must reach `page_put`-sourced docs
 * (gmail/gcal/etc.) whose body lives only in `pages.markdown_body` — those
 * documents have NO file on disk, so a file-tree sweep can never re-embed them.
 * Their chunks ARE in the `chunks` table, so iterating documents in the DB is
 * the only path that covers the ENTIRE corpus (on-disk + inline `page://` docs
 * alike). This mirrors `core/embed-backfill.ts`, but instead of targeting only
 * NULL-vector chunks it re-embeds under the contextual prefix.
 *
 * GATING: this command ALWAYS applies the wrapper — running it IS the operator's
 * intent, so it does NOT read `MEMRAIN_CONTEXTUAL_RETRIEVAL`. The env flag governs
 * FUTURE index-time embedding (`core/indexer.ts`), so new docs stay consistent
 * with the backfilled corpus. Turn the flag on, then run this once.
 *
 * WHAT IS SKIPPED (and why the vector arm stays correct):
 *   - Soft-deleted documents (`deleted_at IS NOT NULL`) — retired content.
 *   - `embed_skip` documents — intentionally never embedded (keyword-only).
 *   - Code documents (`frontmatter.kind = 'code'`) — graph-only by design. Code
 *     chunks carry NO `embeddings` row; that absence is the ONLY thing keeping
 *     code out of the vector arm (`core/search/vector.ts` has no kind filter).
 *     Creating a code embedding — even raw/unwrapped — would make code surface
 *     in vector search, breaking the graph-only invariant that
 *     `embed-backfill` also enforces. So code is excluded outright, never
 *     embedded and never marked.
 * This is the same "embeddable" candidate definition embed-backfill / source-
 * health use, so a chunk this command re-embeds is exactly a chunk that already
 * had (or should have) a vector.
 *
 * IDEMPOTENT + RESUMABLE: each re-embedded chunk is stamped
 * `chunks.contextual_embedded = true` (migration 057) in the SAME transaction
 * that writes its vector. A chunk already marked is skipped unless `--force`, so:
 *   - a re-run after a completed pass is a no-op;
 *   - an interrupted run resumes exactly where it stopped.
 * Per-DOCUMENT atomicity is the crash-safety property: a document's chunks are
 * embedded (network, outside any txn) and then written + marked in ONE
 * transaction, so a crash can only ever leave a document fully wrapped-and-marked
 * or fully untouched — never half-wrapped. `--force` re-embeds even already-
 * marked chunks (for a title/synopsis change or a chunker bump).
 */
import { runInBatchScope } from "./llm/bedrock-errors.ts";
import { withLongHold } from "./pool-budget.ts";
import type { Engine } from "./engine/interface.ts";
import type { Storage } from "./storage.ts";
import { embedText, DEFAULT_MODEL_ID, embeddingSignature } from "./embedding.ts";
import { embedSkipFilterFragment } from "./embed-skip.ts";
import {
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
import { bumpDocumentClock } from "./generation.ts";
import { clearCache } from "./search/query-cache.ts";

export interface ContextualReembedOptions {
  /** Re-embed even chunks already marked `contextual_embedded`. Default false. */
  force?: boolean;
  /** Count candidates only — never embed or write. */
  dryRun?: boolean;
  /** Max chunks to re-embed this run (applied at document boundaries so a
   *  document is never left half-wrapped). Default: no cap. */
  limit?: number;
  /** Model id recorded on each embeddings row. Defaults to Titan v2. */
  model?: string;
  /**
   * Embedder injection seam — tests pass a deterministic fn; production uses
   * the real Titan `embedText`. Mirrors embed-backfill's `embed` seam.
   */
  embed?: (text: string) => Promise<number[]>;
  /**
   * Paid per-chunk LLM-context tier (`contextual-llm.ts`). When set — or when
   * `MEMRAIN_CONTEXTUAL_LLM` is on — each chunk's prefix uses a model-generated
   * situating blurb instead of the deterministic document synopsis; a null
   * result (budget/err) falls back to deterministic. Tests inject `llmFn` to
   * bypass the env gate and avoid any Bedrock spend.
   */
  llmFn?: LlmFn;
  /**
   * Shared USD budget for the LLM tier across the WHOLE run — so
   * `MEMRAIN_CONTEXTUAL_LLM_BUDGET_USD` caps TOTAL spend, not per-chunk. When it is
   * exhausted mid-run, remaining chunks silently fall back to deterministic
   * (still wrapped) and the run completes. Default: a fresh cap from the env.
   */
  llmBudget?: BudgetTracker;
  /** Override the utility model id for the LLM tier (tests/pricing). */
  contextualModel?: string;
  /** Progress callback fired after each document is committed. */
  onProgress?: (documentsDone: number, chunksDone: number) => void;
}

export interface ContextualReembedResult {
  /** Documents that had at least one chunk to re-embed (excludes skipped-clean). */
  documents: number;
  /** Chunks re-embedded + marked. */
  chunks: number;
  /** Chunks already `contextual_embedded` and left as-is (not `--force`). */
  skipped: number;
  /** Documents whose embed call threw — left untouched for a retry. */
  failed: number;
  /** Chunks wrapped with a per-chunk LLM-generated context (paid tier). */
  llmContext: number;
  /** Chunks that fell back to the deterministic synopsis (LLM off, budget
   *  exhausted, or an LLM error). Zero when the LLM tier is not active. */
  deterministicFallback: number;
  /** Chunks already on the LLM tier that this run could only have re-embedded
   *  deterministically — left untouched rather than downgraded. */
  tierKept: number;
  /** Chunks whose text changed (a re-index) while their vector was being
   *  computed — skipped, since that vector describes text no longer there. */
  stale: number;
  dryRun: boolean;
}

interface CandidateDoc {
  id: string;
  title: string | null;
}

interface ChunkRow {
  id: string;
  content: string;
  contextual_tier: string | null;
}

/** Boolean fragment: documents this command is allowed to re-embed. Excludes
 *  soft-deleted, embed-skip, and code docs (see the module header). Kept here so
 *  the candidate-doc scan and the summary's skipped-count share one definition. */
function embeddableDocFragment(): string {
  return (
    `d.deleted_at IS NULL ` +
    `AND ${embedSkipFilterFragment("d")} ` +
    `AND COALESCE(d.frontmatter->>'kind','') <> 'code'`
  );
}

/** Non-deleted, embeddable documents with >=1 chunk still needing the wrapper
 *  (or every chunk under `--force`), id-ordered for a stable, resumable pass. */
async function findCandidateDocs(
  engine: Engine,
  force: boolean,
): Promise<CandidateDoc[]> {
  // Under --force every non-empty chunk is a candidate; otherwise only the
  // unmarked ones. The EXISTS keeps a fully-marked document out of the scan so a
  // resumed/repeat run does no per-document work for what is already done.
  const chunkPredicate = force
    ? "length(btrim(c.content)) > 0"
    : "length(btrim(c.content)) > 0 AND NOT c.contextual_embedded";
  const r = await engine.query<CandidateDoc>(
    `SELECT d.id, d.title
       FROM documents d
      WHERE ${embeddableDocFragment()}
        AND EXISTS (
          SELECT 1 FROM chunks c
           WHERE c.document_id = d.id AND ${chunkPredicate}
        )
      ORDER BY d.id COLLATE "C" ASC`,
  );
  return r.rows;
}

/** The opening chunk's content (lowest `chunk_index`) — its first two sentences
 *  are the deterministic document synopsis. */
async function openingChunkContent(
  engine: Engine,
  documentId: string,
): Promise<string> {
  const r = await engine.query<{ content: string }>(
    `SELECT content FROM chunks
      WHERE document_id = $1
      ORDER BY chunk_index ASC
      LIMIT 1`,
    [documentId],
  );
  return r.rows[0]?.content ?? "";
}

/** The document's full text — every chunk concatenated in order. Fed to the
 *  per-chunk LLM tier so the model can situate a chunk within the whole doc.
 *  Reconstructed from `chunks` because `page://` docs have no file on disk. */
async function documentText(
  engine: Engine,
  documentId: string,
): Promise<string> {
  const r = await engine.query<{ content: string }>(
    `SELECT content FROM chunks
      WHERE document_id = $1
      ORDER BY chunk_index ASC`,
    [documentId],
  );
  return r.rows.map((row) => row.content).join("\n\n");
}

/** Chunks of a document to re-embed this pass, chunk-ordered. */
async function chunksToReembed(
  engine: Engine,
  documentId: string,
  force: boolean,
): Promise<ChunkRow[]> {
  const marked = force ? "" : "AND NOT contextual_embedded";
  const r = await engine.query<ChunkRow>(
    `SELECT id, content, contextual_tier FROM chunks
      WHERE document_id = $1
        AND length(btrim(content)) > 0
        ${marked}
      ORDER BY chunk_index ASC`,
    [documentId],
  );
  return r.rows;
}

/** Count embeddable chunks already marked — reported as `skipped` for context. */
async function countAlreadyMarked(engine: Engine): Promise<number> {
  const r = await engine.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
      WHERE ${embeddableDocFragment()}
        AND c.contextual_embedded
        AND length(btrim(c.content)) > 0`,
  );
  return r.rows[0]?.n ?? 0;
}

/**
 * Re-embed the whole corpus under the contextual-retrieval wrapper. Iterates
 * every embeddable document from the DB (reaching `page://` inline docs that
 * have no file on disk) and, per document, embeds each pending chunk's
 * `<context>title\nsynopsis</context>`-prefixed text, then writes the vectors +
 * marks in one transaction.
 */
/** Runs as a batch: a failure that would only repeat stops the run early. */
export async function runContextualReembed(
  engine: Engine,
  opts: ContextualReembedOptions = {},
): Promise<ContextualReembedResult> {
  return withLongHold(() => runInBatchScope({ stopped: false, circuit: true }, () => runContextualReembedBody(engine, opts)));
}

async function runContextualReembedBody(
  engine: Engine,
  opts: ContextualReembedOptions = {},
): Promise<ContextualReembedResult> {
  const embed = opts.embed ?? ((t: string) => embedText(t));
  const model = opts.model ?? DEFAULT_MODEL_ID;
  const force = opts.force ?? false;
  const limit = opts.limit && opts.limit > 0 ? Math.floor(opts.limit) : undefined;

  // Paid per-chunk LLM tier: active when a test injects `llmFn` OR the operator
  // set the env flag. ONE budget is shared across the whole run so the env cap
  // bounds TOTAL spend; exhaustion mid-run falls back to deterministic per chunk.
  const llmActive = opts.llmFn !== undefined || contextualLlmEnabled();
  const llmBudget = llmActive
    ? opts.llmBudget ??
      new BudgetTracker(defaultContextualLlmBudget(), CONTEXTUAL_LLM_LABEL)
    : undefined;

  const docs = await findCandidateDocs(engine, force);
  const skipped = force ? 0 : await countAlreadyMarked(engine);

  if (opts.dryRun) {
    // Report the chunk workload without embedding. Sum pending chunks per doc.
    let pending = 0;
    for (const doc of docs) {
      pending += (await chunksToReembed(engine, doc.id, force)).length;
    }
    return {
      documents: docs.length,
      chunks: pending,
      skipped,
      failed: 0,
      llmContext: 0,
      deterministicFallback: 0,
      tierKept: 0,
      stale: 0,
      dryRun: true,
    };
  }

  let documents = 0;
  let chunks = 0;
  let failed = 0;
  let llmContext = 0;
  let deterministicFallback = 0;
  let tierKept = 0;
  let stale = 0;

  for (const doc of docs) {
    if (limit !== undefined && chunks >= limit) break;

    try {
      const synopsis = extractFirstTwoSentences(
        await openingChunkContent(engine, doc.id),
      );
      // isCode is always false here — code docs are excluded from the scan.
      const deterministicPrefix = buildContextualPrefix(doc.title, synopsis, {
        isCode: false,
      });
      const pending = await chunksToReembed(engine, doc.id, force);
      if (pending.length === 0) continue;

      // The per-chunk LLM tier needs the whole document; load it once per doc.
      const docText = llmActive ? await documentText(engine, doc.id) : "";

      // Embed OUTSIDE the transaction so a Bedrock failure never half-writes a
      // document (indexer.ts's ordering). Collect vectors first, then commit.
      const writes: { id: string; content: string; vector: number[]; tier: "llm" | "deterministic" }[] = [];
      for (const ch of pending) {
        // Never trade a Haiku-situated vector for a deterministic one: a run
        // without the LLM tier leaves such a chunk exactly as it is.
        if (ch.contextual_tier === "llm" && !llmActive) {
          tierKept++;
          continue;
        }
        let prefix = deterministicPrefix;
        let tier: "llm" | "deterministic" = "deterministic";
        if (llmActive) {
          const llmCtx = await generateChunkContext(docText, ch.content, {
            ...(opts.llmFn ? { llmFn: opts.llmFn } : {}),
            ...(llmBudget ? { budget: llmBudget } : {}),
            ...(opts.contextualModel ? { modelId: opts.contextualModel } : {}),
            // Consecutive chunks of THIS document share the identical doc prefix,
            // so cache it once and read it back for the rest of the document.
            cacheDocument: true,
          });
          if (llmCtx) {
            prefix = buildContextualPrefix(doc.title, llmCtx, { isCode: false });
            tier = "llm";
            llmContext++;
          } else if (ch.contextual_tier === "llm") {
            // The LLM call fell back (budget, error): same rule, keep the chunk.
            tierKept++;
            continue;
          } else {
            deterministicFallback++;
          }
        }
        const vector = await embed(
          wrapChunkForEmbedding(ch.content, prefix, { isCode: false }),
        );
        writes.push({ id: ch.id, content: ch.content, vector, tier });
      }

      // Chunk ids are positional (`<doc>_c<i>`), so a re-index during the
      // embed calls above can leave the same id holding different text. The
      // write only lands on a chunk whose text is still what was embedded, and
      // FOR SHARE holds that row: a re-index deleting it concurrently makes the
      // guard wait and then drop it, instead of passing on the old row and
      // overwriting the vector the re-index writes for the new one.
      const { written, skipped: staleHere } = await engine.transaction(async (tx) => {
        let n = 0;
        for (const w of writes) {
          const ins = await tx.query<{ chunk_id: string }>(
            `INSERT INTO embeddings (chunk_id, vector, model, embedding_signature)
             SELECT c.id, $2::vector, $3, $4 FROM chunks c
              WHERE c.id = $1 AND c.content = $5
              FOR SHARE
             ON CONFLICT (chunk_id) DO UPDATE
               SET vector = EXCLUDED.vector,
                   model = EXCLUDED.model,
                   embedding_signature = EXCLUDED.embedding_signature
             RETURNING chunk_id`,
            [w.id, JSON.stringify(w.vector), model, embeddingSignature(model, w.vector.length), w.content],
          );
          if (ins.rows.length === 0) continue;
          await tx.query(
            "UPDATE chunks SET contextual_embedded = TRUE, contextual_tier = $2 WHERE id = $1",
            [w.id, w.tier],
          );
          n++;
        }
        return { written: n, skipped: writes.length - n };
      });
      stale += staleHere;

      documents++;
      chunks += written;
      opts.onProgress?.(documents, chunks);
    } catch (err) {
      failed++;
      console.error(
        `contextual-reembed: document ${doc.id} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Re-embedding changes what the vector arm returns, so the query cache must be
  // flushed — same reasoning as embed-backfill: a bare clock bump can't evict a
  // Layer-2 row whose referenced docs' generation is unchanged, so clear it
  // outright. Only when vectors actually moved.
  if (chunks > 0) {
    await bumpDocumentClock(engine);
    await clearCache(engine);
  }

  return {
    documents,
    chunks,
    skipped,
    failed,
    llmContext,
    deterministicFallback,
    tierKept,
    stale,
    dryRun: false,
  };
}

/**
 * Storage-facing wrapper so the CLI can pass a `Storage` and let this own the
 * `engine()` handle (matching the other command entry points).
 */
export async function contextualReembed(
  storage: Storage,
  opts: ContextualReembedOptions = {},
): Promise<ContextualReembedResult> {
  return runContextualReembed(storage.engine(), opts);
}
