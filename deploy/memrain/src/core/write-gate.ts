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
import { createHash } from "node:crypto";
import { neutralizeOutsideText } from "./neutralize-outside-text.ts";
import { wellFormForText } from "./well-form.ts";
import { MAX_PRECEDING_CHARS, WRITE_GATE_PATTERNS, type GateFamily, type GatePattern } from "./write-gate-patterns.ts";
import type { TrustTier } from "./trust-tier.ts";

/** Bump whenever the pattern table or the normalization changes. */
export const WRITE_GATE_DETECTOR_VERSION = "write-gate/v2";

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
// form feed are plain whitespace to every view and need no mapping.
const INVISIBLE = /\p{Default_Ignorable_Code_Point}/gu;
// Tag characters mirror printable ASCII invisibly, and a model reads them:
// decode them so hidden text is scanned rather than dropped.
const TAG_ASCII = /[\u{E0020}-\u{E007E}]/gu;
const revealTag = (ch: string) => String.fromCharCode(ch.codePointAt(0)! - 0xE0000);
const HORIZONTAL_SPACE = /[^\S\n]+/g;
const LINE_BREAKS = /\r\n?|[\u2028\u2029\u0085]/g;
const EMPHASIS = /[*_`~]+/g;
const NOT_WORDLIKE = /[^\p{L}\p{M}\p{N}'\- ]/gu;
const LETTER = /^\p{L}$/u;

/**
 * Joins a run of three or more single letters each followed by exactly one
 * space: "i g n o r e" -> "ignore". Wider gaps stay word separators. A single
 * forward scan rather than a regex, because the regex form fell off a
 * performance cliff on long runs in some JavaScript engines.
 */
export function joinSpacedLetters(text: string): string {
  const letterAt = (i: number): string | null => {
    const cp = text.codePointAt(i);
    if (cp === undefined) return null;
    const ch = String.fromCodePoint(cp);
    return LETTER.test(ch) ? ch : null;
  };
  let out = "";
  let copied = 0;
  let i = 0;
  while (i < text.length) {
    const first = i === 0 || text[i - 1] === " " ? letterAt(i) : null;
    if (!first) { i++; continue; }
    const letters = [first];
    let end = i + first.length;
    while (text[end] === " ") {
      const next = letterAt(end + 1);
      if (!next) break;
      const after = end + 1 + next.length;
      if (after !== text.length && text[after] !== " ") break;
      letters.push(next);
      end = after;
    }
    if (letters.length >= 3) {
      out += text.slice(copied, i) + letters.join("");
      copied = end;
      i = end;
    } else {
      i++;
    }
  }
  return copied === 0 ? text : out + text.slice(copied);
}
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
// Look-alikes from no alphabet the brain's owners write in (Cyrillic letters
// outside Russian and Ukrainian, small capitals, dotless i, Armenian): a word
// that uses one is spelling Latin, even with no Latin letter in it.
const FOREIGN_TO_LATIN: Record<string, string> = {
  "ԁ": "d", "ԝ": "w", "ԛ": "q", "ӏ": "l", "һ": "h", "ѕ": "s", "ј": "j", "ı": "i", "ɑ": "a",
  "ᴀ": "a", "ʙ": "b", "ᴄ": "c", "ᴅ": "d", "ᴇ": "e", "ɢ": "g", "ʜ": "h", "ɪ": "i", "ᴊ": "j", "ᴋ": "k",
  "ʟ": "l", "ᴍ": "m", "ɴ": "n", "ᴏ": "o", "ᴘ": "p", "ʀ": "r", "ꜱ": "s", "ᴛ": "t", "ᴜ": "u", "ᴠ": "v",
  "ᴡ": "w", "ʏ": "y", "ᴢ": "z", "օ": "o", "ո": "n", "ս": "u", "հ": "h",
};
// Greek capitals whose lower case looks like another Latin letter (Ν -> ν reads
// as "v"): mapped before lower-casing, inside words that also hold Latin letters.
const GREEK_CAPITAL_TO_LATIN: Record<string, string> = { "Β": "B", "Η": "H", "Μ": "M", "Ν": "N", "Υ": "Y", "Ζ": "Z" };
const GREEK_CAPITALS = /[ΒΗΜΝΥΖ]/g;
const HAS_GREEK_CAPITAL = /[ΒΗΜΝΥΖ]/;
const HAS_ASCII_LETTER = /[a-z]/i;

/**
 * A word made only of Latin letters and their look-alikes reads as Latin; a
 * mixed word whose Latin letters all have Cyrillic twins reads as Cyrillic;
 * otherwise the majority script wins. Digits in a Latin word read as letters.
 */
function foldWord(word: string): string {
  let latin = 0;
  let cyrillic = 0;
  let digits = 0;
  let foreign = 0;
  let unmapped = 0;
  let nonAscii = false;
  for (const ch of word) {
    const c = ch.codePointAt(0)!;
    if (c >= 0x61 && c <= 0x7A) latin++;
    else if (c >= 0x30 && c <= 0x39) digits++;
    else {
      nonAscii = true;
      if (FOREIGN_TO_LATIN[ch]) foreign++;
      else {
        if (c >= 0x400 && c <= 0x52F) cyrillic++;
        if (!TO_LATIN[ch] && LETTER.test(ch)) unmapped++;
      }
    }
  }
  if (latin === 0 && foreign === 0) return word;
  const toLatin = () => Array.from(word, ch => FOREIGN_TO_LATIN[ch] ?? TO_LATIN[ch] ?? (digits > 0 ? LEET[ch] : undefined) ?? ch).join("");
  if (unmapped === 0) return nonAscii || digits > 0 ? toLatin() : word;
  const latinHasTwins = cyrillic > 0 && Array.from(word).every(ch => !/[a-z]/.test(ch) || TO_CYRILLIC[ch] !== undefined);
  if (latinHasTwins || cyrillic > latin) return Array.from(word, ch => TO_CYRILLIC[ch] ?? ch).join("");
  return toLatin();
}

// HTML character references, read once: "&#105;gnore" is "ignore" to a reader.
const ENTITY = /&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|(amp|lt|gt|quot|apos|nbsp));/gi;
const NAMED_ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
function decodeEntity(whole: string, dec?: string, hex?: string, name?: string): string {
  if (name) return NAMED_ENTITY[name.toLowerCase()] ?? whole;
  const cp = dec !== undefined ? Number(dec) : Number.parseInt(hex ?? "", 16);
  return Number.isInteger(cp) && cp > 0 && cp <= 0x10FFFF && (cp < 0xD800 || cp > 0xDFFF) ? String.fromCodePoint(cp) : whole;
}
// Marks no precomposed letter absorbed (a strike-through overlay) left on a Latin letter.
const LATIN_MARKS = /(?<=[a-z])\p{Mn}+/gu;
// Inline markup and Markdown emphasis or code marks ("al**ways", "<b>al</b>ways",
// "`password`"), and single letters joined by one punctuation mark
// ("i-g-n-o-r-e"). A mark right after a colon stays, so a speaker label
// ("**Assistant:**") still reads as a label rather than as an address.
const INLINE_TAG = /<\/?(?:[bisu]|em|strong|span|del|ins|mark|sub|sup|small|big|font|code|tt)(?:\s[^<>]{0,200})?>/g;
const EMPHASIS_MARKS = /(?<!:)[*_~`]+/g;
const SEPARATED_LETTERS = /(?<![\p{L}\p{N}])\p{L}(?:[-._]\p{L}){2,}(?![\p{L}\p{N}])/gu;
const ENCODED_AT = /(?<=[a-z0-9._+-])%40(?=[a-z0-9])/g;

