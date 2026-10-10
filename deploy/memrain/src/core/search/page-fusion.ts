/**
 * Page-grain RRF (MEMRAIN_RANK_PAGE_FUSION, default off).
 *
 * Chunk-grain RRF splits one page's agreement across its chunks: the keyword
 * arm picks the chunk with the query's words, the vector arm picks the chunk
 * with the closest meaning, and each collects one vote. A page both arms rank
 * second then loses to a page one arm ranks first. The compiled-truth mirror
 * (`page-truth://slug`) and the page itself (`page://slug`) are separate
 * documents too, so they split the votes the same way and take two slots.
 *
 * Here every list votes for a page once, at that page's best rank in the list,
 * and the page's lead chunk (its largest own vote; first seen on a tie) carries
 * the page total. The page's other chunks keep only their own votes, so a
 * second chunk never crowds another page's lead out of the window. The per-list
 * k/weight arithmetic is the same as core/rrf.ts.
 */
import type { Engine } from "../engine/interface.ts";
import { DEFAULT_RRF_K } from "../rrf.ts";
import { slugCandidatesForPath } from "./page-slug.ts";

/** One list's vote for a chunk: the list index and the 1-based rank in it. */
export interface ArmVote {
  list: number;
  rank: number;
}

export interface PageFusionResult {
  id: string;
  score: number;
  /** The page's votes on its lead chunk; a chunk's own votes otherwise. */
  votes: ArmVote[];
}

export interface PageFusionOptions {
  k?: number;
  weights?: readonly number[];
  /** Page identity for a chunk id; a chunk without one is its own page. */
  pageOf: (chunkId: string) => string | undefined;
}

export function fuseByPage(
  lists: ReadonlyArray<readonly string[]>,
  opts: PageFusionOptions,
): PageFusionResult[] {
  const k = opts.k ?? DEFAULT_RRF_K;
  const own = new Map<string, number>();
  const ownVotes = new Map<string, ArmVote[]>();
  const pageTotal = new Map<string, number>();
  const pageVotes = new Map<string, ArmVote[]>();
  const pageKey = (id: string): string => opts.pageOf(id) ?? `chunk:${id}`;

  for (let li = 0; li < lists.length; li++) {
    const list = lists[li]!;
    const weight = opts.weights?.[li] ?? 1;
    const listK = weight > 0 ? k / weight : k;
    const voted = new Set<string>();
    for (let i = 0; i < list.length; i++) {
      const id = list[i];
      if (!id) continue;
      const rank = i + 1;
      const contribution = 1 / (listK + rank);
      own.set(id, (own.get(id) ?? 0) + contribution);
      ownVotes.set(id, [...(ownVotes.get(id) ?? []), { list: li, rank }]);
      const page = pageKey(id);
      if (!voted.has(page)) {
        voted.add(page);
        pageTotal.set(page, (pageTotal.get(page) ?? 0) + contribution);
        pageVotes.set(page, [...(pageVotes.get(page) ?? []), { list: li, rank }]);
      }
    }
  }

  // Map iteration is insertion order, so the strict `>` keeps the first-seen
  // chunk as lead on a tie.
  const lead = new Map<string, string>();
  for (const [id, score] of own) {
    const page = pageKey(id);
    const current = lead.get(page);
    if (current === undefined || score > own.get(current)!) lead.set(page, id);
  }

  return [...own.entries()]
    .map(([id, score]) => {
      const page = pageKey(id);
      return lead.get(page) === id
        ? { id, score: pageTotal.get(page)!, votes: pageVotes.get(page)! }
        : { id, score, votes: ownVotes.get(id)! };
    })
    // Same tie rule as core/rrf.ts: a stable sort over first-seen order, so
    // tied hits keep the order chunk-grain fusion would give them.
    .sort((a, b) => b.score - a.score);
}

/**
 * The page a document belongs to: its source plus the slug form of its path
 * (source-stripped for a tenant mirror), so `page://x`, `page-truth://x` and
 * the file twin `x.md` meet on one key. A path with no slug form (code, absolute paths) is its own page.
 */
export function pageKeyFor(
  sourcePath: string | null | undefined,
  sourceId: string | null | undefined,
  documentId: string,
): string {
  // A tenant mirror `page://<source>/<slug>` yields the bare form first and the
  // source-stripped slug second; only the stripped one meets its file twin.
  const candidates = slugCandidatesForPath(sourcePath, sourceId);
  const slug = candidates[1] ?? candidates[0];
  return slug ? `${sourceId ?? "default"}:${slug}` : `doc:${documentId}`;
}

/** Page keys for every chunk id the retrieval lists returned, in one query. */
export async function pageKeysForChunks(
  engine: Engine,
  chunkIds: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(chunkIds)];
  if (ids.length === 0) return out;
  const r = await engine.query<{
    id: string;
    document_id: string;
    source_path: string;
    source_id: string | null;
  }>(
    `SELECT c.id, c.document_id, d.source_path, d.source_id
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
      WHERE c.id = ANY($1::text[])`,
    [ids],
  );
  for (const row of r.rows) {
    out.set(row.id, pageKeyFor(row.source_path, row.source_id, row.document_id));
  }
  return out;
}
