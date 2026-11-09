/**
 * Recursive markdown chunker — heading + paragraph + size-bounded splitter.
 *
 * Strategy:
 *   1. Parse + strip YAML frontmatter (delegated to ../frontmatter.ts).
 *   2. Split the body by H1 / H2 boundaries — each becomes one section.
 *   3. If a section exceeds `maxChars`, sub-split by paragraph; pack
 *      paragraphs greedily into chunks <= maxChars.
 *   4. Merge any chunk shorter than `minChars` with its next sibling.
 *
 * Char-bounded (not token-bounded) on purpose: no tokenizer dependency,
 * Bedrock Titan is character-tolerant, and chunk sizing has loose tails
 * by design.
 *
 * This is the only chunker that actually runs today. `code.ts` and
 * `semantic.ts` are stubs for future content types.
 */
import { parseFrontmatter } from "../frontmatter.ts";
export { parseFrontmatter };

/**
 * Markdown chunker version (migration 052). Stamped onto `documents.chunker_version`
 * at index time. BUMP THIS whenever this splitter's logic changes in a way that
 * should re-chunk + re-embed the existing markdown corpus — a document whose
 * stamp is below the current value reads stale for the doctor `chunker-version-lag`
 * check. Starts at 1 (the grandfather DEFAULT), so the first bump is what
 * surfaces the re-chunk backlog.
 */
// v2 (2026-07-06): the indexer now strips the `## Takes` fence before chunking
// (alongside `## Facts`), so any page/doc chunked under v1 may carry fenced
// takes content that must be re-chunked out of the search index.
export const MARKDOWN_CHUNKER_VERSION = 3;
/** Automatic maintenance retains the last approved corpus-wide upgrade floor. */
export const AUTO_MARKDOWN_RECHUNK_VERSION = 2;

export interface ChunkerOptions {
  /** Soft upper bound per chunk in characters. Default ≈ 4000 chars (~1000 tokens). */
  maxChars?: number;
  /** Anything shorter than this gets merged with its neighbour. */
  minChars?: number;
  /**
   * Sliding-window overlap (chars) prepended to each chunk from the tail of the
   * previous one, so a fact straddling a size-split boundary stays retrievable
   * from both sides. Applied ONLY between the size-driven sub-splits of one
   * heading section -- never across a heading boundary (a heading is a semantic
   * break, not an arbitrary cut). Snapped to a sentence/word boundary and capped
   * at half the previous chunk so it never duplicates a majority of a chunk.
   * Default comes from `MEMRAIN_CHUNK_OVERLAP`, else `DEFAULT_OVERLAP_CHARS`
   * (~50 words, ON). The default applies to NEWLY indexed pages only; chunks
   * already stored keep their current overlap until the document is re-indexed,
   * so flipping the default never forces a corpus-wide reindex. Set `0` (opt or
   * env) to disable.
   */
  overlapChars?: number;
}

export interface ChunkedDocument {
  /** Parsed frontmatter (raw object — not validated here). */
  frontmatter: Record<string, unknown>;
  /** Body title — first H1 if present, else null. */
  title: string | null;
  /** The chunked body, in document order. */
  chunks: string[];
}

const DEFAULT_MAX = 4000;
const DEFAULT_MIN = 200;
/** Below this many chars an overlap window is not worth prepending. */
const MIN_OVERLAP_CHARS = 16;
/**
 * Default trailing overlap (chars) for NEWLY indexed pages — ~50 words of
 * sentence-aware bridge. ON by default so a
 * boundary-straddling fact stays retrievable from both size-split chunks. This
 * changes only what a fresh index/reindex produces: chunks already stored keep
 * their current (overlap-off) content until the document is re-indexed, so no
 * corpus-wide reindex is forced. Turn off per-index with `overlapChars: 0` or
 * corpus-wide with `MEMRAIN_CHUNK_OVERLAP=0`.
 */
export const DEFAULT_OVERLAP_CHARS = 300;