// Each optional step runs only when its trigger is in the text: most text is plain ASCII.
const NON_ASCII = /[^\t\n\r\u0020-\u007E]/;
const HAS_MARK = /\p{Mn}/u;
const HAS_SEPARATED = /\p{L}[-._]\p{L}[-._]\p{L}/u;
const HAS_EMPHASIS = /[*_~`]/;

function baseView(text: string): string {
  let t = wellFormForText(text);
  if (t.includes("&")) t = t.replace(ENTITY, decodeEntity);
  if (NON_ASCII.test(t)) {
    t = t.replace(TAG_ASCII, revealTag).normalize("NFKC").replace(INVISIBLE, "");
    if (HAS_GREEK_CAPITAL.test(t)) t = t.replace(WORD, w => (HAS_ASCII_LETTER.test(w) ? w.replace(GREEK_CAPITALS, ch => GREEK_CAPITAL_TO_LATIN[ch] ?? ch) : w));
  }
  t = t.replace(LINE_BREAKS, "\n").toLowerCase();
  return HAS_MARK.test(t) ? t.replace(LATIN_MARKS, "") : t;
}

/** What the word-level views read: inline markup and emphasis gone, separated letters joined. */
function wordView(base: string): string {
  let t = base.includes("<") ? base.replace(INLINE_TAG, "") : base;
  if (HAS_EMPHASIS.test(t)) t = t.replace(EMPHASIS_MARKS, "");
  return HAS_SEPARATED.test(t) ? t.replace(SEPARATED_LETTERS, m => m.replace(/[-._]/g, "")) : t;
}

/** Padded with a space on each side: prose patterns open with a literal space. */
function proseView(base: string): string {
  const words = joinSpacedLetters(base
    .replace(EMPHASIS, "")
    .replace(NOT_WORDLIKE, " "))
    .replace(SPACES, " ")
    .replace(WORD, foldWord)
    .trim();
  return ` ${words} `;
}

/** Punctuation and line breaks kept, look-alikes folded: what sentence-level rules read. */
function sentenceView(words: string): string {
  return joinSpacedLetters(words.replace(ENCODED_AT, "@").replace(HORIZONTAL_SPACE, " ")).replace(WORD, foldWord);
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

// Global copies for walking every match of a `preceded` pattern; the table's own regexes stay stateless.
const ITERATORS: ReadonlyMap<string, RegExp> = new Map(
  WRITE_GATE_PATTERNS.filter(p => p.preceded && p.re).map(p => [p.name, new RegExp(p.re!.source, `${p.re!.flags}g`)]),
);

/**
 * True when some match of `p` has its context before it. Every match is
 * tried, one character on from the last start, since a rejected match can
 * overlap the one that holds. The text start counts as a line start.
 */
function matchesInContext(p: GatePattern, text: string): boolean {
  const rx = ITERATORS.get(p.name)!;
  rx.lastIndex = 0;
  for (let m = rx.exec(text); m; m = rx.exec(text)) {
    const at = m.index;
    rx.lastIndex = at + 1;
    const before = at > MAX_PRECEDING_CHARS ? text.slice(at - MAX_PRECEDING_CHARS, at) : `\n${text.slice(0, at)}`;
    if (p.near && !p.near.test(before)) continue;
    const context = p.preceded!.exec(before);
    if (context && !context.groups?.["neg"]) return true;
  }
  return false;
}

interface Views { prose: string; structural: string; sentence: string; segs: () => string[] }

function matches(p: GatePattern, v: Views): boolean {
  if (!p.re) return seqMatches(p.seq ?? [], v.segs());
  const text = p.view === "prose" ? v.prose : p.view === "sentence" ? v.sentence : v.structural;
  if (p.requires && !p.requires.every(r => r.test(text))) return false;
  return p.preceded ? matchesInContext(p, text) : p.re.test(text);
}

/** Scan each field for instruction-like text. Pure; never throws on string input. */
export function detectInstructionLike(fields: readonly GateField[]): DetectorResult {
  const found: GateMatch[] = [];
  for (const { field, text } of fields) {
    if (!text || !text.trim()) continue;
    const structural = baseView(text);
    let segs: string[] | null = null;
    const words = wordView(structural);
    const views: Views = { structural, prose: proseView(words), sentence: sentenceView(words), segs: () => (segs ??= segments(structural)) };
    for (const p of WRITE_GATE_PATTERNS) {
      if (matches(p, views)) found.push({ field, family: p.family, pattern: p.name });
    }
  }
  const families = [...new Set(found.map(m => m.family))].sort();
  return { flagged: found.length > 0, families, matches: found, detector_version: WRITE_GATE_DETECTOR_VERSION };
}

// --- Verdict: who wrote it, what the operator asked for, what to stamp ------

/** `content_flag.reason` / `quarantine.reason` the gate stamps. */
export const INSTRUCTION_LIKE_REASON = "instruction_like";
/** Frontmatter record of the gate's verdict on the current title and body. */
export const WRITE_GATE_KEY = "write_gate";
/** The owner's approval of a held document, bound to its title and body. */
export const WRITE_GATE_APPROVAL_KEY = "write_gate_approval";

/**
 * `flag`        store, mark `content_flag`, frame strongly on read (default for outside text)
 * `quarantine`  store hidden from search and queue a hold for the owner
 * `reject`      refuse the write (outside text only)
 * `off`         do not run
 */
export type WriteGateMode = "off" | "flag" | "quarantine" | "reject";
/**
 * The writer's trust tier as the gate reads it (core/trust-tier.ts): `external`
 * text and `agent` text each have a mode of their own; a member is gated as an
 * agent, and the owner is not gated.
 */
export type WriteGateOrigin = Extract<TrustTier, "external" | "agent">;

export function writeGateOrigin(tier: TrustTier): WriteGateOrigin | null {
  if (tier === "owner") return null;
  return tier === "external" ? "external" : "agent";
}

/**
 * The matched families that can hold content back from this origin. Agents
 * write notes about the tools they use ("call page_append instead of ..."),
 * so text from an agent that is only shaped like a tool call is flagged,
 * never held; from outside it is held like any other family.
 */
export function holdingFamilies(origin: WriteGateOrigin, families: readonly GateFamily[]): GateFamily[] {
  return origin === "agent" ? families.filter(f => f !== "tool_call_shape") : [...families];
}
export type WriteGateAction = "allow" | "flag" | "quarantine" | "reject";

export interface WriteGateVerdict {
  action: WriteGateAction;
  origin: WriteGateOrigin;
  families: GateFamily[];
  detector_version: string;
  binding: string;
  /** The detector failed; the verdict fell back to quarantine. */
  error?: true;
  /** Held content the owner approved: released, still flagged. */
  approved?: true;
}

/** Refused by the gate in `reject` mode. The message names families only. */
export class WriteGateBlockError extends Error {
  readonly code = "WRITE_GATE_INSTRUCTION_LIKE";
  readonly verdict: WriteGateVerdict;
  constructor(verdict: WriteGateVerdict) {
    super(`Write refused: the text reads as instructions to an AI (${verdict.families.join(", ")})`);
    this.name = "WriteGateBlockError";
    this.verdict = verdict;
  }
}

const EXTERNAL_MODES: readonly WriteGateMode[] = ["off", "flag", "quarantine", "reject"];
const AGENT_MODES: readonly WriteGateMode[] = ["off", "flag", "quarantine"];
const warnedValues = new Set<string>();

function readMode(env: Record<string, string | undefined>, key: string, allowed: readonly WriteGateMode[], fallback: WriteGateMode): WriteGateMode {
  const raw = env[key]?.trim().toLowerCase();
  if (!raw) return fallback;
  if ((allowed as readonly string[]).includes(raw)) return raw as WriteGateMode;
  if (!warnedValues.has(`${key}=${raw}`)) {
    warnedValues.add(`${key}=${raw}`);
    console.warn(`[write-gate] ${key} must be one of ${allowed.join("|")}; using ${fallback}`);
  }
  return fallback;
}

/**
 * The mode for one write. Outside text defaults to `flag`; agent text to
 * `off`, since agents legitimately write notes that quote instructions. A
 * source listed in MEMRAIN_WRITE_GATE_QUARANTINE_SOURCES upgrades `flag` to
 * `quarantine`; it never loosens `reject` or turns on a disabled gate.
 */
export function resolveWriteGateMode(
  origin: WriteGateOrigin,
  sourceId: string,
  env: Record<string, string | undefined> = process.env,
): WriteGateMode {
  const mode = origin === "external"
    ? readMode(env, "MEMRAIN_WRITE_GATE_EXTERNAL", EXTERNAL_MODES, "flag")
    : readMode(env, "MEMRAIN_WRITE_GATE_AGENT", AGENT_MODES, "off");
  if (mode !== "flag") return mode;
  const optIn = (env["MEMRAIN_WRITE_GATE_QUARANTINE_SOURCES"] ?? "").split(",").map(s => s.trim()).filter(Boolean);
  return optIn.includes(sourceId) ? "quarantine" : mode;
}

/**
 * Hash binding a verdict or an approval to every field the gate assessed
 * (title, body, frontmatter strings), so an approval never covers text the
 * owner did not see.
 */
export function writeGateBinding(fields: readonly GateField[]): string {
  const payload = JSON.stringify(["write_gate/v2", ...fields.map(f => [f.field, wellFormForText(f.text)])]);
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

interface WriteGateApproval { binding: string; hold_id: number; approved_at: string }

function parseApproval(value: unknown): WriteGateApproval | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { binding, hold_id, approved_at } = value as Record<string, unknown>;
  return typeof binding === "string" && /^[0-9a-f]{64}$/.test(binding) && typeof hold_id === "number" && typeof approved_at === "string"
    ? { binding, hold_id, approved_at }
    : null;
}

export interface WriteGateInput {
  origin: WriteGateOrigin;
  mode: WriteGateMode;
  fields: readonly GateField[];
  binding: string;
  /** The stored document's approval, if any; honoured only for the same binding. */
  approval?: unknown;
}

/** Pure verdict. A detector failure quarantines (fail closed) unless the gate is off. */
export function assessWriteGate(input: WriteGateInput, detect: typeof detectInstructionLike = detectInstructionLike): WriteGateVerdict {
  const base = { origin: input.origin, binding: input.binding };
  if (input.mode === "off") return { ...base, action: "allow", families: [], detector_version: WRITE_GATE_DETECTOR_VERSION };
  let result: DetectorResult;
  try {
    result = detect(input.fields);
  } catch {
    return { ...base, action: "quarantine", families: [], detector_version: WRITE_GATE_DETECTOR_VERSION, error: true };
  }
  const verdict = { ...base, families: result.families, detector_version: result.detector_version };
  if (!result.flagged) return { ...verdict, action: "allow" };
  if (input.mode === "quarantine" && holdingFamilies(input.origin, result.families).length === 0) return { ...verdict, action: "flag" };
  if (input.mode === "quarantine" && parseApproval(input.approval)?.binding === input.binding) {
    return { ...verdict, action: "quarantine", approved: true };
  }
  return { ...verdict, action: input.mode };
}

/** The stored verdict, when it was made on the same title and body. */
export function carriedWriteGate(stored: Record<string, unknown> | null | undefined, binding: string): WriteGateVerdict | null {
  const v = stored?.[WRITE_GATE_KEY];
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (r["binding"] !== binding || (r["action"] !== "flag" && r["action"] !== "quarantine")) return null;
  if (r["origin"] !== "external" && r["origin"] !== "agent") return null;
  const families = Array.isArray(r["families"]) ? r["families"].filter((f): f is GateFamily => typeof f === "string") : [];
  return {
    action: r["action"],
    origin: r["origin"],
    families,
    detector_version: typeof r["detector_version"] === "string" ? r["detector_version"] : WRITE_GATE_DETECTOR_VERSION,
    binding,
    ...(r["error"] === true ? { error: true as const } : {}),
    ...(r["action"] === "quarantine" && parseApproval(stored?.[WRITE_GATE_APPROVAL_KEY])?.binding === binding ? { approved: true as const } : {}),
  };
}

/**
 * A new frontmatter object carrying the verdict. A flag or released hold
 * stamps `content_flag`; an unreleased hold also stamps `quarantine`, unless
 * the content-sanity gate already holds the document for its own reason. No
 * `embed_skip`: a held document keeps its vectors so an approval needs no
 * re-embed, and the quarantine filter already keeps it out of both arms.
 */
export function stampWriteGate(
  frontmatter: Record<string, unknown>,
  verdict: WriteGateVerdict | null,
  storedApproval?: unknown,
): Record<string, unknown> {
  if (!verdict || verdict.action === "allow" || verdict.action === "reject") return frontmatter;
  const detail = verdict.error ? "detector_error" : verdict.families.join(", ");
  const out: Record<string, unknown> = {
    ...frontmatter,
    content_flag: { reason: INSTRUCTION_LIKE_REASON, detail },
    [WRITE_GATE_KEY]: {
      action: verdict.action,
      origin: verdict.origin,
      families: verdict.families,
      detector_version: verdict.detector_version,
      binding: verdict.binding,
      ...(verdict.error ? { error: true } : {}),
    },
  };
  if (verdict.action === "quarantine") {
    if (verdict.approved) out[WRITE_GATE_APPROVAL_KEY] = parseApproval(storedApproval);
    else if (!Object.hasOwn(frontmatter, "quarantine")) out["quarantine"] = { reason: INSTRUCTION_LIKE_REASON, detail };
  }
  return out;
}

/** Keys the gate stamps; never taken from a remote writer's header. */
export const WRITE_GATE_OWNED_KEYS: readonly string[] = Object.freeze([WRITE_GATE_KEY, WRITE_GATE_APPROVAL_KEY]);

// Keys the indexer itself stamps, which carry no writer-controlled text.
const SYSTEM_FRONTMATTER = new Set(["page_content_hash", "page_truth_hash", "page_title"]);

/** Every string under `value` (nested keys included), depth first, one per line. */
function nestedStrings(value: unknown): string {
  const out: string[] = [];
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) for (let i = v.length - 1; i >= 0; i--) stack.push(v[i]);
    else if (v && typeof v === "object") {
      const entries = Object.entries(v as Record<string, unknown>);
      for (let i = entries.length - 1; i >= 0; i--) stack.push(entries[i]![1], entries[i]![0]);
    }
  }
  return out.join("\n");
}

/** The writer-controlled text of a document: title, body, and every frontmatter string. */
export function writeGateFields(title: string, body: string, frontmatter: Record<string, unknown>, gateOwned: readonly string[]): GateField[] {
  const fields: GateField[] = [{ field: "title", text: title }, { field: "body", text: body }];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (SYSTEM_FRONTMATTER.has(key) || gateOwned.includes(key)) continue;
    const text = nestedStrings(value);
    if (text) fields.push({ field: `frontmatter.${key}`, text });
  }
  return fields;
}

/** Up to 200 characters of the first field that tripped, neutralized and on one line. */
export function writeGateExcerpt(fields: readonly GateField[], detect: typeof detectInstructionLike = detectInstructionLike): string {
  let first: GateField | undefined;
  try {
    const tripped = new Set(detect(fields).matches.map(m => m.field));
    first = fields.find(f => tripped.has(f.field));
  } catch {
    first = undefined;
  }
  const text = neutralizeOutsideText(first?.text ?? fields.find(f => f.field === "body")?.text ?? "").replace(/\s+/g, " ").trim();
  return Array.from(text).slice(0, 200).join("");
}
