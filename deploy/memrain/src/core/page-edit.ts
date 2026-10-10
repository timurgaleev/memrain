/**
 * page_edit: ordered exact-string replacements on a page's markdown body.
 *
 * The body is split into editable text and protected spans: the facts and
 * takes fences (either marker brand). Those fences are reconciled into their
 * own tables on every write, so an edit that touched one would change a ledger
 * row through a back door; they are written with add_fact / forget_fact and
 * the takes tools instead. Every edit must match exactly once inside editable
 * text, and the edits apply in order, each to the text the previous one left,
 * all or nothing. Bytes outside the edited spans are kept as they were.
 */
import { OperationError, type PublicErrorEnvelope } from "./operation-error.ts";
import { FENCE_BRANDS, fenceMarkers, type FenceKind } from "./fence-shared.ts";

export const PAGE_EDIT_MAX_EDITS = 50;
export const PAGE_EDIT_DIFF_MAX_BYTES = 8 * 1024;

export interface PageEdit {
  old_text: string;
  new_text: string;
}

/** A refused edit. The index and match count are counters, safe on every ingress. */
export class PageEditError extends OperationError {
  constructor(
    code: "edit_invalid" | "edit_no_match" | "edit_ambiguous_match" | "edit_protected_span",
    message: string,
    suggestion: string,
    public readonly editIndex?: number,
    public readonly matchCount?: number,
  ) {
    super(code, message, suggestion);
    this.name = "PageEditError";
  }

  override toEnvelope(isPublic: boolean): PublicErrorEnvelope & { edit_index?: number; match_count?: number } {
    return {
      ...super.toEnvelope(isPublic),
      ...(this.editIndex !== undefined ? { edit_index: this.editIndex } : {}),
      ...(this.matchCount !== undefined ? { match_count: this.matchCount } : {}),
    };
  }
}

const FENCE_KINDS: readonly FenceKind[] = ["facts", "takes"];
const FENCES = FENCE_KINDS.flatMap((kind) => FENCE_BRANDS.map((brand) => fenceMarkers(kind, brand)));
const MARKERS = FENCES.flatMap((f) => [f.begin, f.end]);
const END_OF = new Map(FENCES.map((f) => [f.begin, f.end]));
const MARKER_PATTERN = new RegExp(MARKERS.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");

/** Validates the wire shape: 1–50 objects of exactly `{old_text, new_text}`, old_text non-empty. */
export function parsePageEdits(value: unknown): PageEdit[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > PAGE_EDIT_MAX_EDITS) {
    throw new PageEditError(
      "edit_invalid",
      `page_edit: \`edits\` must be an array of 1 to ${PAGE_EDIT_MAX_EDITS} replacements`,
      'Pass edits: [{"old_text": "…", "new_text": "…"}] in the order to apply them.',
    );
  }
  return value.map((edit, index) => {
    const record = edit as Record<string, unknown> | null;
    if (
      record === null ||
      typeof record !== "object" ||
      Array.isArray(record) ||
      Object.keys(record).some((k) => k !== "old_text" && k !== "new_text") ||
      typeof record["old_text"] !== "string" ||
      typeof record["new_text"] !== "string"
    ) {
      throw new PageEditError(
        "edit_invalid",
        `page_edit: edit ${index} must be an object with string old_text and new_text`,
        'Each edit is exactly {"old_text": "…", "new_text": "…"}.',
        index,
      );
    }
    const oldText = record["old_text"];
    const newText = record["new_text"];
    if (oldText.length === 0) {
      throw new PageEditError(
        "edit_invalid",
        `page_edit: edit ${index} has an empty old_text`,
        "Quote enough existing text to match exactly once; use page_put to write a whole page.",
        index,
      );
    }
    if (MARKERS.some((marker) => newText.includes(marker))) {
      throw new PageEditError(
        "edit_protected_span",
        `page_edit: edit ${index} would write a facts or takes fence marker`,
        "Write facts with add_fact / forget_fact and takes with the takes tools.",
        index,
      );
    }
    return { old_text: oldText, new_text: newText };
  });
}

interface Segment {
  text: string;
  editable: boolean;
}

