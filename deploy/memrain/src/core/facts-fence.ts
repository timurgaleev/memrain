/**
 * Parser / renderer for the `## Facts` markdown fence.
 *
 * A `## Facts` fence on an entity's page is the system-of-record for facts
 * about that entity; the `entity_facts` DB table (migrations 018/035/037) is a
 * derived index the reconcile pass (core/facts-reconcile.ts) rebuilds from it.
 * This module is the pure markdown <-> structured-rows boundary — no DB, no
 * LLM, no I/O — so it can run in the chunker strip path and in a CI invariant
 * check without pulling a DB-shaped dependency graph.
 *
 * memrain carries the column subset its `entity_facts` models: the
 * always-present `claim / confidence / source` plus the optional v1.3.45
 * metadata `kind / notability / valid_from / valid_until`. Columns are matched
 * by HEADER NAME (not fixed position), so a narrow legacy fence
 * (`| # | claim | confidence | source |`) and a wide one parse with the same
 * code, and new columns can be added without breaking old pages. Markers are
 * brand-namespaced: `memrain:` and the `memex:` markers of earlier releases
 * both parse, and a page keeps whichever marker it already carries.
 *
 *   ## Facts
 *
 *   <!--- memrain:facts:begin -->
 *   | # | claim | kind | confidence | notability | valid_from | valid_until | source |
 *   |---|-------|------|------------|------------|------------|-------------|--------|
 *   | 1 | Founded Acme in 2017 | event | 1   | high | 2017-01-01 |            | linkedin   |
 *   | 2 | ~~Moved to Berlin~~  | fact  | 0.9 |      |            | 2024-06-01  | email/x9f2 |
 *   <!--- memrain:facts:end -->
 *
 * A `~~struck~~` claim marks the fact inactive (retracted / forgotten) — the
 * markdown stays the record, and the reconcile pass drops it from the DB.
 */

import {
  parseRowCells,
  isSeparatorRow,
  stripStrikethrough,
  parseStringCell,
  escapeFenceCell,
  locateFenceMarkers,
  fenceMarkers,
  FENCE_BRANDS,
  type FenceBrand,
} from "./fence-shared.ts";
import { DEFAULT_FACT_KIND } from "./facts-decay.ts";

export const FACTS_FENCE_BEGIN = "<!--- memrain:facts:begin -->";
export const FACTS_FENCE_END = "<!--- memrain:facts:end -->";
export const LEGACY_FACTS_FENCE_BEGIN = "<!--- memex:facts:begin -->";
export const LEGACY_FACTS_FENCE_END = "<!--- memex:facts:end -->";

/** Fact category — what kind of claim this is. */
export type FactKind = "event" | "preference" | "commitment" | "belief" | "fact";
/** How notable / important the fact is — ordinal, drives recall ranking. */
export type FactNotability = "high" | "medium" | "low";

const KIND_VALUES: ReadonlySet<string> = new Set([
  "event",
  "preference",
  "commitment",
  "belief",
  "fact",
]);
const NOTABILITY_VALUES: ReadonlySet<string> = new Set(["high", "medium", "low"]);
/** Strict ISO calendar date `YYYY-MM-DD`. */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** One parsed fence row. Mirrors the `entity_facts` projection. */
export interface ParsedFact {
  /** Append-only row number from the `#` column (1-based; sequential fallback). */
  rowNum: number;
  /** Fact text; strikethrough markers stripped on parse. */
  claim: string;
  /** Evidence strength, clamped to 0..1 (default 1.0 on empty/invalid). */
  confidence: number;
  /** Provenance slug, or undefined. */
  source?: string;
  /**
   * Fact category (migration 037). A blank or unrecognized cell resolves to
   * `DEFAULT_FACT_KIND` rather than staying empty: the reconcile pass projects
   * this straight into `entity_facts.kind`, and decay cannot see a blank kind —
   * a fence row that left the column out would never age. Optional only so a
   * hand-built `ParsedFact` need not spell it out; the parser always sets it.
   */
  kind?: FactKind;
  /** Notability ordinal (migration 037). Undefined when absent/unrecognized. */
  notability?: FactNotability;
  /** ISO date the fact became valid (migration 037). Undefined if absent/invalid. */
  validFrom?: string;
  /** ISO date the fact stopped being valid (migration 037). Undefined if absent/invalid. */
  validUntil?: string;
  /**
   * Typed-claim fields (migration 070). Optional. Present when a fact is a
   * numeric claim (`mrr`, `arr`, …); they drive the metric-trajectory
   * regression + drift analysis in core/insights.ts. Absent on ordinary
   * free-text facts — the renderer only widens the fence when at least one row
   * carries one, so existing narrow fences are never churned.
   *   - `claimMetric`: canonical metric label, lowercase snake_case.
   *   - `claimValue`:  finite numeric value. Empty/non-numeric cell → undefined.
   *   - `claimUnit`:   free-form unit string.
   *   - `claimPeriod`: free-form period string, or undefined for non-periodic.
   *   - `eventType`:   event-shaped row marker (`meeting`, `job_change`, …).
   */
  claimMetric?: string;
  claimValue?: number;
  claimUnit?: string;
  claimPeriod?: string;
  eventType?: string;
  /** False when the claim was wrapped in `~~ ~~` (retracted / forgotten). */
  active: boolean;
}

