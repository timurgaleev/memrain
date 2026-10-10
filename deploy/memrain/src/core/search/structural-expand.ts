/**
 * Structural two-pass retrieval expansion — `near_symbol` + `walk_depth`.
 *
 * Given an anchor set of chunks (from the keyword/vector/RRF pass and/or a
 * `near_symbol` qualified-name lookup), walk the code call graph up to
 * `walkDepth` hops over `code_edges_symbol` (migration 041) and collect
 * structural neighbors. Each neighbor scores `anchorScore * 1/(1+hop)`.
 *
 * Default OFF — inert unless `walkDepth > 0` or `nearSymbol` is set. The live
 * corpus carries ~0 code chunks, so this is dormant until code is ingested;
 * it adds candidates, never removes them, so a brain with no edges is a no-op.
 *
 * memrain's edge model is SYMBOL-anchored (no resolved `to_chunk_id` on the edge
 * row), so neighbors resolve differently per direction:
 *   - callers: `to_symbol_qualified` is sym or its bare last segment → the
 *     caller IS `from_chunk_id`.
 *   - callees: `from_symbol_qualified = sym` → the callee is a symbol name,
 *     resolved to its definition chunk via `chunks.symbol_name_qualified`.
 *
 * Caps: depth ≤ 2, ≤ 50 neighbors per hop.
 */
import type { Engine } from "../engine/interface.ts";
import { andSourceScope, normalizeScope } from "../source-scope.ts";

const MAX_WALK_DEPTH = 2;
const NEIGHBOR_CAP_PER_HOP = 50;
/** Frontier width carried into the next hop — bounds total graph fan-out. */
const FRONTIER_CAP = NEIGHBOR_CAP_PER_HOP;
/** Hard cap on fresh neighbor chunks admitted per hop (highest-scored kept). */
const MAX_CANDIDATES_PER_HOP = NEIGHBOR_CAP_PER_HOP * 4;

export interface ExpandOpts {
  /** 1 or 2 — capped at 2. 0/undefined → no walk (near_symbol anchors only). */
  walkDepth?: number;
  /** Seed the anchor set with chunks whose symbol_name_qualified matches. */
  nearSymbol?: string;
  /** Tenant scope — when set, expansion stays within these sources. */
  sourceIds?: readonly string[];
}

export interface AnchorChunk {
  id: string;
  score: number;
}

interface SeenEntry {
  id: string;
  score: number;
  symbol: string | null;
  hop: number;
}

/** Resolve a set of chunk ids → their qualified symbol (NULL for prose chunks). */
async function symbolsForChunks(
  engine: Engine,
  ids: string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (ids.length === 0) return out;
  const r = await engine.query<{ id: string; symbol_name_qualified: string | null }>(
    `SELECT id, symbol_name_qualified FROM chunks WHERE id = ANY($1::text[])`,
    [ids],
  );
  for (const row of r.rows) out.set(row.id, row.symbol_name_qualified);
  return out;
}

/**
 * Resolve a qualified symbol name to its chunk(s) — the `near_symbol` anchor
 * path. Exact match on symbol_name_qualified; optional tenant scope.
 */
async function chunksForSymbol(
  engine: Engine,
  symbol: string,
  sources: string[] | undefined,
): Promise<{ id: string; symbol: string }[]> {
  const params: unknown[] = [symbol];
  let join = "";
  let filter = "";
  if (sources !== undefined) {
    join = " JOIN documents d ON d.id = c.document_id";
    filter = andSourceScope("d.source_id", sources, params);
  }
  const r = await engine.query<{ id: string; symbol_name_qualified: string }>(
    `SELECT c.id, c.symbol_name_qualified
       FROM chunks c${join}
      WHERE c.symbol_name_qualified = $1${filter}
      LIMIT ${NEIGHBOR_CAP_PER_HOP}`,
    params,
  );
  return r.rows.map((row) => ({ id: row.id, symbol: row.symbol_name_qualified }));
}

interface ParentNeighbor {
  parent: string;
  chunkId: string;
}

/**
 * Neighbor chunks for an ENTIRE frontier in three batched queries (not one set
 * per symbol — that was an O(frontier) serial round-trip storm). Each row keeps
 * its `parent` frontier symbol so the caller can decay-score by the parent's
 * score. When a scope is set, edges are filtered on `code_edges_symbol.source_id`
 * (stamped from the chunk's document) and def chunks on `chunks.source_id`, so
 * out-of-scope rows never consume the per-hop cap; the caller's `scopeChunks`
 * pass against `documents.source_id` stays the final check.
 *   - callers: `to_symbol_qualified` is a frontier symbol or its bare name → the caller IS `from_chunk_id`.
 *   - callees (resolved): prefer the resolve-phase `resolved_chunk_id`.
 *   - callees (unresolved): join the callee name to a def chunk, keeping parent.
 */