/**
 * Resolve the overlap window (ON by default). Precedence:
 *   - explicit `opt` wins (a caller passing `0` disables; a negative/NaN opt
 *     fails SAFE to 0 — chunking must never break indexing);
 *   - else `MEMRAIN_CHUNK_OVERLAP`: `0` disables, a positive value sets it, and an
 *     unset OR unparseable value falls back to `DEFAULT_OVERLAP_CHARS` (ON).
 * Capped at half of `maxChars` so overlap can never dominate a chunk.
 */
export function resolveOverlapChars(
  opt: number | undefined,
  maxChars: number,
): number {
  let v = opt;
  if (v === undefined) {
    const raw = process.env.MEMRAIN_CHUNK_OVERLAP;
    if (raw === undefined || raw.trim() === "") {
      v = DEFAULT_OVERLAP_CHARS; // unset → ON by default
    } else {
      const parsed = Number.parseInt(raw, 10);
      // A parseable value (incl. 0 = explicit disable) wins; garbage → default.
      v = Number.isFinite(parsed) ? parsed : DEFAULT_OVERLAP_CHARS;
    }
  }
  if (!Number.isFinite(v) || v < 0) return 0; // explicit negative/NaN opt → off
  if (v === 0) return 0; // explicit disable
  return Math.min(Math.floor(v), Math.floor(maxChars / 2));
}

/**
 * The overlap text to prepend to a chunk: the tail of the previous chunk,
 * capped at `overlapChars` AND at half the previous chunk, snapped FORWARD to a
 * clean start. Preference: the FIRST sentence boundary in the capped window
 * (intentionally first-not-last, so the bridge is generous up to the cap), then
 * a word boundary, else "". The fallback chain matters: a window whose first
 * sentence start leaves too little, or a window with no whitespace at all (one
 * giant token / URL / hash), must not produce a sub-floor or mid-token bridge.
 */
export function overlapTail(prev: string, overlapChars: number): string {
  const cap = Math.min(overlapChars, Math.floor(prev.length / 2));
  if (cap < MIN_OVERLAP_CHARS) return "";
  const window = prev.slice(prev.length - cap);
  const candidates: string[] = [];
  const sentence = window.search(/(?<=[.!?])\s+/);
  if (sentence >= 0) candidates.push(window.slice(sentence).replace(/^\s+/, ""));
  const word = window.search(/\s/);
  if (word >= 0) candidates.push(window.slice(word + 1));
  for (const c of candidates) {
    const t = c.trim();
    if (t.length >= MIN_OVERLAP_CHARS) return t;
  }
  return "";
}

/**
 * True if a chunk contains an H1/H2 heading line ANYWHERE (`m` flag). A normal
 * size-split continuation carries no heading (the heading rode with the
 * section's first piece). A leading heading marks a section start; an EMBEDDED
 * heading marks a chunk that mergeShort folded across a section boundary. Either
 * way the chunk must not receive an overlap bridge -- it would cross a section.
 * Uses the same `/^#{1,2}\s/` grammar as `sectionsByHeading`, so it agrees with
 * how the chunker decides boundaries in the first place.
 */
function containsHeading(chunk: string): boolean {
  return /^#{1,2}\s/m.test(chunk);
}

/**
 * Prepend a sliding-window overlap to each FINAL chunk that is a pure size-split
 * continuation -- i.e. a chunk that carries NO heading line. A chunk holding a
 * heading (leading = section start, or embedded = a mergeShort cross-section
 * merge) is skipped, so an overlap window never bridges a section boundary.
 *
 * Applied AFTER mergeShort over the final chunk list, so it changes chunk
 * CONTENT only, never the chunk COUNT: mergeShort decides boundaries on the
 * original (un-overlapped) lengths, keeping positional chunk ids stable vs the
 * overlap-off output. The overlap is read from the ORIGINAL previous chunk (not
 * the already-overlapped `out`), so windows do not compound.
 */
