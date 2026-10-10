/**
 * Model-free quote check for a synthesized answer. Every quoted span of four
 * or more words is looked up in the evidence the answer was written from:
 *
 *   grounded    the span is in the evidence (after case, whitespace and
 *               typographic folding) — left as written.
 *   repaired    a near match (character-bigram Dice >= 0.9 against a window
 *               of the evidence) with the same negations and the same numbers
 *               — the span is replaced with the evidence's own words, so the
 *               quotation marks stay truthful. A near match that differs in a
 *               "not" or in a number differs in meaning, so it is unverified.
 *   unverified  found nowhere — the quotation marks are removed and the text
 *               is marked "[unverified]", so no reader takes it for a quote.
 *
 * Shorter quoted spans (titles, terms, scare quotes) are not checked. Pure.
 */

export const UNVERIFIED_QUOTE_MARK = "[unverified]";

const MIN_QUOTE_WORDS = 4;
const NEAR_MATCH_DICE = 0.9;
/** A window whose length differs from the quote's by more than this ratio cannot reach the Dice threshold. */
const MIN_LENGTH_RATIO = NEAR_MATCH_DICE / (2 - NEAR_MATCH_DICE);
const MAX_QUOTES = 50;
const UNVERIFIED_TEXT_CHARS = 300;

/**
 * Straight or curly double quotes, „German“ and «guillemet» pairs; one line,
 * bounded length. A straight quote right after a digit is an inch mark (27"),
 * not an opener.
 */
