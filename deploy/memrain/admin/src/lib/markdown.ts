import { isSlug, safeHref } from "./href.ts";
import type { SafeHref } from "./href.ts";

// A deliberately small markdown reader for stored page bodies. It never
// produces HTML: every construct becomes a typed node holding plain text, and
// the React layer renders text nodes only. Raw HTML in a body therefore shows
// up as literal text. The scanner walks each line once and finds closing
// delimiters through a memoised forward search, so adversarial input such as
// a long run of "[" or "*" stays linear.

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "link"; c: Inline[]; href: SafeHref }
  | { t: "wikilink"; slug: string; label: string }
  | { t: "image"; alt: string };

export type Block =
  | { t: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; c: Inline[] }
  | { t: "para"; c: Inline[] }
  | { t: "code"; lang: string; v: string }
  | { t: "list"; ordered: boolean; items: Inline[][] }
  | { t: "quote"; c: Block[] }
  | { t: "hr" };

export const MARKDOWN_MAX_CHARS = 200_000;

const MAX_INLINE_DEPTH = 4;
const MAX_QUOTE_DEPTH = 4;

/** indexOf with a per-needle memo: a search that already failed from an
 *  earlier position cannot succeed from a later one, and a hit at or past the
 *  new start is still the first hit. Starts only move forward in practice. */
function makeFinder(s: string): (needle: string, from: number) => number {
  const memo = new Map<string, { from: number; at: number }>();
  return (needle, from) => {
    const m = memo.get(needle);
    if (m && from >= m.from && (m.at === -1 || m.at >= from)) return m.at;
    const at = s.indexOf(needle, from);
    memo.set(needle, { from, at });
    return at;
  };
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
}

function stripLinkTitle(raw: string): string {
  const s = raw.trim();
  if (!s.endsWith("\"")) return s;
  const open = s.lastIndexOf(" \"", s.length - 2);
  return open > 0 ? s.slice(0, open).trim() : s;
}

function parseInline(src: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  if (src === "") return out;
  if (depth >= MAX_INLINE_DEPTH) return [{ t: "text", v: src }];
  const find = makeFinder(src);
  let buf = "";
  const flush = () => {
    if (buf !== "") {
      out.push({ t: "text", v: buf });
      buf = "";
    }
  };
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i] as string;
    const next = src[i + 1];

    if (ch === "\\" && next !== undefined && /[\\`*_[\]()!#>|-]/.test(next)) {
      buf += next;
      i += 2;
      continue;
    }

    if (ch === "`") {
      const close = find("`", i + 1);
      if (close > i + 1) {
        flush();
        out.push({ t: "code", v: src.slice(i + 1, close) });
        i = close + 1;
        continue;
      }
      buf += ch;
      i += 1;
      continue;
    }

    if (ch === "[" && next === "[") {
      const close = find("]]", i + 2);
      if (close > i + 2) {
        const inner = src.slice(i + 2, close);
        const bar = inner.indexOf("|");
        const slug = (bar === -1 ? inner : inner.slice(0, bar)).trim();
        const label = (bar === -1 ? slug : inner.slice(bar + 1)).trim() || slug;
        if (isSlug(slug)) {
          flush();
          out.push({ t: "wikilink", slug, label });
          i = close + 2;
          continue;
        }
      }
      buf += "[[";
      i += 2;
      continue;
    }

    if ((ch === "!" && next === "[") || ch === "[") {
      const start = ch === "!" ? i + 2 : i + 1;
      const close = find("]", start);
      if (close !== -1 && src[close + 1] === "(") {
        const paren = find(")", close + 2);
        if (paren !== -1) {
          const label = src.slice(start, close);
          const target = stripLinkTitle(src.slice(close + 2, paren));
          flush();
          if (ch === "!") out.push({ t: "image", alt: label });
          else out.push({ t: "link", c: parseInline(label, depth + 1), href: safeHref(target) });
          i = paren + 1;
          continue;
        }
      }
      buf += ch === "!" ? "![" : "[";
      i = start;
      continue;
    }

    if ((ch === "*" || ch === "_") && next === ch) {
      const delim = ch + ch;
      const close = find(delim, i + 2);
      if (close > i + 2) {
        flush();
        out.push({ t: "strong", c: parseInline(src.slice(i + 2, close), depth + 1) });
        i = close + 2;
        continue;
      }
      buf += delim;
      i += 2;
      continue;
    }

    if ((ch === "*" || ch === "_") && next !== undefined && next !== " " && !(ch === "_" && isWordChar(src[i - 1]))) {
      const close = find(ch, i + 1);
      if (close > i + 1 && src[close - 1] !== " " && !(ch === "_" && isWordChar(src[close + 1]))) {
        flush();
        out.push({ t: "em", c: parseInline(src.slice(i + 1, close), depth + 1) });
        i = close + 1;
        continue;
      }
    }

    buf += ch;
    i += 1;
  }
  flush();
  return out;
}