async function frontierNeighbors(
  engine: Engine,
  symbols: string[],
  sources?: readonly string[],
): Promise<ParentNeighbor[]> {
  if (symbols.length === 0) return [];
  const cap = NEIGHBOR_CAP_PER_HOP * symbols.length;
  const params: unknown[] = [symbols];
  // An edge with no source belongs to no reader's grant; only the unscoped
  // operator follows it.
  const edgeScope = andSourceScope("e.source_id", sources, params);

  // A call edge stores the callee as written (`this.c()` → bare `c`), so the
  // callers read matches each frontier symbol by its qualified name and its
  // last segment; an edge resolved to a definition counts only for that one.
  const bareOf = (s: string): string => s.split("::").pop() ?? s;
  const callerParams: unknown[] = [Array.from(new Set(symbols.flatMap((s) => [s, bareOf(s)])))];
  const callerScope = andSourceScope("e.source_id", sources, callerParams);
  const callerRows = await engine.query<{ target: string; chunk_id: string; resolved: string | null }>(
    `SELECT DISTINCT e.to_symbol_qualified AS target, e.from_chunk_id AS chunk_id,
            e.edge_metadata->>'resolved_chunk_id' AS resolved
       FROM code_edges_symbol e
      WHERE e.to_symbol_qualified = ANY($1::text[])
        AND e.from_symbol_qualified IS NOT NULL
        AND e.from_chunk_id IS NOT NULL${callerScope}
      LIMIT ${cap}`,
    callerParams,
  );
  const defs = await engine.query<{ id: string; symbol_name_qualified: string }>(
    `SELECT id, symbol_name_qualified FROM chunks WHERE symbol_name_qualified = ANY($1::text[])`,
    [symbols],
  );
  const defIds = new Map<string, Set<string>>();
  for (const d of defs.rows) {
    const set = defIds.get(d.symbol_name_qualified) ?? new Set<string>();
    set.add(d.id);
    defIds.set(d.symbol_name_qualified, set);
  }
  const callers: { parent: string; chunk_id: string }[] = [];
  for (const parent of symbols) {
    const own = defIds.get(parent);
    for (const r of callerRows.rows) {
      if (r.target !== parent && r.target !== bareOf(parent)) continue;
      if (r.resolved !== null && own !== undefined && !own.has(r.resolved)) continue;
      callers.push({ parent, chunk_id: r.chunk_id });
    }
  }
  const calleesResolved = await engine.query<{ parent: string; chunk_id: string }>(
    `SELECT DISTINCT e.from_symbol_qualified AS parent,
            e.edge_metadata->>'resolved_chunk_id' AS chunk_id
       FROM code_edges_symbol e
      WHERE e.from_symbol_qualified = ANY($1::text[])
        AND e.edge_metadata ? 'resolved_chunk_id'${edgeScope}
      LIMIT ${cap}`,
    params,
  );
  // Unresolved callees: resolve the callee name to a def chunk in one join,
  // keeping the parent for score attribution.
  const unresolvedParams = [...params];
  const chunkScope = andSourceScope("c.source_id", sources, unresolvedParams);
  const calleesUnresolved = await engine.query<{ parent: string; chunk_id: string }>(
    `SELECT DISTINCT e.from_symbol_qualified AS parent, c.id AS chunk_id
       FROM code_edges_symbol e
       JOIN chunks c
         ON (c.symbol_name_qualified = e.to_symbol_qualified
             OR c.symbol_name = e.to_symbol_qualified)
      WHERE e.from_symbol_qualified = ANY($1::text[])
        AND e.to_symbol_qualified IS NOT NULL
        AND NOT (e.edge_metadata ? 'resolved_chunk_id')
        AND c.symbol_name_qualified IS NOT NULL${edgeScope}${chunkScope}
      LIMIT ${cap}`,
    unresolvedParams,
  );

  const out: ParentNeighbor[] = [];
  for (const r of callers) if (r.chunk_id) out.push({ parent: r.parent, chunkId: r.chunk_id });
  for (const r of calleesResolved.rows) if (r.chunk_id) out.push({ parent: r.parent, chunkId: r.chunk_id });
  for (const r of calleesUnresolved.rows) if (r.chunk_id) out.push({ parent: r.parent, chunkId: r.chunk_id });
  return out;
}

/** Keep only chunk ids whose parent document is in scope. No-op when unscoped. */
async function scopeChunks(
  engine: Engine,
  ids: string[],
  sources: string[] | undefined,
): Promise<Set<string>> {
  if (sources === undefined || ids.length === 0) return new Set(ids);
  const r = await engine.query<{ id: string }>(
    `SELECT c.id FROM chunks c
       JOIN documents d ON d.id = c.document_id
      WHERE c.id = ANY($1::text[]) AND d.source_id = ANY($2::text[])`,
    [ids, sources],
  );
  return new Set(r.rows.map((row) => row.id));
}

