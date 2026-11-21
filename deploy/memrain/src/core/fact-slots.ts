/**
 * Fact slots. A fact about a person may carry one slot, a (dimension, value)
 * pair from a closed vocabulary of single-valued dimensions: where they live,
 * who employs them, their role. Nothing closes a slot value in storage: every
 * reader derives each value's end at read time from the slot's chronology,
 * over the facts that reader may see, so a fact hidden from a reader never
 * ends one it can see, and re-extracting pages in any order yields the same
 * windows.
 */
import type { Engine } from "./engine/interface.ts";
import { normalizeDimension, valueHash } from "./chronicle/ontology.ts";
import { factSourceEligibleSql } from "./quarantine.ts";
import { factRemoteEligibleSql } from "./fact-visibility.ts";
import { ownerOnlyLineageSql } from "./owner-only.ts";
import { factRankSql } from "./trust-tier.ts";

/** The dimensions a fact may carry as a slot. Each holds one value at a time. */
export const SLOT_DIMENSIONS: ReadonlySet<string> = new Set(["location", "employer", "role"]);
export const MAX_SLOT_VALUE_CHARS = 80;

/** The slot a fact keeps, or null: a dimension outside the vocabulary, an empty or over-long value, or no entity. */
export function normalizeSlot(dimension: unknown, value: unknown, entity: string | null | undefined): { dimension: string; value: string } | null {
  if (!entity || typeof dimension !== "string" || typeof value !== "string") return null;
  const d = normalizeDimension(dimension);
  const v = value.trim();
  return SLOT_DIMENSIONS.has(d) && v && v.length <= MAX_SLOT_VALUE_CHARS ? { dimension: d, value: v } : null;
}

export function slotValueHash(value: string): string {
  return valueHash(value);
}

/** Across source pages, a newer value ends the one before it only when its fact states the change in plain English. */
export const CHANGE_CUE = /\b(?:moved|relocated|left|quit|joined|switched|transferred|promoted|resigned|retired|now (?:works|lives|is based|based)|started (?:at|as|working)|took over|stepped down|became|no longer|used to|formerly)\b/i;

export interface SlotRow {
  id: number; source_id: string; entity_slug: string; dimension: string; value_hash: string;
  valid_from: Date | string; source_markdown_slug: string | null; fact: string;
  /** Effective trust rank (core/trust-tier.ts); absent means unknown and is not compared. */
  trust_rank?: number;
}

export interface SlotEnd { at: Date; by: number }

/**
 * Derived ends by fact id. Rows of one (source, entity, dimension) are walked
 * in valid_from order; consecutive rows of one value are one stint (a
 * restatement continues it). A stint ends where the next distinct value starts
 * when that value's first row is on a page one of the stint's rows came from,
 * or its fact matches CHANGE_CUE, and only when it starts later than the stint.
 * A value less trusted than a row of the stint never ends it: replacing a more
 * trusted value is the owner's decision (core/trust-proposals.ts).
 * Callers pass only rows the reader may see.
 */
export function deriveSlotEnds(rows: readonly SlotRow[]): Map<number, SlotEnd> {
  const ends = new Map<number, SlotEnd>();
  const groups = new Map<string, SlotRow[]>();
  for (const r of rows) {
    const key = [r.source_id, r.entity_slug, r.dimension].join("\u0000");
    const group = groups.get(key);
    if (group) group.push(r);
    else groups.set(key, [r]);
  }
  const time = (r: SlotRow) => new Date(r.valid_from).getTime();
  for (const group of groups.values()) {
    group.sort((a, b) => time(a) - time(b) || a.value_hash.localeCompare(b.value_hash) || Number(a.id) - Number(b.id));
    const stints: SlotRow[][] = [];
    for (const r of group) {
      const last = stints.at(-1);
      if (last && last[0]!.value_hash === r.value_hash) last.push(r);
      else stints.push([r]);
    }
    for (let i = 0; i + 1 < stints.length; i++) {
      const stint = stints[i]!;
      const next = stints[i + 1]![0]!;
      if (time(next) <= time(stint[0]!)) continue;
      const samePage = next.source_markdown_slug != null && stint.some((r) => r.source_markdown_slug === next.source_markdown_slug);
      if (!samePage && !CHANGE_CUE.test(next.fact)) continue;
      if (next.trust_rank !== undefined && stint.some((r) => r.trust_rank !== undefined && r.trust_rank > next.trust_rank!)) continue;
      for (const r of stint) ends.set(Number(r.id), { at: new Date(next.valid_from), by: Number(next.id) });
    }
  }
  return ends;
}

/** The read policy of the reader asking: the same predicates its own fact read applies. */
export interface SlotReadScope {
  sourceIds?: readonly string[];
  /** Visibilities the reader may see; omitted or empty → all. */
  visibility?: readonly string[];
  /** A remote read: no diary-derived fact, none from an owner-only source. */
  excludeDiary?: boolean;
  /** A remote read that already fences diaries elsewhere: no fact from an owner-only source. */
  excludeOwnerOnly?: boolean;
  /** Read the slots as the brain knew them at this instant (ISO). */
  knownAsOf?: string;
}

