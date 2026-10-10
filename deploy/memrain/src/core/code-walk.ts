/**
 * Recursive code call-graph walks over `code_edges_symbol` (migration 041) —
 * the engine core behind the `code_blast` (transitive callers / blast radius)
 * and `code_flow` (transitive callees / execution flow) MCP tools.
 * Deterministic, no LLM.
 *
 * Single-hop reads (`code_callers`/`code_callees`) live in code-graph.ts over
 * `entity_mentions`; this module walks the chunk-anchored, qualified-name edge
 * table so a multi-hop traversal resolves a SPECIFIC caller symbol per hop
 * rather than aliasing same-named methods. BFS bounded by depth + max_nodes
 * caps with cycle detection via a visited-set.
 *
 * Edges store the callee as written at the call site — `this.repo.save()` is
 * an edge to bare `save` — so a hop matches a frontier symbol by its qualified
 * name AND its bare last segment. An edge the resolve-symbol-edges phase tied to
 * one definition (or to a candidate list) only counts for that definition.
 * Every hop reads live, visible documents only, and stays in the start
 * symbol's language so a same-named function in another language is not
 * reported as a caller.
 */
import type { Engine } from "./engine/interface.ts";
import { andSourceScope, normalizeScope } from "./source-scope.ts";
import { codeIndexReadiness, type CodeIndexReadiness } from "./code-graph.ts";
import { visibilityClause } from "./visibility.ts";
import { nearest } from "./did-you-mean.ts";

export type WalkDirection = "callers" | "callees";

export type SinkKind =
  | "db_call"
  | "http_call"
  | "file_io"
  | "process_exec"
  | "unknown";

export interface WalkNode {
  symbol: string;
  /**
   * Origin chunk of the edge — direction-dependent:
   *   callers: the caller's own chunk (navigable to the calling symbol).
   *   callees: the CALL-SITE chunk in the parent symbol. `def_chunk_id` is the
   *     callee's definition when it is known.
   */
  chunk_id?: string;
  /** Definition chunk of `symbol`, when the edge could be tied to one. */
  def_chunk_id?: string;
  /**
   * True when the edge is tied to a specific definition: resolved by the
   * resolve-symbol-edges phase, or (callees) the only live definition of that
   * name in the caller's language.
   */
  resolved?: boolean;
  sink_kind?: SinkKind;
}

export interface DepthGroup {
  depth: number;
  nodes: WalkNode[];
  /** confidence = 1 / (1 + 0.3 * depth), clamped to [0.05, 1.0] */
  confidence: number;
}

export type WalkResult =
  | {
      result: "ok";
      depth_groups: DepthGroup[];
      cycles_detected: boolean;
      truncation: "none" | "max_nodes" | "depth_cap" | "both";
      terminal_nodes?: { symbol: string; sink_kind: SinkKind }[];
      /** Present only when `depth_groups` is empty. */
      readiness?: CodeIndexReadiness;
    }
  | {
      result: "not_found";
      did_you_mean: { symbol_qualified: string }[];
      readiness: CodeIndexReadiness;
    }
  | { result: "ambiguous"; candidates: { symbol_qualified: string }[] };

export interface WalkOpts {
  direction: WalkDirection;
  /** Hop cap. Default 5 (callers), 8 (callees). */
  depth?: number;
  /** Total-node cap. Default 200. */
  maxNodes?: number;
  /** Optional tenant scope — fail-closed against `code_edges_symbol.source_id`. */
  sourceIds?: string[];
  /** Skip bare-name disambiguation; treat `symbol` as an exact qualified name. */
  exact?: boolean;
  /**
   * Restrict the walk to one `chunks.language`. Unset → the start symbol's
   * language when all of its definitions share one, else no filter.
   */
  lang?: string;
}

// --- sink classification ---

type SinkTable = Record<Exclude<SinkKind, "unknown">, readonly string[]>;

