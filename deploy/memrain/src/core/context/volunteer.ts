/**
 * Push-based context — the brain VOLUNTEERS relevant pages from a rolling
 * conversation window instead of waiting to be asked.
 *
 *   window text -> parseWindow() -> turns[] -> extractCandidatesFromWindow()
 *        |                                       (recency + frequency +
 *        |                                        user-role weights)
 *        v
 *   resolveEntitiesToPointers()                 alias 0.9 / title 0.8 /
 *        |                                       slug-suffix 0.6 (+0.05 boost
 *        v                                       for >=2-turn or newest-turn)
 *   gate min_confidence (default 0.7) ->
 *   exclude already-pushed slugs ->
 *   cap (3 default / 5 max)
 *
 * Zero-LLM, deterministic, precision-biased: push noise is worse than pull
 * silence. At the default gate, slug-suffix matches (0.6 + 0.05 < 0.7) never
 * volunteer — they need an explicit lower min_confidence.
 *
 * The pointer path is source-scoped: `opts.sourceIds` reaches every resolver
 * arm, so a scoped caller is never volunteered a page outside its grant. The
 * usage-stats path has no such axis (its event rows keep `source_id` NULL by
 * construction) and therefore REFUSES a scoped caller rather than answering
 * from the whole brain — see volunteerUsageStats. That join derives "used"
 * from `pages.last_retrieved_at` (migration 024) and is APPROXIMATE by design.
 */

import type { OnGatherFailure } from "../gather-degraded.ts";
import type { Storage } from "../storage.ts";
import { normalizeAlias } from "../page-aliases.ts";
import {
  extractCandidatesFromWindow,
  type WindowTurn,
  type WindowEntityCandidate,
} from "./entity-salience.ts";
import {
  resolveEntitiesToPointers,
  ARM_CONFIDENCE,
  type ResolveArm,
} from "./reflex.ts";
import { andSourceScope } from "../source-scope.ts";

export const VOLUNTEER_DEFAULT_MAX_PAGES = 3;
export const VOLUNTEER_MAX_PAGES_CAP = 5;
export const VOLUNTEER_DEFAULT_MIN_CONFIDENCE = 0.7;
/** Deterministic boost for >=2-turn or newest-turn mentions. */
export const VOLUNTEER_SALIENCE_BOOST = 0.05;

export interface VolunteeredPage {
  slug: string;
  title: string;
  display: string;
  confidence: number;
  arm: ResolveArm;
  /** Deterministic template string — never raw conversation text. */
  rationale: string;
  synopsis: string;
}

export interface VolunteerOpts {
  onDegraded?: OnGatherFailure;
  /** Rolling conversation window (oldest -> newest). */
  window: WindowTurn[];
  maxPages?: number;
  minConfidence?: number;
  /**
   * Slugs to skip BEFORE the confidence gate and the cap (O(1) membership).
   * `memrain watch` passes its session-dedupe set here — a post-call filter
   * would let a recurring already-pushed entity consume cap slots every turn
   * and starve new pages behind it.
   */
  excludeSlugs?: ReadonlySet<string>;
  /**
   * Already-surfaced context (pointer blocks / opened page bodies). A pointer
   * whose slug appears verbatim in this text is suppressed before the gate and
   * the cap — slug-only suppression, so a page the agent already holds never
   * re-consumes a volunteer slot.
   */
  priorContext?: string;
  /**
   * Tenant read scope, threaded into the pointer resolver. Omitted ->
   * unscoped (local CLI / `memrain watch`, which run as the operator).
   */
  sourceIds?: string[];
}

/** Shared wire protocol for window turns — watch.ts imports this so the two
 * channels can never desynchronize on the prefix grammar. */
export const TURN_PREFIX_RE = /^(user|assistant)\s*:\s?(.*)$/i;

/**
 * Lenient window parser: `user:` / `assistant:` line prefixes start a new turn
 * (oldest -> newest); unprefixed lines continue the current turn; input with no
 * prefixes at all is ONE user turn. CRLF-tolerant. Empty/whitespace -> [].
 */