function clampConfidence(raw: string | undefined): number {
  if (raw === undefined) return 1.0;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return 1.0;
  return Math.min(1, Math.max(0, n));
}

/** An absent / blank / unrecognized kind cell floors to `DEFAULT_FACT_KIND` —
 *  see `ParsedFact.kind` for why a fence row may not land kindless. */
function normalizeKind(raw: string | undefined): FactKind {
  if (raw === undefined) return DEFAULT_FACT_KIND;
  const v = raw.trim().toLowerCase();
  return KIND_VALUES.has(v) ? (v as FactKind) : DEFAULT_FACT_KIND;
}

function normalizeNotability(raw: string | undefined): FactNotability | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  return NOTABILITY_VALUES.has(v) ? (v as FactNotability) : undefined;
}

/**
 * Canonicalize a metric / event-type label to lowercase snake_case so the
 * trajectory grouping is stable regardless of hand-edit casing (`Team Size`,
 * `team-size`, `team_size` all collapse to `team_size`). Empty → undefined.
 */
function normalizeLabel(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const v = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    // Measured linear through parseFactsFence, on a fence row whose metric cell
    // is a run of `_` plus a rejecting `x`: 2.4 ms at 4 M chars, ratio 1.84 on a
    // doubling, tracking a plain `a`-run control the whole way. `_` is itself in
    // `[^a-z0-9]`, so the collapse on the line above leaves every underscore run
    // exactly one char long — the run this quantifier squares on cannot reach it.
    // eslint-disable-next-line regexp/no-super-linear-move
    .replace(/^_+|_+$/g, "");
  return v.length > 0 ? v : undefined;
}

/**
 * Parse a free-form numeric cell (typed-claim value). Tolerates plain numbers
 * and scientific notation; strips thousands separators so `50,000` → 50000.
 * Empty / non-numeric → undefined (the row is kept, its value just stays NULL).
 */
