/**
 * Shared transactional writer for documents + chunks + entity_mentions.
 *
 * Used by both the markdown indexer (`core/indexer.ts`) and the code
 * indexer (`core/indexer-code.ts`). The two callers differ in two ways:
 *
 *   1. Markdown ships per-chunk Titan vectors → embeddings rows.
 *      Code is graph-only (Q1 = hashed-only) → no embeddings.
 *   2. Code chunks have line ranges (start_line, end_line) populated by
 *      tree-sitter; markdown chunks leave them NULL.
 *
 * The contract: caller pre-computes everything (chunks, entities, optional
 * vectors, optional line ranges); this function just writes it atomically.
 * Re-running with the same documentId wipes prior chunks (cascades to
 * embeddings + entity_mentions).
 */
import {
  entityId,
  type ExtractedEntity,
} from "./entities.ts";
import type { Engine } from "./engine/interface.ts";
import type { Storage } from "./storage.ts";
import { bumpDocumentClock } from "./generation.ts";
import { embeddingSignature } from "./embedding.ts";
import { withRetry, BULK_RETRY_OPTS } from "./retry.ts";
import { OperationError } from "./operation-error.ts";
import { insertCodeEdges, type CodeEdgeInput } from "./code-edges.ts";
import { wellFormForText, wellFormJsonbObject } from "./well-form.ts";
import {
  importFilename,
  resolveEffectiveDateWithSource,
} from "./effective-date.ts";

export interface ChunkWrite {
  /** Chunk body text (will land in chunks.content). */
  text: string;
  /** Optional 1-based start line — populated for code chunks, NULL for markdown. */
  startLine?: number | null;
  /** Optional 1-based end line — populated for code chunks, NULL for markdown. */
  endLine?: number | null;
  /** Optional embedding vector for this chunk (omit for graph-only sources). */
  embedding?: number[] | null;
  /** Bare symbol identifier — populated for code chunks, NULL for markdown. */
  symbolName?: string | null;
  /** Qualified symbol name (parent path :: name) — code chunks only. The key
   *  the resolve-symbol-edges phase matches call targets against. */
  symbolNameQualified?: string | null;
  /** Symbol kind (function/class/method/arrow/const/module-import) — code only. */
  symbolType?: string | null;
  /**
   * Enclosing scope chain, outermost-first (empty/NULL at top level) — code
   * only. Persisted to `chunks.parent_symbol_path` (TEXT[]); an empty chain
   * stores NULL.
   */
  parentSymbolPath?: readonly string[] | null;
  /**
   * Extracted doc comment (JSDoc / `//` block / Python docstring) — code only,
   * NULL for markdown and for symbols with none. Persisted to
   * `chunks.doc_comment` and weighted 'A' in the chunk FTS (migration 032).
   */
  docComment?: string | null;
  /** Source language (typescript/python/…) — code only, NULL for markdown. */
  language?: string | null;
  /**
   * How this chunk was derived (migration 093). `'fenced_code'` for a code
   * example lifted out of a markdown page; NULL for ordinary prose + whole-file
   * code chunks. Persisted to `chunks.chunk_source`.
   */
  chunkSource?: string | null;
  /**
   * Contextual tier the stored vector was produced under (migration 106).
   * Also sets `contextual_embedded` (migration 057) for the wrapped tiers.
   * Omitted = unknown, which is what code and graph-only chunks write.
   */
  contextualTier?: "none" | "deterministic" | "llm";
  /** Entities to attach to this chunk's row in entity_mentions. */
  entities: readonly ExtractedEntity[];
}

