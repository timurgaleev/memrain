/**
 * Code indexer — turns a TypeScript / Python source file into rows in
 * `documents`, `chunks`, `entities`, `entity_mentions`. Graph-only:
 * no Titan calls, no rows in `embeddings`. (Q1 = `indexed_policy =
 * hashed-only`; flip later by computing vectors here and passing them
 * through to writeDocumentTransaction.)
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
import {
  qualifiedSymbolName,
  writeCodeEdgesForDocument,
  type CodeEdgeInput,
} from "./code-edges.ts";
import type { ExtractedEntity } from "./entities.ts";
import {
  writeDocumentTransaction,
  type ChunkWrite,
  type IndexTxResult,
} from "./indexer-tx.ts";
import { normalizeSourcePath } from "./indexer.ts";
import { guardLocalIndex, type RereadGuard } from "./sources.ts";
import { auditSecrets, guardSecrets, guardWrite } from "./secret-scan.ts";

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
}

export interface IndexCodeInput {
  sourcePath: string;
  text: string;
  mtimeMs?: number;
  /** Owning source; the document and every edge extracted from it carry it. */
  sourceId?: string | null;
  /** See DocumentWrite.expectOwner — the code sweep only. */
  expectOwner?: string | null;
}

/** `MEMRAIN_CODE_SECRET_SCAN=0` indexes source text unscanned. On by default. */
function codeSecretScanOn(): boolean {
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
  const id = docId(input.sourcePath);

  // File-level imports become code-ref entities attached to chunk 0
  // (mirrors how the markdown indexer attaches frontmatter tags only
  // to chunk 0 — they're document-level signals, not symbol-level).
  const fileImportRefs: ExtractedEntity[] = parsed.fileImports.map((imp) => ({
    type: "code-ref",
    name: imp.name,
    surfaceForm: `${input.sourcePath}:${imp.line}:<import>`,
  }));

  // Build per-symbol entity sets. Each chunk corresponds to one symbol.
  const chunkWrites: ChunkWrite[] = [];
  const codeEdges: CodeEdgeInput[] = [];
  for (let i = 0; i < parsed.symbols.length; i++) {
    const symbol = parsed.symbols[i]!;
    const entities = await extractCodeEntities({
      symbol,
      file: input.sourcePath,
      language,
    });
    // Prepend the file-level imports onto the FIRST symbol chunk so
    // `code-refs <name>` finds them.
    const merged = i === 0 ? [...fileImportRefs, ...entities] : entities;
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
  if (parsed.symbols.length === 0 && text.trim().length > 0) {
    const windows = chunkPlainText(text);
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
  }

  // A file that reached here with nothing to write is BLANK (0 bytes or only
  // whitespace) — the fallback above covers every other symbol-less case. Mark
  // it so orphans-purge can tell "legitimately empty" from "corrupt index"; the
  // two are indistinguishable from the document row alone, and re-indexing an
  // empty file produces the same zero chunks forever.
  const frontmatter: Record<string, unknown> = { language, kind: "code" };
  if (chunkWrites.length === 0) frontmatter[EMPTY_SOURCE_KEY] = true;

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
      embeddingModel: null,
      chunkerVersion: CODE_CHUNKER_VERSION,
      sourceId: input.sourceId ?? null,
      ...(input.expectOwner !== undefined ? { expectOwner: input.expectOwner } : {}),
    },
    chunkWrites,
  );

  // Persist call edges (best-effort — the chunks/graph already committed; a
  // failure here just leaves edges for the next reindex/cycle to rebuild).
  if (codeEdges.length > 0) {
    try {
      await writeCodeEdgesForDocument(storage, id, codeEdges);
    } catch (e) {
      console.error(
        `[code-edges] failed to write edges for ${input.sourcePath}:`,
        e instanceof Error ? e.message : e,
      );
    }
  }

  return {
    ...result,
    hasParseError: parsed.hasParseError,
    language,
    skipped: false,
  };
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
  opts: { rereadGuard?: RereadGuard } = {},
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
  });
}
