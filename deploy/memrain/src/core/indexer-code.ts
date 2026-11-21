/**
 * Code indexer — turns a TypeScript / Python source file into rows in
 * `documents`, `chunks`, `entities`, `entity_mentions` and `embeddings`.
 * Each chunk is embedded raw (code-embed.ts) through the spend wallet, under
 * a per-run dollar cap; a chunk whose text and input hash are unchanged keeps
 * its stored vector, so re-indexing an unchanged file pays nothing.
 *
 * Idempotent at the file level — re-indexing the same source_path
 * replaces all of its chunks (cascade clears entity_mentions too).
 */
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { createHash } from "node:crypto";
import type { Storage } from "./storage.ts";
import {
  chunkCode,
  CODE_CHUNKER_VERSION,
  type CodeChunked,
} from "./chunkers/code.ts";
import { chunkPlainText } from "./chunkers/recursive.ts";
import {
  GrammarLoadError,
  ParseTimeoutError,
  languageForFile,
  type CodeLanguage,
} from "./chunkers/parsers.ts";
import { extractCodeEntities } from "./code-entities.ts";
import { EMPTY_SOURCE_KEY } from "./empty-source.ts";
import { qualifiedSymbolName, type CodeEdgeInput } from "./code-edges.ts";
import type { ExtractedEntity } from "./entities.ts";
import type { Engine } from "./engine/interface.ts";
import {
  checkLocalWriteOwner,
  writeDocumentTransaction,
  type ChunkWrite,
  type IndexTxResult,
} from "./indexer-tx.ts";
import { normalizeSourcePath } from "./indexer.ts";
import { guardLocalIndex, type RereadGuard } from "./sources.ts";
import { auditSecrets, guardSecrets, guardWrite } from "./secret-scan.ts";
import type { EmbedFn } from "./indexer.ts";
import { DEFAULT_MODEL_ID, EMBED_DIMENSIONS, embedText } from "./embedding.ts";
import { embeddingInputHash } from "./embedding-input-hash.ts";
import { codeEmbeddingInput, codeEmbedMaxUsd, EmbedSpendCap } from "./code-embed.ts";
import { acquireWriteEmbedSlot } from "./concurrency.ts";
import { isLlmAvailable, keywordOnlyMode } from "./llm/gateway.ts";
import { OperationError } from "./operation-error.ts";
import { wellFormForText } from "./well-form.ts";
import { isContentRejection, stopsTheRun } from "./embed-backfill.ts";

export interface IndexCodeResult extends IndexTxResult {
  /**
   * True if tree-sitter reported syntax errors anywhere in the file, OR the
   * file was never parsed at all because its grammar could not be loaded
   * (see chunkCodeOrDegrade). Either way the chunks are lower fidelity than a
   * clean parse, which is what the sweep's `parseErrors` counter reports.
   */
  hasParseError: boolean;
  /** Detected language; null for unsupported file types. */
  language: CodeLanguage | null;
  /** True if the file was skipped because the language is unsupported. */
  skipped: boolean;
  /** Chunks written without a vector because of the cap or an embed failure. */
  embeddingDeferred?: number;
}

export interface IndexCodeOptions {
  /** Embedder; defaults to Titan when AWS is configured, else nothing is embedded. */
  embedFn?: EmbedFn;
  embeddingModel?: string;
  /**
   * Dollar cap the run's embed calls reserve against. A sweep shares one across
   * its files; without one each document gets `MEMRAIN_CODE_EMBED_MAX_USD`.
   */
  embedCap?: EmbedSpendCap;
  /** A chunk that cannot be embedded fails the write instead of landing without a vector. */
  requireCompleteEmbeddings?: boolean;
}

export interface IndexCodeInput {
  sourcePath: string;
  text: string;
  mtimeMs?: number;
  /** Owning source; the document and every edge extracted from it carry it. */
  sourceId?: string | null;
  /** See DocumentWrite.expectOwner — the code sweep only. */
  expectOwner?: string | null;
  beforeCommit?: (tx: Engine) => Promise<void>;
  requireCompleteParse?: boolean;
}

/** `MEMRAIN_CODE_SECRET_SCAN=0` indexes source text unscanned. On by default. */
export function codeSecretScanOn(): boolean {
  return !["0", "false", "off", "no"].includes((process.env.MEMRAIN_CODE_SECRET_SCAN ?? "").trim().toLowerCase());
}