export interface DocumentWrite {
  /** Stable id (caller's choice; usually `doc_<sha8>`). */
  documentId: string;
  /** Natural key — file path or external URI. */
  sourcePath: string;
  /** Document title (markdown's H1, or code file path). */
  title: string | null;
  /** Frontmatter / arbitrary doc-level metadata (JSONB). */
  frontmatter: Record<string, unknown>;
  /** mtime in ms — recorded so `sweepVault` / `sweepCodeRoots` can skip unchanged files. */
  mtimeMs?: number | null;
  /** Embedding model id (only meaningful when chunks carry vectors). */
  embeddingModel?: string | null;
  /**
   * Chunker version that produced these chunks (migration 052) —
   * MARKDOWN_CHUNKER_VERSION for markdown, CODE_CHUNKER_VERSION for code.
   * Stamped onto `documents.chunker_version`; omitted → the column DEFAULT 1
   * (the grandfather value) applies on insert and is preserved on reindex.
   */
  chunkerVersion?: number;
  /**
   * Owning source (tenant). Stamped onto `documents.source_id` so search arms
   * scope results per tenant. Null/undefined → 'default' on a fresh insert and
   * leaves an existing row's source untouched on reindex (never clobbers a real
   * tenant with the fallback).
   */
  sourceId?: string | null;
  /**
   * Let this write claim a document row that currently has NO owner. Only the
   * page-mirror writers set it: the mirror belongs to the page it mirrors, so
   * adopting an unowned row is a backfill, not a takeover. Every tenant-facing
   * path leaves it unset and is refused instead.
   */
  claimUnowned?: boolean;
  /**
   * The owner this caller saw on the row when it decided to write — `null` for
   * an unowned or absent row. When set, the write lands only if the row is
   * still absent or still carries that owner. The local re-readers pass it:
   * they judge a file against a snapshot taken at the start of a long walk, and
   * a remote `index` that labels the same path in the meantime would otherwise
   * keep its ownership through the COALESCE below and receive the file.
   */
  expectOwner?: string | null;
}

export interface IndexTxResult {
  documentId: string;
  chunks: number;
  embeddings: number;
  entities: number;
}

/**
 * Atomically write a document + its chunks + per-chunk entity mentions
 * (and embeddings if any chunk carries one). Returns counts for the caller
 * to surface in CLI output / job-handler logs.
 */
