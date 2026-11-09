/**
 * Parser/renderer for fenced takes tables — the operator-authored takes canon.
 *
 * Markdown is the source of truth (the page body is canonical). The
 * `synth_takes` rows derived from a fence are an index; this module is the
 * boundary between them.
 *
 * Fence shape (HTML-comment markers):
 *
 *   ## Takes
 *
 *   <!--- memrain:takes:begin -->
 *   | # | claim | kind | who | weight | since | source |
 *   |---|-------|------|-----|--------|-------|--------|
 *   | 1 | CEO of Acme | fact | world | 1.0 | 2017-01 | Crustdata |
 *   | 2 | Strong technical founder | take | operator | 0.85 | 2026-04-29 | OH |
 *   | 3 | ~~Will reach $50B~~ | bet | operator | 0.7 | 2026-04 → 2026-06 | superseded by #4 |
 *   | 4 | Will reach $30B | bet | operator | 0.55 | 2026-06 | revised after Q2 |
 *   <!--- memrain:takes:end -->
 *
 * Parsing rules (strict on canonical shape, lenient on hand-edits):
 *
 * - Strikethrough `~~claim~~` → active=false; the inner text is parsed.
 * - Date ranges in `since` (`2022-01 → 2026-06` or `2022-01 -> 2026-06`)
 *   split into `sinceDate` + `untilDate`.
 * - Weight parses as a float here; out-of-range values are clamped at the
 *   DB-write layer (normalizeWeightForStorage), not in the parser.
 * - Malformed rows (wrong cell count, non-numeric weight, unknown kind) are
 *   skipped; the parser returns the parsed-OK rows + a `warnings` list so
 *   callers can surface TAKES_TABLE_MALFORMED.
 *
 * Append-only semantics: `upsertTakeRow` always appends to the end of the
 * table; `supersedeRow` strikes through the target row's claim + appends a
 * replacement. Row numbers never shift, so cross-references (`slug#N`) stay
 * valid forever.
 *
 * Resolution columns: when ANY row carries a resolution quality, the renderer
 * widens the table with `resolved | quality | evidence | value | unit | by`
 * columns; unresolved pages keep the narrow 7-column shape. Round-trip
 * preservation through upsert/supersede is the safety net against silently
 * dropping resolution data on unrelated edits.
 *
 * Markers are brand-namespaced: `memrain:` and the `memex:` markers of earlier
 * releases both parse, and every edit keeps the marker the page already
 * carries. A page carrying both brands is refused (parsed as empty with a
 * TAKES_FENCE_MIXED warning, never rewritten).
 */

import { locateFenceMarkers, fenceMarkers, FENCE_BRANDS, parseRowCells, escapeFenceCell, type FenceBrand } from "../fence-shared.ts";

export type FenceTakeKind = string;

export type TakeQuality = "correct" | "incorrect" | "partial" | "unresolvable";

export interface ParsedFenceTake {
  rowNum: number;
  /** Strikethrough markers stripped; inner text only. */
  claim: string;
  kind: FenceTakeKind;
  /**
   * Who HOLDS this belief — the person asserting/endorsing it, NOT the person
   * the belief is about. Values: 'world' (consensus fact) | 'brain'
   * (AI-inferred) | 'people/<slug>' | 'companies/<slug>' | a legacy bare slug.
   */
  holder: string;
  /** 0..1 raw — may be out of range; the DB write layer clamps. */
  weight: number;
  sinceDate?: string;
  untilDate?: string;
  source?: string;
  /** false when the claim was wrapped in ~~ ~~ (superseded/retracted). */
  active: boolean;
  // Resolution fields — undefined on unresolved rows.
  resolvedAt?: string;
  resolvedQuality?: TakeQuality;
  resolvedOutcome?: boolean;
  resolvedEvidence?: string;
  resolvedValue?: number;
  resolvedUnit?: string;
  resolvedBy?: string;
}

export interface FenceParseResult {
  takes: ParsedFenceTake[];
  warnings: string[];
}