function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function docId(sourcePath: string): string {
  return `doc_${shortHash(sourcePath)}`;
}

/** A parse result plus whether it came from a real parse or from degrading. */
type ChunkedOrDegraded = CodeChunked & { degraded: boolean };

/**
 * Languages already reported as unusable in this process. A grammar that
 * cannot load fails for EVERY file of its type, so warning per file turns one
 * boot sweep of a shell-heavy repo into thousands of identical lines.
 */
const degradedLanguagesLogged = new Set<CodeLanguage>();

/** Test seam: forget which languages have already been reported. */
export function _resetGrammarFallbackWarningsForTests(): void {
  degradedLanguagesLogged.clear();
}

/**
 * Chunk a source file into symbols, degrading to an EMPTY symbol set when the
 * grammar cannot be loaded (or the parse throws for any other reason).
 *
 * A throw here used to drop the file from the index entirely: chunkCode ran
 * before writeDocumentTransaction, so a file whose grammar failed produced no
 * document, no chunks and no embeddings — invisible to both search arms, with
 * only a line in the sweep's per-file error list to say so. That is how the
 * shell corpus stayed out of the brain for weeks. A file we cannot parse is
 * still text worth retrieving, so hand back zero symbols and let the existing
 * symbol-less fallback below window it as plain text — one fallback path, not
 * two.
 *
 * ParseTimeoutError is the one throw that still propagates: it means the file
 * IS parseable but ran over its wall-clock budget, and skipping it preserves
 * the file's previous fully-parsed chunks rather than overwriting them with
 * degraded windows (the no-partial-reindex rationale in
 * `chunkers/parsers.ts`).
 */
async function chunkCodeOrDegrade(
  text: string,
  sourcePath: string,
  language: CodeLanguage,
): Promise<ChunkedOrDegraded> {
  try {
    return { ...(await chunkCode(text, sourcePath, language)), degraded: false };
  } catch (e) {
    if (e instanceof ParseTimeoutError) throw e;
    if (!degradedLanguagesLogged.has(language)) {
      degradedLanguagesLogged.add(language);
      const what =
        e instanceof GrammarLoadError ? "grammar unusable" : "parser failed";
      const why = e instanceof Error ? e.message : String(e);
      console.warn(
        `[code] ${language}: ${what} — indexing every ${language} file as ` +
          `plain text (no symbols, no call graph) until this is fixed: ${why}`,
      );
    }
    return {
      frontmatter: {},
      // Same title chunkCode would have produced: the file's basename.
      title: basename(sourcePath),
      symbols: [],
      fileImports: [],
      hasParseError: true,
      degraded: true,
    };
  }
}

/**
 * Index a single in-memory source file. Returns counts plus a
 * `hasParseError` flag for the sweep to log on.
 */
