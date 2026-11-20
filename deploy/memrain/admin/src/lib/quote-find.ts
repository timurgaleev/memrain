// Where a quoted passage sits in a page's rendered text, which the renderer
// splits across many text nodes (bold, links, list items). Free of DOM so the
// root test runner can load it: the caller passes each text node's content
// and turns the positions back into a Range. The folding follows the
// server's quote check (synthesis/quote-verify.ts), which matched the quote
// against the page's markdown.

export interface QuoteSpan {
  /** [text node index, offset] of the first character. */
  start: [number, number];
  /** [text node index, offset] just past the last character. */
  end: [number, number];
}

const FOLD: Record<string, string> = { "‘": "'", "’": "'", "ʼ": "'", "“": "\"", "”": "\"", "–": "-", "—": "-", "−": "-" };
/** Markdown emphasis and code marks are formatting, not words. */
const SKIP = new Set(["*", "`"]);

function foldChar(ch: string): string {
  const f = FOLD[ch] ?? ch;
  const lower = f.toLowerCase();
  return lower.length === 1 ? lower : f;
}

/** Case, spacing, typography and marks folded, a trailing stop dropped; an elided quote keeps its first part. */
function foldQuote(quote: string): string {
  const head = quote.split(/\[\.\.\.\]|\[…\]|\.\.\.|…/).find((p) => p.trim() !== "") ?? "";
  let out = "";
  for (const ch of head.trim()) {
    if (/\s/.test(ch)) {
      if (!out.endsWith(" ")) out += " ";
    } else if (!SKIP.has(ch)) {
      out += foldChar(ch);
    }
  }
  return out.trimEnd().replace(/[.,;:!?]+$/, "");
}

/**
 * `blockStarts` names the nodes that begin a new block (a paragraph, a list
 * item): a space is read before each, as the markdown had a line break there.
 */
export function locateQuote(texts: readonly string[], quote: string, blockStarts: readonly number[] = []): QuoteSpan | null {
  const needle = foldQuote(quote);
  if (needle === "") return null;
  const breaks = new Set(blockStarts);
  let hay = "";
  const at: Array<[number, number]> = [];
  texts.forEach((text, i) => {
    if (breaks.has(i) && hay !== "" && !hay.endsWith(" ")) {
      hay += " ";
      at.push([i, 0]);
    }
    for (let j = 0; j < text.length; j++) {
      const ch = text[j]!;
      if (SKIP.has(ch)) continue;
      if (/\s/.test(ch)) {
        if (hay.endsWith(" ")) continue;
        hay += " ";
      } else {
        hay += foldChar(ch);
      }
      at.push([i, j]);
    }
  });
  const found = hay.indexOf(needle);
  if (found === -1) return null;
  const [lastNode, lastOffset] = at[found + needle.length - 1]!;
  return { start: at[found]!, end: [lastNode, lastOffset + 1] };
}
