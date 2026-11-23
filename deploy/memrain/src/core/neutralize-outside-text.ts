/**
 * Defuse text written outside the brain (GitHub issue titles and bodies,
 * transcript messages) before it is rendered into a page, so it cannot pass
 * for structure the brain derives stores from:
 *
 *   - a `<!--- memrain:facts:begin -->` / `takes` marker (either brand) gets
 *     its colon escaped, so no fence parser's exact-line match sees it;
 *   - `[Source:` becomes `[Source\:`, so no inline citation is read;
 *   - a `Timeline` heading, a `### YYYY-MM-DD` header or a dated bullet is
 *     prefixed with `\`, so the body-timeline parser skips it.
 *
 * NUL and lone surrogates go first, then CR and U+2028/U+2029 become `\n`, so
 * a marker cannot hide behind a control character or a separator another
 * reader treats as a line break. Applied to the outside text only, never to a
 * composed page, so the brain's own fences are never touched. Idempotent.
 */
import { wellFormForText } from "./well-form.ts";

const LINE_BREAK_RE = /\r\n?|[\u2028\u2029]/g;
const FENCE_MARKER_RE = /(<!---\s*)(memrain|memex)(\s*):(?=\s*(?:facts|takes)\b)/gi;
const CITATION_RE = /\[(source):/gi;

const DATED_BULLET_RE = /^\s{0,8}[-*]\s{1,4}(?:\*\*)?\d{4}-\d{2}-\d{2}/;
const DATED_HEADER_RE = /^###\s{1,4}\d{4}-\d{2}-\d{2}/;

/** Heading level (1-6) of a line, or 0. Counts leading '#' without a regex. */
function headingLevel(line: string): number {
  let n = 0;
  while (n < line.length && n < 7 && line[n] === "#") n++;
  if (n === 0 || n > 6) return 0;
  const next = line[n];
  return next === undefined || next === " " || next === "\t" ? n : 0;
}

/**
 * True for a line a body timeline reader would take as its own: a level-1/2
 * `Timeline` heading, a `### YYYY-MM-DD` header, or a bullet that opens with a
 * date. No date-validity check: outside text escapes the shape, valid or not.
 */
function isTimelineLine(line: string): boolean {
  const level = headingLevel(line);
  if (level === 1 || level === 2) return line.slice(level).trim().toLowerCase() === "timeline";
  return DATED_HEADER_RE.test(line) || DATED_BULLET_RE.test(line);
}

export function neutralizeOutsideText(text: string): string {
  const defused = wellFormForText(text)
    .replace(LINE_BREAK_RE, "\n")
    .replace(FENCE_MARKER_RE, "$1$2$3\\:")
    .replace(CITATION_RE, "[$1\\:");
  return defused
    .split("\n")
    .map((line) => (isTimelineLine(line) ? `\\${line}` : line))
    .join("\n");
}