export async function indexCodeDocument(
  storage: Storage,
  input: IndexCodeInput,
  opts: IndexCodeOptions = {},
): Promise<IndexCodeResult> {
  if (!input.sourcePath || input.text === undefined) {
    throw new Error("indexCodeDocument: sourcePath and text are required");
  }
  const language = languageForFile(input.sourcePath);
  if (!language) {
    return {
      documentId: "",
      chunks: 0,
      embeddings: 0,
      entities: 0,
      hasParseError: false,
      language: null,
      skipped: true,
    };
  }

  // A key committed to a repository is still a key: redact it before the
  // parse, line for line, so every symbol's start/end line still points at the
  // file on disk.
  const secrets = codeSecretScanOn()
    ? await guardWrite(storage.engine(), input.sourcePath, input.sourceId ?? null, () =>
        guardSecrets(input.text, input.sourcePath, { preserveLines: true }))
    : { text: input.text, findings: [] };
  if (secrets.findings.length > 0) {
    await auditSecrets(storage.engine(), secrets.findings, input.sourcePath, input.sourceId ?? null);
  }
  const text = secrets.text;

  const parsed = await chunkCodeOrDegrade(
    text,
    input.sourcePath,
    language,
  );
  if (input.requireCompleteParse && parsed.hasParseError) {
    throw new Error("reviewed rechunk requires a complete code parse");
  }
  const id = docId(input.sourcePath);

  // File-level imports belong to the module chunk when present, otherwise
  // the first symbol or fallback chunk retains the document-level references.
  const fileImportRefs: ExtractedEntity[] = parsed.fileImports.map((imp) => ({
    type: "code-ref",
    name: imp.name,
    surfaceForm: `${input.sourcePath}:${imp.line}:<import>`,
  }));

  // Build per-symbol entity sets. Each chunk corresponds to one symbol.
  const chunkWrites: ChunkWrite[] = [];
  const codeEdges: CodeEdgeInput[] = [];
  const importOwner = Math.max(0, parsed.symbols.findIndex(symbol => symbol.kind === "module"));
  for (let i = 0; i < parsed.symbols.length; i++) {
    const symbol = parsed.symbols[i]!;
    const entities = await extractCodeEntities({
      symbol,
      file: input.sourcePath,
      language,
    });
    // Keep one owner for file-level imports so references are not duplicated.
    const merged = i === importOwner ? [...fileImportRefs, ...entities] : entities;
    const qualified = qualifiedSymbolName(symbol.parentSymbolPath, symbol.name);
    chunkWrites.push({
      text: symbol.body,
      startLine: symbol.startLine,
      endLine: symbol.endLine,
      embedding: null, // graph-only
      symbolName: symbol.name,
      symbolNameQualified: qualified,
      symbolType: symbol.kind,
      parentSymbolPath: symbol.parentSymbolPath,
      docComment: symbol.docComment,
      language,
      entities: merged,
    });
    // Turn this symbol's callee references (already extracted as `code-caller`
    // entities) into typed edges anchored on this symbol's chunk. Targets are
    // bare names left UNRESOLVED; the resolve-symbol-edges phase links them to a
    // defining chunk. Dedup per (callee) so a symbol called N times = one edge.
    const seen = new Set<string>();
    for (const e of entities) {
      if (e.type !== "code-caller" || seen.has(e.name)) continue;
      seen.add(e.name);
      codeEdges.push({
        fromChunkId: `${id}_c${i}`,
        fromSymbolQualified: qualified,
        toSymbolQualified: e.name,
        edgeType: "calls",
      });
    }
  }

  // Fallback: a file with no extractable symbols (a barrel of re-exports, a
  // config-only script, a DML-only SQL file — or one whose grammar could not
  // be loaded at all, see chunkCodeOrDegrade) still gets plain text-window
  // chunks so its content is searchable — windowed module chunks whenever
  // symbol extraction yields nothing, so a symbol-less file NEVER produces a
  // zero-chunk (unretrievable) document.
  // chunkPlainText (NOT chunkMarkdown): a markdown parse would eat a leading
  // `--- … ---` block as YAML frontmatter — those are valid SQL comment
  // separators. Line stamps for the fallback: startLine 1,
  // endLine = the window's own line count (window offsets aren't tracked).
  // File-level imports, when present, attach to the first fallback chunk.
  const windows = fallbackWindows(parsed, text);
  for (let i = 0; i < windows.length; i++) {
    chunkWrites.push({
      text: windows[i]!,
      startLine: 1,
      endLine: windows[i]!.split(/\r?\n/).length,
      embedding: null,
      language, // not a symbol, but still this language
      entities: i === 0 ? fileImportRefs : [],
    });
  }

  // A file that reached here with nothing to write is BLANK (0 bytes or only
  // whitespace) — the fallback above covers every other symbol-less case. Mark
  // it so orphans-purge can tell "legitimately empty" from "corrupt index"; the
  // two are indistinguishable from the document row alone, and re-indexing an
  // empty file produces the same zero chunks forever.
  const frontmatter: Record<string, unknown> = { language, kind: "code" };
  if (chunkWrites.length === 0) frontmatter[EMPTY_SOURCE_KEY] = true;

  // The write's owner fence, run before any embed is paid for: a file the
  // transaction would refuse must not re-pay its vectors on every sweep.
  await checkLocalWriteOwner(storage.raw(), {
    documentId: id,
    sourcePath: input.sourcePath,
    sourceId: input.sourceId ?? null,
    ...(input.expectOwner !== undefined ? { expectOwner: input.expectOwner } : {}),
  });
  const embedded = await embedCodeChunks(storage, id, input.sourcePath, chunkWrites, opts);

  const result = await writeDocumentTransaction(
    storage,
    {
      documentId: id,
      sourcePath: input.sourcePath,
      title: parsed.title,
      frontmatter,
      // A degraded document is stamped with NO mtime on purpose. The sweep skips
      // a file whose stored mtime is current (sweep-code.ts), so stamping one
      // here would freeze the text-only version in place: fixing the grammar
      // would no longer heal the corpus by itself. A NULL stamp reproduces the
      // pre-fallback behaviour — the file is re-indexed every sweep and gets its
      // symbols back the moment the grammar links again.
      mtimeMs: parsed.degraded ? null : (input.mtimeMs ?? null),
      embeddingModel: embedded.model,
      chunkerVersion: CODE_CHUNKER_VERSION,
      sourceId: input.sourceId ?? null,
      ...(input.expectOwner !== undefined ? { expectOwner: input.expectOwner } : {}),
      ...(input.beforeCommit ? { beforeCommit: input.beforeCommit } : {}),
    },
    embedded.chunks,
    { codeEdges },
  );

  return {
    ...result,
    hasParseError: parsed.hasParseError,
    language,
    skipped: false,
    ...(embedded.deferred > 0 ? { embeddingDeferred: embedded.deferred } : {}),
  };
}

