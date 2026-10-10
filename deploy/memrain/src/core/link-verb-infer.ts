/**
 * link-verb-infer.ts — deterministic (LLM-free) verb-context inference of a
 * wikilink edge's TYPE from the prose around the mention.
 *
 * memrain resolves a `[[target]]` wikilink to a slug and writes
 * `type='wikilink'`; with verb
 * inference ON (opt-in, `MEMRAIN_LINK_VERB_INFER=1`), the ~240-char window around
 * the mention is scanned for employment / investment / founder / advisor verbs
 * and the edge is upgraded to the matching typed relationship
 * (`works_at` / `invested_in` / `founded` / `advises`). When no verb matches it
 * stays `mentions` (the caller keeps `wikilink`).
 *
 * Two layers:
 *   1. Per-edge: explicit verbs in the local window
 *      (FOUNDED > INVESTED > ADVISES > WORKS_AT). A verb counts only when this
 *      link is the wikilink nearest to it, a past or ended role ("former",
 *      "no longer", "left") does not type the edge, and the target must be
 *      able to hold the role (see targetTakesRole).
 *   2. Page-role prior: when the per-edge pass falls through, a person page
 *      whose body describes the subject as a partner/investor, advisor, or
 *      employee biases its outbound `companies/*` refs
 *      (PARTNER > ADVISOR > EMPLOYEE).
 *
 * The regexes are calibrated against a rich-prose corpus.
 */

// Employment context: position + at/of, or explicit work verbs.
const WORKS_AT_RE =
  /\b(?:CEO of|CTO of|COO of|CFO of|CMO of|CRO of|VP at|VP of|VPs? Engineering|VPs? Product|works at|worked at|working at|employed by|employed at|joined as|joined the team|engineer at|engineer for|director at|director of|head of|heads up .{0,20} at|leads engineering|leads product|leads the .{0,20} (?:team|org) at|manages engineering at|manages product at|running (?:engineering|product|design) at|currently at|previously at|previously worked at|spent .* (?:years|months) at|stint at|stint as|tenure at|tenure as|role at|position at|(?:senior|staff|principal|lead|backend|frontend|full-?stack|ML|data|security) engineer at|promoted to (?:senior|staff|principal|lead) .{0,20} at|(?:his|her|their|my) time at)\b/i;

// Investment context (most-specific → least).
const INVESTED_RE =
  /\b(?:invested in|invests in|investing in|invest in|investment in|investments in|backed by|funding from|funded by|raised from|led the (?:seed|Series|round|investment)|led .{0,30}(?:Series [A-Z]|seed|round|investment)|participated in (?:the )?(?:seed|Series|round)|wrote (?:a |the )?check|first check|early investor|portfolio (?:company|includes)|board seat (?:at|in|on)|term sheet for)\b/i;

// Founder patterns (incl. noun forms).
const FOUNDED_RE =
  /\b(?:founded|co-?founded|started the company|incorporated|founder of|founders? (?:include|are)|the founder|is a co-?founder|is one of the founders)\b/i;

// Advise context: rooted in "advisor"/"advise" (investors also sit on boards).
// A board director advises the company; it is not employment there, and it is
// checked before WORKS_AT_RE, whose "director at/of" would otherwise take it.
const ADVISES_RE =
  /\b(?:advises|advised|advis[eo]r (?:to|at|for|of)|board director|non-executive director|independent director|director on the board|sits on the board|board member (?:at|of)|advisory (?:board|role|position|capacity|engagement|partnership|contract|relationship|work)|board advisor|on .{0,20} advisory board|joined .{0,20} advisory board|in an? advisory (?:capacity|role|position)|as an? (?:advis[eo]r|security advis[eo]r|technical advis[eo]r|strategic advis[eo]r|industry advis[eo]r|product advis[eo]r|board advis[eo]r|senior advis[eo]r)|(?:strategic|technical|security|product|industry|senior|board) advis[eo]r (?:to|at|for|of)|consults for|consulting role (?:at|with))\b/i;

// An ended or negated role: the prose names the relation but says it no longer
// holds, so the edge stays a plain mention.
const ENDED_ROLE_RE =
  /\b(?:former(?:ly)?|ex-|no longer|not (?:at|with|working)|never (?:worked|was)|left|quit|departed|previously|used to)\b/i;
/** How far before the verb an ended-role word still belongs to its clause. */
const ENDED_ROLE_LOOKBACK = 40;

