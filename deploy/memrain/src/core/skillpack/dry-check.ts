/**
 * skillpack/dry-check.ts — shared rules copied into skills, and the safe fix.
 *
 * A rule a skill copies out of a shared doc (`conventions/*.md`,
 * `_brain-filing-rules.md`, ...) drifts the day the doc changes, so a skill
 * points at the doc instead of restating it. Two findings:
 *   - a copy: a paragraph, list item or quote every sentence of which is
 *     already in one shared doc, word for word once markdown and punctuation
 *     are set aside (sentences that only point at a doc do not count);
 *   - a named rule: a cross-cutting rule called by name (the notability gate,
 *     the Iron Law of back-linking, the citation format) with no pointer to
 *     the doc that owns it within 40 lines.
 * `--fix` rewrites only copies: the copied block becomes one
 * `> **Convention:**` line pointing at the doc, so nothing is lost — the text
 * still lives in the doc. It writes only a regular file reached without a
 * symbolic link, tracked and unmodified in version control (the history is
 * the backup), and only when the file holds one copy of that doc. A named
 * rule is reported for a hand edit, never rewritten.
 */
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, relative, sep } from "node:path";
import { readSkillText } from "./read-text.ts";

/** Lines around a match within which a pointer to the owning doc counts. */
export const DRY_PROXIMITY_LINES = 40;

/** A copy shorter than this (normalised characters) is a phrase, not a rule. */
const MIN_COPY_CHARS = 60;
/** A sentence shorter than this (words) is too generic to call a copy. */
const MIN_SENTENCE_WORDS = 5;

export interface SharedDoc {
  /** Pack-relative slug: `conventions/quality`, `_brain-filing-rules`. */
  slug: string;
  /** Normalised text, padded with spaces for whole-word containment. */
  norm: string;
  /** Each `## heading` with the normalised offset its section starts at. */
  headings: { at: number; text: string }[];
}

export interface DryFinding {
  kind: "copy" | "named-rule";
  /** 1-based first line of the block. */
  line: number;
  /** The shared doc the text belongs to. */
  doc: string;
  /** What the rule is called, for the message and the pointer line. */
  label: string;
  /** 0-based inclusive line range of the block (copies only). */
  block?: { start: number; end: number };
  /** The line above the copy (blank lines aside) already points at `doc`. */
  pointerAbove?: boolean;
  /** A sentence of the block that names a doc also says something else. */
  saysMore?: boolean;
}

export type DryFixStatus = "applied" | "skipped";

export interface DryFixOutcome {
  slug: string;
  line: number;
  doc: string;
  status: DryFixStatus;
  reason?: string;
  before?: string;
  after?: string;
}