function malformedFence(): PageEditError {
  return new PageEditError(
    "edit_invalid",
    "page_edit: a facts or takes fence on this page is malformed",
    "Read the page and repair the fence with page_put before editing it.",
  );
}

function bodySegments(body: string): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;
  let open: { start: number; end: string } | undefined;
  for (const token of body.matchAll(MARKER_PATTERN)) {
    const marker = token[0];
    const at = token.index;
    if (open === undefined) {
      const end = END_OF.get(marker);
      // A stray end marker outside any fence is still a marker: never editable.
      if (end === undefined) throw malformedFence();
      if (at > cursor) segments.push({ text: body.slice(cursor, at), editable: true });
      open = { start: at, end };
      continue;
    }
    if (marker !== open.end) throw malformedFence();
    cursor = at + marker.length;
    segments.push({ text: body.slice(open.start, cursor), editable: false });
    open = undefined;
  }
  if (open !== undefined) throw malformedFence();
  if (cursor < body.length) segments.push({ text: body.slice(cursor), editable: true });
  return segments;
}

function occurrences(haystack: string, needle: string): number[] {
  const found: number[] = [];
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) found.push(at);
  return found;
}

/** Apply the edits in order, all or nothing. Returns the new body. */
export function applyPageEdits(body: string, edits: readonly PageEdit[]): string {
  let segments = bodySegments(body);
  edits.forEach((edit, index) => {
    const whole = segments.map((s) => s.text).join("");
    const ranges: Array<{ start: number; end: number; i: number }> = [];
    let offset = 0;
    segments.forEach((s, i) => {
      ranges.push({ start: offset, end: offset + s.text.length, i });
      offset += s.text.length;
    });
    const inside = (at: number) =>
      ranges.find((r) => segments[r.i]!.editable && at >= r.start && at + edit.old_text.length <= r.end);
    const all = occurrences(whole, edit.old_text);
    const allowed = all.filter((at) => inside(at) !== undefined);
    if (allowed.length === 0 && all.length > 0) {
      throw new PageEditError(
        "edit_protected_span",
        `page_edit: edit ${index}'s old_text touches a facts or takes fence`,
        "Quote only ordinary page text; write facts with add_fact / forget_fact and takes with the takes tools.",
        index,
      );
    }
    if (allowed.length === 0) {
      throw new PageEditError(
        "edit_no_match",
        `page_edit: edit ${index}'s old_text was not found in the page`,
        "Read the page with page_get and copy old_text exactly, whitespace included; earlier edits in the same call are already applied to the text it matches.",
        index,
        0,
      );
    }
    if (allowed.length > 1) {
      throw new PageEditError(
        "edit_ambiguous_match",
        `page_edit: edit ${index}'s old_text matches ${allowed.length} places`,
        "Include surrounding text in old_text so it matches exactly once.",
        index,
        allowed.length,
      );
    }
    const at = allowed[0]!;
    const range = inside(at)!;
    const seg = segments[range.i]!;
    const local = at - range.start;
    const replaced = seg.text.slice(0, local) + edit.new_text + seg.text.slice(local + edit.old_text.length);
    segments = segments.map((s, i) => (i === range.i ? { text: replaced, editable: true } : s));
  });
  const result = segments.map((s) => s.text).join("");
  // Edits can assemble a marker no single new_text carries (two edits, or one
  // next to partial marker text): the result must hold exactly the fences the
  // page had, byte for byte.
  const protectedText = (segs: Segment[]) => segs.filter((s) => !s.editable).map((s) => s.text);
  let after: string[] | null;
  try {
    after = protectedText(bodySegments(result));
  } catch {
    after = null; // the edits left a stray or unbalanced marker
  }
  const before = protectedText(bodySegments(body));
  if (after === null || after.length !== before.length || after.some((t, i) => t !== before[i])) {
    throw new PageEditError(
      "edit_protected_span",
      "page_edit: the edits together would create or change a facts or takes fence",
      "Write facts with add_fact / forget_fact and takes with the takes tools.",
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// Unified diff of the edit, for the response. Line LCS over the region between
// the common prefix and suffix; a region too large for the table falls back to
// one replace hunk, which is still a correct diff, only a coarser one.
// ---------------------------------------------------------------------------

const DIFF_CONTEXT = 3;
const MAX_LCS_CELLS = 4_000_000;

type Op = { kind: " " | "-" | "+"; line: string };

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function middleOps(a: string[], b: string[]): Op[] {
  if (a.length * b.length > MAX_LCS_CELLS) {
    return [...a.map((line) => ({ kind: "-" as const, line })), ...b.map((line) => ({ kind: "+" as const, line }))];
  }
  const w = b.length + 1;
  const table = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * w + j] = a[i] === b[j] ? table[(i + 1) * w + j + 1]! + 1 : Math.max(table[(i + 1) * w + j]!, table[i * w + j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: " ", line: a[i]! });
      i++;
      j++;
    } else if (table[(i + 1) * w + j]! >= table[i * w + j + 1]!) {
      ops.push({ kind: "-", line: a[i++]! });
    } else {
      ops.push({ kind: "+", line: b[j++]! });
    }
  }
  while (i < a.length) ops.push({ kind: "-", line: a[i++]! });
  while (j < b.length) ops.push({ kind: "+", line: b[j++]! });
  return ops;
}