export async function writeDocumentTransaction(
  storage: Storage,
  doc: DocumentWrite,
  chunks: readonly ChunkWrite[],
  opts: { codeEdges?: readonly CodeEdgeInput[] } = {},
): Promise<IndexTxResult> {
  if (!doc.documentId || !doc.sourcePath) {
    throw new Error(
      "writeDocumentTransaction: documentId and sourcePath are required",
    );
  }

  const engine = storage.raw();
  let embeddingsWritten = 0;
  let entitiesWritten = 0;
  // Content date + its mig080 provenance, derived once outside the tx.
  const effectiveDate = resolveEffectiveDateWithSource(
    doc.frontmatter,
    doc.sourcePath,
  );

  // Wrap the whole transaction (not individual queries) in a connection-retry:
  // a dropped socket kills the tx, so retry must restart from BEGIN on a fresh
  // connection. The body is idempotent (documents upsert → DELETE chunks →
  // re-insert), so a replay reproduces the same end state — but the counters
  // must reset per attempt so a retried tx doesn't double-count.
  await withRetry(() => engine.transaction(async (tx) => {
    embeddingsWritten = 0;
    entitiesWritten = 0;

    const healed = await adoptLegacyDocuments(tx, doc);
    const healedOwner = healed?.owner;
    const expectOwner = healed === undefined ? doc.expectOwner : healed.owner;

    // No cross-tenant document overwrite. `documents.id` hashes ONLY the
    // caller-supplied source_path (see `docId` in indexer.ts), so a scoped
    // caller who names another tenant's path — they are predictable,
    // `page://<source>/<slug>` — lands on that tenant's row and the upsert
    // below replaces its chunks. The victim's canonical page survives, but
    // every chunk backing it is deleted and re-inserted from the attacker's
    // text: their own search stops finding their own note, silently. This is
    // the same ownership fence `putPage` applies to `pages` (core/pages.ts).
    //
    // Only a caller that NAMES a source is fenced. Trusted local callers (CLI
    // reindex, vault sweep, the cycle) pass null and keep the existing owner
    // via the COALESCE below — fencing those would break every re-index.
    if (doc.sourceId != null) {
      const existing = await tx.query<{ source_id: string | null }>(
        "SELECT source_id FROM documents WHERE id = $1",
        [doc.documentId],
      );
      // An UNOWNED row (source_id NULL) is not free real estate: every document
      // the local sweeps write — vault, code, the cycle — is unowned, and
      // letting a scoped caller claim one is the same takeover the named case
      // refuses, just against the operator's own content. Absent row → insert.
      //
      // `claimUnowned` is the one exception, and it is not a tenant path: the
      // page-mirror writers own the document they are mirroring by definition
      // (`page://<source>/<slug>`), and a mirror written before the row carried
      // a source — or by a caller holding a partial page object — is otherwise
      // unreconcilable forever, which shows up as a page that silently stops
      // being searchable.
      const owner = existing.rows[0]?.source_id;
      const claimable = doc.claimUnowned === true && owner == null;
      if (existing.rows.length > 0 && owner !== doc.sourceId && !claimable) {
        throw new OperationError(
          "permission_denied",
          `document '${doc.sourcePath}' is owned by another source`,
          "Index under a source_path inside your own source.",
        );
      }
    }

    const upserted = await tx.query<{ id: string }>(
      `INSERT INTO documents (id, source_id, source_path, title, frontmatter, last_indexed_mtime, chunker_version, effective_date, effective_date_source, import_filename, updated_at)
       VALUES ($1, COALESCE($6, $14::text), $2, $3, $4::text::jsonb, $5, COALESCE($7, 1), $8, $9, $10, NOW())
       ON CONFLICT (id) DO UPDATE SET
         -- Keep the existing source on reindex unless the caller passes one
         -- explicitly. A null write leaves classification to the path-prefix
         -- backfill in core/sources.ts (don't freeze a doc as 'default').
         source_id          = COALESCE($6, documents.source_id),
         source_path        = EXCLUDED.source_path,
         title              = EXCLUDED.title,
         frontmatter        = EXCLUDED.frontmatter,
         last_indexed_mtime = EXCLUDED.last_indexed_mtime,
         -- Content date re-parsed from the fresh frontmatter on every re-index;
         -- the mig080 provenance pair moves with it.
         effective_date     = EXCLUDED.effective_date,
         effective_date_source = EXCLUDED.effective_date_source,
         import_filename    = EXCLUDED.import_filename,
         -- Re-index re-chunks under the CURRENT chunker, so advance the stamp;
         -- a metadata-only re-put that omits the version preserves the prior one.
         chunker_version    = COALESCE($7, documents.chunker_version),
         -- Per-document generation (migration 031) — Layer 2 of the query
         -- cache. A re-index bumps ONLY this document's counter, so the cache
         -- invalidates queries that reference this doc without touching
         -- unrelated cached queries. A fresh INSERT keeps the DEFAULT 0.
         generation         = documents.generation + 1,
         updated_at         = NOW()
       -- The check above is a check-then-act: two scoped callers can both read
       -- "no row" and the loser's DO UPDATE would then overwrite the winner.
       -- Re-state the rule where the write happens, so the database arbitrates:
       -- an unscoped caller ($6 NULL) keeps whatever owner is there, and a
       -- scoped one may only update a row that is already its own.
       WHERE ($6::text IS NULL
          OR documents.source_id IS NOT DISTINCT FROM $6::text
          OR ($11::boolean AND documents.source_id IS NULL))
         AND (NOT $12::boolean OR documents.source_id IS NOT DISTINCT FROM $13::text)
       RETURNING id`,
      [
        doc.documentId,
        doc.sourcePath,
        // TEXT columns reject U+0000 / lone surrogates just like jsonb — a
        // NUL-bearing file must index, not abort the whole document tx.
        doc.title == null ? null : wellFormForText(doc.title),
        // Sanitize lone UTF-16 surrogates + NUL before the ::jsonb cast — a
        // single bad value (truncated emoji, mis-encoded source) would
        // otherwise make Postgres reject the cast and abort the whole index tx.
        // wellFormJsonbObject ALSO guards the object invariant: a non-object
        // frontmatter (a recipe passing raw content) collapses to {} instead of
        // serializing as a multi-MB jsonb scalar (the 420MB-frontmatter bug).
        JSON.stringify(wellFormJsonbObject(doc.frontmatter)),
        doc.mtimeMs ?? null,
        doc.sourceId ?? null,
        doc.chunkerVersion ?? null,
        effectiveDate.iso,
        effectiveDate.source,
        importFilename(doc.sourcePath),
        doc.claimUnowned === true,
        expectOwner !== undefined,
        expectOwner ?? null,
        healedOwner ?? null,
      ],
    );

    // A refused conflict update returns NO row, and everything below this line
    // — the clock bump, the chunk delete, the re-insert — would otherwise run
    // against the winner's document with the loser's content. Reading the
    // RETURNING is what turns the WHERE above from a comment into a fence.
    if (upserted.rows.length === 0) {
      throw new OperationError(
        "permission_denied",
        `document '${doc.sourcePath}' is owned by another source`,
        "Index under a source_path inside your own source.",
      );
    }

    // The folded rows took their soft-delete and archive state with them; the
    // write must not revive a document either copy had retired.
    if (healed && hasLifecycle(healed.lifecycle)) {
      const l = healed.lifecycle;
      await tx.query(
        `UPDATE documents
            SET deleted_at         = COALESCE(deleted_at, $2::timestamptz),
                archived           = archived OR $3::boolean,
                archived_at        = COALESCE(archived_at, $4::timestamptz),
                archive_expires_at = COALESCE(archive_expires_at, $5::timestamptz)
          WHERE id = $1`,
        [doc.documentId, l.deleted_at, l.archived === true, l.archived_at, l.archive_expires_at],
      );
    }
    // A fresh INSERT stamps ingested_at = now(); keep the earliest copy's, which
    // synthesis reads as the note's date when it has no effective_date.
    if (healed?.lifecycle.ingested_at) {
      await tx.query(
        `UPDATE documents SET ingested_at = LEAST(ingested_at, $2::timestamptz) WHERE id = $1`,
        [doc.documentId, healed.lifecycle.ingested_at],
      );
    }

    // Bump the live-model generation clock so the query cache knows the
    // corpus changed (migration 025).
    await bumpDocumentClock(tx);

    // Read the AUTHORITATIVE source back from the row we just upserted — NOT the
    // raw doc.sourceId. On reindex the upsert keeps the prior source via
    // COALESCE($6, documents.source_id), so the stored value is the only correct
    // one. Mirroring it onto chunks (migration 058) keeps chunks.source_id ==
    // documents.source_id, including NULL, so a bridged/unclassified doc's chunks
    // never freeze to 'default'.
    const effSource =
      (
        await tx.query<{ source_id: string | null }>(
          "SELECT source_id FROM documents WHERE id = $1",
          [doc.documentId],
        )
      ).rows[0]?.source_id ?? null;

    // Wipe prior chunks for this document. Cascades to embeddings + entity_mentions
    // via ON DELETE CASCADE on the FK, so reindexing is idempotent.
    await tx.query("DELETE FROM chunks WHERE document_id = $1", [doc.documentId]);

    for (let i = 0; i < chunks.length; i++) {
      const ch = chunks[i];
      if (!ch) continue;
      const cid = `${doc.documentId}_c${i}`;
      await tx.query(
        `INSERT INTO chunks
           (id, document_id, chunk_index, content, start_line, end_line,
            symbol_name, symbol_type, parent_symbol_path, doc_comment, language,
            symbol_name_qualified, source_id, chunk_source, contextual_tier, contextual_embedded)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10, $11, $12, $13, $14, $15, $16)`,
        [
          cid,
          doc.documentId,
          i,
          // Chunk body is raw file content (markdown or code) — sanitize NUL /
          // lone surrogates here at the choke point so one bad file can't
          // abort the tx with "invalid byte sequence for encoding UTF8: 0x00".
          wellFormForText(ch.text),
          ch.startLine ?? null,
          ch.endLine ?? null,
          ch.symbolName ?? null,
          ch.symbolType ?? null,
          // Empty / absent chain → NULL (never `{}`), so the column is always
          // either NULL or a non-empty TEXT[]. Mirrors migration 028, which
          // preserves NULL and casts existing scalars to 1-element arrays.
          ch.parentSymbolPath && ch.parentSymbolPath.length > 0
            ? [...ch.parentSymbolPath]
            : null,
          // Doc comments come from the same raw file content as the body —
          // same sanitization, same reason.
          ch.docComment == null ? null : wellFormForText(ch.docComment),
          ch.language ?? null,
          ch.symbolNameQualified ?? null,
          // Mirror the parent doc's authoritative source (migration 058) — NULL
          // stays NULL so unclassified docs don't freeze to 'default'.
          effSource,
          ch.chunkSource ?? null,
          ch.contextualTier ?? null,
          ch.contextualTier === "deterministic" || ch.contextualTier === "llm",
        ],
      );

      if (ch.embedding) {
        const embModel = doc.embeddingModel ?? "unknown";
        await tx.query(
          `INSERT INTO embeddings (chunk_id, vector, model, embedding_signature)
           VALUES ($1, $2::vector, $3, $4)`,
          [
            cid,
            JSON.stringify(ch.embedding),
            embModel,
            embeddingSignature(embModel, ch.embedding.length),
          ],
        );
        embeddingsWritten++;
      }

      entitiesWritten += await persistEntitiesViaTx(tx, cid, ch.entities);
    }

    // Same transaction as the chunks: a code document whose edges did not land
    // keeps its previous chunks and mtime, so the next sweep retries it.
    if (opts.codeEdges && opts.codeEdges.length > 0) {
      await insertCodeEdges(tx, opts.codeEdges);
    }
  }), BULK_RETRY_OPTS);

  return {
    documentId: doc.documentId,
    chunks: chunks.length,
    embeddings: embeddingsWritten,
    entities: entitiesWritten,
  };
}