export function parseWindow(text: string): WindowTurn[] {
  if (!text || !text.trim()) return [];
  const turns: WindowTurn[] = [];
  let current: WindowTurn | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const m = TURN_PREFIX_RE.exec(rawLine);
    if (m) {
      if (current) turns.push(current);
      current = { role: (m[1] ?? "user").toLowerCase() as WindowTurn["role"], text: m[2] ?? "" };
    } else if (current) {
      current.text += (current.text ? "\n" : "") + rawLine;
    } else if (rawLine.trim()) {
      current = { role: "user", text: rawLine };
    }
  }
  if (current) turns.push(current);
  return turns
    .map((t) => ({ role: t.role, text: t.text.trim() }))
    .filter((t) => t.text.length > 0);
}

function clampMaxPages(n: number | undefined): number {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 1) {
    return VOLUNTEER_DEFAULT_MAX_PAGES;
  }
  return Math.min(Math.floor(n), VOLUNTEER_MAX_PAGES_CAP);
}

function rationaleFor(
  arm: ResolveArm,
  display: string,
  c: WindowEntityCandidate | undefined,
  windowSize: number,
): string {
  const armText =
    arm === "alias"
      ? `alias match "${display}"`
      : arm === "title"
        ? `exact title match "${display}"`
        : `slug match "${display}"`;
  if (!c) return armText;
  const parts = [armText];
  if (c.occurrences >= 2) {
    parts.push(`mentioned in ${c.occurrences} of last ${windowSize} turns`);
  } else if (c.inNewestTurn) {
    parts.push("mentioned in the newest turn");
  }
  if (!c.userMention) parts.push("assistant-introduced");
  return parts.join("; ");
}

/**
 * Volunteer confidence-gated pages for a conversation window. Pure read —
 * event logging is the CALLER's job (through volunteer-events.ts). Returns []
 * when nothing clears the gate.
 */
export async function volunteerContext(
  storage: Storage,
  opts: VolunteerOpts,
): Promise<VolunteeredPage[]> {
  const turns = opts.window;
  if (!turns?.length) return [];
  const candidates = extractCandidatesFromWindow(turns);
  if (!candidates.length) return [];

  const byNorm = new Map<string, WindowEntityCandidate>();
  for (const c of candidates) {
    const norm = normalizeAlias(c.query);
    if (norm && !byNorm.has(norm)) byNorm.set(norm, c);
  }

  const maxPages = clampMaxPages(opts.maxPages);
  const minConfidence =
    typeof opts.minConfidence === "number" &&
    opts.minConfidence >= 0 &&
    opts.minConfidence <= 1
      ? opts.minConfidence
      : VOLUNTEER_DEFAULT_MIN_CONFIDENCE;

  // Resolve up to the hard cap so the confidence gate sees the full pool — a
  // gated-out alias hit must not shadow a passing title hit behind it.
  const pointers = await resolveEntitiesToPointers(storage, candidates, {
    maxPointers: VOLUNTEER_MAX_PAGES_CAP * 2,
    onDegraded: opts.onDegraded,
    ...(opts.sourceIds !== undefined ? { sourceIds: opts.sourceIds } : {}),
  });
  if (!pointers.length) return [];

  const out: VolunteeredPage[] = [];
  for (const p of pointers) {
    if (opts.excludeSlugs?.has(p.slug)) continue; // before gate + cap
    if (opts.priorContext && opts.priorContext.includes(p.slug)) continue;
    const cand =
      (p.matchedNorm ? byNorm.get(p.matchedNorm) : undefined) ??
      byNorm.get(normalizeAlias(p.display));
    const boost =
      cand && (cand.occurrences >= 2 || cand.inNewestTurn)
        ? VOLUNTEER_SALIENCE_BOOST
        : 0;
    const confidence = Math.min(0.99, ARM_CONFIDENCE[p.arm] + boost);
    if (confidence < minConfidence) continue;
    out.push({
      slug: p.slug,
      title: p.title,
      display: p.display,
      confidence,
      arm: p.arm,
      rationale: rationaleFor(p.arm, p.display, cand, turns.length),
      synopsis: p.synopsis,
    });
    if (out.length >= maxPages) break;
  }
  return out;
}

