/**
 * Keep the facts and takes fences the brain appended to a page that is
 * re-rendered from outside text (a GitHub item, a transcript part). The fresh
 * render never has a fence of its own, so without this every re-sync would
 * drop the fence and its projected facts or takes.
 *
 * Fences are carried only from a page a neutralizing writer produced, marked
 * by {@link OUTSIDE_NEUTRALIZED} in its compiled truth. A page written before
 * outside text was neutralized may hold a live fence that came from the
 * outside text itself, so an ambiguous re-import is held without changing it.
 *
 * Every fence span of the old body, of either kind and brand, is preserved
 * conservatively, including legacy inline markers the parsers no longer read
 * as a fence. The carried text is unchanged. A span whose neutralized
 * text is in the fresh body came from the outside text and is skipped; the
 * rest, each with a `## Facts` / `## Takes` heading directly above it, are
 * appended after the fresh body in the layout the brain's own fence writer
 * uses (`upsertTakeRow`), so a page whose source did not change re-renders
 * byte-identical and writes no new version. A kind is not carried when the
 * fresh body already has that fence.
 */
import { FENCE_BRANDS, fenceBounds, fenceMarkers, locateFenceMarkers, parseRowCells, isSeparatorRow, type FenceKind } from "./fence-shared.ts";
import { neutralizeOutsideText } from "./neutralize-outside-text.ts";
import { parseFactsFence } from "./facts-fence.ts";
import { parseTakesFence } from "./synthesis/takes-fence.ts";

/** Compiled-truth key the GitHub and transcript writers set on every page they write. */
export const OUTSIDE_NEUTRALIZED = "outside_neutralized";

export class FenceCarryHeldError extends Error {
  readonly reason = "unproven_fences" as const;
  constructor() { super("Import held: unproven_fences"); }
}

const KINDS: ReadonlyArray<{ kind: FenceKind; heading: string }> = [
  { kind: "facts", heading: "## Facts" },
  { kind: "takes", heading: "## Takes" },
];

interface Span {
  start: number;
  end: number;
}

function fenceSpans(lines: readonly string[], kind: FenceKind, heading: string): Span[] {
  const spans: Span[] = [];
  for (const brand of FENCE_BRANDS) {
    const { begin, end } = fenceMarkers(kind, brand);
    for (let i = 0; i < lines.length; i++) {
      const at = lines[i]!.indexOf(begin);
      if (at === -1) continue;
      let j = i;
      if (!lines[i]!.includes(end, at + begin.length)) {
        j = i + 1;
        while (j < lines.length && !lines[j]!.includes(end)) j++;
        if (j === lines.length) break;
      }
      let start = i;
      let probe = i - 1;
      while (probe >= 0 && lines[probe]!.trim() === "") probe--;
      if (probe >= 0 && lines[probe]!.trim() === heading) start = probe;
      spans.push({ start, end: j });
      i = j;
    }
  }
  return spans;
}

export function carryForwardFences(
  old: { slug: string; markdown_body: string; compiled_truth: Record<string, unknown> | null } | null,
  newBody: string,
): string {
  if (old === null) return newBody;
  const lines = old.markdown_body.split("\n");
  if (old.compiled_truth?.[OUTSIDE_NEUTRALIZED] !== 1) {
    const markers = KINDS.some(({ kind }) => FENCE_BRANDS.some(brand => {
      const { begin, end } = fenceMarkers(kind, brand);
      return old.markdown_body.includes(begin) || old.markdown_body.includes(end);
    }));
    if (markers) throw new FenceCarryHeldError();
    return newBody;
  }
  const text = (s: Span) => lines.slice(s.start, s.end + 1).join("\n");
  const spans = KINDS.filter(({ kind }) => fenceBounds(newBody, kind) === null)
    .flatMap(({ kind, heading }) => fenceSpans(lines, kind, heading))
    .filter((s) => !newBody.includes(neutralizeOutsideText(text(s))))
    .sort((a, b) => a.start - b.start);
  const kept: Span[] = [];
  for (const s of spans) if (kept.length === 0 || s.start > kept[kept.length - 1]!.end) kept.push(s);
  if (kept.length === 0) return newBody;
  const first = text(kept[0]!);
  const heading = KINDS.find(k => first.startsWith(`${k.heading}\n`) || first.startsWith(`${k.heading}\r\n`))?.heading;
  if (heading) {
    const freshLines = newBody.split("\n");
    let last = freshLines.length - 1;
    while (last >= 0 && freshLines[last]!.trim() === "") last--;
    if (last >= 0 && freshLines[last]!.replace(/\r$/, "") === heading) {
      newBody = freshLines.slice(0, last).join("\n") + (last > 0 ? "\n" : "");
    }
  }
  const newline = newBody.endsWith("\r\n") ? "\r\n" : "\n";
  const sep = newBody === "" || newBody.endsWith(`${newline}${newline}`) ? "" : newBody.endsWith(newline) ? newline : newline + newline;
  return `${newBody}${sep}${kept.map(text).join("\n\n")}\n`;
}

/** A managed-table edit can keep provenance only when every outside byte stays put. */
export function preservesOutsideText(before: string, after: string): boolean {
  const oldOutside = outsideFences(before);
  return oldOutside !== null && oldOutside === outsideFences(after);
}

function outsideFences(body: string): string | null {
  const split = body.split("\n");
  const lines = split.map((line, i) => i < split.length - 1 ? `${line}\n` : line);
  const spans: Span[] = [];
  for (const { kind, heading } of KINDS) {
    const markers = FENCE_BRANDS.flatMap(brand => Object.values(fenceMarkers(kind, brand)));
    const count = markers.reduce((n, marker) => n + body.split(marker).length - 1, 0);
    if (count === 0) continue;
    const loc = locateFenceMarkers(body, kind, true);
    if (!loc || loc.brand === "both" || count !== 2 || loc.beginLine < 0 || loc.endLine <= loc.beginLine) return null;
    const rows = lines.slice(loc.beginLine + 1, loc.endLine).filter(line => line.trim() !== "");
    const header = parseRowCells(rows[0] ?? "");
    const separator = parseRowCells(rows[1] ?? "");
    if (!header?.includes("claim") || !header.includes("#") || !separator || !isSeparatorRow(separator)) return null;
    const warnings: string[] = [];
    if (kind === "facts") parseFactsFence(body, warnings);
    else warnings.push(...parseTakesFence(body).warnings);
    if (warnings.length > 0) return null;
    let start = loc.beginLine;
    while (start > 0 && lines[start - 1]!.trim() === "") start--;
    if (start > 0 && lines[start - 1]!.replace(/\r?\n$/, "") === heading) start--;
    while (start > 0 && lines[start - 1]!.trim() === "") start--;
    spans.push({ start, end: loc.endLine });
  }
  const sorted = spans.sort((a, b) => a.start - b.start);
  if (sorted.some((span, i) => i > 0 && span.start <= sorted[i - 1]!.end)) return null;
  const outside: string[] = [];
  let start = 0;
  for (const span of sorted) {
    outside.push(...lines.slice(start, span.start));
    start = span.end + 1;
  }
  return outside.join("") + lines.slice(start).join("");
}