// Patterns match the bare last segment of the callee as written. Bare verbs a
// map, cache or array also answers to (get/put/read/write/open/delete/update/
// query/request) are left out: with no receiver type they tag `cache.get()`
// as an HTTP call far more often than they find a real sink.
const SINKS_TS: SinkTable = {
  db_call: ["execute", "transaction", "insert", "select", "findOne", "findMany", "save", "commit"],
  http_call: ["fetch", "axios", "post", "patch"],
  file_io: [
    "readFile", "readFileSync", "writeFile", "writeFileSync",
    "createReadStream", "createWriteStream",
  ],
  process_exec: ["spawn", "spawnSync", "exec", "execSync", "execFile"],
};

const SINKS_PY: SinkTable = {
  db_call: ["execute", "executemany", "insert", "select", "save", "commit"],
  http_call: ["urlopen", "post", "patch"],
  file_io: ["read_text", "write_text", "read_bytes", "write_bytes"],
  process_exec: ["system", "Popen", "check_output", "check_call"],
};

const SINKS_GO: SinkTable = {
  db_call: ["Exec", "ExecContext", "QueryRow", "QueryContext", "QueryRowContext", "BeginTx", "Commit"],
  http_call: ["PostForm", "NewRequest", "NewRequestWithContext"],
  file_io: ["ReadFile", "WriteFile", "OpenFile", "ReadDir"],
  process_exec: ["Command", "CommandContext"],
};

const SINK_KINDS = ["db_call", "http_call", "file_io", "process_exec"] as const;

const SINKS_BY_LANGUAGE: Record<string, SinkTable> = {
  typescript: SINKS_TS,
  tsx: SINKS_TS,
  python: SINKS_PY,
  go: SINKS_GO,
};

const NO_SINKS: SinkTable = { db_call: [], http_call: [], file_io: [], process_exec: [] };

/** Every language's table at once — for a callee whose language is unknown. */
const SINKS_ANY: SinkTable = Object.fromEntries(
  SINK_KINDS.map((k) => [
    k,
    Array.from(new Set([SINKS_TS, SINKS_PY, SINKS_GO].flatMap((t) => t[k]))),
  ]),
) as unknown as SinkTable;

/** Bare last segment of a qualified symbol — split on `::` then `.`. */
function lastSegment(callee: string): string {
  const afterColons = callee.includes("::")
    ? (callee.split("::").pop() ?? callee)
    : callee;
  return afterColons.includes(".")
    ? (afterColons.split(".").pop() ?? afterColons)
    : afterColons;
}

/**
 * Classify a callee to a sink kind (or 'unknown'). `lang` is the language of
 * the calling code; null/undefined checks every language's names.
 */
export function classifySink(callee: string, lang?: string | null): SinkKind {
  const bare = lastSegment(callee);
  const table = lang == null ? SINKS_ANY : (SINKS_BY_LANGUAGE[lang] ?? NO_SINKS);
  for (const kind of SINK_KINDS) {
    if (table[kind].includes(bare)) return kind;
  }
  return "unknown";
}

function clampConfidence(depth: number): number {
  const c = 1.0 / (1 + 0.3 * depth);
  return Math.max(0.05, Math.min(1.0, c));
}

/** Upper bound on edge rows one batched hop reads. */
const HOP_ROW_CAP = 5000;

interface WalkScope {
  sources: string[] | undefined;
  lang: string | null;
}

/** ` AND c.language = $n` when the walk is pinned to a language. */
function andLanguage(col: string, lang: string | null, params: unknown[]): string {
  if (lang === null) return "";
  params.push(lang);
  return ` AND ${col} = $${params.length}`;
}

interface DefChunk {
  id: string;
  symbol_name: string;
  symbol_name_qualified: string;
  language: string | null;
}

