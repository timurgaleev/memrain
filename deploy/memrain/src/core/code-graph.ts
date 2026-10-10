/**
 * Code call-graph reads over `entity_mentions` — the engine-level core behind
 * the `code_callers` / `code_callees` MCP tools. Deterministic, no LLM.
 *
 * Mirrors the call-graph entity model from commands/code.ts: a symbol's
 * mentions are keyed by `entityId(<type>, <name>)`, where the type is
 * `code-caller` (who calls NAME) or `code-callee` (what the symbol at
 * file:line calls). `code_callees` is two-phase: resolve the innermost
 * code-def covering file:line, then look up that symbol's callees.
 *
 * ponytail: the SQL is duplicated from commands/code.ts rather than shared —
 * runCode is a console-printing CLI with its own exitCode side effects and a
 * dedicated test; lifting it would churn that tested surface for ~25 lines.
 * Unify if a third caller appears.
 */
import type { Engine } from "./engine/interface.ts";
import { entityId, type EntityType } from "./entities.ts";
import { andSourceScope, isNoGrant, normalizeScope, type SourceScope } from "./source-scope.ts";
import { codeSweepCovers, codeSweepInProgress } from "./sweep-code.ts";

export interface CodeMention {
  surface_form: string;
  chunk_id: string;
  document_id: string;
  source_path: string;
  /** `chunks.language` of the mentioning chunk. */
  language: string | null;
  /** Symbol kind of the mentioning chunk (function, method, class, ...). */
  kind: string | null;
  start_line: number | null;
  end_line: number | null;
  /** The chunk's first SNIPPET_CHARS characters. */
  snippet: string;
}

/** Characters of chunk text a mention carries — enough to read a signature. */
const SNIPPET_CHARS = 500;

/**
 * Why a code lookup came back empty. `ready` means the index is built and the
 * symbol really is absent; the other states mean the answer cannot be trusted.
 */
export type CodeIndexState = "not_built" | "indexing" | "no_symbols" | "ready";

export interface CodeIndexReadiness {
  state: CodeIndexState;
  /** Live code documents in the caller's scope, saturating at READINESS_COUNT_CAP + 1. */
  code_documents: number;
  /** Rows of the graph the tool reads, in the caller's scope, same saturation. */
  symbols: number;
}

/**
 * Which graph a tool reads: the mention-based tools look up one entity type in
 * `entity_mentions`; `code_blast`/`code_flow` walk `code_edges_symbol`. The two
 * are written by the same indexer but can drift apart (the edges survive a
 * mention wipe), so readiness counts the one the caller actually queried.
 */
export type CodeReadinessGraph = "code-def" | "code-ref" | "code-caller" | "code-callee" | "edges";

// Readiness only needs "zero or not"; the cap keeps the count cheap on a large
// corpus while still giving the caller a rough size.
const READINESS_COUNT_CAP = 10_000;

export interface CodeGraphResult {
  query: { type: EntityType; name: string };
  count: number;
  mentions: CodeMention[];
  /** Present only when `count` is 0. */
  readiness?: CodeIndexReadiness;
}

export interface CodeCalleesResult extends CodeGraphResult {
  /** The code-def symbol resolved at the requested file:line (null = none). */
  resolved_symbol: string | null;
}

/** "<path>:<line>" — line is the LAST numeric segment so a colon in the path
 *  (rare, Windows) doesn't poison the parse. */
export function parsePathLine(
  target: string,
): { file: string; line: number } | null {
  const lastColon = target.lastIndexOf(":");
  if (lastColon < 0) return null;
  const file = target.slice(0, lastColon);
  const lineStr = target.slice(lastColon + 1);
  const line = Number(lineStr);
  if (!Number.isInteger(line) || line < 1) return null;
  if (file.length === 0) return null;
  return { file, line };
}

function clampLimit(limit: number | undefined): number {
  return typeof limit === "number" && limit >= 1 && limit <= 1000
    ? Math.floor(limit)
    : 200;
}


/**
 * How far the code index is built for the caller's scope, counted over the
 * graph `graph` names. A caller granted nothing gets `not_built` without a
 * query, so it learns nothing about other tenants' code.
 */