/** Plain text windows for a file whose parse yielded no symbol (see indexCodeDocument). */
function fallbackWindows(parsed: CodeChunked, text: string): string[] {
  return parsed.symbols.length === 0 && text.trim().length > 0 ? chunkPlainText(text) : [];
}

/**
 * The chunk texts indexCodeDocument would write for `text` at `sourcePath`, for
 * pricing a re-index before it runs. Same redaction, parse and fallback; no
 * database, no audit.
 */
export async function codeChunkTexts(text: string, sourcePath: string): Promise<string[]> {
  const language = languageForFile(sourcePath);
  if (!language) return [];
  const redacted = codeSecretScanOn() ? guardSecrets(text, sourcePath, { preserveLines: true }).text : text;
  const parsed = await chunkCodeOrDegrade(redacted, sourcePath, language);
  return [...parsed.symbols.map((symbol) => symbol.body), ...fallbackWindows(parsed, redacted)];
}

/**
 * Give each chunk a vector before the write. A chunk whose stored vector was
 * embedded from the same input (migration 187's hash; NULL = unknown, reused by
 * text) keeps it for free. The rest are embedded one at a time, each reserving
 * its worst case against the run's cap first.
 *
 * A vector is an extra on top of the code graph, so by default nothing here
 * fails the write: a chunk that cannot be embedded lands without a vector and
 * `memrain embed --code` fills it later. Which chunks that covers depends on
 * the failure: the model refusing one chunk's text skips that chunk; a passing
 * failure (throttle, timeout) skips the rest of this file; the cap, or a
 * failure every call would repeat (a spent budget, credentials, access, an
 * unknown model), stops the cap's whole run, so a sweep does not try again on
 * every file. Without an injected embedder, embedding needs AWS configured
 * (isLlmAvailable): an install without it indexes the graph quietly.
 */