/**
 * Expand an anchor set through the code call graph. Returns the FULL set
 * (anchors at hop 0 + neighbors), each chunk keyed once with its best score.
 * The caller merges these into the fused candidate list (skipping ids it
 * already holds). Best-effort: any query error throws to the caller, which
 * treats expansion as optional and falls back to the un-expanded anchors.
 */
export async function expandAnchors(
  engine: Engine,
  anchors: readonly AnchorChunk[],
  opts: ExpandOpts = {},
): Promise<AnchorChunk[]> {
  const depth = Math.min(Math.max(opts.walkDepth ?? 0, 0), MAX_WALK_DEPTH);
  if (depth === 0 && !opts.nearSymbol) {
    return anchors.map((a) => ({ id: a.id, score: a.score }));
  }
  const sources = normalizeScope(opts.sourceIds);
  const seen = new Map<string, SeenEntry>();
  for (const a of anchors) {
    if (!seen.has(a.id)) seen.set(a.id, { id: a.id, score: a.score, symbol: null, hop: 0 });
  }

  // near_symbol: add chunks whose qualified symbol matches as hop-0 anchors.
  // Seeded at the top text-anchor score (or 1.0 when there are no text anchors,
  // where it stands alone so the absolute value is irrelevant). Parity with the
  // best lexical hit is deliberate — the caller explicitly anchored here.
  if (opts.nearSymbol) {
    const baseScore = anchors.length > 0 ? anchors[0]!.score : 1.0;
    const matches = await chunksForSymbol(engine, opts.nearSymbol, sources);
    for (const m of matches) {
      if (!seen.has(m.id)) {
        seen.set(m.id, { id: m.id, score: baseScore, symbol: m.symbol, hop: 0 });
      }
    }
  }

  // Resolve hop-0 chunk symbols so the walk has a starting frontier.
  const hop0 = Array.from(seen.values()).filter((e) => e.hop === 0);
  const symMap = await symbolsForChunks(engine, hop0.map((e) => e.id));
  let frontier = capFrontier(
    hop0.flatMap((e) => {
      const sym = e.symbol ?? symMap.get(e.id) ?? null;
      e.symbol = sym;
      return sym ? [{ symbol: sym, score: e.score }] : [];
    }),
  );

  for (let hop = 1; hop <= depth; hop++) {
    if (frontier.length === 0) break;
    const decay = 1 / (1 + hop);
    const parentScore = new Map(frontier.map((n) => [n.symbol, n.score]));

    // One batched fan-out over the whole frontier (not per-symbol). Best score
    // per fresh chunk wins when reachable from several parents.
    const neighbors = await frontierNeighbors(engine, frontier.map((n) => n.symbol), sources);
    const candidate = new Map<string, number>();
    for (const nb of neighbors) {
      if (seen.has(nb.chunkId)) continue;
      const ps = parentScore.get(nb.parent);
      if (ps === undefined) continue;
      const score = ps * decay;
      const prev = candidate.get(nb.chunkId);
      if (prev === undefined || score > prev) candidate.set(nb.chunkId, score);
    }
    if (candidate.size === 0) break;

    // Admit only the highest-scored MAX_CANDIDATES_PER_HOP chunks this hop.
    let entries = Array.from(candidate.entries());
    if (entries.length > MAX_CANDIDATES_PER_HOP) {
      entries = entries.sort((a, b) => b[1] - a[1]).slice(0, MAX_CANDIDATES_PER_HOP);
    }
    const inScope = await scopeChunks(engine, entries.map((e) => e[0]), sources);
    const freshIds: string[] = [];
    for (const [id, score] of entries) {
      if (!inScope.has(id)) continue;
      seen.set(id, { id, score, symbol: null, hop });
      freshIds.push(id);
    }

    // Re-resolve each fresh chunk's qualified symbol for the next frontier —
    // callee edges store the call as written (bare), so the edge's
    // to_symbol_qualified is NOT a walkable def symbol; the chunk's own
    // symbol_name_qualified is. Then dedup + cap the frontier width.
    const symMap2 = await symbolsForChunks(engine, freshIds);
    frontier = capFrontier(
      freshIds.flatMap((id) => {
        const sym = symMap2.get(id) ?? null;
        return sym ? [{ symbol: sym, score: seen.get(id)!.score }] : [];
      }),
    );
  }

  return Array.from(seen.values()).map((e) => ({ id: e.id, score: e.score }));
}

/** Dedup a frontier by symbol (keeping the max score) and cap its width. */
function capFrontier(
  nodes: { symbol: string; score: number }[],
): { symbol: string; score: number }[] {
  const best = new Map<string, number>();
  for (const n of nodes) {
    const prev = best.get(n.symbol);
    if (prev === undefined || n.score > prev) best.set(n.symbol, n.score);
  }
  const deduped = Array.from(best, ([symbol, score]) => ({ symbol, score }));
  if (deduped.length <= FRONTIER_CAP) return deduped;
  return deduped.sort((a, b) => b.score - a.score).slice(0, FRONTIER_CAP);
}