const HEADING_RE = /^ {0,3}(#{1,6})[ \t](.*)$/;
const FENCE_RE = /^ {0,3}(```|~~~)\s*([\w+-]*)/;
const BULLET_RE = /^ {0,3}[-*+][ \t](.*)$/;
const ORDERED_RE = /^ {0,3}\d{1,9}[.)][ \t](.*)$/;

/** "## Title ##" closes with optional hashes; trimmed by hand rather than with
 *  a lazy regex, which backtracks quadratically on long runs of "#". */
function trimClosingHashes(s: string): string {
  const t = s.trimEnd();
  let start = t.length;
  while (start > 0 && t[start - 1] === "#") start -= 1;
  if (start === t.length) return t;
  if (start === 0) return "";
  return t[start - 1] === " " || t[start - 1] === "\t" ? t.slice(0, start).trimEnd() : t;
}

function isHr(line: string): boolean {
  const s = line.replace(/[ \t]/g, "");
  if (s.length < 3) return false;
  const c = s[0];
  if (c !== "-" && c !== "*" && c !== "_") return false;
  for (const ch of s) if (ch !== c) return false;
  return true;
}

function listItem(line: string): { ordered: boolean; text: string } | null {
  const b = BULLET_RE.exec(line);
  if (b) return { ordered: false, text: (b[1] ?? "").trimStart() };
  const o = ORDERED_RE.exec(line);
  if (o) return { ordered: true, text: (o[1] ?? "").trimStart() };
  return null;
}

function startsBlock(line: string): boolean {
  return HEADING_RE.test(line) || FENCE_RE.test(line) || /^ {0,3}>/.test(line) || isHr(line) || listItem(line) !== null;
}

function parseBlocks(lines: string[], depth: number): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (line.trim() === "") {
      i += 1;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[1] as string;
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] as string).trimStart().startsWith(marker)) {
        body.push(lines[i] as string);
        i += 1;
      }
      i += 1; // closing fence (or end of input)
      blocks.push({ t: "code", lang: fence[2] ?? "", v: body.join("\n") });
      continue;
    }

    const h = HEADING_RE.exec(line);
    if (h) {
      const level = Math.min(6, (h[1] as string).length) as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({ t: "heading", level, c: parseInline(trimClosingHashes((h[2] ?? "").trimStart())) });
      i += 1;
      continue;
    }

    if (isHr(line)) {
      blocks.push({ t: "hr" });
      i += 1;
      continue;
    }

    if (/^ {0,3}>/.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i] as string)) {
        inner.push((lines[i] as string).replace(/^ {0,3}> ?/, ""));
        i += 1;
      }
      if (depth >= MAX_QUOTE_DEPTH) blocks.push({ t: "para", c: [{ t: "text", v: inner.join("\n") }] });
      else blocks.push({ t: "quote", c: parseBlocks(inner, depth + 1) });
      continue;
    }

    const first = listItem(line);
    if (first) {
      const items: string[] = [first.text];
      i += 1;
      while (i < lines.length) {
        const l = lines[i] as string;
        const item = listItem(l.replace(/^\s+/, ""));
        if (item) {
          items.push(item.text);
        } else if (l.trim() !== "" && /^\s/.test(l)) {
          items[items.length - 1] += ` ${l.trim()}`;
        } else {
          break;
        }
        i += 1;
      }
      blocks.push({ t: "list", ordered: first.ordered, items: items.map((t) => parseInline(t)) });
      continue;
    }

    const para: string[] = [line.trim()];
    i += 1;
    while (i < lines.length && (lines[i] as string).trim() !== "" && !startsBlock(lines[i] as string)) {
      para.push((lines[i] as string).trim());
      i += 1;
    }
    blocks.push({ t: "para", c: parseInline(para.join("\n")) });
  }
  return blocks;
}

export function parseMarkdown(src: string): { blocks: Block[]; truncated: boolean } {
  const text = typeof src === "string" ? src : "";
  const truncated = text.length > MARKDOWN_MAX_CHARS;
  const capped = truncated ? text.slice(0, MARKDOWN_MAX_CHARS) : text;
  return { blocks: parseBlocks(capped.replace(/\r\n?/g, "\n").split("\n"), 0), truncated };
}