export async function codeIndexReadiness(
  engine: Engine,
  sourceIds?: SourceScope,
  graph: CodeReadinessGraph = "code-def",
): Promise<CodeIndexReadiness> {
  if (isNoGrant(sourceIds)) {
    return { state: "not_built", code_documents: 0, symbols: 0 };
  }
  const params: unknown[] = [READINESS_COUNT_CAP + 1];
  const docScope = andSourceScope("d.source_id", sourceIds, params);
  let symbolsSql: string;
  if (graph === "edges") {
    // The walk filters on the edge's own source_id, so readiness does too.
    const edgeScope = andSourceScope("e.source_id", sourceIds, params);
    symbolsSql = `SELECT 1 FROM code_edges_symbol e
             JOIN chunks c ON c.id = e.from_chunk_id
             JOIN documents d ON d.id = c.document_id
            WHERE d.deleted_at IS NULL${edgeScope}`;
  } else {
    // Driven from entities(type, name)'s unique index, then the mention index —
    // the same rows mentionsFor reads by entity_id.
    params.push(graph);
    symbolsSql = `SELECT 1 FROM entities e
             JOIN entity_mentions em ON em.entity_id = e.id
             JOIN chunks c ON c.id = em.chunk_id
             JOIN documents d ON d.id = c.document_id
            WHERE e.type = $${params.length} AND d.deleted_at IS NULL${docScope}`;
  }
  const r = await engine.query<{ code_documents: number | string; symbols: number | string }>(
    `SELECT
       (SELECT count(*) FROM (
          SELECT 1 FROM documents d
           WHERE d.frontmatter->>'kind' = 'code' AND d.deleted_at IS NULL${docScope}
           LIMIT $1) docs) AS code_documents,
       (SELECT count(*) FROM (
          ${symbolsSql}
           LIMIT $1) syms) AS symbols`,
    params,
  );
  const code_documents = Number(r.rows[0]?.code_documents ?? 0);
  const symbols = Number(r.rows[0]?.symbols ?? 0);
  let state: CodeIndexState;
  if (await sweepCoversScope(engine, sourceIds)) state = "indexing";
  else if (code_documents === 0) state = "not_built";
  else if (symbols === 0) state = "no_symbols";
  else state = "ready";
  return { state, code_documents, symbols };
}

/**
 * A running sweep only makes a tenant's answer untrustworthy when it walks a
 * root that tenant's sources own; the operator sees every sweep.
 */
async function sweepCoversScope(engine: Engine, sourceIds: SourceScope): Promise<boolean> {
  if (!codeSweepInProgress()) return false;
  const sources = normalizeScope(sourceIds);
  if (sources === undefined) return true;
  if (sources.length === 0) return false;
  const r = await engine.query<{ path_prefix: string | null }>(
    "SELECT path_prefix FROM sources WHERE id = ANY($1::text[])",
    [sources],
  );
  const prefixes = r.rows
    .map((row) => row.path_prefix)
    .filter((p): p is string => typeof p === "string" && p.length > 0);
  return codeSweepCovers(prefixes);
}

async function withReadiness<T extends CodeGraphResult>(
  engine: Engine,
  result: T,
  graph: CodeReadinessGraph,
  sourceIds?: string[],
): Promise<T> {
  if (result.count > 0) return result;
  return { ...result, readiness: await codeIndexReadiness(engine, sourceIds, graph) };
}

interface MentionFilter {
  /** Only mentions from chunks of this language. */
  lang?: string;
  /** Only mentions from the chunk defining this qualified symbol. */
  symbolQualified?: string;
}

async function mentionsFor(
  engine: Engine,
  type: "code-def" | "code-ref" | "code-caller" | "code-callee",
  name: string,
  limit: number,
  sourceIds?: string[],
  filter: MentionFilter = {},
): Promise<CodeGraphResult> {
  const eid = entityId(type, name);
  const params: unknown[] = [eid, limit, SNIPPET_CHARS];
  // Scope on the joined documents.source_id. NULL (unclassified) rows are
  // excluded fail-closed: a tenant never sees an unclassified legacy mention.
  const sources = normalizeScope(sourceIds);
  let sourceFilter = "";
  if (sources) {
    params.push(sources);
    sourceFilter = ` AND d.source_id = ANY($${params.length}::text[])`;
  }
  if (filter.lang) {
    params.push(filter.lang);
    sourceFilter += ` AND c.language = $${params.length}`;
  }
  if (filter.symbolQualified) {
    params.push(filter.symbolQualified);
    sourceFilter += ` AND c.symbol_name_qualified = $${params.length}`;
  }
  const r = await engine.query<CodeMention>(
    `SELECT em.surface_form, em.chunk_id, c.document_id, d.source_path,
            c.language, c.symbol_type AS kind, c.start_line, c.end_line,
            left(c.content, $3) AS snippet
       FROM entity_mentions em
       JOIN chunks c ON c.id = em.chunk_id
       JOIN documents d ON d.id = c.document_id
      WHERE em.entity_id = $1 AND d.deleted_at IS NULL${sourceFilter}
      ORDER BY d.source_path, c.start_line NULLS FIRST
      LIMIT $2`,
    params,
  );
  return withReadiness(
    engine,
    { query: { type, name }, count: r.rows.length, mentions: r.rows },
    type,
    sourceIds,
  );
}