interface FoldedLifecycle {
  deleted_at: string | null;
  archived: boolean | null;
  archived_at: string | null;
  archive_expires_at: string | null;
  ingested_at: string | null;
}

function hasLifecycle(l: FoldedLifecycle): boolean {
  return l.deleted_at !== null || l.archived === true || l.archived_at !== null || l.archive_expires_at !== null;
}

function ownerConflict(sourcePath: string): OperationError {
  return new OperationError(
    "permission_denied",
    `document '${sourcePath}' is owned by another source`,
    "Index under a source_path inside your own source.",
  );
}

/**
 * The one owner the rows under a drifted source_path share, which the fold
 * keeps. Refused when two sources own them, when none carries the owner the
 * caller verified, or when the row the path hashes to is owned by anyone else:
 * that is the row a remote `index` labels, and a legacy row never hands a
 * local file to it.
 */
function foldedOwner(
  legacy: readonly { source_id: string | null }[],
  current: readonly { source_id: string | null }[],
  doc: Pick<DocumentWrite, "sourcePath" | "sourceId" | "expectOwner">,
): string | null {
  const seen = [...legacy, ...current].map((r) => r.source_id);
  const owners = [...new Set(seen.filter((o): o is string => o !== null))];
  const kept = owners[0] ?? null;
  const currentOwner = current[0]?.source_id ?? null;
  const refused =
    owners.length > 1 ||
    !seen.includes(doc.expectOwner ?? null) ||
    (currentOwner !== null && currentOwner !== doc.expectOwner) ||
    (doc.sourceId != null && kept !== null && doc.sourceId !== kept);
  if (refused) throw ownerConflict(doc.sourcePath);
  return kept;
}