/** Live definition chunks whose qualified name is one of `symbols`. */
async function defsByQualified(
  engine: Engine,
  symbols: string[],
  scope: WalkScope,
): Promise<Map<string, DefChunk[]>> {
  const params: unknown[] = [symbols];
  const lang = andLanguage("c.language", scope.lang, params);
  const src = andSourceScope("d.source_id", scope.sources, params);
  const r = await engine.query<DefChunk>(
    `SELECT c.id, c.symbol_name, c.symbol_name_qualified, c.language
       FROM chunks c JOIN documents d ON d.id = c.document_id
      WHERE c.symbol_name_qualified = ANY($1::text[])
        AND ${visibilityClause("d")}${lang}${src}
      ORDER BY c.id`,
    params,
  );
  const out = new Map<string, DefChunk[]>();
  for (const row of r.rows) {
    const arr = out.get(row.symbol_name_qualified) ?? [];
    arr.push(row);
    out.set(row.symbol_name_qualified, arr);
  }
  return out;
}

/** Live definition chunks whose bare name is one of `names`. */
async function defsByBare(
  engine: Engine,
  names: string[],
  scope: WalkScope,
): Promise<Map<string, DefChunk[]>> {
  const out = new Map<string, DefChunk[]>();
  if (names.length === 0) return out;
  const params: unknown[] = [names];
  const lang = andLanguage("c.language", scope.lang, params);
  const src = andSourceScope("d.source_id", scope.sources, params);
  const r = await engine.query<DefChunk>(
    `SELECT c.id, c.symbol_name, c.symbol_name_qualified, c.language
       FROM chunks c JOIN documents d ON d.id = c.document_id
      WHERE c.symbol_name = ANY($1::text[])
        AND c.symbol_name_qualified IS NOT NULL
        AND ${visibilityClause("d")}${lang}${src}
      ORDER BY c.id
      LIMIT ${HOP_ROW_CAP}`,
    params,
  );
  for (const row of r.rows) {
    const arr = out.get(row.symbol_name) ?? [];
    arr.push(row);
    out.set(row.symbol_name, arr);
  }
  return out;
}

interface HopNode {
  parent: string;
  node: WalkNode;
  /** Language of the calling chunk — the sink classifier's table. */
  language: string | null;
}

interface CallerRow {
  target: string;
  next_symbol: string;
  chunk_id: string;
  edge_metadata: unknown;
}

function edgeMeta(raw: unknown): { resolved_chunk_id?: string; candidates?: string[] } {
  const v = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  if (!v || typeof v !== "object") return {};
  const o = v as Record<string, unknown>;
  return {
    ...(typeof o["resolved_chunk_id"] === "string" ? { resolved_chunk_id: o["resolved_chunk_id"] } : {}),
    ...(Array.isArray(o["candidates"])
      ? { candidates: o["candidates"].filter((c): c is string => typeof c === "string") }
      : {}),
  };
}

/** Callers of every frontier symbol in one edge read. */
async function callersHop(
  engine: Engine,
  frontier: string[],
  limit: number,
  scope: WalkScope,
): Promise<HopNode[]> {
  const keys = Array.from(new Set(frontier.flatMap((s) => [s, lastSegment(s)])));
  const defs = await defsByQualified(engine, frontier, scope);
  const params: unknown[] = [keys];
  const lang = andLanguage("c.language", scope.lang, params);
  const src = andSourceScope("e.source_id", scope.sources, params);
  params.push(limit);
  const r = await engine.query<CallerRow>(
    `SELECT DISTINCT e.to_symbol_qualified AS target,
            e.from_symbol_qualified AS next_symbol,
            e.from_chunk_id AS chunk_id,
            e.edge_metadata
       FROM code_edges_symbol e
       JOIN chunks c ON c.id = e.from_chunk_id
       JOIN documents d ON d.id = c.document_id
      WHERE e.to_symbol_qualified = ANY($1::text[])
        AND e.from_symbol_qualified IS NOT NULL
        AND ${visibilityClause("d")}${lang}${src}
      ORDER BY e.from_chunk_id, e.to_symbol_qualified
      LIMIT $${params.length}`,
    params,
  );
  const out: HopNode[] = [];
  for (const parent of frontier) {
    const defIds = new Set((defs.get(parent) ?? []).map((d) => d.id));
    const bare = lastSegment(parent);
    for (const row of r.rows) {
      if (row.target !== parent && row.target !== bare) continue;
      const meta = edgeMeta(row.edge_metadata);
      if (meta.resolved_chunk_id !== undefined) {
        // With no known definition only the exact name can vouch for the edge.
        if (defIds.size > 0 ? !defIds.has(meta.resolved_chunk_id) : row.target !== parent) continue;
      } else if (meta.candidates !== undefined && defIds.size > 0) {
        if (!meta.candidates.some((c) => defIds.has(c))) continue;
      }
      out.push({
        parent,
        language: null,
        node: {
          symbol: row.next_symbol,
          chunk_id: row.chunk_id,
          def_chunk_id: row.chunk_id,
          resolved: meta.resolved_chunk_id !== undefined,
        },
      });
    }
  }
  return out;
}