export function unifiedDiff(before: string, after: string, label: string): string {
  if (before === after) return "";
  const a = splitLines(before);
  const b = splitLines(after);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const ops: Op[] = [
    ...a.slice(0, pre).map((line) => ({ kind: " " as const, line })),
    ...middleOps(a.slice(pre, a.length - suf), b.slice(pre, b.length - suf)),
    ...a.slice(a.length - suf).map((line) => ({ kind: " " as const, line })),
  ];
  const changes = ops.flatMap((op, k) => (op.kind === " " ? [] : [k]));
  const out = [`--- a/${label}`, `+++ b/${label}`];
  if (changes.length === 0) {
    // Only the trailing newline moved; the line view cannot show it.
    out.push("@@ -0,0 +0,0 @@", "\\ trailing newline changed");
    return `${out.join("\n")}\n`;
  }
  const hunks: Array<[number, number]> = [];
  for (const k of changes) {
    const last = hunks[hunks.length - 1];
    if (last !== undefined && k - last[1] <= DIFF_CONTEXT * 2 + 1) last[1] = k;
    else hunks.push([k, k]);
  }
  // Line numbers before each op, in the old and the new text.
  const aAt: number[] = [];
  const bAt: number[] = [];
  let ai = 0;
  let bi = 0;
  for (const op of ops) {
    aAt.push(ai);
    bAt.push(bi);
    if (op.kind !== "+") ai++;
    if (op.kind !== "-") bi++;
  }
  for (const [first, last] of hunks) {
    const start = Math.max(0, first - DIFF_CONTEXT);
    const end = Math.min(ops.length - 1, last + DIFF_CONTEXT);
    const slice = ops.slice(start, end + 1);
    const aCount = slice.filter((op) => op.kind !== "+").length;
    const bCount = slice.filter((op) => op.kind !== "-").length;
    const aStart = aCount === 0 ? aAt[start]! : aAt[start]! + 1;
    const bStart = bCount === 0 ? bAt[start]! : bAt[start]! + 1;
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (const op of slice) out.push(`${op.kind}${op.line}`);
  }
  return `${out.join("\n")}\n`;
}

/** The diff cut on a line boundary so it stays within PAGE_EDIT_DIFF_MAX_BYTES. */
export function boundedDiff(before: string, after: string, label: string): { diff: string; diff_truncated?: true } {
  const full = unifiedDiff(before, after, label);
  if (Buffer.byteLength(full) <= PAGE_EDIT_DIFF_MAX_BYTES) return { diff: full };
  let kept = "";
  let bytes = 0;
  for (const line of full.split("\n")) {
    const size = Buffer.byteLength(line) + 1;
    if (bytes + size > PAGE_EDIT_DIFF_MAX_BYTES) break;
    kept += `${line}\n`;
    bytes += size;
  }
  return { diff: kept, diff_truncated: true };
}