/**
 * The owner checks `writeDocumentTransaction` makes for a local re-read, run
 * read-only before the caller pays for embeddings. The in-transaction fence
 * stays the authority; this only turns a refusal it would make into one made
 * before any spend.
 */
export async function checkLocalWriteOwner(
  engine: Engine,
  doc: Pick<DocumentWrite, "documentId" | "sourcePath" | "sourceId" | "claimUnowned" | "expectOwner">,
): Promise<void> {
  if (doc.expectOwner === undefined) return;
  const legacy = await engine.query<{ source_id: string | null }>(
    "SELECT source_id FROM documents WHERE source_path = $1 AND id <> $2",
    [doc.sourcePath, doc.documentId],
  );
  const current = await engine.query<{ source_id: string | null }>(
    "SELECT source_id FROM documents WHERE id = $1",
    [doc.documentId],
  );
  const expect =
    legacy.rows.length > 0 ? foldedOwner(legacy.rows, current.rows, doc) : doc.expectOwner;
  if (current.rows.length === 0) return;
  const owner = legacy.rows.length > 0 ? expect : current.rows[0]!.source_id;
  const claimable = doc.claimUnowned === true && owner == null;
  if (owner !== expect || (doc.sourceId != null && owner !== doc.sourceId && !claimable)) {
    throw ownerConflict(doc.sourcePath);
  }
}

/**
 * Fold rows stored under this source_path with an id other than the one the
 * path hashes to into the write's own id. They exist where a path was
 * rewritten in place (migration 099 moved `/vault/…` to `/memory/…` and kept
 * the ids), and every local re-read otherwise upserts a second document beside
 * them, then fails its owner fence against that twin on the next tick.
 *
 * Only a local re-read heals (`expectOwner` set): a remote inline `index`
 * writes the id its own label hashes to and never reaches another row. The
 * kept owner is the one `foldedOwner` accepts; anything else is refused, not
 * merged. Chunks, embeddings, entity mentions and code edges cascade with the
 * legacy row, since this write regenerates them; provenance pointers (links,
 * timeline events, facts, hot memory, synthesis atoms and takes) and eval
 * expectations move to the new ids, and the rows' soft-delete and archive
 * state comes back for the write to keep.
 *
 * Returns the owner the write must keep and find, or undefined when there was
 * nothing to fold.
 */