/** Who calls `name` — the `code-caller` mentions for a symbol. */
export async function codeCallers(
  engine: Engine,
  name: string,
  limit?: number,
  sourceIds?: string[],
  lang?: string,
): Promise<CodeGraphResult> {
  return mentionsFor(engine, "code-caller", name, clampLimit(limit), sourceIds, { lang });
}

/** Where `name` is defined — the `code-def` mentions for a symbol (by bare
 *  name). Complements `resolveSymbolAt` (file:line → def) with def-by-name. */
export async function codeDefs(
  engine: Engine,
  name: string,
  limit?: number,
  sourceIds?: string[],
  lang?: string,
): Promise<CodeGraphResult> {
  return mentionsFor(engine, "code-def", name, clampLimit(limit), sourceIds, { lang });
}

/** All references to `name` — the `code-ref` mentions (imports, type uses,
 *  non-call references). Complements `codeCallers` for proof-grade tracing. */
export async function codeRefs(
  engine: Engine,
  name: string,
  limit?: number,
  sourceIds?: string[],
  lang?: string,
): Promise<CodeGraphResult> {
  return mentionsFor(engine, "code-ref", name, clampLimit(limit), sourceIds, { lang });
}

/** Resolve the innermost-enclosing code-def symbol covering file:line. */
export async function resolveSymbolAt(
  engine: Engine,
  file: string,
  line: number,
  sourceIds?: string[],
): Promise<string | null> {
  const params: unknown[] = [file, line];
  const sources = normalizeScope(sourceIds);
  let sourceFilter = "";
  if (sources) {
    params.push(sources);
    sourceFilter = ` AND d.source_id = ANY($${params.length}::text[])`;
  }
  const r = await engine.query<{ name: string }>(
    `SELECT e.name
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
       JOIN entity_mentions em ON em.chunk_id = c.id
       JOIN entities e ON e.id = em.entity_id
      WHERE d.source_path = $1
        AND d.deleted_at IS NULL
        AND $2 BETWEEN c.start_line AND c.end_line
        AND e.type = 'code-def'${sourceFilter}
      ORDER BY (c.end_line - c.start_line) ASC
      LIMIT 1`,
    params,
  );
  return r.rows[0]?.name ?? null;
}

/**
 * What a symbol calls — the `code-callee` mentions. `target` is `<path>:<line>`
 * (the innermost symbol covering that line) or a symbol name, bare or
 * qualified (`Repo::save` narrows to that definition's own call sites).
 */
export async function codeCallees(
  engine: Engine,
  target: string,
  limit?: number,
  sourceIds?: string[],
  lang?: string,
): Promise<CodeCalleesResult> {
  const parsed = parsePathLine(target);
  if (!parsed) {
    const name = target.trim();
    if (name.length === 0 || /\s/.test(name)) {
      throw new Error(
        `code_callees: invalid target '${target}' — expected '<path>:<line>' or a symbol name`,
      );
    }
    // code-callee mentions are keyed by the bare symbol name.
    const bare = name.split("::").pop()!;
    const res = await mentionsFor(engine, "code-callee", bare, clampLimit(limit), sourceIds, {
      lang,
      ...(name.includes("::") ? { symbolQualified: name } : {}),
    });
    return { ...res, query: { type: "code-callee", name }, resolved_symbol: name };
  }
  const sym = await resolveSymbolAt(engine, parsed.file, parsed.line, sourceIds);
  if (!sym) {
    return withReadiness(
      engine,
      {
        query: { type: "code-callee", name: target },
        count: 0,
        mentions: [],
        resolved_symbol: null,
      },
      "code-def",
      sourceIds,
    );
  }
  const res = await mentionsFor(engine, "code-callee", sym, clampLimit(limit), sourceIds, { lang });
  return { ...res, resolved_symbol: sym };
}