function addOverlap(chunks: string[], overlapChars: number): string[] {
  if (overlapChars <= 0 || chunks.length <= 1) return chunks;
  const out: string[] = [chunks[0] ?? ""];
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i] ?? "";
    if (containsHeading(chunk)) {
      out.push(chunk);
      continue;
    }
    const tail = overlapTail(chunks[i - 1] ?? "", overlapChars);
    out.push(tail ? `${tail}\n\n${chunk}` : chunk);
  }
  return out;
}

/**
 * Split markdown body into sections at H1 (`# `) and H2 (`## `) boundaries.
 * The heading line itself is included in the section that follows it.
 */
function sectionsByHeading(body: string): string[] {
  const lines = body.split(/\r?\n/);
  const out: string[] = [];
  let buf: string[] = [];
  for (const line of lines) {
    if (/^#{1,2}\s/.test(line) && buf.length > 0) {
      out.push(buf.join("\n"));
      buf = [];
    }
    buf.push(line);
  }
  if (buf.length > 0) out.push(buf.join("\n"));
  return out.filter((s) => s.trim().length > 0);
}

/**
 * Hard-split a single paragraph that itself exceeds maxChars. A wall-of-text
 * transcript (e.g. a voice-note with no blank lines or newlines) is one giant
 * paragraph: splitting by blank line leaves it whole, so it would be emitted
 * as a single oversized chunk that blows the embedding model's token cap and
 * silently drops the entire document. Split on sentence boundaries first to
 * keep units coherent, then hard-slice any remaining run that is still too
 * long. ASCII terminators only (covers the en/de/ru corpus; keeps this source
 * file byte-clean for the audit gate). The hard slice is the floor that
 * bounds each returned unit, except that a surrogate pair stays atomic.
 */
function splitOversizedUnit(text: string, maxChars: number): string[] {
  // A non-positive budget would make the hard-slice loop below never advance
  // (infinite loop). Treat it as "do not split" -- callers always pass a sane
  // maxChars, but never hang on a config typo.
  if (maxChars <= 0) return [text];
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  const out: string[] = [];
  for (const s of sentences) {
    if (s.length <= maxChars) {
      out.push(s);
      continue;
    }
    for (let i = 0; i < s.length; ) {
      let end = Math.min(i + maxChars, s.length);
      if (end < s.length) {
        const newline = s.lastIndexOf("\n", end - 1);
        if (newline > i) end = newline + 1;
      }
      // A surrogate pair stays whole even when the budget is one code unit.
      if (end < s.length) {
        const code = s.charCodeAt(end - 1);
        const next = s.charCodeAt(end);
        if (code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
          end += end - i > 1 ? -1 : 1;
        }
      }
      out.push(s.slice(i, end));
      i = end;
    }
  }
  return out;
}

/**
 * Sub-split a single section that exceeds maxChars by paragraph (blank-line
 * separated). Greedily packs paragraphs until the budget is reached. Any
 * single paragraph that already exceeds maxChars is first expanded into
 * sentence-/char-bounded units (see splitOversizedUnit) so no returned chunk
 * can ever exceed maxChars.
 */
function splitBySize(section: string, maxChars: number): string[] {
  if (section.length <= maxChars) return [section];
  const paragraphs = section.split(/\r?\n\s*\n/).filter(Boolean);
  const units: string[] = [];
  for (const p of paragraphs) {
    if (p.length <= maxChars) units.push(p);
    else units.push(...splitOversizedUnit(p, maxChars));
  }
  const out: string[] = [];
  let current = "";
  for (const p of units) {
    if (current.length === 0) {
      current = p;
      continue;
    }
    if (current.length + 2 + p.length <= maxChars) {
      current = current + "\n\n" + p;
    } else {
      out.push(current);
      current = p;
    }
  }
  if (current.length > 0) out.push(current);
  return out;
}