// Page-level priors.
const PARTNER_ROLE_RE =
  /\b(?:partner at|partner of|venture partner|VC partner|invested early|investor at|investor in|portfolio|venture capital|early-stage investor|seed investor|fund [A-Z]|invests across|backs companies)\b/i;
const ADVISOR_ROLE_RE =
  /\b(?:full-time advis[eo]r|professional advis[eo]r|advises (?:multiple|several|various)|is an? (?:advis[eo]r|security advis[eo]r|technical advis[eo]r|strategic advis[eo]r|industry advis[eo]r|product advis[eo]r|senior advis[eo]r)|took on advisory roles|(?:her|his|their) advisory (?:work|role|engagement|portfolio)|serves as (?:an )?advis[eo]r)\b/i;
const EMPLOYEE_ROLE_RE =
  /\b(?:is an? (?:senior|staff|principal|lead|backend|frontend|full-?stack|ML|data|security|DevOps|platform)? ?engineer at|is an? (?:senior|staff|principal|lead)? ?(?:developer|designer|product manager|engineering manager|director|VP) (?:at|of)|holds? the (?:CTO|CEO|CFO|COO|CMO|CRO|VP) (?:role|position|seat|title) at|is the (?:CTO|CEO|CFO|COO|CMO|CRO) of|employee at|on the team at|works on .{0,30} at)\b/i;

/** The edge types verb inference can produce (plus the `mentions` fallback). */
export type InferredLinkType = "founded" | "invested_in" | "advises" | "works_at" | "attended" | "mentions";

/**
 * Infer a wikilink edge's type from page context. Deterministic, no LLM.
 *   - meeting pages: `attended` only for a person target listed under an
 *     Attendees / Participants heading or on an `Attendees:` line; a person
 *     merely mentioned in the notes stays `mentions`;
 *   - per-edge window verbs: founded > invested_in > advises > works_at;
 *   - then a person→company page-role prior: investor > advisor > employee,
 *     skipped when every mention of the target sits in a Timeline / See also /
 *     Related-style list section (those lists name companies without saying
 *     anything about the page subject's role there);
 *   - else `mentions`.
 * `pageType` is the SOURCE page's type, `context` the per-edge window,
 * `globalContext` the full body (for the prior), `targetSlug` the resolved edge
 * target (the prior only fires for `companies/*` targets), `surface` the
 * wikilink text as written — it locates the mentions in `globalContext`.
 * Without `surface` (or the body) a meeting page has no attendance evidence
 * and yields `mentions`.
 */
export function inferLinkType(
  pageType: string,
  context: string,
  globalContext?: string,
  targetSlug?: string,
  surface?: string,
): InferredLinkType {
  if (pageType === "media") return "mentions";
  if (pageType === "meeting") {
    if (globalContext === undefined || surface === undefined || !personLikeTarget(targetSlug)) return "mentions";
    const { attendance } = sectionRanges(globalContext);
    return wikilinkOffsets(globalContext, surface).some((i) => inRanges(attendance, i)) ? "attended" : "mentions";
  }

  // Per-edge verb rules.
  const verbs: Array<[RegExp, InferredLinkType, boolean]> = [
    [FOUNDED_RE, "founded", false],
    [INVESTED_RE, "invested_in", false],
    [ADVISES_RE, "advises", true],
    [WORKS_AT_RE, "works_at", true],
  ];
  let ended = false;
  for (const [re, type, canEnd] of verbs) {
    const hit = verbFor(re, context, surface, canEnd);
    if (hit === "ended") ended = true;
    if (hit === "yes") return targetTakesRole(type, targetSlug) ? type : "mentions";
  }
  // The prose said the role ended; the page-wide prior must not restore it.
  if (ended) return "mentions";

  // Page-role prior — only person → companies/* links. Precedence within
  // priors: investor > advisor > employee (investors also sit on boards).
  if (
    pageType === "person" && globalContext && targetSlug?.startsWith("companies/")
    && !onlyInSuppressedSections(globalContext, surface)
  ) {
    if (PARTNER_ROLE_RE.test(globalContext)) return "invested_in";
    if (ADVISOR_ROLE_RE.test(globalContext)) return "advises";
    if (EMPLOYEE_ROLE_RE.test(globalContext)) return "works_at";
  }
  return "mentions";
}

/**
 * Whether the target can hold the role: employment and investment point at a
 * company, so a namespaced target outside `companies/` (a person, a meeting,
 * a project) keeps the plain mention. A flat slug is unknown and allowed.
 */
