/**
 * Keep the facts and takes fences the brain appended to a page that is
 * re-rendered from outside text (a GitHub item, a transcript part). The fresh
 * render never has a fence of its own, so without this every re-sync would
 * drop the fence and its projected facts or takes.
 *
 * Fences are carried only from a page a neutralizing writer produced, marked
 * by {@link OUTSIDE_NEUTRALIZED} in its compiled truth. A page written before
 * outside text was neutralized may hold a live fence that came from the
 * outside text itself, so nothing is carried from it: that is exactly what the
 * writers did before, and a write that replaces the truth without the marker
 * (a `page_put` that omits `compiled_truth`) falls back to it too.
 *
 * Every fence span of the old body, of either kind and brand, is found by the
 * widest rule a parser uses (a line containing the begin marker through the
 * next line containing that brand's end marker; the takes parser matches by
 * `indexOf`, the facts parser by the trimmed line). A span whose neutralized
 * text is in the fresh body came from the outside text and is skipped; the
 * rest, each with a `## Facts` / `## Takes` heading directly above it, are
 * appended after the fresh body in the layout the brain's own fence writer
 * uses (`upsertTakeRow`), so a page whose source did not change re-renders
 * byte-identical and writes no new version. A kind is not carried when the
 * fresh body already has that fence.
 */
import { FENCE_BRANDS, fenceBounds, fenceMarkers, type FenceKind } from "./fence-shared.ts";
import { neutralizeOutsideText } from "./neutralize-outside-text.ts";

/** Compiled-truth key the GitHub and transcript writers set on every page they write. */
export const OUTSIDE_NEUTRALIZED = "outside_neutralized";

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
  old: { markdown_body: string; compiled_truth: Record<string, unknown> | null } | null,
  newBody: string,
): string {
  if (old === null || old.compiled_truth?.[OUTSIDE_NEUTRALIZED] !== 1) return newBody;
  const lines = old.markdown_body.split(/\r?\n/);
  const text = (s: Span) => lines.slice(s.start, s.end + 1).join("\n");
  const spans = KINDS.filter(({ kind }) => fenceBounds(newBody, kind) === null)
    .flatMap(({ kind, heading }) => fenceSpans(lines, kind, heading))
    .filter((s) => !newBody.includes(neutralizeOutsideText(text(s))))
    .sort((a, b) => a.start - b.start);
  const kept: Span[] = [];
  for (const s of spans) if (kept.length === 0 || s.start > kept[kept.length - 1]!.end) kept.push(s);
  if (kept.length === 0) return newBody;
  const sep = newBody.endsWith("\n") ? "\n" : "\n\n";
  return `${newBody}${sep}${kept.map(text).join("\n\n")}\n`;
}
