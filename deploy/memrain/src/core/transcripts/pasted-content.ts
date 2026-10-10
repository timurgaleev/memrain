/**
 * Claude Code paste blocks. When a user pastes into the Claude Code prompt,
 * the session log records the expanded text wrapped as
 *
 *   <pasted_content id="2830">
 *   …pasted text…
 *   </pasted_content id="2830">
 *
 * (the closing tag repeats the id). Pasted text is usually someone else's
 * words — an email, an article, a log — so it must never become a fact about
 * the user. Transcript pages keep the paste with its tags (recall and search
 * still see it); only fact extraction strips it before the model reads the
 * turn.
 *
 * Linear: one forward scan with indexOf, tags bounded to one short line.
 */

const OPEN = "<pasted_content";
const CLOSE = "</pasted_content";
/** An unclosed paste is stripped to the end of the text only when its opening
 *  tag has the exact attribute shape the harness writes. */
const HARNESS_OPEN_RE = /^<pasted_content id="[^"<>\r\n]*">$/;
const MAX_TAG_CHARS = 256;

/** Index just past the `>` of a tag whose name ends at `from`, or -1 when the
 *  text there does not continue a tag (name boundary, one line, bounded). */
function tagEnd(text: string, from: number): number {
  const first = text[from];
  if (first !== ">" && first !== " " && first !== "\t") return -1;
  const limit = Math.min(text.length, from + MAX_TAG_CHARS);
  for (let i = from; i < limit; i++) {
    const c = text[i];
    if (c === ">") return i + 1;
    if (c === "<" || c === "\n" || c === "\r") return -1;
  }
  return -1;
}

function findClose(text: string, from: number): number {
  for (let at = text.indexOf(CLOSE, from); at >= 0; at = text.indexOf(CLOSE, at + CLOSE.length)) {
    const end = tagEnd(text, at + CLOSE.length);
    if (end >= 0) return end;
  }
  return -1;
}

/**
 * Remove every paste block (`<pasted_content …>…</pasted_content …>`), plus an
 * unclosed harness-shaped tail. Each removed block leaves one space so the
 * words around it never merge. `stripped` counts removed blocks; a malformed
 * tag is left as text.
 */
export function stripPastedContent(text: string): { text: string; stripped: number } {
  if (!text.includes(OPEN)) return { text, stripped: 0 };
  let out = "";
  let pos = 0;
  let stripped = 0;
  // Once no closing tag follows some point, none follows any later point:
  // remembering that keeps a run of unclosed openers from rescanning the tail.
  let noCloseAhead = false;
  let at = text.indexOf(OPEN, pos);
  while (at >= 0) {
    const openEnd = tagEnd(text, at + OPEN.length);
    if (openEnd < 0) {
      at = text.indexOf(OPEN, at + OPEN.length);
      continue;
    }
    const closeEnd = noCloseAhead ? -1 : findClose(text, openEnd);
    if (closeEnd < 0) noCloseAhead = true;
    if (closeEnd >= 0) {
      out += `${text.slice(pos, at)} `;
      pos = closeEnd;
      stripped++;
      at = text.indexOf(OPEN, pos);
      continue;
    }
    if (HARNESS_OPEN_RE.test(text.slice(at, openEnd))) {
      out += `${text.slice(pos, at)} `;
      pos = text.length;
      stripped++;
      break;
    }
    at = text.indexOf(OPEN, openEnd);
  }
  return { text: out + text.slice(pos), stripped };
}

/** True when the text held at least one paste block and nothing else. */
export function isPasteOnly(text: string): boolean {
  const r = stripPastedContent(text);
  return r.stripped > 0 && r.text.trim().length === 0;
}