interface CalleeRow {
  parent: string;
  target: string;
  chunk_id: string;
  language: string | null;
  resolved_chunk_id: string | null;
  resolved_symbol: string | null;
}

/** Callees of every frontier symbol in one edge read. */
async function calleesHop(
  engine: Engine,
  frontier: string[],
  limit: number,
  scope: WalkScope,
): Promise<HopNode[]> {
  const params: unknown[] = [frontier];
  const lang = andLanguage("c.language", scope.lang, params);
  const src = andSourceScope("e.source_id", scope.sources, params);
  params.push(limit);
  const r = await engine.query<CalleeRow>(
    `SELECT DISTINCT e.from_symbol_qualified AS parent,
            e.to_symbol_qualified AS target,
            e.from_chunk_id AS chunk_id,
            c.language,
            rc.id AS resolved_chunk_id,
            rc.symbol_name_qualified AS resolved_symbol
       FROM code_edges_symbol e
       JOIN chunks c ON c.id = e.from_chunk_id
       JOIN documents d ON d.id = c.document_id
       LEFT JOIN chunks rc ON rc.id = e.edge_metadata->>'resolved_chunk_id'
      WHERE e.from_symbol_qualified = ANY($1::text[])
        AND ${visibilityClause("d")}${lang}${src}
      ORDER BY e.from_chunk_id, e.to_symbol_qualified
      LIMIT $${params.length}`,
    params,
  );
  // An unresolved callee still names a definition when exactly one live chunk
  // in the caller's language defines that name (the calling chunk excluded, as
  // the resolve phase does) — that is what lets a method chain keep walking.
  const unresolved = r.rows.filter((row) => !row.resolved_symbol).map((row) => lastSegment(row.target));
  const byBare = await defsByBare(engine, Array.from(new Set(unresolved)), scope);
  const out: HopNode[] = [];
  for (const parent of frontier) {
    for (const row of r.rows) {
      if (row.parent !== parent) continue;
      if (row.resolved_symbol && row.resolved_chunk_id) {
        out.push({
          parent,
          language: row.language,
          node: {
            symbol: row.resolved_symbol,
            chunk_id: row.chunk_id,
            def_chunk_id: row.resolved_chunk_id,
            resolved: true,
          },
        });
        continue;
      }
      const defs = (byBare.get(lastSegment(row.target)) ?? []).filter(
        (d) => d.id !== row.chunk_id && d.language === row.language,
      );
      const unique = defs.length === 1 ? defs[0]! : null;
      out.push({
        parent,
        language: row.language,
        node: unique
          ? { symbol: unique.symbol_name_qualified, chunk_id: row.chunk_id, def_chunk_id: unique.id, resolved: true }
          : { symbol: row.target, chunk_id: row.chunk_id, resolved: false },
      });
    }
  }
  return out;
}