async function embedCodeChunks(
  storage: Storage,
  documentId: string,
  sourcePath: string,
  chunks: readonly ChunkWrite[],
  opts: IndexCodeOptions,
): Promise<{ chunks: ChunkWrite[]; model: string | null; deferred: number }> {
  const model = opts.embeddingModel ?? DEFAULT_MODEL_ID;
  const keywordOnly = keywordOnlyMode();
  // The wallet sends a capped call once, so one reservation covers one request.
  const titan: EmbedFn = (text, o) => embedText(text, { ...o, maxAttempts: 1 });
  const embed = keywordOnly ? null : (opts.embedFn ?? (isLlmAvailable() ? titan : null));
  const prior = await priorCodeVectors(storage, documentId, model);
  const cap = opts.embedCap ?? new EmbedSpendCap(codeEmbedMaxUsd());
  const out: ChunkWrite[] = [];
  let deferred = 0;
  let fileStop: string | null = null;
  let vectors = 0;
  for (const chunk of chunks) {
    const input = codeEmbeddingInput(chunk.text);
    if (input.trim().length === 0) {
      out.push(chunk);
      continue;
    }
    const hash = embeddingInputHash({ model, dimensions: EMBED_DIMENSIONS, tier: "none", input });
    const stored = prior.get(wellFormForText(chunk.text));
    if (stored && (stored.hash === null || stored.hash === hash || keywordOnly)) {
      out.push({ ...chunk, embedding: stored.vec, embeddingInputHash: stored.hash });
      vectors++;
      continue;
    }
    if (!embed) {
      out.push(chunk);
      continue;
    }
    if (fileStop !== null || !cap.tryReserve(model, input)) {
      if (opts.requireCompleteEmbeddings) {
        throw new OperationError(
          "budget_exhausted",
          `code chunk not embedded: ${fileStop ?? cap.stopReason}`,
          "Raise the cap or index fewer files.",
        );
      }
      out.push(chunk);
      deferred++;
      continue;
    }
    const release = await acquireWriteEmbedSlot();
    try {
      const vec = await embed(input, { modelId: model });
      out.push({ ...chunk, embedding: vec, embeddingInputHash: hash });
      vectors++;
    } catch (e) {
      if (opts.requireCompleteEmbeddings) throw e;
      const reason = e instanceof Error ? e.message.slice(0, 200) : String(e);
      if (stopsTheRun(e)) cap.stop(reason);
      else if (!isContentRejection(e)) fileStop = reason;
      out.push(chunk);
      deferred++;
    } finally {
      release();
    }
  }
  // A sweep shares one cap and reports its own total once; a lone document says it here.
  if (deferred > 0 && opts.embedCap === undefined) {
    console.warn(
      `[code] ${deferred} chunk(s) of '${sourcePath}' stored without a vector ` +
        `(${fileStop ?? cap.stopReason ?? "the model refused the text"}); \`memrain embed --code\` fills them`,
    );
  }
  return { chunks: out, model: vectors > 0 ? model : null, deferred };
}

/** This document's stored vectors under `model` and the current width, keyed by chunk text. */
async function priorCodeVectors(
  storage: Storage,
  documentId: string,
  model: string,
): Promise<Map<string, { vec: number[]; hash: string | null }>> {
  const prior = new Map<string, { vec: number[]; hash: string | null }>();
  try {
    // scope: upstream the document is the one this write owns
    const { rows } = await storage.engine().query<{ content: string; vec: string; input_hash: string | null }>(
      `SELECT c.content, e.vector::text AS vec, e.input_hash
         FROM chunks c JOIN embeddings e ON e.chunk_id = c.id
        WHERE c.document_id = $1 AND e.model = $2`,
      [documentId, model],
    );
    for (const r of rows) {
      const vec = JSON.parse(r.vec) as number[];
      if (vec.length === EMBED_DIMENSIONS) prior.set(r.content, { vec, hash: r.input_hash ?? null });
    }
  } catch {
    // No reuse this pass: every chunk is embedded again.
    prior.clear();
  }
  return prior;
}

/**
 * Index a code file on disk. Reads the file, calls indexCodeDocument.
 */
// Same rationale as indexer.ts MAX_INDEX_FILE_BYTES — tree-sitter
// parsing is synchronous CPU and would block the Bun event loop on a
// monolithic minified bundle. 5 MiB matches the markdown indexer cap.
const MAX_INDEX_CODE_FILE_BYTES = 5 * 1024 * 1024;

export async function indexCodeFile(
  storage: Storage,
  filePath: string,
  opts: { rereadGuard?: RereadGuard; embedCap?: EmbedSpendCap } = {},
): Promise<IndexCodeResult> {
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    throw new Error(`indexCodeFile: file not found: ${filePath}`);
  }
  if (stat.size > MAX_INDEX_CODE_FILE_BYTES) {
    throw new Error(
      `indexCodeFile: ${filePath} is ${stat.size} bytes — exceeds ` +
        `${MAX_INDEX_CODE_FILE_BYTES} byte cap (likely a vendored bundle)`,
    );
  }
  // Same canonicalization as indexFile, and the reason is sharper here: the
  // reported repro is `memrain index foo.ts`, and commands/index.ts routes any
  // recognised code extension to THIS function, so fixing only the markdown
  // path would have left the case that was actually filed.
  const sourcePath = normalizeSourcePath(filePath);
  // Same owner check as indexFile, before the file is read.
  const expectOwner = await guardLocalIndex(storage.raw(), sourcePath, opts.rereadGuard);
  const text = readFileSync(filePath, "utf8");
  return indexCodeDocument(storage, {
    sourcePath,
    text,
    mtimeMs: Math.floor(stat.mtimeMs),
    expectOwner,
  }, opts.embedCap ? { embedCap: opts.embedCap } : {});
}