const QUOTE_SPAN = /(?<!\d)["“]([^"“”\n]{1,600})["”]|„([^„“”\n]{1,600})[“”]|«([^«»\n]{1,600})»/g;
const TRAILING_PUNCT = new Set([".", ",", ";", ":", "!", "?"]);

function trimTrailingPunct(s: string): string {
  let end = s.length;
  while (end > 0 && TRAILING_PUNCT.has(s[end - 1]!)) end--;
  return s.slice(0, end);
}

export interface QuoteCheck {
  grounded: number;
  repaired: number;
  unverified: number;
}

export interface QuoteVerification {
  /** The answer with repaired and unquoted spans applied. */
  answer: string;
  /** The answer as the model wrote it. */
  answer_raw: string;
  quote_check: QuoteCheck;
  unverified_quotes: Array<{ text: string; reason: "quote_not_in_evidence" }>;
}

interface Folded {
  /** Lowercased, whitespace-collapsed, typography-folded text. */
  norm: string;
  /** Per code unit of `norm`: the start offset of its source character. */
  start: number[];
  /** Per code unit of `norm`: the end offset of its source character. */
  end: number[];
}

/** Bracketed elisions, folded to "..." like a bare ellipsis. */
const BRACKET_ELISIONS = ["[...]", "[…]"];

/** Fold for comparison, keeping an offset map back into the original string. */
function fold(s: string): Folded {
  let norm = "";
  const start: number[] = [];
  const end: number[] = [];
  let pendingSpace = false;
  let idx = 0;
  while (idx < s.length) {
    const i = idx;
    const elision = BRACKET_ELISIONS.find((e) => s.startsWith(e, i));
    const cp = elision ?? String.fromCodePoint(s.codePointAt(i)!);
    idx += cp.length;
    if (/\s/u.test(cp)) {
      pendingSpace = norm.length > 0;
      continue;
    }
    // Markdown emphasis and code marks are formatting, not words.
    if (cp === "*" || cp === "`") continue;
    let ch = cp;
    if (ch === "‘" || ch === "’" || ch === "ʼ") ch = "'";
    else if (ch === "“" || ch === "”") ch = '"';
    else if (ch === "–" || ch === "—" || ch === "−") ch = "-";
    else if (ch === "…" || elision) ch = "...";
    if (pendingSpace) {
      norm += " ";
      start.push(i);
      end.push(i);
      pendingSpace = false;
    }
    const low = ch.toLowerCase();
    norm += low;
    for (let k = 0; k < low.length; k++) {
      start.push(i);
      end.push(i + cp.length);
    }
  }
  return { norm, start, end };
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

function dice(a: Map<string, number>, aSize: number, b: string): number {
  const bSize = Math.max(0, b.length - 1);
  if (aSize + bSize === 0) return 0;
  const bm = bigrams(b);
  let shared = 0;
  for (const [g, n] of bm) shared += Math.min(n, a.get(g) ?? 0);
  return (2 * shared) / (aSize + bSize);
}

/** Word start/end offsets in a folded string (words are space-separated). */
function wordSpans(norm: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let s = -1;
  for (let i = 0; i <= norm.length; i++) {
    const space = i === norm.length || norm[i] === " ";
    if (space && s >= 0) {
      spans.push([s, i]);
      s = -1;
    } else if (!space && s < 0) {
      s = i;
    }
  }
  return spans;
}

const NEGATION_WORDS = new Set(["not", "never", "no", "не", "нет", "nicht", "kein", "keine", "keinen", "keinem", "keiner", "keines"]);

/** Negation tokens in order, from folded (lowercased) text. */
function negations(norm: string): string[] {
  const out: string[] = [];
  for (const w of norm.split(/[^\p{L}']+/u)) {
    if (NEGATION_WORDS.has(w)) out.push(w);
    else if (w.endsWith("n't")) out.push("n't");
  }
  return out;
}

/** A repair may change wording, never a negation or a number. */
function sameMeaningMarkers(a: string, b: string): boolean {
  const digitsA = a.match(/\d+/g) ?? [];
  const digitsB = b.match(/\d+/g) ?? [];
  return negations(a).join(" ") === negations(b).join(" ") && digitsA.join(" ") === digitsB.join(" ");
}

/** The best near-match window for `q` in one evidence block, as original text, or null. */
function nearMatch(q: string, block: Folded, original: string): { text: string; score: number } | null {
  const qWords = q.split(" ").length;
  const qGrams = bigrams(q);
  const qSize = Math.max(0, q.length - 1);
  const words = wordSpans(block.norm);
  let best: { from: number; to: number; score: number } | null = null;
  for (let w = 0; w < words.length; w++) {
    for (let len = Math.max(1, qWords - 1); len <= qWords + 1; len++) {
      const last = w + len - 1;
      if (last >= words.length) break;
      const from = words[w]![0];
      const to = words[last]![1];
      const span = to - from;
      if (Math.min(span, q.length) / Math.max(span, q.length) < MIN_LENGTH_RATIO) continue;
      const window = block.norm.slice(from, to);
      const score = dice(qGrams, qSize, window);
      if (score >= NEAR_MATCH_DICE && (!best || score > best.score) && sameMeaningMarkers(q, window)) {
        best = { from, to, score };
      }
    }
  }
  if (!best) return null;
  const text = original
    .slice(block.start[best.from]!, block.end[best.to - 1]!)
    .replace(/\s+/g, " ")
    .trim();
  return { text, score: best.score };
}

/** An elided quote ("a ... b") is grounded when its parts appear in order in one block. */
function elidedGrounded(parts: string[], blocks: Folded[]): boolean {
  return blocks.some((b) => {
    let from = 0;
    for (const p of parts) {
      const at = b.norm.indexOf(p, from);
      if (at < 0) return false;
      from = at + p.length;
    }
    return true;
  });
}

export function verifyQuotes(answer: string, evidence: readonly string[]): QuoteVerification {
  const out: QuoteVerification = {
    answer,
    answer_raw: answer,
    quote_check: { grounded: 0, repaired: 0, unverified: 0 },
    unverified_quotes: [],
  };
  const sources = evidence.filter((e) => e.trim().length > 0);
  const blocks = sources.map(fold);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  let checked = 0;

  for (const m of answer.matchAll(QUOTE_SPAN)) {
    if (checked >= MAX_QUOTES) break;
    const inner = (m[1] ?? m[2] ?? m[3])!;
    // A leading or trailing ellipsis only marks a cut; inner ones split the quote into parts.
    const parts = fold(inner)
      .norm.split("...")
      .map((p) => trimTrailingPunct(p.trim()).trim())
      .filter((p) => p.length > 0);
    if (parts.join(" ").split(" ").length < MIN_QUOTE_WORDS) continue;
    checked++;
    const q = parts[0]!;
    const spanStart = m.index ?? 0;
    const spanEnd = spanStart + m[0].length;

    if (parts.length > 1 ? elidedGrounded(parts, blocks) : blocks.some((b) => b.norm.includes(q))) {
      out.quote_check.grounded++;
      continue;
    }

    let best: { text: string; score: number } | null = null;
    if (parts.length === 1) {
      for (let i = 0; i < blocks.length; i++) {
        const hit = nearMatch(q, blocks[i]!, sources[i]!);
        if (hit && (!best || hit.score > best.score)) best = hit;
      }
    }
    if (best) {
      out.quote_check.repaired++;
      edits.push({ start: spanStart + 1, end: spanEnd - 1, text: best.text });
    } else {
      out.quote_check.unverified++;
      const flat = inner.replace(/\s+/g, " ").trim();
      out.unverified_quotes.push({
        text: flat.length > UNVERIFIED_TEXT_CHARS ? `${flat.slice(0, UNVERIFIED_TEXT_CHARS - 3)}...` : flat,
        reason: "quote_not_in_evidence",
      });
      edits.push({ start: spanStart, end: spanEnd, text: `${inner} ${UNVERIFIED_QUOTE_MARK}` });
    }
  }

  let body = answer;
  for (const e of edits.sort((a, b) => b.start - a.start)) {
    body = body.slice(0, e.start) + e.text + body.slice(e.end);
  }
  out.answer = body;
  return out;
}

/**
 * True when `quote` appears in `text` after the same folding `verifyQuotes`
 * uses (case, whitespace, typography, trailing punctuation, "..." elisions).
 */
export function isQuoteInText(quote: string, text: string): boolean {
  const parts = fold(quote)
    .norm.split("...")
    .map((p) => trimTrailingPunct(p.trim()).trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return false;
  return elidedGrounded(parts, [fold(text)]);
}

/** MEMRAIN_THINK_QUOTE_VERIFY: on unless set to 0/false/off/no. */
export function thinkQuoteVerifyEnabled(raw: string | undefined = process.env.MEMRAIN_THINK_QUOTE_VERIFY): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}