function hop(
  engine: Engine,
  frontier: string[],
  direction: WalkDirection,
  limit: number,
  scope: WalkScope,
): Promise<HopNode[]> {
  return direction === "callers"
    ? callersHop(engine, frontier, limit, scope)
    : calleesHop(engine, frontier, limit, scope);
}

/** Resolve a bare name to qualified candidate symbols via live `chunks`. */
async function disambiguate(
  engine: Engine,
  bare: string,
  scope: WalkScope,
): Promise<string[]> {
  const params: unknown[] = [bare];
  const lang = andLanguage("c.language", scope.lang, params);
  const src = andSourceScope("d.source_id", scope.sources, params);
  const r = await engine.query<{ symbol_name_qualified: string }>(
    `SELECT DISTINCT c.symbol_name_qualified
       FROM chunks c JOIN documents d ON d.id = c.document_id
      WHERE c.symbol_name_qualified IS NOT NULL
        AND (c.symbol_name = $1 OR c.symbol_name_qualified = $1)
        AND ${visibilityClause("d")}${lang}${src}
      ORDER BY c.symbol_name_qualified
      LIMIT 25`,
    params,
  );
  return r.rows.map((row) => row.symbol_name_qualified);
}

const SUGGESTION_CAP = 5;

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Near names for an unknown symbol: live definitions sharing its first three
 * characters, the closest by edit distance first.
 */
async function suggestSymbols(
  engine: Engine,
  bare: string,
  scope: WalkScope,
): Promise<{ symbol_qualified: string }[]> {
  if (bare.length === 0) return [];
  const params: unknown[] = [`${escapeLike(bare.slice(0, 3))}%`];
  const lang = andLanguage("c.language", scope.lang, params);
  const src = andSourceScope("d.source_id", scope.sources, params);
  const r = await engine.query<{ symbol_name: string; symbol_name_qualified: string }>(
    `SELECT DISTINCT c.symbol_name, c.symbol_name_qualified
       FROM chunks c JOIN documents d ON d.id = c.document_id
      WHERE c.symbol_name_qualified IS NOT NULL
        AND c.symbol_name ILIKE $1 ESCAPE '\\'
        AND ${visibilityClause("d")}${lang}${src}
      ORDER BY c.symbol_name_qualified
      LIMIT 200`,
    params,
  );
  const close = nearest(bare, r.rows.map((row) => row.symbol_name));
  const lower = bare.toLowerCase();
  const rank = (name: string): number =>
    name === close ? 0 : name.toLowerCase().startsWith(lower) ? 1 : 2;
  return [...r.rows]
    .sort((a, b) => rank(a.symbol_name) - rank(b.symbol_name) ||
      a.symbol_name_qualified.length - b.symbol_name_qualified.length)
    .slice(0, SUGGESTION_CAP)
    .map((row) => ({ symbol_qualified: row.symbol_name_qualified }));
}

/** The language to pin the walk to: the caller's, else the start symbol's one. */
async function walkLanguage(
  engine: Engine,
  start: string,
  opts: WalkOpts,
  sources: string[] | undefined,
): Promise<string | null> {
  if (opts.lang) return opts.lang;
  const defs = await defsByQualified(engine, [start], { sources, lang: null });
  const langs = new Set((defs.get(start) ?? []).map((d) => d.language));
  if (langs.size !== 1) return null;
  return [...langs][0] ?? null;
}

/**
 * BFS recursive walk over the code edge graph. Returns the depth-grouped
 * envelope shared by `code_blast` (callers) and `code_flow` (callees).
 */