function parseNumericCell(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const n = Number.parseFloat(trimmed.replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

/** Parse a strict `YYYY-MM-DD` cell; reject anything else (hand-edits degrade
 *  to undefined rather than poisoning the DATE column). Validates the calendar
 *  so `2024-13-40` is rejected, not just the shape. */
function normalizeDate(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim();
  if (!ISO_DATE_RE.test(v)) return undefined;
  // Reject year 0000 — JS `Date` accepts it (year 0) but Postgres rejects it as
  // a DATE out of range, which would abort reconcile instead of degrading to
  // NULL. Postgres AD dates start at year 1.
  if (v.slice(0, 4) === "0000") return undefined;
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return undefined;
  // Round-trip guard: `Date` normalizes overflow (2024-02-30 → 2024-03-01),
  // so require the parsed value to print back identically.
  return d.toISOString().slice(0, 10) === v ? v : undefined;
}

/**
 * Header → column-index map. Recognized header names (case-insensitive,
 * trimmed) map to a canonical field. Unknown headers are ignored. Returns
 * `null` when the row does not look like a header (no `claim` column).
 */
type ColMap = Partial<Record<keyof ParsedFact, number>>;

function buildColMap(cells: readonly string[]): ColMap | null {
  const map: ColMap = {};
  cells.forEach((cell, idx) => {
    const name = cell.trim().toLowerCase();
    switch (name) {
      case "#":
      case "n":
      case "row":
      case "":
        if (map.rowNum === undefined) map.rowNum = idx;
        break;
      case "claim":
        map.claim = idx;
        break;
      case "kind":
        map.kind = idx;
        break;
      case "confidence":
      case "conf":
        map.confidence = idx;
        break;
      case "notability":
        map.notability = idx;
        break;
      case "valid_from":
      case "valid from":
      case "from":
        map.validFrom = idx;
        break;
      case "valid_until":
      case "valid until":
      case "until":
        map.validUntil = idx;
        break;
      case "source":
      case "src":
        map.source = idx;
        break;
      case "claim_metric":
      case "metric":
        map.claimMetric = idx;
        break;
      case "claim_value":
      case "value":
        map.claimValue = idx;
        break;
      case "claim_unit":
      case "unit":
        map.claimUnit = idx;
        break;
      case "claim_period":
      case "period":
        map.claimPeriod = idx;
        break;
      case "event_type":
        map.eventType = idx;
        break;
      default:
        break;
    }
  });
  return map.claim !== undefined ? map : null;
}

/** Legacy fixed layout for a fence with no recognizable header row. */
const LEGACY_COLMAP: ColMap = { rowNum: 0, claim: 1, confidence: 2, source: 3 };

/**
 * Does this `buildColMap`-matching row look like a HEADER (vs a data row whose
 * claim text is coincidentally a column name like "claim")? A data row always
 * LEADS with its row number; a header leads with a label (`#` / `n` / `row` /
 * empty / a column name). So a positive-integer FIRST cell ⇒ data, not header.
 * Tested against the literal first cell (not a mapped column) so it works even
 * for a header that omits the `#` column.
 */
function isHeaderShaped(cells: readonly string[]): boolean {
  const first = (cells[0] ?? "").trim();
  const n = Number(first);
  return !(Number.isInteger(n) && n > 0);
}

function cellAt(cells: readonly string[], idx: number | undefined): string | undefined {
  if (idx === undefined) return undefined;
  return cells[idx];
}

/**
 * Parse the `## Facts` fence out of a markdown body. Returns the rows in
 * source order. A missing or malformed fence yields `[]` (never throws — the
 * markdown is hand-editable and must degrade gracefully).
 *
 * `warnings`, when supplied, collects a message per DATA row that was skipped
 * for being claimless/malformed (missing or empty claim cell). Callers that
 * project the parse into the DB use it to tell "clean parse" from "partial
 * parse" — a wipe+reinsert over a partial parse would destroy the skipped
 * rows' prior projections. Structural non-rows (prose lines, separators,
 * repeated headers) do not warn: they are tolerated table furniture, not lost
 * facts. A body carrying both a `memrain:` and a `memex:` facts fence yields
 * `[]` plus a warning: neither fence is authoritative over the other.
 */
export function parseFactsFence(markdown: string, warnings?: string[]): ParsedFact[] {
  const bounds = locateFenceMarkers(markdown, "facts");
  if (bounds === null) return [];
  if (bounds.brand === "both") {
    warnings?.push("FACTS_FENCE_MIXED: both memrain: and memex: facts fences present");
    return [];
  }
  const lines = markdown.split(/\r?\n/);
  const begin = bounds.beginLine;
  const end = bounds.endLine;
  if (begin === -1 || end === -1 || end <= begin) return [];

  // First pass: locate the header row (the first row carrying a `claim` column)
  // and build the column map from it. Fall back to the legacy fixed layout when
  // no header is present, so a header-less hand-written fence still parses.
  //
  // A row is only accepted as the header when it ALSO looks header-shaped: its
  // row-number cell must be non-numeric (`#` / `n` / `row` / empty). Every data
  // row starts with an actual row number, so this stops a data row whose claim
  // text happens to be the literal word "claim" (which would otherwise satisfy
  // buildColMap) from being absorbed as the header and silently dropped.
  let colMap: ColMap = LEGACY_COLMAP;
  let headerIdx = -1;
  for (let i = begin + 1; i < end; i++) {
    const cells = parseRowCells(lines[i] ?? "");
    if (!cells || isSeparatorRow(cells)) continue;
    const m = buildColMap(cells);
    if (m && isHeaderShaped(cells)) {
      colMap = m;
      headerIdx = i;
      break;
    }
  }

  const out: ParsedFact[] = [];
  let seq = 0;
  for (let i = begin + 1; i < end; i++) {
    if (i === headerIdx) continue; // skip the header row itself
    const cells = parseRowCells(lines[i] ?? "");
    if (!cells) {
      // A pipe-bearing line inside the fence that fails row parsing is a
      // mangled data row — surface it, or reconcile would treat its absence
      // as a deletion. Pipe-less prose stays silent (legitimately skippable).
      const raw = (lines[i] ?? "").trim();
      if (raw.includes("|")) {
        warnings?.push(`fence line ${i + 1}: unparseable table row`);
      }
      continue;
    }
    if (isSeparatorRow(cells)) continue;
    // Skip a REPEATED header row (markers/labels, non-numeric lead cell) — a
    // duplicate `| # | claim | … |` must not become a fact whose claim is the
    // literal word "claim". A genuine data row leads with a row number, so
    // isHeaderShaped is false for it and it parses normally.
    if (buildColMap(cells) && isHeaderShaped(cells)) continue;
    const claimCell = cellAt(cells, colMap.claim);
    if (claimCell === undefined) {
      warnings?.push(`fence line ${i + 1}: data row has no claim cell`);
      continue;
    }
    const { text: claim, struck } = stripStrikethrough(claimCell);
    if (!claim.trim()) {
      // a row with no claim is not a fact
      warnings?.push(`fence line ${i + 1}: data row has an empty claim`);
      continue;
    }

    seq += 1;
    const rowNumRaw = Number.parseInt((cellAt(cells, colMap.rowNum) ?? "").trim(), 10);
    const fact: ParsedFact = {
      rowNum: Number.isInteger(rowNumRaw) && rowNumRaw > 0 ? rowNumRaw : seq,
      claim: claim.trim(),
      confidence: clampConfidence(cellAt(cells, colMap.confidence)),
      kind: normalizeKind(cellAt(cells, colMap.kind)),
      active: !struck,
    };
    const source = parseStringCell(cellAt(cells, colMap.source) ?? "");
    if (source !== undefined) fact.source = source;
    const notability = normalizeNotability(cellAt(cells, colMap.notability));
    if (notability !== undefined) fact.notability = notability;
    const validFrom = normalizeDate(cellAt(cells, colMap.validFrom));
    if (validFrom !== undefined) fact.validFrom = validFrom;
    const validUntil = normalizeDate(cellAt(cells, colMap.validUntil));
    if (validUntil !== undefined) fact.validUntil = validUntil;
    // Typed-claim fields (migration 070). Only set when present so an ordinary
    // fact row still `toEqual`s its narrow shape (no undefined keys leak in).
    const claimMetric = normalizeLabel(cellAt(cells, colMap.claimMetric));
    if (claimMetric !== undefined) fact.claimMetric = claimMetric;
    const claimValue = parseNumericCell(cellAt(cells, colMap.claimValue));
    if (claimValue !== undefined) fact.claimValue = claimValue;
    const claimUnit = parseStringCell(cellAt(cells, colMap.claimUnit) ?? "");
    if (claimUnit !== undefined) fact.claimUnit = claimUnit;
    const claimPeriod = parseStringCell(cellAt(cells, colMap.claimPeriod) ?? "");
    if (claimPeriod !== undefined) fact.claimPeriod = claimPeriod;
    const eventType = normalizeLabel(cellAt(cells, colMap.eventType));
    if (eventType !== undefined) fact.eventType = eventType;
    out.push(fact);
  }
  return out;
}

/**
 * Render facts into the fenced markdown block (markers + table). The table
 * widens to carry the migration-070 typed-claim columns ONLY when at least one
 * row has a typed field set; otherwise it stays at the narrow 8-column shape so
 * an ordinary fence is never churned on an unrelated rewrite. `brand` picks
 * the markers; a caller rewriting an existing fence passes that fence's brand.
 */
export function renderFactsFence(facts: readonly ParsedFact[], brand: FenceBrand = "memrain"): string {
  const anyTyped = facts.some(
    (f) =>
      f.claimMetric !== undefined ||
      f.claimValue !== undefined ||
      f.claimUnit !== undefined ||
      f.claimPeriod !== undefined ||
      f.eventType !== undefined,
  );
  const header = anyTyped
    ? "| # | claim | kind | confidence | notability | valid_from | valid_until | source | claim_metric | claim_value | claim_unit | claim_period | event_type |"
    : "| # | claim | kind | confidence | notability | valid_from | valid_until | source |";
  const sep = anyTyped
    ? "|---|-------|------|------------|------------|------------|-------------|--------|--------------|-------------|------------|--------------|------------|"
    : "|---|-------|------|------------|------------|------------|-------------|--------|";
  const rows = facts.map((f, idx) => {
    const claimCell = escapeFenceCell(f.claim);
    const claim = f.active ? claimCell : `~~${claimCell}~~`;
    const n = Number.isInteger(f.rowNum) && f.rowNum > 0 ? f.rowNum : idx + 1;
    const conf = clampConfidence(String(f.confidence));
    const base =
      `| ${n} | ${claim} | ${escapeFenceCell(f.kind ?? "")} | ${conf} | ` +
      `${escapeFenceCell(f.notability ?? "")} | ${escapeFenceCell(f.validFrom ?? "")} | ` +
      `${escapeFenceCell(f.validUntil ?? "")} | ${escapeFenceCell(f.source ?? "")} |`;
    if (!anyTyped) return base;
    const valueCell = f.claimValue === undefined ? "" : String(f.claimValue);
    return (
      `${base} ${escapeFenceCell(f.claimMetric ?? "")} | ${escapeFenceCell(valueCell)} | ` +
      `${escapeFenceCell(f.claimUnit ?? "")} | ${escapeFenceCell(f.claimPeriod ?? "")} | ` +
      `${escapeFenceCell(f.eventType ?? "")} |`
    );
  });
  const { begin, end } = fenceMarkers("facts", brand);
  return [begin, header, sep, ...rows, end].join("\n");
}

/**
 * Remove the `## Facts` fence block (markers + table, and the immediately
 * preceding `## Facts` heading if present) from a markdown body — so the
 * fenced table is not re-indexed as ordinary body text by the chunker. Leaves
 * the rest of the document untouched; a body with no fence is returned as-is.
 * Every brand present is stripped.
 */
export function stripFactsFence(markdown: string): string {
  let out = markdown;
  for (const brand of FENCE_BRANDS) out = stripOneFactsFence(out, fenceMarkers("facts", brand));
  return out;
}

function stripOneFactsFence(markdown: string, markers: { begin: string; end: string }): string {
  if (!markdown.includes(markers.begin)) return markdown;
  const lines = markdown.split(/\r?\n/);
  const begin = lines.findIndex((l) => l.trim() === markers.begin);
  const end = lines.findIndex((l) => l.trim() === markers.end);
  if (begin === -1 || end === -1 || end <= begin) return markdown;

  // Also drop a `## Facts` heading directly above the fence (and one blank
  // line between them), so stripping doesn't leave a dangling header.
  let from = begin;
  let probe = begin - 1;
  while (probe >= 0 && (lines[probe] ?? "").trim() === "") probe--;
  if (probe >= 0 && /^#{1,6}\s+facts\s*$/i.test((lines[probe] ?? "").trim())) {
    from = probe;
  }
  const kept = [...lines.slice(0, from), ...lines.slice(end + 1)];
  return kept.join("\n");
}