export const TAKES_FENCE_BEGIN = "<!--- memrain:takes:begin -->";
export const TAKES_FENCE_END = "<!--- memrain:takes:end -->";
export const LEGACY_TAKES_FENCE_BEGIN = "<!--- memex:takes:begin -->";
export const LEGACY_TAKES_FENCE_END = "<!--- memex:takes:end -->";

const TAKES_FENCE_MIXED = "TAKES_FENCE_MIXED: both memrain: and memex: takes fences present";

interface TakesFenceSpan {
  brand: FenceBrand;
  begin: string;
  end: string;
  beginIdx: number;
  endIdx: number;
}

/**
 * Locate the takes fence with the `indexOf` rule every takes site has always
 * used, under the brand whose begin marker the body carries. With no begin
 * marker, an orphan end marker of either brand is still reported (the parser
 * warns TAKES_FENCE_UNBALANCED on it). `"mixed"` when both brands are present.
 */
function locateTakesFence(body: string): TakesFenceSpan | "mixed" {
  const bounds = locateFenceMarkers(body, "takes", true);
  if (bounds?.brand === "both") return "mixed";
  if (bounds !== null) return bounds;
  return { brand: "memex", ...fenceMarkers("takes", "memex"), beginIdx: -1, endIdx: -1 };
}

/** Slug character class for holder segments (matches memrain page-slug grammar:
 *  lowercase alphanumerics plus `._-`). */
const SLUG_SEGMENT = "[a-z0-9][a-z0-9._-]*";

/**
 * Holder grammar. Canonical: `world` | `brain` | `people/<slug>` |
 * `companies/<slug>`. A legacy bare slug (single lowercase segment) is
 * tolerated — the markdown source-of-truth contract preserves the row either
 * way — so the canonical `world`/`brain` literals need no branch of their own;
 * they are bare segments. Only a malformed holder (uppercase, an unknown
 * prefix, empty) fails here and earns TAKES_HOLDER_INVALID.
 */
export const HOLDER_REGEX = new RegExp(
  `^(?:(?:people|companies)/${SLUG_SEGMENT}|${SLUG_SEGMENT})$`,
);

export function isValidHolder(holder: string): boolean {
  return HOLDER_REGEX.test(holder);
}

/** Fence kinds: the operator vocabulary (fact/take/bet/hunch) plus the
 *  LLM-propose vocabulary (prediction/judgment) so both stay one namespace. */
const KIND_VALUES: ReadonlySet<string> = new Set([
  "fact",
  "take",
  "bet",
  "hunch",
  "prediction",
  "judgment",
]);
const QUALITY_VALUES: ReadonlySet<string> = new Set([
  "correct",
  "incorrect",
  "partial",
  "unresolvable",
]);

// Header tokens that mark a resolution-shape fence. Presence of any widens
// the parser to read the extra cells; absence keeps the 7-column shape.
const RESOLUTION_HEADER_TOKENS = [
  "resolved",
  "quality",
  "evidence",
  "value",
  "unit",
  "by",
] as const;
type ResolutionColumn = (typeof RESOLUTION_HEADER_TOKENS)[number];

// --- shared pipe-table primitives -------------------------------------------

export { parseRowCells, escapeFenceCell } from "../fence-shared.ts";

/** True for a `|---|:--:|` header-separator row. */
export function isSeparatorRow(cells: string[]): boolean {
  return cells.every((c) => /^[-:\s]+$/.test(c)) && cells.length > 0;
}

/** `~~text~~` → { text, struck: true }; plain text passes through. */
export function stripStrikethrough(s: string): { text: string; struck: boolean } {
  const m = s.match(/^~~(.+?)~~$/);
  if (m && m[1] !== undefined) return { text: m[1].trim(), struck: true };
  return { text: s, struck: false };
}

// --- cell parsers ------------------------------------------------------------

function parseQualityCell(raw: string): TakeQuality | undefined {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return undefined;
  return QUALITY_VALUES.has(trimmed) ? (trimmed as TakeQuality) : undefined;
}