/**
 * Canonical human rendering of one volunteered page — shared by `memrain watch`
 * and the volunteer_context op so the surfaces can't drift.
 */
export function formatVolunteeredPage(p: VolunteeredPage): string {
  return (
    `${p.display} -> ${p.slug} (${p.confidence.toFixed(2)}, ${p.arm}) - ${p.rationale}` +
    (p.synopsis ? `\n    ${p.synopsis}` : "")
  );
}

// -- Usage stats (the feedback loop) --------------------------------------

export interface VolunteerArmStats {
  match_arm: string;
  channel: string;
  volunteered: number;
  used: number;
  /** used / volunteered, 0 when nothing volunteered. */
  precision: number;
}

export interface VolunteerUsageStats {
  days: number;
  /** The join is approximate — false +/- documented in the note. */
  approximate: true;
  note: string;
  total_volunteered: number;
  total_used: number;
  by_arm: VolunteerArmStats[];
}

export const VOLUNTEER_STATS_NOTE =
  'approximate: "used" = pages.last_retrieved_at > volunteered_at. The ' +
  "last-retrieved throttle causes false negatives; unrelated reads of the " +
  "same page cause false positives.";

interface UsageRow {
  match_arm: string | null;
  channel: string | null;
  volunteered: string | number;
  used: string | number;
}

/**
 * Per-arm/channel precision over the last N days. Read-only; returns zeroed
 * stats on a pre-044 brain (no table).
 *
 * `sourceIds` is the caller's read scope: omitted means the operator's whole
 * brain; a list narrows the events to pages in those sources (each event carries
 * its page's source); `[]` sees nothing.
 */
export async function volunteerUsageStats(
  storage: Storage,
  days = 30,
  sourceIds?: string[],
): Promise<VolunteerUsageStats> {
  const safeDays = Number.isFinite(days) && days > 0 ? Math.floor(days) : 30;
  const params: unknown[] = [String(safeDays)];
  const scopeFilter = andSourceScope("e.source_id", sourceIds, params);
  // A slug can be reused by another source after a purge; a scoped caller's
  // "used" count must come from its own page, not the new owner's retrievals.
  const pageScope = sourceIds !== undefined ? " AND p.source_id = e.source_id" : "";
  let rows: UsageRow[] = [];
  try {
    const r = await storage.engine().query<UsageRow>(
      // Slug-level precision: a slug re-volunteered N times must count once, else
      // a single `last_retrieved_at` open inflates `used` by N and precision can
      // exceed 1.0. count(DISTINCT slug) keeps numerator + denominator at page
      // granularity, bounding precision to [0,1].
      `SELECT e.match_arm, e.channel,
              count(DISTINCT e.slug)::text AS volunteered,
              count(DISTINCT e.slug) FILTER (WHERE p.last_retrieved_at > e.volunteered_at)::text AS used
         FROM context_volunteer_events e
         LEFT JOIN pages p
           ON p.slug = e.slug AND p.deleted_at IS NULL${pageScope}
        WHERE e.volunteered_at > now() - ($1 || ' days')::interval${scopeFilter}
        GROUP BY e.match_arm, e.channel
        ORDER BY e.match_arm, e.channel`,
      params,
    );
    rows = r.rows;
  } catch {
    rows = []; // pre-044 brain — table doesn't exist yet
  }
  const by_arm: VolunteerArmStats[] = rows.map((r) => {
    const volunteered = Number(r.volunteered);
    const used = Number(r.used);
    return {
      match_arm: r.match_arm ?? "",
      channel: r.channel ?? "",
      volunteered,
      used,
      precision: volunteered > 0 ? Number((used / volunteered).toFixed(3)) : 0,
    };
  });
  return {
    days: safeDays,
    approximate: true,
    note: VOLUNTEER_STATS_NOTE,
    total_volunteered: by_arm.reduce((s, a) => s + a.volunteered, 0),
    total_used: by_arm.reduce((s, a) => s + a.used, 0),
    by_arm,
  };
}