/** Lowercase words only: markdown, punctuation and spacing set aside. */
export function normalizeProse(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

const DOC_REF_RE = /(conventions\/[a-z0-9-]+|_brain-filing-rules|_output-rules|_friction-protocol)/g;

/** The shared-doc slugs a line points at. */
function docRefs(line: string): string[] {
  return [...line.matchAll(DOC_REF_RE)].map((m) => m[1]!);
}

/** `Back-Linking (MANDATORY)` → `Back-Linking`. */
function withoutTrailingParens(heading: string): string {
  const t = heading.trim();
  const open = t.lastIndexOf("(");
  return t.endsWith(")") && open > 0 ? t.slice(0, open).trim() : t;
}

/** Shared docs a skill may defer to, normalised for containment checks. */
export function loadSharedDocs(skillsDir: string, files: readonly string[]): SharedDoc[] {
  return files.map((rel) => {
    const text = readSkillText(join(skillsDir, rel), skillsDir);
    let norm = " ";
    const headings: { at: number; text: string }[] = [];
    for (const line of text.split("\n")) {
      const h = /^#{2,6}\s+(\S.*)$/.exec(line);
      if (h) headings.push({ at: norm.length, text: withoutTrailingParens(h[1]!) });
      const n = normalizeProse(line);
      if (n.length > 0) norm += `${n} `;
    }
    return { slug: rel.replace(/\.md$/, ""), norm, headings };
  });
}

interface Block {
  start: number;
  end: number;
  quote: boolean;
}

const BULLET_RE = /^\s*(?:[-*+]|\d+\.)\s/;

/**
 * Paragraphs, list items and block quotes of a skill body, outside fences and
 * the frontmatter. Headings and table rows end a block and are never one.
 */
function blocksOf(lines: readonly string[], bodyStart: number): Block[] {
  const blocks: Block[] = [];
  let open: Block | null = null;
  let fence: string | null = null;
  const close = (): void => {
    if (open !== null) blocks.push(open);
    open = null;
  };
  for (let i = bodyStart; i < lines.length; i++) {
    const line = lines[i]!;
    const t = line.trimStart();
    const marker = t.startsWith("```") ? "```" : t.startsWith("~~~") ? "~~~" : null;
    if (marker !== null) {
      close();
      if (fence === null) fence = marker;
      else if (marker === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    if (t === "" || t.startsWith("#") || t.startsWith("|")) {
      close();
      continue;
    }
    const quote = t.startsWith(">");
    const blockOpen = open as Block | null;
    if (blockOpen === null || blockOpen.quote !== quote || (!quote && BULLET_RE.test(line))) {
      close();
      open = { start: i, end: i, quote };
      continue;
    }
    blockOpen.end = i;
  }
  close();
  return blocks;
}

function blockText(lines: readonly string[], b: Block): string {
  return lines
    .slice(b.start, b.end + 1)
    .map((l) => l.replace(/^\s*>\s?/, "").replace(BULLET_RE, ""))
    .join(" ");
}

function isCallout(text: string): boolean {
  return /^\s*\*\*(?:Convention|Filing rule):\*\*/.test(text);
}

/**
 * The doc every sentence of `text` is copied from, if there is one. When
 * several docs hold the text, the doc the callout right above points at wins,
 * then any doc the skill points at, then a convention, so the fix points
 * where the skill already reads.
 */
function copiedFrom(
  text: string,
  docs: readonly SharedDoc[],
  pointedAt: ReadonlySet<string>,
  pointedAbove: readonly string[],
): { doc: SharedDoc; at: number } | null {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .filter((s) => docRefs(s).length === 0)
    .map(normalizeProse)
    .filter((s) => s.length > 0);
  if (sentences.length === 0) return null;
  return copiedSentences(sentences, docs, pointedAt, pointedAbove);
}

/** Words a sentence that only points at a doc is made of ("See X for format."). */
const POINTER_WORDS: ReadonlySet<string> = new Set([
  "see", "for", "the", "a", "its", "format", "formats", "details", "rule", "rules", "via", "get", "skill",
  "read", "more", "md", "skills", "and", "in", "on",
]);

/**
 * True when every sentence of `text` that names a shared doc says nothing but
 * where to look, so dropping it loses nothing. "See `conventions/quality.md`
 * for format." qualifies; "See `conventions/quality.md`, except for drafts."
 * does not.
 */
function onlyBarePointers(text: string): boolean {
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((s) => docRefs(s).length > 0)
    .every((s) => normalizeProse(s.replace(DOC_REF_RE, " ")).split(" ").every((w) => w === "" || POINTER_WORDS.has(w)));
}

function copiedSentences(
  sentences: readonly string[],
  docs: readonly SharedDoc[],
  pointedAt: ReadonlySet<string>,
  pointedAbove: readonly string[],
): { doc: SharedDoc; at: number } | null {
  if (sentences.join(" ").length < MIN_COPY_CHARS) return null;
  if (sentences.some((s) => s.split(" ").length < MIN_SENTENCE_WORDS)) return null;
  const hits: { doc: SharedDoc; at: number }[] = [];
  for (const doc of docs) {
    let first = -1;
    let all = true;
    for (const s of sentences) {
      const at = doc.norm.indexOf(` ${s} `);
      if (at === -1) {
        all = false;
        break;
      }
      if (first === -1) first = at;
    }
    if (all) hits.push({ doc, at: first });
  }
  const conventionsFirst = (d: { doc: SharedDoc }): number => (d.doc.slug.startsWith("conventions/") ? 0 : 1);
  hits.sort((a, b) => conventionsFirst(a) - conventionsFirst(b));
  return hits.find((h) => pointedAbove.includes(h.doc.slug))
    ?? hits.find((h) => pointedAt.has(h.doc.slug))
    ?? hits[0]
    ?? null;
}

function sectionLabel(doc: SharedDoc, at: number): string {
  let label = "";
  for (const h of doc.headings) {
    if (h.at > at) break;
    label = h.text;
  }
  return label === "" ? "this rule" : label;
}

interface NamedRule {
  label: string;
  /** Owning docs; a pointer to any of them near the match is enough. */
  docs: string[];
  matches: (lower: string) => boolean;
}

/** `first` then `second` later on the same line; two indexOf scans, linear. */
function inOrder(lower: string, first: RegExp, second: readonly string[]): boolean {
  const m = first.exec(lower);
  if (m === null) return false;
  const from = m.index + m[0].length;
  return second.some((s) => lower.includes(s, from));
}

const NAMED_RULES: readonly NamedRule[] = [
  {
    label: "the Iron Law of back-linking",
    docs: ["conventions/quality"],
    matches: (l) => inOrder(l, /iron\s?law/, ["back-link", "backlink"]),
  },
  {
    label: "the citation format",
    docs: ["conventions/quality"],
    matches: (l) => inOrder(l, /citation/, ["[source:"]) && l.includes("format"),
  },
  {
    label: "the notability gate",
    docs: ["conventions/quality", "_brain-filing-rules"],
    matches: (l) => inOrder(l, /notability/, ["gate"]),
  },
];

/** The docs a callout on the nearest non-blank line above `start` points at. */
function calloutDocsAbove(lines: readonly string[], start: number): string[] {
  let i = start - 1;
  while (i >= 0 && lines[i]!.trim() === "") i--;
  if (i < 0) return [];
  const line = lines[i]!;
  return /^\s*>/.test(line) && isCallout(line.replace(/^\s*>\s?/, "")) ? docRefs(line) : [];
}

function bodyStartLine(lines: readonly string[]): number {
  if (lines[0]?.trimEnd() !== "---") return 0;
  for (let i = 1; i < lines.length; i++) if (lines[i]!.trimEnd() === "---") return i + 1;
  return 0;
}

/** Copies and unpointed named rules in one skill file's text. */
export function findDryIssues(text: string, docs: readonly SharedDoc[]): DryFinding[] {
  const lines = text.split("\n");
  const start = bodyStartLine(lines);
  const findings: DryFinding[] = [];
  const refLines: { line: number; doc: string }[] = [];
  for (let i = start; i < lines.length; i++) {
    for (const doc of docRefs(lines[i]!)) refLines.push({ line: i, doc });
  }
  const pointedAt = new Set(refLines.map((r) => r.doc));
  for (const b of blocksOf(lines, start)) {
    const text = blockText(lines, b);
    if (b.quote && isCallout(text)) continue;
    const above = calloutDocsAbove(lines, b.start);
    const hit = copiedFrom(text, docs, pointedAt, above);
    if (hit === null) continue;
    findings.push({
      kind: "copy",
      line: b.start + 1,
      doc: hit.doc.slug,
      label: sectionLabel(hit.doc, hit.at),
      block: { start: b.start, end: b.end },
      pointerAbove: above.includes(hit.doc.slug),
      saysMore: !onlyBarePointers(text),
    });
  }
  const inFence = fencedLines(lines, start);
  // Line numbers per doc, ascending (refLines is built in line order), so a
  // proximity check is a binary search, not a scan of every reference.
  const refsByDoc = new Map<string, number[]>();
  for (const r of refLines) {
    const list = refsByDoc.get(r.doc) ?? [];
    list.push(r.line);
    refsByDoc.set(r.doc, list);
  }
  for (const rule of NAMED_RULES) {
    for (let i = start; i < lines.length; i++) {
      if (inFence.has(i)) continue;
      const raw = lines[i]!;
      if (raw.length > 4096 || !rule.matches(raw.toLowerCase())) continue;
      if (rule.docs.some((d) => hasLineNear(refsByDoc.get(d), i))) continue;
      findings.push({ kind: "named-rule", line: i + 1, doc: rule.docs[0]!, label: rule.label });
      break;
    }
  }
  return findings.sort((a, b) => a.line - b.line);
}

/** Whether ascending `sorted` holds a line within DRY_PROXIMITY_LINES of `line`. */
function hasLineNear(sorted: readonly number[] | undefined, line: number): boolean {
  if (sorted === undefined) return false;
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < line - DRY_PROXIMITY_LINES) lo = mid + 1;
    else hi = mid;
  }
  return lo < sorted.length && sorted[lo]! <= line + DRY_PROXIMITY_LINES;
}

function fencedLines(lines: readonly string[], start: number): Set<number> {
  const out = new Set<number>();
  let fence: string | null = null;
  for (let i = start; i < lines.length; i++) {
    const t = lines[i]!.trimStart();
    const marker = t.startsWith("```") ? "```" : t.startsWith("~~~") ? "~~~" : null;
    if (marker !== null) {
      if (fence === null) fence = marker;
      else if (marker === fence) fence = null;
      out.add(i);
      continue;
    }
    if (fence !== null) out.add(i);
  }
  return out;
}

export function pointerLine(doc: string, label: string): string {
  return `> **Convention:** see \`${doc}.md\` (via \`get_skill ${doc}\`) for ${label}.`;
}

export type FileGate = "ok" | "symlink" | "not_regular" | "untracked" | "modified" | "no_repository";

/**
 * Whether `file` may be rewritten: a regular file inside `skillsDir`, no
 * symbolic link on the way to it, tracked and unmodified in version control.
 * Arguments go to the tool as an array, so a file name cannot reach a shell.
 */
export function fileGate(skillsDir: string, file: string): FileGate {
  const root = realpathSync(skillsDir);
  const rel = relative(skillsDir, file);
  if (rel === "" || rel.startsWith("..")) return "not_regular";
  let path = root;
  const parts = rel.split(sep);
  for (let i = 0; i < parts.length; i++) {
    path = join(path, parts[i]!);
    let st;
    try {
      st = lstatSync(path);
    } catch {
      return "not_regular";
    }
    if (st.isSymbolicLink()) return "symlink";
    if (i === parts.length - 1 && !st.isFile()) return "not_regular";
  }
  const run = (args: string[]) =>
    spawnSync("git", ["-C", dirname(path), ...args, "--", basename(path)], { encoding: "utf8" });
  const tracked = run(["ls-files", "--error-unmatch"]);
  if (tracked.error !== undefined) return "no_repository";
  if (tracked.status !== 0) {
    return /not a git repository/i.test(tracked.stderr ?? "") ? "no_repository" : "untracked";
  }
  const status = run(["status", "--porcelain"]);
  if (status.status !== 0) return "no_repository";
  return (status.stdout ?? "").trim() === "" ? "ok" : "modified";
}

/**
 * Rewrite the copies in one skill file. Every copy of a doc is skipped when
 * the file holds more than one copy of it; the rest are replaced bottom-up in
 * a single write, after the file passed `fileGate`.
 */
export function fixDryCopies(
  skillsDir: string,
  slug: string,
  file: string,
  findings: readonly DryFinding[],
): DryFixOutcome[] {
  const copies = findings.filter((f) => f.kind === "copy");
  if (copies.length === 0) return [];
  const perDoc = new Map<string, number>();
  for (const c of copies) perDoc.set(c.doc, (perDoc.get(c.doc) ?? 0) + 1);
  const outcomes: DryFixOutcome[] = [];
  const fixable: DryFinding[] = [];
  for (const c of copies) {
    if (perDoc.get(c.doc)! > 1) {
      outcomes.push({ slug, line: c.line, doc: c.doc, status: "skipped", reason: "several copies of one doc; edit by hand" });
    } else {
      fixable.push(c);
    }
  }
  if (fixable.length === 0) return outcomes;
  const gate = fileGate(skillsDir, file);
  if (gate !== "ok") {
    for (const c of fixable) outcomes.push({ slug, line: c.line, doc: c.doc, status: "skipped", reason: gate });
    return outcomes;
  }
  const lines = readFileSync(file, "utf8").split("\n");
  const applied: DryFixOutcome[] = [];
  for (const c of [...fixable].sort((a, b) => b.block!.start - a.block!.start)) {
    const { start, end } = c.block!;
    // A pointer line in the middle of a list would break the list apart.
    if (BULLET_RE.test(lines[start] ?? "")) {
      outcomes.push({ slug, line: c.line, doc: c.doc, status: "skipped", reason: "list item; edit by hand" });
      continue;
    }
    if (c.saysMore === true) {
      outcomes.push({ slug, line: c.line, doc: c.doc, status: "skipped", reason: "the block says more than the copy; edit by hand" });
      continue;
    }
    const before = lines.slice(start, end + 1).join("\n");
    if (c.pointerAbove === true) {
      // The pointer is already the line above: the copy just goes, with the
      // blank line that separated them.
      const from = start > 0 && lines[start - 1]!.trim() === "" ? start - 1 : start;
      lines.splice(from, end - from + 1);
      applied.push({ slug, line: c.line, doc: c.doc, status: "applied", before, after: "" });
      continue;
    }
    const after = pointerLine(c.doc, c.label);
    lines.splice(start, end - start + 1, after);
    applied.push({ slug, line: c.line, doc: c.doc, status: "applied", before, after });
  }
  if (applied.length > 0) writeFileSync(file, lines.join("\n"));
  return [...outcomes, ...applied.reverse()].sort((a, b) => a.line - b.line);
}