function parseFloatCell(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const n = Number.parseFloat(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

function parseStringCell(raw: string): string | undefined {
  const trimmed = raw.trim();
  return trimmed || undefined;
}

function parseSinceCell(raw: string): { since?: string; until?: string } {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  // Range syntax: `2022-01 → 2026-06` or `2022-01 -> 2026-06`.
  //
  // No `\s*` around the arrow. It used to be there, and it squared the scan:
  // `.` already accepts whitespace, so for every length of the lazy left side
  // the `\s*` re-walked the same whitespace run looking for an arrow that is
  // not there. Measured through parseTakesFence on a since cell of
  // `a` + spaces + `b`: 7.9 ms at 4 K, 32.0 ms at 8 K, 129.9 ms at 16 K,
  // 520.6 ms at 32 K — ratio 4.0 per doubling, ~9 minutes extrapolated to a
  // 1 MB page. A page body is user-written and nothing caps it on this path.
  //
  // Dropping it does not change what this accepts: `\s*` is subsumed by the
  // `.+?`/`.+` on either side, so the language is identical, and the only
  // observable difference — whitespace inside the two capture groups — is
  // undone by the `.trim()` two lines down. Verified over 81 curated cells
  // plus 400 K fuzzed ones: no output differs. Now linear, ratio 2.0.
  //
  // The two sides still share the arrow character, which the rule still flags.
  // That one is measured linear through parseTakesFence too: 0.31 ms on a
  // 256 K cell of arrows, ratio 1.9 on a doubling (0.25 ms for `a` + arrows,
  // 0.24 ms for a `-` run, 0.13 ms for `->` pairs). The right side can only
  // come up empty at the very last position, so at most ONE arrow in a cell
  // ever fails and hands the scan back — there is no repeatable rejection.
  // eslint-disable-next-line regexp/no-super-linear-backtracking
  const rangeMatch = trimmed.match(/^(.+?)(?:→|->)(.+)$/);
  if (rangeMatch && rangeMatch[1] !== undefined && rangeMatch[2] !== undefined) {
    return { since: rangeMatch[1].trim(), until: rangeMatch[2].trim() };
  }
  return { since: trimmed };
}

/**
 * Normalize a weight for storage. Single source of truth for every takes
 * write site.
 *
 *   1. NaN / ±Infinity → 0.5 (default), clamped=true.
 *   2. Out of [0, 1] → clamp, clamped=true.
 *   3. Round to the 0.05 grid (finer values are false precision relative to
 *      actual calibration accuracy). Rounding alone does NOT set `clamped`.
 *
 * `undefined`/`null` return 0.5 with clamped=false (the default weight when a
 * fence row omits the column).
 */
export function normalizeWeightForStorage(
  raw: number | null | undefined,
): { weight: number; clamped: boolean } {
  let w = raw ?? 0.5;
  let clamped = false;
  if (!Number.isFinite(w)) {
    clamped = true;
    w = 0.5;
  } else if (w < 0 || w > 1) {
    clamped = true;
    w = Math.max(0, Math.min(1, w));
  }
  return { weight: Math.round(w * 20) / 20, clamped };
}

// --- parse -------------------------------------------------------------------

/**
 * Slice the body between the fence markers and parse the table. Returns empty
 * takes + empty warnings when no fence is present.
 */
export function parseTakesFence(body: string): FenceParseResult {
  const warnings: string[] = [];
  const span = locateTakesFence(body);
  if (span === "mixed") {
    warnings.push(TAKES_FENCE_MIXED);
    return { takes: [], warnings };
  }
  const { beginIdx, endIdx } = span;

  if (beginIdx === -1 && endIdx === -1) return { takes: [], warnings };
  if (beginIdx === -1 || endIdx === -1) {
    warnings.push("TAKES_FENCE_UNBALANCED: missing begin or end marker");
    return { takes: [], warnings };
  }

  const inner = body.slice(beginIdx + span.begin.length, endIdx);
  const lines = inner.split("\n");
  const takes: ParsedFenceTake[] = [];
  let sawHeader = false;
  // Resolution column name → cell index. Empty for the 7-column shape.
  const resolutionColIdx: Partial<Record<ResolutionColumn, number>> = {};
  const seenRowNums = new Set<number>();

  for (const line of lines) {
    if (!line.trim()) continue;
    const cells = parseRowCells(line);
    if (!cells) continue;

    if (!sawHeader) {
      const lower = cells.map((c) => c.toLowerCase());
      if (lower.includes("claim") && lower.includes("kind")) {
        sawHeader = true;
        for (const tok of RESOLUTION_HEADER_TOKENS) {
          const idx = lower.indexOf(tok);
          if (idx !== -1) resolutionColIdx[tok] = idx;
        }
        continue;
      }
      warnings.push(`TAKES_TABLE_MALFORMED: row before header: "${line.trim()}"`);
      continue;
    }

    if (isSeparatorRow(cells)) continue;

    // 7 cells expected: row_num, claim, kind, holder, weight, since, source
    // (source may be omitted → 6).
    if (cells.length < 6) {
      warnings.push(
        `TAKES_TABLE_MALFORMED: only ${cells.length} cells in row "${line.trim()}"`,
      );
      continue;
    }

    const [rowNumStr = "", claimRaw = "", kindRaw = "", holderRaw = "", weightRaw = "", sinceRaw = "", sourceRaw = ""] =
      cells;
    const rowNum = Number.parseInt(rowNumStr, 10);
    if (!Number.isFinite(rowNum) || rowNum <= 0) {
      warnings.push(`TAKES_TABLE_MALFORMED: invalid row_num "${rowNumStr}"`);
      continue;
    }
    if (seenRowNums.has(rowNum)) {
      warnings.push(`TAKES_ROW_NUM_COLLISION: duplicate row_num ${rowNum}`);
      continue;
    }
    seenRowNums.add(rowNum);

    const kind = kindRaw.trim().toLowerCase();
    if (!KIND_VALUES.has(kind)) {
      warnings.push(
        `TAKES_TABLE_MALFORMED: unknown kind "${kindRaw}" (expected fact|take|bet|hunch|prediction|judgment)`,
      );
      continue;
    }

    // Holder grammar check — warning only; the row is still parsed + stored
    // (markdown source-of-truth contract).
    const holderTrimmed = holderRaw.trim();
    if (!isValidHolder(holderTrimmed)) {
      warnings.push(
        `TAKES_HOLDER_INVALID: "${holderTrimmed}" in row ${rowNumStr} (expected: world | brain | people/<slug> | companies/<slug>)`,
      );
    }

    const weight = Number.parseFloat(weightRaw);
    if (!Number.isFinite(weight)) {
      warnings.push(`TAKES_TABLE_MALFORMED: non-numeric weight "${weightRaw}"`);
      continue;
    }

    const { text: claimText, struck } = stripStrikethrough(claimRaw);
    const { since, until } = parseSinceCell(sinceRaw);

    const cellAt = (col: ResolutionColumn): string | undefined => {
      const idx = resolutionColIdx[col];
      if (idx === undefined) return undefined;
      return idx < cells.length ? cells[idx] : undefined;
    };
    const resolvedAtRaw = cellAt("resolved");
    const qualityRaw = cellAt("quality");
    const evidenceRaw = cellAt("evidence");
    const valueRaw = cellAt("value");
    const unitRaw = cellAt("unit");
    const byRaw = cellAt("by");
    const resolvedQuality = qualityRaw !== undefined ? parseQualityCell(qualityRaw) : undefined;
    // Derive the boolean outcome so the parsed shape is self-consistent for
    // callers reading either field.
    const resolvedOutcome =
      resolvedQuality === "correct" ? true : resolvedQuality === "incorrect" ? false : undefined;

    const take: ParsedFenceTake = {
      rowNum,
      claim: claimText,
      kind,
      holder: holderTrimmed,
      weight,
      active: !struck,
    };
    if (since !== undefined) take.sinceDate = since;
    if (until !== undefined) take.untilDate = until;
    const source = sourceRaw.trim();
    if (source) take.source = source;
    const resolvedAt = resolvedAtRaw ? parseStringCell(resolvedAtRaw) : undefined;
    if (resolvedAt !== undefined) take.resolvedAt = resolvedAt;
    if (resolvedQuality !== undefined) take.resolvedQuality = resolvedQuality;
    if (resolvedOutcome !== undefined) take.resolvedOutcome = resolvedOutcome;
    const evidence = evidenceRaw ? parseStringCell(evidenceRaw) : undefined;
    if (evidence !== undefined) take.resolvedEvidence = evidence;
    const value = valueRaw ? parseFloatCell(valueRaw) : undefined;
    if (value !== undefined) take.resolvedValue = value;
    const unit = unitRaw ? parseStringCell(unitRaw) : undefined;
    if (unit !== undefined) take.resolvedUnit = unit;
    const by = byRaw ? parseStringCell(byRaw) : undefined;
    if (by !== undefined) take.resolvedBy = by;
    takes.push(take);
  }

  if (!sawHeader && takes.length === 0 && lines.some((l) => l.trim().startsWith("|"))) {
    warnings.push("TAKES_TABLE_MALFORMED: pipe-rows present but no recognizable header");
  }

  return { takes, warnings };
}

// --- render ------------------------------------------------------------------

function formatWeight(w: number): string {
  if (Number.isInteger(w)) return w.toFixed(1);
  return String(Number.parseFloat(w.toFixed(2)));
}

/**
 * Render a takes array back to a fenced markdown table. Round-trip safe with
 * parseTakesFence. When ANY take has `resolvedQuality` set, the table widens
 * to the resolution shape; otherwise it keeps the narrow 7-column shape.
 * `brand` picks the markers; edits of an existing fence pass that fence's brand.
 */
export function renderTakesFence(takes: ParsedFenceTake[], brand: FenceBrand = "memrain"): string {
  const hasAnyResolution = takes.some((t) => t.resolvedQuality !== undefined);
  const header = hasAnyResolution
    ? `| # | claim | kind | who | weight | since | source | resolved | quality | evidence | value | unit | by |`
    : `| # | claim | kind | who | weight | since | source |`;
  const separator = hasAnyResolution
    ? `|---|-------|------|-----|--------|-------|--------|----------|---------|----------|-------|------|----|`
    : `|---|-------|------|-----|--------|-------|--------|`;
  const rows = takes.map((t) => {
    const claimCell = t.active ? t.claim : `~~${t.claim}~~`;
    const sinceCell = t.untilDate
      ? `${t.sinceDate ?? ""} → ${t.untilDate}`
      : (t.sinceDate ?? "");
    const w = formatWeight(t.weight);
    const source = t.source ?? "";
    const safe = escapeFenceCell;
    const baseCells = `| ${t.rowNum} | ${safe(claimCell)} | ${t.kind} | ${safe(t.holder)} | ${w} | ${safe(sinceCell)} | ${safe(source)} |`;
    if (!hasAnyResolution) return baseCells;
    const resolved = t.resolvedAt ? safe(t.resolvedAt) : "";
    const quality = t.resolvedQuality ?? "";
    const evidence = t.resolvedEvidence ? safe(t.resolvedEvidence) : "";
    const value = t.resolvedValue !== undefined ? String(t.resolvedValue) : "";
    const unit = t.resolvedUnit ? safe(t.resolvedUnit) : "";
    const by = t.resolvedBy ? safe(t.resolvedBy) : "";
    return `${baseCells} ${resolved} | ${quality} | ${evidence} | ${value} | ${unit} | ${by} |`;
  });
  const inner = ["", header, separator, ...rows, ""].join("\n");
  const { begin, end } = fenceMarkers("takes", brand);
  return `${begin}${inner}${end}`;
}

// --- body edits --------------------------------------------------------------

/**
 * Append a new take row to the body. If a fenced takes table exists the row is
 * added at its end; otherwise a new `## Takes` section + fence is created at
 * the end of the body. Append-only: row_num = max existing + 1, stable forever.
 * The page's existing marker brand is kept; the default brand applies only to
 * a page with no fence. Throws (no write) on a page carrying both brands.
 */
export function upsertTakeRow(
  body: string,
  newRow: Omit<ParsedFenceTake, "rowNum"> & { rowNum?: number },
): { body: string; rowNum: number } {
  const span = locateTakesFence(body);
  if (span === "mixed") {
    throw new Error("upsertTakeRow: page carries both memrain: and memex: takes fences");
  }
  const { takes } = parseTakesFence(body);
  const nextRowNum =
    newRow.rowNum ?? (takes.length > 0 ? Math.max(...takes.map((t) => t.rowNum)) + 1 : 1);

  const appended: ParsedFenceTake = {
    ...newRow,
    rowNum: nextRowNum,
    weight: newRow.weight ?? 0.5,
    active: newRow.active ?? true,
  };
  const newFence = renderTakesFence(
    [...takes, appended],
    span.beginIdx !== -1 ? span.brand : undefined,
  );

  const { beginIdx, endIdx } = span;
  let out: string;
  if (beginIdx !== -1 && endIdx !== -1) {
    out = body.slice(0, beginIdx) + newFence + body.slice(endIdx + span.end.length);
  } else {
    const sep = body.endsWith("\n") ? "\n" : "\n\n";
    out = `${body}${sep}## Takes\n\n${newFence}\n`;
  }
  return { body: out, rowNum: nextRowNum };
}

/**
 * Supersede an existing row: strike through the target row's claim AND append
 * a new row with the replacement. Both rows stay in the markdown for git-blame
 * archaeology. Throws when the target row is not in the fence. Keeps the
 * fence's marker brand; throws on a page carrying both brands.
 */
export function supersedeRow(
  body: string,
  oldRowNum: number,
  replacement: Omit<ParsedFenceTake, "rowNum" | "active">,
): { body: string; oldRowNum: number; newRowNum: number } {
  const span = locateTakesFence(body);
  if (span === "mixed") {
    throw new Error("supersedeRow: page carries both memrain: and memex: takes fences");
  }
  const { takes } = parseTakesFence(body);
  const idx = takes.findIndex((t) => t.rowNum === oldRowNum);
  if (idx === -1) {
    throw new Error(`supersedeRow: row #${oldRowNum} not found in takes fence`);
  }
  const newRowNum = takes.length > 0 ? Math.max(...takes.map((t) => t.rowNum)) + 1 : 1;

  const updatedTakes: ParsedFenceTake[] = takes.map((t, i) =>
    i === idx ? { ...t, active: false } : t,
  );
  updatedTakes.push({
    ...replacement,
    rowNum: newRowNum,
    source: replacement.source ?? `superseded by #${newRowNum}`,
    active: true,
  });

  const newFence = renderTakesFence(updatedTakes, span.brand);
  const { beginIdx, endIdx } = span;
  if (beginIdx === -1 || endIdx === -1) {
    throw new Error("supersedeRow: fence markers missing in body");
  }
  const out = body.slice(0, beginIdx) + newFence + body.slice(endIdx + span.end.length);
  return { body: out, oldRowNum, newRowNum };
}

/**
 * Strip the fenced takes block from a body — used so takes content lives only
 * in the takes table, not duplicated into page chunks. No-op when no fence is
 * present or the input is not a string. Every brand present is stripped.
 */
export function stripTakesFence(body: string): string {
  if (typeof body !== "string") return body;
  let out = body;
  for (const brand of FENCE_BRANDS) out = stripOneTakesFence(out, fenceMarkers("takes", brand));
  return out;
}

function stripOneTakesFence(body: string, markers: { begin: string; end: string }): string {
  if (!body.includes(markers.begin)) return body;
  const lines = body.split(/\r?\n/);
  const begin = lines.findIndex((l) => l.trim() === markers.begin);
  const end = lines.findIndex((l) => l.trim() === markers.end);
  if (begin === -1 || end === -1 || end <= begin) return body;

  // Also drop a `## Takes` heading directly above the fence (and any blank lines
  // between them), so stripping doesn't leave a dangling header that chunks as
  // search noise — mirrors stripFactsFence.
  let from = begin;
  let probe = begin - 1;
  while (probe >= 0 && (lines[probe] ?? "").trim() === "") probe--;
  if (probe >= 0 && /^#{1,6}\s+takes\s*$/i.test((lines[probe] ?? "").trim())) {
    from = probe;
  }
  const kept = [...lines.slice(0, from), ...lines.slice(end + 1)];
  return kept.join("\n");
}
