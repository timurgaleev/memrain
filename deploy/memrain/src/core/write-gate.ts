/**
 * Write gate — a deterministic check, run before outside or agent text becomes
 * memory, for text that reads as instructions to an AI: directives that try to
 * replace the reader's instructions, chat-template role markers, text shaped
 * like a tool call, requests to send data out, and directives aimed at the
 * memory itself. No model is called; the pattern table lives in
 * write-gate-patterns.ts.
 *
 * The detector never quotes what it matched: a result names the field, the
 * family and the pattern, so audit rows and error messages cannot echo the
 * text that tripped it.
 */
import { wellFormForText } from "./well-form.ts";
import { WRITE_GATE_PATTERNS, type GateFamily, type GatePattern } from "./write-gate-patterns.ts";

/** Bump whenever the pattern table or the normalization changes. */
export const WRITE_GATE_DETECTOR_VERSION = "write-gate/v1";

export interface GateField { field: string; text: string }
export interface GateMatch { field: string; family: GateFamily; pattern: string }
export interface DetectorResult {
  flagged: boolean;
  families: GateFamily[];
  matches: GateMatch[];
  detector_version: string;
}

// Invisible characters an attacker can thread through a word (soft hyphen,
// zero-width and bidi controls, joiners, variation selectors, BOM, tag
// characters): the Unicode Default_Ignorable_Code_Point set. Vertical tab and
// form feed are plain whitespace to both views and need no mapping.
const INVISIBLE = /\p{Default_Ignorable_Code_Point}/gu;
const LINE_BREAKS = /\r\n?|[\u2028\u2029\u0085]/g;
const EMPHASIS = /[*_`~]+/g;
const NOT_WORDLIKE = /[^\p{L}\p{M}\p{N}'\- ]/gu;
// A run of three or more single letters each followed by exactly one space:
// "i g n o r e" -> "ignore". Wider gaps stay word separators.
const SPACED_LETTERS = /(^| )(\p{L}(?: \p{L}(?= |$)){2,})/gu;
const SPACES = / {2,}/g;
const WORD = /[\p{L}\p{M}\p{N}'-]+/gu;

// Look-alike letters, folded towards whichever script holds the word's majority.
const TO_LATIN: Record<string, string> = {
  "а": "a", "в": "b", "е": "e", "ё": "e", "к": "k", "м": "m", "н": "h", "о": "o", "р": "p", "с": "c",
  "т": "t", "у": "y", "х": "x", "і": "i", "ї": "i", "ј": "j", "ѕ": "s", "ԁ": "d", "һ": "h", "ӏ": "l",
  "ԛ": "q", "ԝ": "w", "α": "a", "ε": "e", "ι": "i", "κ": "k", "ν": "v", "ο": "o", "ρ": "p", "τ": "t",
  "υ": "u", "χ": "x",
};
const TO_CYRILLIC: Record<string, string> = {
  a: "а", b: "в", c: "с", e: "е", h: "н", k: "к", m: "м", o: "о", p: "р", t: "т", x: "х", y: "у",
};
const LEET: Record<string, string> = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t" };

function foldWord(word: string): string {
  let latin = 0;
  let cyrillic = 0;
  let greek = 0;
  let digits = 0;
  for (let i = 0; i < word.length; i++) {
    const c = word.charCodeAt(i);
    if (c >= 0x61 && c <= 0x7A) latin++;
    else if (c >= 0x30 && c <= 0x39) digits++;
    else if (c >= 0x400 && c <= 0x52F) cyrillic++;
    else if (c >= 0x370 && c <= 0x3FF) greek++;
  }
  if (latin === 0) return word;
  if (cyrillic > latin) return Array.from(word, ch => TO_CYRILLIC[ch] ?? ch).join("");
  if (cyrillic === 0 && greek === 0 && digits === 0) return word;
  const leet = digits > 0;
  return Array.from(word, ch => TO_LATIN[ch] ?? (leet ? LEET[ch] : undefined) ?? ch).join("");
}

function baseView(text: string): string {
  return wellFormForText(text)
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .replace(LINE_BREAKS, "\n")
    .toLowerCase();
}

/** Padded with a space on each side: prose patterns open with a literal space. */
function proseView(base: string): string {
  const words = base
    .replace(EMPHASIS, "")
    .replace(NOT_WORDLIKE, " ")
    .replace(SPACED_LETTERS, (_run, lead: string, letters: string) => lead + letters.replace(/ /g, ""))
    .replace(SPACES, " ")
    .replace(WORD, foldWord)
    .trim();
  return ` ${words} `;
}

/** Lines and sentences: the scope inside which a `seq` pattern's parts must meet. */
function segments(structural: string): string[] {
  return structural.split(/\n|[.!?;]\s+/);
}

function seqMatches(parts: readonly RegExp[], segs: readonly string[]): boolean {
  for (const seg of segs) {
    let from = 0;
    let ok = true;
    for (const part of parts) {
      const m = part.exec(seg.slice(from));
      if (!m) { ok = false; break; }
      from += m.index + m[0].length;
    }
    if (ok) return true;
  }
  return false;
}

function matches(p: GatePattern, prose: string, structural: string, segs: () => string[]): boolean {
  if (p.re) return p.re.test(p.view === "prose" ? prose : structural);
  return seqMatches(p.seq ?? [], segs());
}

/** Scan each field for instruction-like text. Pure; never throws on string input. */
export function detectInstructionLike(fields: readonly GateField[]): DetectorResult {
  const found: GateMatch[] = [];
  for (const { field, text } of fields) {
    if (!text || !text.trim()) continue;
    const structural = baseView(text);
    const prose = proseView(structural);
    let segs: string[] | null = null;
    const lazySegs = () => (segs ??= segments(structural));
    for (const p of WRITE_GATE_PATTERNS) {
      if (matches(p, prose, structural, lazySegs)) found.push({ field, family: p.family, pattern: p.name });
    }
  }
  const families = [...new Set(found.map(m => m.family))].sort();
  return { flagged: found.length > 0, families, matches: found, detector_version: WRITE_GATE_DETECTOR_VERSION };
}
