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
import { isTimelineLine } from "./timeline-body.ts";

const LINE_BREAK_RE = /\r\n?|[\u2028\u2029]/g;
const FENCE_MARKER_RE = /(<!---\s*)(memrain|memex)(\s*):(?=\s*(?:facts|takes)\b)/gi;
const CITATION_RE = /\[(source):/gi;

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