export async function runRecursiveWalk(
  engine: Engine,
  symbol: string,
  opts: WalkOpts,
): Promise<WalkResult> {
  const depthCap = opts.depth ?? (opts.direction === "callers" ? 5 : 8);
  const maxNodes = opts.maxNodes ?? 200;
  const sources = normalizeScope(opts.sourceIds);
  const lookupScope: WalkScope = { sources, lang: opts.lang ?? null };

  let start = symbol;
  if (!opts.exact && !symbol.includes("::")) {
    const matches = await disambiguate(engine, symbol, lookupScope);
    if (matches.length === 0) {
      // No qualified def — fall back to the bare name as-is (edges may be
      // written bare at top level) rather than a hard not_found.
      const bareHop = await hop(engine, [symbol], opts.direction, 1, lookupScope);
      if (bareHop.length === 0) {
        return {
          result: "not_found",
          did_you_mean: await suggestSymbols(engine, symbol, lookupScope),
          readiness: await codeIndexReadiness(engine, opts.sourceIds, "edges"),
        };
      }
    } else if (matches.length > 1) {
      return {
        result: "ambiguous",
        candidates: matches.map((m) => ({ symbol_qualified: m })),
      };
    } else {
      start = matches[0]!;
    }
  }
  const scope: WalkScope = { sources, lang: await walkLanguage(engine, start, opts, sources) };

  const visited = new Set<string>([start]);
  const depthGroups: DepthGroup[] = [];
  let cyclesDetected = false;
  let truncation: "none" | "max_nodes" | "depth_cap" | "both" = "none";
  let totalNodes = 0;
  const terminalNodes: { symbol: string; sink_kind: SinkKind }[] = [];

  let frontier = [start];
  for (let d = 1; d <= depthCap; d++) {
    const nextFrontier: string[] = [];
    const nodesThisDepth: WalkNode[] = [];

    // Rows are filtered per parent after the read, so over-fetch the remaining
    // node budget per frontier symbol, bounded by HOP_ROW_CAP.
    const remaining = Math.max(1, maxNodes - totalNodes);
    const limit = Math.min(HOP_ROW_CAP, remaining * frontier.length * 2);
    const edges = await hop(engine, frontier, opts.direction, limit, scope);
    for (const e of edges) {
      const next = e.node.symbol;
      if (!next || next === e.parent) continue;
      if (visited.has(next)) {
        cyclesDetected = true;
        continue;
      }
      if (totalNodes >= maxNodes) {
        truncation = truncation === "depth_cap" ? "both" : "max_nodes";
        break;
      }
      visited.add(next);
      totalNodes += 1;
      const node: WalkNode = { ...e.node };
      // A callee tied to a definition is the project's own code and the walk
      // continues through it; only an unresolved name can be an external sink.
      if (opts.direction === "callees" && !node.resolved) {
        const kind = classifySink(next, e.language);
        if (kind !== "unknown") {
          node.sink_kind = kind;
          terminalNodes.push({ symbol: next, sink_kind: kind });
        }
      }
      nodesThisDepth.push(node);
      nextFrontier.push(next);
    }

    if (nodesThisDepth.length > 0) {
      depthGroups.push({
        depth: d,
        nodes: nodesThisDepth,
        confidence: clampConfidence(d),
      });
    }
    if (truncation === "max_nodes" || truncation === "both") break;
    if (nextFrontier.length === 0) break;
    // Past the max_nodes break, truncation is "none" here.
    if (d === depthCap && nextFrontier.length > 0) {
      truncation = "depth_cap";
    }
    frontier = nextFrontier;
  }

  const result: Extract<WalkResult, { result: "ok" }> = {
    result: "ok",
    depth_groups: depthGroups,
    cycles_detected: cyclesDetected,
    truncation,
  };
  if (opts.direction === "callees" && terminalNodes.length > 0) {
    result.terminal_nodes = terminalNodes;
  }
  // A qualified or `exact` start skips disambiguation, so an empty walk cannot
  // tell "no callers" from "graph not built yet" without the readiness state.
  if (depthGroups.length === 0) {
    result.readiness = await codeIndexReadiness(engine, opts.sourceIds, "edges");
  }
  return result;
}