async function adoptLegacyDocuments(
  tx: Engine,
  doc: DocumentWrite,
): Promise<{ owner: string | null; lifecycle: FoldedLifecycle } | undefined> {
  if (doc.expectOwner === undefined) return undefined;
  const legacy = await tx.query<{ id: string; source_id: string | null }>(
    `SELECT id, source_id FROM documents
      WHERE source_path = $1 AND id <> $2
      ORDER BY id
      FOR UPDATE`,
    [doc.sourcePath, doc.documentId],
  );
  if (legacy.rows.length === 0) return undefined;
  const current = await tx.query<{ source_id: string | null }>(
    "SELECT source_id FROM documents WHERE id = $1 FOR UPDATE",
    [doc.documentId],
  );
  const kept = foldedOwner(legacy.rows, current.rows, doc);
  const lifecycle = (
    await tx.query<FoldedLifecycle>(
      `SELECT min(deleted_at)::text AS deleted_at, bool_or(archived) AS archived,
              min(archived_at)::text AS archived_at, min(archive_expires_at)::text AS archive_expires_at,
              min(ingested_at)::text AS ingested_at
         FROM documents
        WHERE source_path = $1 AND id <> $2`,
      [doc.sourcePath, doc.documentId],
    )
  ).rows[0]!;

  for (const { id } of legacy.rows) {
    const from = `${id}_c`;
    const to = `${doc.documentId}_c`;
    const repoint = (table: string, clash: string) =>
      tx.query(
        `UPDATE ${table} t
            SET source_chunk_id = $2::text || substr(t.source_chunk_id, length($1::text) + 1)
          WHERE starts_with(t.source_chunk_id, $1::text)${clash}`,
        [from, to],
      );
    await repoint("links", "");
    await repoint("hot_memory", "");
    // Both carry a unique key over the chunk id; a row the current document
    // already derived keeps its pointer, and the duplicate keeps the old one.
    await repoint(
      "timeline_events",
      ` AND NOT EXISTS (SELECT 1 FROM timeline_events o
                         WHERE o.slug = t.slug AND o.occurred_at = t.occurred_at
                           AND o.source_chunk_id = $2::text || substr(t.source_chunk_id, length($1::text) + 1))`,
    );
    await repoint(
      "entity_facts",
      ` AND NOT EXISTS (SELECT 1 FROM entity_facts o
                         WHERE o.entity_slug = t.entity_slug AND o.fact = t.fact
                           AND o.source_chunk_id = $2::text || substr(t.source_chunk_id, length($1::text) + 1))`,
    );
    await tx.query(
      "UPDATE eval_queries SET expected_doc_id = $2 WHERE expected_doc_id = $1",
      [id, doc.documentId],
    );
    // Synthesis keys its idempotency and its tenant join on the document id;
    // a stale one re-extracts the document and counts its takes elsewhere.
    await tx.query(
      "UPDATE synth_atoms SET source_ref = $2 WHERE source_ref = $1 AND source_kind = 'document'",
      [id, doc.documentId],
    );
    await tx.query(
      `UPDATE synth_takes t SET source_ref = $2
        WHERE t.source_ref = $1
          AND (t.row_num IS NULL
               OR NOT EXISTS (SELECT 1 FROM synth_takes o WHERE o.source_ref = $2 AND o.row_num = t.row_num))`,
      [id, doc.documentId],
    );
    await tx.query("DELETE FROM documents WHERE id = $1", [id]);
  }
  if (kept !== null && current.rows.length > 0) {
    await tx.query("UPDATE documents SET source_id = $2 WHERE id = $1", [doc.documentId, kept]);
  }
  return { owner: kept, lifecycle };
}

async function persistEntitiesViaTx(
  tx: Engine,
  chunkId: string,
  entities: readonly ExtractedEntity[],
): Promise<number> {
  if (entities.length === 0) return 0;
  let count = 0;
  for (const e of entities) {
    const eid = entityId(e.type, e.name);
    await tx.query(
      `INSERT INTO entities (id, type, name)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [eid, e.type, e.name],
    );
    await tx.query(
      `INSERT INTO entity_mentions (chunk_id, entity_id, surface_form)
       VALUES ($1, $2, $3)
       ON CONFLICT (chunk_id, entity_id) DO NOTHING`,
      [chunkId, eid, e.surfaceForm],
    );
    count++;
  }
  return count;
}