/**
 * Live at the known-as-of instant in parameter `n` (over an unaliased
 * entity_facts): not retired then, or retired later by a replacement. Erased
 * stays erased: a row forgotten or purged is never read back, and neither is
 * a replaced copy of a claim that was later withdrawn or of a purged page.
 */
export function knownAsOfLiveSql(n: number): string {
  if (!Number.isSafeInteger(n) || n < 1) throw new Error("invalid parameter index");
  return `(forgotten_at IS NULL OR (forgotten_at > $${n}::timestamptz AND forgotten_cause = 'supersede'
      AND NOT EXISTS (SELECT 1 FROM fact_withdrawals w
                       WHERE w.source_id = entity_facts.source_id AND w.visibility = entity_facts.visibility
                         AND w.entity_slug = entity_facts.entity_slug AND w.claim_key = memrain_fact_claim_key(entity_facts.fact))
      AND NOT EXISTS (SELECT 1 FROM fact_purge_receipts pr
                       WHERE pr.source_id = entity_facts.source_id
                         AND pr.page_slug = COALESCE(entity_facts.source_markdown_slug, entity_facts.source_slug))))`;
}

/** A slot row's effective trust rank, over the unaliased entity_facts. */
const SLOT_RANK_SQL = factRankSql("entity_facts", "tt_p.slug IN (entity_facts.source_slug, entity_facts.source_markdown_slug)");

/** The date a slot value starts: its valid_from, else the day it was first written. */
const SLOT_START_SQL = "COALESCE(valid_from, first_written_at::date, written_at::date)";

/** Every slot row of the given entities the reader may see. */
async function readSlotRows(engine: Engine, scope: SlotReadScope, keys: ReadonlyArray<{ source_id: string; entity_slug: string }>): Promise<SlotRow[]> {
  const params: unknown[] = [keys.map((k) => k.source_id), keys.map((k) => k.entity_slug)];
  const where = [
    "slot_dimension IS NOT NULL", "slot_value_hash IS NOT NULL", "dimension IS NULL", factSourceEligibleSql(),
    "(source_id, entity_slug) IN (SELECT * FROM unnest($1::text[], $2::text[]))",
  ];
  if (scope.knownAsOf !== undefined) {
    params.push(scope.knownAsOf);
    where.push(`COALESCE(first_written_at, written_at) <= $${params.length}::timestamptz`, knownAsOfLiveSql(params.length));
  } else {
    where.push("forgotten_at IS NULL");
  }
  if (scope.sourceIds !== undefined) {
    params.push([...scope.sourceIds]);
    where.push(`source_id = ANY($${params.length}::text[])`);
  }
  if (scope.visibility && scope.visibility.length > 0) {
    params.push([...scope.visibility]);
    where.push(`visibility = ANY($${params.length}::text[])`);
  }
  if (scope.excludeDiary) where.push(factRemoteEligibleSql());
  else if (scope.excludeOwnerOnly) where.push(ownerOnlyLineageSql("fact", "entity_facts.id"));
  // scope: upstream keyed by the reader's own (source_id, entity_slug) pairs, plus its source grant when it has one.
  const r = await engine.query<SlotRow>(
    `SELECT id, source_id, entity_slug, slot_dimension AS dimension, slot_value_hash AS value_hash,
            ${SLOT_START_SQL}::text AS valid_from, COALESCE(source_markdown_slug, source_slug) AS source_markdown_slug, fact,
            (${SLOT_RANK_SQL})::int AS trust_rank
       FROM entity_facts WHERE ${where.join(" AND ")}
      ORDER BY ${SLOT_START_SQL}, id`,
    params,
  );
  return r.rows.map((row) => ({ ...row, id: Number(row.id), trust_rank: Number(row.trust_rank) }));
}

/**
 * Read-time slot ends for one reader's rows. One read of the slot rows of the
 * rows' entities under the reader's own scope. A row with a stored
 * valid_until keeps it. A row a derived end has passed (as of now, or as of
 * `knownAsOf`) is dropped when `activeOnly`, otherwise returned with
 * `valid_until` set to its end (a future end is kept and shown). Rows without a slot cost no read.
 */
export async function applySlotEnds<T extends { id: number; source_id: string; entity_slug: string; valid_until?: string | null; slot_dimension?: string | null }>(
  engine: Engine, scope: SlotReadScope, rows: T[], opts: { activeOnly: boolean },
): Promise<{ rows: Array<T & { slot_end?: SlotEnd }>; dropped: number }> {
  const keys = new Map(rows.filter((r) => r.slot_dimension).map((r) => [`${r.source_id}\u0000${r.entity_slug}`, { source_id: r.source_id, entity_slug: r.entity_slug }]));
  if (keys.size === 0) return { rows, dropped: 0 };
  const ends = deriveSlotEnds(await readSlotRows(engine, scope, [...keys.values()]));
  if (ends.size === 0) return { rows, dropped: 0 };
  const now = scope.knownAsOf !== undefined ? new Date(scope.knownAsOf).getTime() : Date.now();
  let dropped = 0;
  const out = rows.flatMap((r) => {
    const end = r.valid_until ? undefined : ends.get(Number(r.id));
    if (!end) return [r];
    if (opts.activeOnly && end.at.getTime() <= now) { dropped++; return []; }
    return [{ ...r, valid_until: end.at.toISOString().slice(0, 10), slot_end: end }];
  });
  return { rows: out, dropped };
}
