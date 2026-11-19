/**
 * The implicit feedback signal: a page the same principal reads with
 * `page_get` or `get_chunks` within IMPLICIT_WINDOW_MS of a `search` that
 * returned it counts as one positive vote of implicit (quarter) strength.
 *
 * What each principal's recent searches returned is kept in this process
 * only, bounded, and never changes a search response. A static public bearer
 * is shared by everyone who holds it, so its reads are not counted. Off
 * (MEMRAIN_FEEDBACK unset) nothing is remembered and nothing is written.
 */
import type { Storage } from "../storage.ts";
import { principalTier } from "../trust-tier.ts";
import { feedbackEnabled, IMPLICIT_WINDOW_MS } from "./settings.ts";
import { recordRating } from "./store.ts";
import type { VoterTier } from "./weights.ts";

const MAX_PRINCIPALS = 1000;
const MAX_PAGES_PER_PRINCIPAL = 100;

/** Each principal's recently returned pages, with the time each stops counting. */
export class RecentHits {
  private readonly byPrincipal = new Map<string, Map<string, number>>();

  note(principal: string, slugs: readonly string[], now: number): void {
    const prior = this.byPrincipal.get(principal);
    this.byPrincipal.delete(principal);
    const pages = new Map<string, number>();
    for (const [slug, until] of prior ?? []) if (until > now) pages.set(slug, until);
    for (const slug of slugs) {
      pages.delete(slug);
      pages.set(slug, now + IMPLICIT_WINDOW_MS);
    }
    while (pages.size > MAX_PAGES_PER_PRINCIPAL) pages.delete(pages.keys().next().value!);
    this.byPrincipal.set(principal, pages);
    while (this.byPrincipal.size > MAX_PRINCIPALS) this.byPrincipal.delete(this.byPrincipal.keys().next().value!);
  }

  /** True once per search hit read in time; the hit is then forgotten. */
  take(principal: string, slug: string, now: number): boolean {
    const pages = this.byPrincipal.get(principal);
    const until = pages?.get(slug);
    if (until === undefined) return false;
    pages!.delete(slug);
    return until >= now;
  }

  size(): number {
    let n = 0;
    for (const pages of this.byPrincipal.values()) n += pages.size;
    return n;
  }
}

const recent = new RecentHits();

/** The voter's tier; the static public bearer has none. */
function voterTier(principal: string): VoterTier | null {
  if (principal === "" || principal === "public") return null;
  const tier = principalTier(principal);
  return tier === "external" ? null : tier;
}

const PAGE_SCHEME = "page://";

/** Page slugs in a search result, in the order returned. */
function returnedSlugs(text: string): string[] {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return [];
  }
  const hits = (body as { hits?: unknown } | null)?.hits;
  if (!Array.isArray(hits)) return [];
  const out: string[] = [];
  for (const h of hits) {
    const path = (h as { sourcePath?: unknown } | null)?.sourcePath;
    if (typeof path === "string" && path.startsWith(PAGE_SCHEME)) out.push(path.slice(PAGE_SCHEME.length));
  }
  return out;
}

/** Called after every MCP tool call; returns at once and never throws. */
export function observeRetrievalUse(
  storage: Storage,
  name: string,
  args: Record<string, unknown>,
  result: { isError?: boolean; content: ReadonlyArray<{ type: string; text?: string }> },
  /** The caller as dispatch books its writes (`operator`, `client:<id>`, `public`). */
  principal: string,
): void {
  if (!feedbackEnabled() || result.isError) return;
  if (name !== "search" && name !== "page_get" && name !== "get_chunks") return;
  const tier = voterTier(principal);
  if (tier === null) return;
  const now = Date.now();
  if (name === "search") {
    const first = result.content[0];
    if (first?.type === "text" && typeof first.text === "string") recent.note(principal, returnedSlugs(first.text), now);
    return;
  }
  const slug = args["slug"];
  if (typeof slug !== "string" || !recent.take(principal, slug, now)) return;
  void (async () => {
    const engine = storage.engine();
    // scope: upstream the page_get / get_chunks call just read this page under the caller's grant
    const page = await engine.query<{ source_id: string }>(
      `SELECT source_id FROM pages WHERE slug = $1 AND deleted_at IS NULL`,
      [slug],
    );
    const sourceId = page.rows[0]?.source_id;
    if (sourceId === undefined) return;
    await recordRating(engine, { sourceId, slug, principal, tier, rating: 1, signal: "implicit" });
  })().catch((e: unknown) => {
    console.warn("[feedback] implicit vote not recorded:", e instanceof Error ? e.message : e);
  });
}
