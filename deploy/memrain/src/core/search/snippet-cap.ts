/**
 * Optional per-hit content cap for the `search` and `query` MCP results
 * (MEMRAIN_SEARCH_SNIPPET_CHARS). A capped hit says it was cut and, for a page
 * hit, which call returns the whole body, so the client can pay for a full
 * page only when the snippet is not enough. Unset or 0 leaves hits untouched.
 */
import { isPageSourcePath } from "../page-index.ts";
import { slugCandidatesForPath } from "./page-slug.ts";

/** Characters a hit keeps, or 0 for no cap. A malformed value means no cap. */
export function searchSnippetChars(): number {
  const n = Number(process.env["MEMRAIN_SEARCH_SNIPPET_CHARS"] ?? "");
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/**
 * `text` cut to at most `max` characters, at the last whitespace inside the
 * window when there is one (a cut word reads as a different word), otherwise
 * hard at `max`.
 */
export function cutAtWordBoundary(text: string, max: number): string {
  if (text.length <= max) return text;
  const window = text.slice(0, max);
  if (/\s/.test(text[max]!)) return window.trimEnd();
  const lastSpace = window.search(/\s\S*$/);
  return (lastSpace > 0 ? window.slice(0, lastSpace) : window).trimEnd();
}

/**
 * The page slug a hit's mirror document belongs to, or null for a hit that is
 * not a page (a file, a code chunk). The hit's owning source disambiguates
 * tenant prefixes from default-source slugs. Legacy callers without provenance
 * retain the read-scope fallback.
 */
export function pageSlugForHit(sourcePath: string, readSources?: readonly string[], sourceId?: string | null): string | null {
  if (!isPageSourcePath(sourcePath)) return null;
  const [bare] = slugCandidatesForPath(sourcePath, null);
  if (!bare) return null;
  if (sourceId !== undefined) {
    return sourceId && sourceId !== "default" && bare.startsWith(`${sourceId}/`)
      ? bare.slice(sourceId.length + 1) : bare;
  }
  for (const s of readSources ?? []) {
    if (s !== "default" && bare.startsWith(`${s}/`) && bare.length > s.length + 1) {
      return bare.slice(s.length + 1);
    }
  }
  return bare;
}

export type CappedHit<T> = T & { truncated?: boolean; full?: string };

/**
 * Copies of `hits` with `content` cut to `max` characters. A hit that had to
 * be cut gains `truncated: true` and, when it is a page, `full: "page_get
 * {slug, source_id}"`. `max <= 0` returns the input unchanged.
 */
export function capHitSnippets<T extends { content: string; sourcePath: string; source_id?: string | null }>(
  hits: readonly T[],
  max: number,
  readSources?: readonly string[],
): CappedHit<T>[] {
  if (max <= 0) return hits as CappedHit<T>[];
  return hits.map((h) => {
    if (typeof h.content !== "string" || h.content.length <= max) return h;
    const slug = pageSlugForHit(h.sourcePath, readSources, h.source_id);
    return {
      ...h,
      content: cutAtWordBoundary(h.content, max),
      truncated: true,
      ...(slug ? { full: `page_get ${h.source_id === undefined ? slug : JSON.stringify({ slug, source_id: h.source_id || "default" })}` } : {}),
    };
  });
}