export function targetTakesRole(type: InferredLinkType, targetSlug: string | undefined): boolean {
  if (type !== "works_at" && type !== "invested_in") return true;
  if (targetSlug === undefined || !targetSlug.includes("/")) return true;
  return targetSlug.startsWith("companies/");
}

const CONTEXT_LINK_RE = /\[\[([^\]\n|#]{1,256})(?:#[^\]\n|]*)?(?:\|[^\]\n]{0,512})?\]\]/g;

/**
 * Does `re` type this edge in `context`? "yes" when some match has this
 * link as its nearest wikilink (a tie goes to the link after the verb, the
 * usual place of its object); "ended" when such a match sits in a clause that
 * says the role ended and `canEnd`; "no" otherwise. Without the surface, or
 * when the context has no wikilink for it, any match counts.
 */
function verbFor(re: RegExp, context: string, surface: string | undefined, canEnd: boolean): "yes" | "ended" | "no" {
  const global = new RegExp(re.source, "gi");
  const links: Array<{ start: number; end: number; mine: boolean }> = [];
  const want = surface?.trim().toLowerCase();
  CONTEXT_LINK_RE.lastIndex = 0;
  for (let m = CONTEXT_LINK_RE.exec(context); m !== null; m = CONTEXT_LINK_RE.exec(context)) {
    links.push({ start: m.index, end: m.index + m[0].length, mine: m[1]!.trim().toLowerCase() === want });
  }
  const checkNearest = want !== undefined && links.some((l) => l.mine);
  let ended = false;
  for (let m = global.exec(context); m !== null; m = global.exec(context)) {
    if (m[0].length === 0) global.lastIndex++;
    const start = m.index;
    const end = start + m[0].length;
    let target: { start: number; end: number } | null = null;
    if (checkNearest) {
      let best: { gap: number; after: boolean; link: (typeof links)[number] } | null = null;
      for (const l of links) {
        const after = l.start >= end;
        const gap = after ? l.start - end : l.end <= start ? start - l.end : 0;
        if (best === null || gap < best.gap || (gap === best.gap && after && !best.after)) best = { gap, after, link: l };
      }
      if (!best?.link.mine) continue;
      target = best.link;
    }
    const from = Math.max(0, Math.min(start, target?.start ?? start) - ENDED_ROLE_LOOKBACK);
    const to = Math.max(end, target?.end ?? end);
    if (canEnd && ENDED_ROLE_RE.test(context.slice(from, to))) {
      ended = true;
      continue;
    }
    return "yes";
  }
  return ended ? "ended" : "no";
}

type Range = readonly [number, number];

/** Meeting sections whose wikilinks name the people who were there. */
const ATTENDANCE_HEADING_RE = /^(#{1,6})[ \t]+(?:attendees|participants)\b/i;
/** `Attendees: [[A]], [[B]]` (optionally bulleted / bold) outside such a section. */
const ATTENDANCE_LINE_RE = /^[ \t]*(?:[-*+][ \t]+)?(?:\*\*|__)?(?:attendees|participants)(?:\*\*|__)?[ \t]*:(?:\*\*|__)?/i;
/** Machine-written list sections where the page-role prior must not fire. */
const PRIOR_SUPPRESSED_HEADING_RE =
  /^(#{1,6})[ \t]+(?:timeline|see[ -]also|related|facts|sources|links|email mention links|backlinks|significant moments)\b/i;
const HEADING_RE = /^(#{1,6})[ \t]/;
const FENCE_RE = /^[ \t]*(?:```|~~~)/;
const LEADING_WIKILINK_RE = /\[\[[^\]\n]{1,768}\]\]/y;

/**
 * The span of the attendee list starting at `from`: consecutive wikilinks joined
 * only by separators. `- [[Alice]] (CEO), [[Bob]]` admits Alice and stops at the
 * annotation, so a name in an aside is not read as an attendee.
 */
function leadingLinkRun(text: string, from: number, lineEnd: number): Range | null {
  let pos = from;
  let end = -1;
  for (;;) {
    while (pos < lineEnd && /[\s,;&]/.test(text[pos]!)) pos++;
    LEADING_WIKILINK_RE.lastIndex = pos;
    const m = LEADING_WIKILINK_RE.exec(text);
    if (!m || pos + m[0].length > lineEnd) break;
    pos += m[0].length;
    end = pos;
  }
  return end < 0 ? null : [from, end];
}

interface SectionRanges { attendance: Range[]; suppressed: Range[] }
let rangeCache: { body: string; ranges: SectionRanges } | null = null;

/** Attendance and prior-suppressed spans of a body, fenced code excluded.
 *  Cached for the last body: the sync pass asks once per wikilink target. */
function sectionRanges(body: string): SectionRanges {
  if (rangeCache?.body === body) return rangeCache.ranges;
  const attendance: Range[] = [];
  const suppressed: Range[] = [];
  let open: { kind: "attendance" | "suppressed"; level: number; start: number } | null = null;
  let inFence = false;
  let lineStart = 0;
  const close = (at: number) => {
    if (open?.kind === "suppressed") suppressed.push([open.start, at]);
    open = null;
  };
  while (lineStart <= body.length) {
    const nl = body.indexOf("\n", lineStart);
    const lineEnd = nl < 0 ? body.length : nl;
    const line = body.slice(lineStart, lineEnd);
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
    } else if (!inFence) {
      const heading = HEADING_RE.exec(line);
      if (heading && open !== null && heading[1]!.length <= open.level) close(lineStart);
      if (heading && open === null) {
        const att = ATTENDANCE_HEADING_RE.exec(line);
        const sup = att ? null : PRIOR_SUPPRESSED_HEADING_RE.exec(line);
        if (att) open = { kind: "attendance", level: att[1]!.length, start: lineEnd };
        else if (sup) open = { kind: "suppressed", level: sup[1]!.length, start: lineEnd };
      } else if (!heading) {
        if (open?.kind === "attendance") {
          const bullet = /^[ \t]*(?:[-*+][ \t]+)?/.exec(line)![0].length;
          const run = leadingLinkRun(body, lineStart + bullet, lineEnd);
          if (run) attendance.push(run);
        } else if (open === null) {
          const label = ATTENDANCE_LINE_RE.exec(line);
          const run = label ? leadingLinkRun(body, lineStart + label[0].length, lineEnd) : null;
          if (run) attendance.push(run);
        }
      }
    }
    if (nl < 0) break;
    lineStart = nl + 1;
  }
  close(body.length);
  const ranges = { attendance, suppressed };
  rangeCache = { body, ranges };
  return ranges;
}

function inRanges(ranges: readonly Range[], index: number): boolean {
  return ranges.some(([start, end]) => index >= start && index < end);
}

/** Offsets of every `[[surface]]` / `[[surface|alias]]` / `[[surface#anchor]]` in the body. */
function wikilinkOffsets(body: string, surface: string): number[] {
  const escaped = surface.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\[\\[[ \\t]*${escaped}[ \\t]*(?:#[^\\]\\n|]*)?(?:\\|[^\\]\\n]*)?\\]\\]`, "g");
  const out: number[] = [];
  for (let m = re.exec(body); m !== null; m = re.exec(body)) out.push(m.index);
  return out;
}

/** True when the body mentions the target and every mention sits in a
 *  prior-suppressed list section. Unknown surface → false (prior applies). */
function onlyInSuppressedSections(body: string, surface: string | undefined): boolean {
  if (surface === undefined) return false;
  const offsets = wikilinkOffsets(body, surface);
  if (offsets.length === 0) return false;
  const { suppressed } = sectionRanges(body);
  return offsets.every((i) => inRanges(suppressed, i));
}

/**
 * Whether a meeting-page target can be an attendee: a `people/` page, or a flat
 * slug with no directory. `companies/…`, `projects/…` and the like never attend.
 */
function personLikeTarget(targetSlug: string | undefined): boolean {
  if (targetSlug === undefined) return true;
  const dirs = targetSlug.split("/").slice(0, -1);
  return dirs.length === 0 || dirs.includes("people");
}

/**
 * The ~240-char window around the FIRST occurrence of a `[[surface]]` mention
 * in the body — the per-edge context fed to `inferLinkType`. The
 * wider window (vs the original 80) catches verbs that sit a clause away in
 * narrative prose. Returns the whole body when the surface isn't found
 * (defensive — the caller resolved it from this body).
 */
export function edgeContextWindow(body: string, surface: string, radius = 240): string {
  const idx = body.indexOf(surface);
  if (idx < 0) return body;
  const start = Math.max(0, idx - radius);
  const end = Math.min(body.length, idx + surface.length + radius);
  return body.slice(start, end);
}

/** Whether verb-context link-type inference is enabled (opt-in, default OFF). */
export function linkVerbInferEnabled(): boolean {
  return process.env["MEMRAIN_LINK_VERB_INFER"] === "1";
}
