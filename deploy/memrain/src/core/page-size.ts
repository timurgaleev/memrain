/**
 * Page body size: one cap for every putPage write, and the splitter connectors
 * use to stay under it.
 *
 * `MEMRAIN_PAGE_MAX_BYTES` is off by default, so existing writes are unchanged.
 * Set, a write whose resulting body grows past it is refused with
 * `page_too_large`; a page already over the cap can still change its title or
 * truth, because only a body the write changes is measured.
 *
 * `splitLargeDocument()` turns one long transcript or thread into a contents
 * page plus `<slug>/part-NNN` pages that each fit. Parts are packed greedily
 * from the start at heading, then paragraph, then line boundaries, so the same
 * text always splits the same way and appending text rewrites only the tail.
 */
import { OperationError } from "./operation-error.ts";

const ENV = "MEMRAIN_PAGE_MAX_BYTES";

/** Connector default part size (2 MiB). */
export const DEFAULT_SPLIT_PART_BYTES = 2 * 1024 * 1024;

/** The longest UTF-8 encoding of one code point; a part must hold at least that. */
const MIN_PART_BYTES = 4;

const utf8Bytes = (s: string): number => Buffer.byteLength(s, "utf8");

/** The configured cap in bytes, or null when unset. A malformed value throws rather than running uncapped. */
export function pageMaxBytes(): number | null {
  const raw = process.env[ENV]?.trim();
  if (!raw) return null;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new Error(`${ENV} must be a positive whole number of bytes (got ${JSON.stringify(raw)})`);
  }
  return Number(raw);
}

/** Refuse a body over the configured cap. A no-op while the cap is unset. */
export function assertPageBodyWithinCap(slug: string, body: string): void {
  const cap = pageMaxBytes();
  if (cap === null) return;
  const size = utf8Bytes(body);
  if (size <= cap) return;
  throw new OperationError(
    "page_too_large",
    `page '${slug}' body is ${size} bytes; the limit is ${cap} (${ENV})`,
    "Split the content across several pages (for example <slug>/part-001, part-002) with a short contents page linking them.",
  );
}

export interface PageDraft { slug: string; title: string; body: string }

export interface SplitDocument {
  /** The page at the original slug: the whole body when it fits, else a contents page. */
  parent: PageDraft;
  /** The parts in order; empty when the body fits in one page. */
  parts: PageDraft[];
}

/** The longest prefix of `s` within `max` UTF-8 bytes, ending on a code point; prefers the last newline. */
function prefixWithin(s: string, max: number): string {
  let bytes = 0;
  let end = 0;
  for (const ch of s) {
    const b = utf8Bytes(ch);
    if (bytes + b > max) break;
    bytes += b;
    end += ch.length;
  }
  const cut = s.slice(0, end);
  const nl = cut.lastIndexOf("\n");
  return nl > 0 && nl < cut.length - 1 ? cut.slice(0, nl + 1) : cut;
}

/** Cut `text` after every match of `boundary` (zero-width), keeping all characters. */
function cutBefore(text: string, boundary: RegExp): string[] {
  const out: string[] = [];
  let start = 0;
  for (const m of text.matchAll(boundary)) {
    const at = m.index;
    if (at > start) {
      out.push(text.slice(start, at));
      start = at;
    }
  }
  out.push(text.slice(start));
  return out.filter(p => p.length > 0);
}

function pieces(body: string, max: number): string[] {
  const out: string[] = [];
  for (const section of cutBefore(body, /(?<=\n)(?=#{1,6} )/g)) {
    if (utf8Bytes(section) <= max) { out.push(section); continue; }
    for (const para of cutBefore(section, /(?<=\n\n)/g)) {
      let rest = para;
      while (utf8Bytes(rest) > max) {
        const head = prefixWithin(rest, max);
        out.push(head);
        rest = rest.slice(head.length);
      }
      if (rest.length > 0) out.push(rest);
    }
  }
  return out;
}

export function splitLargeDocument(input: PageDraft & { maxPartBytes?: number }): SplitDocument {
  const max = input.maxPartBytes ?? DEFAULT_SPLIT_PART_BYTES;
  if (!Number.isInteger(max) || max < MIN_PART_BYTES) {
    throw new Error(`maxPartBytes must be a whole number of at least ${MIN_PART_BYTES} bytes`);
  }
  const { slug, title, body } = input;
  if (utf8Bytes(body) <= max) return { parent: { slug, title, body }, parts: [] };

  const bodies: string[] = [];
  let current = "";
  for (const piece of pieces(body, max)) {
    if (current.length > 0 && utf8Bytes(current) + utf8Bytes(piece) > max) {
      bodies.push(current);
      current = "";
    }
    current += piece;
  }
  if (current.length > 0) bodies.push(current);

  const parts = bodies.map((partBody, i) => ({
    slug: `${slug}/part-${String(i + 1).padStart(3, "0")}`,
    title: `${title} — part ${i + 1}`,
    body: partBody,
  }));
  const contents = [
    `# ${title}`,
    "",
    `This document is split into ${parts.length} parts.`,
    "",
    ...parts.map((p, i) => `- [[${p.slug}]] — part ${i + 1}`),
    "",
  ].join("\n");
  return { parent: { slug, title, body: contents }, parts };
}
