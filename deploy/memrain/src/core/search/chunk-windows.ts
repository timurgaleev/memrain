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
import { cutAtWordBoundary } from "./snippet-cap.ts";
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

/**
 * Windows of `radius` chunks (1..2) either side of each hit chunk, keyed by hit
 * chunk id. Hits without a neighbour on either side are absent.
 */
export async function readChunkWindows(
  engine: Engine,
  chunkIds: readonly string[],
  radius: number,
  opts: { sourceIds?: readonly string[] } = {},
): Promise<Map<string, ChunkWindow>> {
  const r = Math.min(MAX_WINDOW_RADIUS, Math.max(0, Math.floor(radius)));
  const ids = [...new Set(chunkIds)];
  if (r === 0 || ids.length === 0) return new Map();
  const params: unknown[] = [ids, r];
  const scope = andSourceScope("d.source_id", opts.sourceIds, params);
  const rows = (await engine.query<{ hit_id: string; offset: number | string; content: string }>(
    `WITH hit AS (
       SELECT c.id AS hit_id, c.document_id, c.chunk_index
         FROM chunks c JOIN documents d ON d.id = c.document_id
        WHERE c.id = ANY($1::text[]) AND ${visibilityClause("d")}${scope}
     )
     SELECT DISTINCT ON (h.hit_id, n.chunk_index) h.hit_id, n.chunk_index - h.chunk_index AS offset, n.content
       FROM hit h JOIN chunks n ON n.document_id = h.document_id
      WHERE n.chunk_index BETWEEN h.chunk_index - $2::int AND h.chunk_index + $2::int
        AND n.chunk_index <> h.chunk_index
      ORDER BY h.hit_id, n.chunk_index, n.id COLLATE "C"`,
    params,
  )).rows;
  const parts = new Map<string, { before: string[]; after: string[] }>();
  for (const row of rows) {
    const p = parts.get(row.hit_id) ?? { before: [], after: [] };
    (Number(row.offset) < 0 ? p.before : p.after).push(row.content);
    parts.set(row.hit_id, p);
  }
  return new Map([...parts].map(([id, p]) => [id, { before: p.before.join("\n\n"), after: p.after.join("\n\n") }]));
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
  const windows = await readChunkWindows(engine, hits.map(h => h.chunkId), radius, opts);
  const max = opts.maxChars !== undefined && opts.maxChars > 0 ? opts.maxChars : DEFAULT_WINDOW_SIDE_CHARS;
  const side = (text: string, hit: T): string => (text ? frameForRead(cutAtWordBoundary(text, max), hit) : "");
  let room = opts.tokenRoom ?? Number.POSITIVE_INFINITY;
  return hits.map((h) => {
    const w = windows.get(h.chunkId);
    if (!w || room <= 0) return h;
    const window = { before: side(w.before, h), after: side(w.after, h) };
    const cost = estTokens(window.before) + estTokens(window.after);
    if (cost > room) {
      room = 0;
      return h;
    }
    room -= cost;
    return { ...h, window };
  });
}