/**
 * Merge any chunk shorter than minChars with the next one to avoid
 * embedding tiny fragments that just dilute search recall.
 */
function mergeShort(chunks: string[], minChars: number): string[] {
  if (chunks.length <= 1) return chunks;
  const out: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const cur = chunks[i] ?? "";
    if (cur.length < minChars && i + 1 < chunks.length) {
      const next = chunks[i + 1] ?? "";
      chunks[i + 1] = cur + "\n\n" + next;
      continue;
    }
    out.push(cur);
  }
  return out;
}

/**
 * Plain-text window splitter: size-bounded windows over raw text with the
 * short-tail merge, but NO frontmatter parse and NO heading sectioning. The
 * fallback path for symbol-less CODE files goes through this — running code
 * through `chunkMarkdown` would eat a leading `--- … ---` block as YAML
 * frontmatter (e.g. `---` SQL comment separators) and silently drop content.
 */
export function chunkPlainText(
  text: string,
  opts: ChunkerOptions = {},
): string[] {
  const maxChars = opts.maxChars ?? DEFAULT_MAX;
  const minChars = opts.minChars ?? DEFAULT_MIN;
  const pieces = splitBySize(text, maxChars).map((s) => s.trim());
  return mergeShort(
    pieces.filter((s) => s.length > 0),
    minChars,
  );
}

function findFirstH1(body: string): string | null {
  // Measured linear through chunkMarkdown: 6.9 ms on a 256 K body of `#` +
  // newlines, 6.1 ms on 256 K of `#` + 100-newline runs, ratio 2.0-2.3 on a
  // doubling — the same ratio the no-`#` control body posts, so the growth is
  // the chunker's own walk, not this match. `\s+` can only give back into a
  // greedy `.+` that runs to the next newline, and `$` under `/m` is satisfied
  // there by construction, so the give-back either succeeds at once or dies on
  // a newline in O(1).
  // eslint-disable-next-line regexp/no-super-linear-backtracking
  const m = body.match(/^#\s+(.+)$/m);
  return m && m[1] ? m[1].trim() : null;
}

export function chunkMarkdown(
  md: string,
  opts: ChunkerOptions = {},
): ChunkedDocument {
  const maxChars = opts.maxChars ?? DEFAULT_MAX;
  const minChars = opts.minChars ?? DEFAULT_MIN;
  const overlapChars = resolveOverlapChars(opts.overlapChars, maxChars);

  const { frontmatter, body } = parseFrontmatter(md);
  const sections = sectionsByHeading(body);

  const expanded: string[] = [];
  for (const sec of sections) {
    for (const piece of splitBySize(sec, maxChars)) {
      expanded.push(piece.trim());
    }
  }
  const merged = mergeShort(
    expanded.filter((s) => s.length > 0),
    minChars,
  );
  // Overlap is the LAST step, over the final chunk list: it bridges size-split
  // continuations without changing the chunk count mergeShort produced (so
  // positional chunk ids stay stable vs overlap-off), and the heading-start
  // skip keeps a window from ever crossing a section boundary.
  const chunks = addOverlap(merged, overlapChars);

  // Final safety clamp. splitBySize bounds each piece to maxChars, but the two
  // later steps (mergeShort fold-forward, addOverlap prepend) run afterwards
  // and can grow a chunk past it. The embedding model rejects an over-cap chunk
  // with a 400 and the WHOLE document is dropped, so hard-bound the final
  // output. The ceiling (2x maxChars) sits well above any normal overlapped
  // chunk (<= 1.5x maxChars), so this only fires on pathological growth and
  // leaves ordinary chunk ids untouched.
  const ceiling = maxChars * 2;
  const clamped: string[] = [];
  for (const c of chunks) {
    if (c.length <= ceiling) clamped.push(c);
    else clamped.push(...splitOversizedUnit(c, maxChars));
  }

  return {
    frontmatter,
    title: findFirstH1(body),
    chunks: clamped,
  };
}
