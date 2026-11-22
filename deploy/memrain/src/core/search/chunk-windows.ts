/**
 * Neighbour chunk windows for evidence delivery: the chunks just before and
 * after each hit in its own document, read for many hits in ONE query. A hit
 * often lands mid-argument; a window of one or two chunks either side gives the
 * reader the sentence that set it up without a follow-up `get_chunks` per hit.
 *
 * Every hit chunk is re-authorized here (source scope, visible document), and
 * neighbours come only from the hit's own document, so a window never shows
 * text from a document the hit could not. A hit that fails the check simply
 * gets no window.
 */
import type { Engine } from "../engine/interface.ts";
import { andSourceScope } from "../source-scope.ts";
import { visibilityClause } from "../visibility.ts";
import { frameForRead, type ExternalTrust } from "../trust-frame.ts";
import { cutAtWordBoundary, cutTailAtWordBoundary } from "./snippet-cap.ts";
import { estTokens } from "./token-budget.ts";

export const MAX_WINDOW_RADIUS = 2;
/** Per-side character cap when MEMRAIN_SEARCH_SNIPPET_CHARS sets none. */
export const DEFAULT_WINDOW_SIDE_CHARS = 1000;

export interface ChunkWindow {
  /** Neighbour text before the hit, in document order ("" when none). */
  before: string;
  /** Neighbour text after the hit, in document order ("" when none). */
  after: string;
}

/** Shortest shared run counted as the chunker's overlap rather than a coincidence. */
const MIN_OVERLAP_CHARS = 20;
/** Longest overlap looked for; the chunker overlaps by far less. */
const MAX_OVERLAP_CHARS = 1000;

/** Length of the longest suffix of `a` that is a prefix of `b`, or 0 below MIN_OVERLAP_CHARS. */
export function overlapLength(a: string, b: string): number {
  const top = Math.min(a.length, b.length, MAX_OVERLAP_CHARS);
  for (let k = top; k >= MIN_OVERLAP_CHARS; k--) {
    if (a.endsWith(b.slice(0, k))) return k;
  }
  return 0;
}

/** Chunks in document order joined into one text, the overlap each repeats from the one before dropped. */
function joinChunks(chunks: readonly string[]): string {
  let out = "";
  for (const c of chunks) {
    if (!out) {
      out = c;
      continue;
    }
    const k = overlapLength(out, c);
    out += k > 0 ? c.slice(k) : `\n\n${c}`;
  }
  return out;
}

/**
 * Windows of `radius` chunks (1..2) either side of each hit chunk, keyed by hit
 * chunk id. Hits without a neighbour on either side are absent.
 *
 * A side stops at a chunk in `stopAt` (the other hits of the same answer), so
 * two hits in one document never repeat each other's text in their windows,
 * and the overlap adjacent chunks share with the hit (and with each other) is
 * dropped, so a window holds only text the hit does not.
 */
export async function readChunkWindows(
  engine: Engine,
  chunkIds: readonly string[],
  radius: number,
  opts: { sourceIds?: readonly string[]; stopAt?: ReadonlySet<string> } = {},
): Promise<Map<string, ChunkWindow>> {
  const r = Math.min(MAX_WINDOW_RADIUS, Math.max(0, Math.floor(radius)));
  const ids = [...new Set(chunkIds)];
  if (r === 0 || ids.length === 0) return new Map();
  const params: unknown[] = [ids, r];
  const scope = andSourceScope("d.source_id", opts.sourceIds, params);
  const rows = (await engine.query<{ hit_id: string; hit_content: string; offset: number | string; id: string; content: string }>(
    `WITH hit AS (
       SELECT c.id AS hit_id, c.document_id, c.chunk_index, c.content AS hit_content
         FROM chunks c JOIN documents d ON d.id = c.document_id
        WHERE c.id = ANY($1::text[]) AND ${visibilityClause("d")}${scope}
     )
     SELECT DISTINCT ON (h.hit_id, n.chunk_index) h.hit_id, h.hit_content, n.chunk_index - h.chunk_index AS offset, n.id, n.content
       FROM hit h JOIN chunks n ON n.document_id = h.document_id
      WHERE n.chunk_index BETWEEN h.chunk_index - $2::int AND h.chunk_index + $2::int
        AND n.chunk_index <> h.chunk_index
      ORDER BY h.hit_id, n.chunk_index, n.id COLLATE "C"`,
    params,
  )).rows;
  const byHit = new Map<string, { hit: string; rows: Array<{ offset: number; id: string; content: string }> }>();
  for (const row of rows) {
    const p = byHit.get(row.hit_id) ?? { hit: row.hit_content, rows: [] };
    p.rows.push({ offset: Number(row.offset), id: row.id, content: row.content });
    byHit.set(row.hit_id, p);
  }
  const stop = opts.stopAt ?? new Set<string>();
  const out = new Map<string, ChunkWindow>();
  for (const [hitId, { hit, rows: ns }] of byHit) {
    const at = new Map(ns.map(n => [n.offset, n] as const));
    const before: string[] = [];
    for (let o = -1; o >= -r; o--) {
      const n = at.get(o);
      if (!n || stop.has(n.id)) break;
      before.unshift(n.content);
    }
    const after: string[] = [];
    for (let o = 1; o <= r; o++) {
      const n = at.get(o);
      if (!n || stop.has(n.id)) break;
      after.push(n.content);
    }
    let b = joinChunks(before);
    const tail = overlapLength(b, hit);
    if (tail > 0) b = b.slice(0, b.length - tail);
    let a = joinChunks(after);
    a = a.slice(overlapLength(hit, a));
    if (b || a) out.set(hitId, { before: b, after: a });
  }
  return out;
}

/**
 * `hits` with a `window` attached where one exists. Window text is framed the
 * way the hit's own content was (external, instruction-like) and cut to
 * `maxChars` per side (DEFAULT_WINDOW_SIDE_CHARS when that is not positive).
 * With `tokenRoom` set (what a token budget leaves after the hits and facts),
 * windows are attached in rank order until the next one would not fit, each
 * charged for its text the way the hit trim charges a hit; the hits are never
 * touched.
 */
export async function withChunkWindows<T extends { chunkId: string; content_flag?: { reason: string; detail: string } } & ExternalTrust>(
  engine: Engine,
  hits: readonly T[],
  radius: number,
  opts: { sourceIds?: readonly string[]; maxChars?: number; tokenRoom?: number } = {},
): Promise<Array<T & { window?: ChunkWindow }>> {
  const hitIds = hits.map(h => h.chunkId);
  const windows = await readChunkWindows(engine, hitIds, radius, { ...opts, stopAt: new Set(hitIds) });
  const max = opts.maxChars !== undefined && opts.maxChars > 0 ? opts.maxChars : DEFAULT_WINDOW_SIDE_CHARS;
  // The text next to the hit is what a window is for: `before` keeps its end, `after` its start.
  const side = (text: string, hit: T, cut: (t: string, n: number) => string): string => (text ? frameForRead(cut(text, max), hit) : "");
  let room = opts.tokenRoom ?? Number.POSITIVE_INFINITY;
  return hits.map((h) => {
    const w = windows.get(h.chunkId);
    if (!w || room <= 0) return h;
    const window = { before: side(w.before, h, cutTailAtWordBoundary), after: side(w.after, h, cutAtWordBoundary) };
    const cost = estTokens(window.before) + estTokens(window.after);
    if (cost > room) {
      room = 0;
      return h;
    }
    room -= cost;
    return { ...h, window };
  });
}
