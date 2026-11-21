/**
 * The write gate on facts, takes and timeline entries.
 *
 * Documents are gated in the indexer (write-gate-index.ts). A row an agent
 * writes, or one that lands in an outside source, runs through the same
 * detector here. The owner's rows are never gated. MEMRAIN_WRITE_GATE_ROWS
 * picks the mode:
 *
 *   flag        (default) the row is stored and read as before; a receipt in
 *               `write_gate_receipts` (migration 179) names the families and a
 *               hash of the text, never the text
 *   quarantine  the row is not stored: writers call `holdIfQuarantined` before
 *               their insert, and a matching row goes to
 *               `write_gate_row_holds` (migration 183) until the owner releases
 *               or drops it (write-gate-row-holds.ts)
 *   off         no check
 *
 * Recording is best effort: a failure is logged and never fails the write.
 * Some writers call this inside their own transaction, where a failed
 * statement would abort it, so every statement here is a read or an insert
 * that cannot violate a constraint (a missing source writes nothing).
 */
import type { Engine } from "./engine/interface.ts";
import type { TrustTier } from "./trust-tier.ts";
import { documentRankSql, factRankSql, isTrustTier, pageRankSql, rankTierSql } from "./trust-tier.ts";
import { findRowHold, holdKindOf, recordRowHold } from "./write-gate-row-holds.ts";
import {
  WRITE_GATE_DETECTOR_VERSION,
  detectInstructionLike,
  holdingFamilies,
  writeGateBinding,
  writeGateOrigin,
  type DetectorResult,
  type GateField,
  type WriteGateOrigin,
} from "./write-gate.ts";

export type GatedRowTable = "entity_facts" | "synth_takes" | "timeline_events";
export type RowGateMode = "off" | "flag" | "quarantine";

const ROW_MODES: readonly RowGateMode[] = ["off", "flag", "quarantine"];
const warnedRowModes = new Set<string>();

/**
 * MEMRAIN_WRITE_GATE_ROWS (default `flag`) for both origins, unless the
 * origin's own variable (MEMRAIN_WRITE_GATE_EXTERNAL / MEMRAIN_WRITE_GATE_AGENT)
 * is `off`. The document modes of those variables do not carry over to rows.
 */
export function resolveRowGateMode(
  origin: WriteGateOrigin,
  _sourceId: string,
  env: Record<string, string | undefined> = process.env,
): RowGateMode {
  const key = origin === "external" ? "MEMRAIN_WRITE_GATE_EXTERNAL" : "MEMRAIN_WRITE_GATE_AGENT";
  if (env[key]?.trim().toLowerCase() === "off") return "off";
  const raw = env["MEMRAIN_WRITE_GATE_ROWS"]?.trim().toLowerCase();
  if (!raw) return "flag";
  if ((ROW_MODES as readonly string[]).includes(raw)) return raw as RowGateMode;
  if (!warnedRowModes.has(raw)) {
    warnedRowModes.add(raw);
    console.warn(`[write-gate] MEMRAIN_WRITE_GATE_ROWS must be one of ${ROW_MODES.join("|")}; using flag`);
  }
  return "flag";
}

export interface GatedRow {
  table: GatedRowTable;
  /** The row's id (`synth_takes`: its take_key). */
  targetId: string | number;
  sourceId: string | null;
  /** The writer's trust tier for this row. */
  tier: TrustTier;
  fields: readonly GateField[];
}

/** Check one stored row; true when a receipt was written or bumped. Never throws. */
export async function flagGatedRow(
  engine: Engine,
  row: GatedRow,
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  const result = detect(row.fields);
  if (result !== null && !result.flagged) return false;
  return recordFlag(engine, row, result, env);
}

/** The detector's result, or null when it threw (recorded as a detector error). */
function detect(fields: readonly GateField[]): DetectorResult | null {
  try {
    return detectInstructionLike(fields);
  } catch {
    return null;
  }
}

async function recordFlag(
  engine: Engine,
  row: GatedRow,
  result: DetectorResult | null,
  env: Record<string, string | undefined>,
): Promise<boolean> {
  const sourceId = row.sourceId ?? "default";
  const origin = writeGateOrigin(row.tier);
  if (origin === null || resolveRowGateMode(origin, sourceId, env) === "off") return false;
  try {
    const r = await engine.query<{ id: number }>(
      `INSERT INTO write_gate_receipts
         (target_table, target_id, source_id, origin, verdict, reason_families, detector_version, detector_error, binding)
       SELECT $1, $2, $3, $4, 'flag', $5::text[], $6, $7, $8
        WHERE EXISTS (SELECT 1 FROM sources WHERE id = $3)
       ON CONFLICT (target_table, target_id, binding, detector_version)
       DO UPDATE SET seen_count = write_gate_receipts.seen_count + 1, last_seen_at = NOW()
       RETURNING id`,
      [
        row.table,
        String(row.targetId),
        sourceId,
        origin,
        result?.families ?? [],
        result?.detector_version ?? "unknown",
        result === null,
        writeGateBinding(row.fields),
      ],
    );
    return r.rows.length > 0;
  } catch (e) {
    console.warn(`[write-gate] could not record a flag on ${row.table} ${row.targetId}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/** The stored row whose effective tier decides the origin, read the way trust-frame.ts reads it. */
export type RowOrigin =
  | { fact: number }
  | { event: number }
  /** A take on a page's takes fence, or one a caller pinned to the page. */
  | { page: string; principal?: string | null }
  /** A take proposed from a document. */
  | { document: string }
  /** A fact about to be inserted, by the columns its tier is read from. */
  | { newFact: ProspectiveFact }
  /** A timeline entry about to be inserted. */
  | { newEvent: ProspectiveEvent };

export interface ProspectiveFact {
  principal?: string | null;
  sourceId: string;
  sourceSlug?: string | null;
  markdownSlug?: string | null;
  chunkId?: string | null;
}

export interface ProspectiveEvent {
  principal?: string | null;
  sourceId: string;
  slug: string;
  chunkId?: string | null;
  /** The page the text came from, when it is not `slug`; its tier can only lower the entry's. */
  drawnFrom?: string | null;
}

function originQuery(origin: RowOrigin): { sql: string; params: unknown[] } {
  if ("newFact" in origin) {
    const f = origin.newFact;
    // scope: upstream the row the caller is about to write, by its own columns
    return {
      sql: `SELECT ${rankTierSql(factRankSql("r", "tt_p.slug IN (r.source_slug, r.source_markdown_slug)"))} AS tier, r.source_id
              FROM (SELECT $1::text AS written_by_principal, $2::text AS source_id, $3::text AS source_slug,
                           $4::text AS source_markdown_slug, $5::text AS source_chunk_id, NULL::text AS trust_tier) r`,
      params: [f.principal ?? null, f.sourceId, f.sourceSlug ?? null, f.markdownSlug ?? null, f.chunkId ?? null],
    };
  }
  if ("newEvent" in origin) {
    const e = origin.newEvent;
    // scope: upstream the row the caller is about to write, by its own columns
    return {
      sql: `SELECT ${rankTierSql(factRankSql("r", "tt_p.slug IN (r.slug, r.drawn_from)", false))} AS tier, r.source_id
              FROM (SELECT $1::text AS written_by_principal, $2::text AS source_id, $3::text AS slug, $4::text AS source_chunk_id,
                           $5::text AS drawn_from) r`,
      params: [e.principal ?? null, e.sourceId, e.slug, e.chunkId ?? null, e.drawnFrom ?? null],
    };
  }
  if ("fact" in origin) {
    // scope: upstream the row the caller just wrote, by its key
    return { sql: `SELECT ${rankTierSql(factRankSql("r", "tt_p.slug IN (r.source_slug, r.source_markdown_slug)"))} AS tier, r.source_id FROM entity_facts r WHERE r.id = $1`, params: [origin.fact] };
  }
  if ("event" in origin) {
    // scope: upstream the row the caller just wrote, by its key
    return { sql: `SELECT ${rankTierSql(factRankSql("r", "tt_p.slug = r.slug"))} AS tier, r.source_id FROM timeline_events r WHERE r.id = $1`, params: [origin.event] };
  }
  if ("page" in origin) {
    // A caller's principal can only lower the page's tier.
    const principal = `CASE WHEN $2::text IS NULL OR $2::text IN ('', 'operator') THEN 3 WHEN $2::text LIKE 'member:%' THEN 2 ELSE 1 END`;
    // scope: upstream the row the caller just wrote, by its key
    return { sql: `SELECT ${rankTierSql(`LEAST(${pageRankSql("pg")}, ${principal})`)} AS tier, pg.source_id FROM pages pg WHERE pg.slug = $1`, params: [origin.page, origin.principal ?? null] };
  }
  // scope: upstream the document the caller just drew the row from, by its key
  return { sql: `SELECT ${rankTierSql(documentRankSql("d"))} AS tier, COALESCE(d.source_id, 'default') AS source_id FROM documents d WHERE d.id = $1`, params: [origin.document] };
}

/** A row's effective tier and source, read the way trust-frame.ts reads it; null when the row is not found. */
export async function effectiveRowTier(engine: Engine, origin: RowOrigin): Promise<{ tier: TrustTier; sourceId: string } | null> {
  const q = originQuery(origin);
  const r = await engine.query<{ tier: string | null; source_id: string | null }>(q.sql, q.params);
  const tier = r.rows[0]?.tier;
  return isTrustTier(tier) ? { tier, sourceId: r.rows[0]?.source_id ?? "default" } : null;
}

/**
 * Check a stored row whose tier is its effective trust: the writer, the
 * source kind, and the page or document it was drawn from, so a fact the
 * extractor took from an agent's page counts as the agent's. Never throws.
 */
export async function flagRowAt(
  engine: Engine,
  row: { table: GatedRowTable; targetId: string | number; fields: readonly GateField[] },
  origin: RowOrigin,
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  // Most rows are plain text: run the detector before the tier lookup, which
  // joins page history and runs inside some writers' transactions.
  const result = detect(row.fields);
  if (result !== null && !result.flagged) return false;
  try {
    const at = await effectiveRowTier(engine, origin);
    if (at === null) return false;
    return await recordFlag(engine, { ...row, sourceId: at.sourceId, tier: at.tier }, result, env);
  } catch (e) {
    console.warn(`[write-gate] could not check ${row.table} ${row.targetId}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

export interface RowHoldCandidate {
  table: GatedRowTable;
  fields: readonly GateField[];
  /** The page the row lands on (a fact's entity, a take's page, an entry's page); '' when none. */
  slug: string;
  /** The row exactly as the writer would insert it; what a release inserts. */
  payload: Record<string, unknown>;
  /** Part of the hold's key beside the text, so two rows with the same text (a timeline entry on another day) stay two holds. */
  identity?: string;
}

export interface RowHeld {
  hold_id: number;
  ref: string;
  status: "held" | "dropped";
  families: string[];
}

/**
 * Called by a writer before it inserts a gated row. In quarantine mode, a
 * row whose text the detector matches (or cannot assess) and whose effective
 * tier is not the owner's is held instead: the writer must then skip its
 * insert. Null means "insert as usual" (any flag receipt is recorded after the
 * insert, as in flag mode); content the owner released before is inserted.
 * Never throws: a failure is logged and the row is stored as before.
 */
export async function holdIfQuarantined(
  engine: Engine,
  row: RowHoldCandidate,
  origin: RowOrigin,
  env: Record<string, string | undefined> = process.env,
): Promise<RowHeld | null> {
  if (env["MEMRAIN_WRITE_GATE_ROWS"]?.trim().toLowerCase() !== "quarantine") return null;
  const result = detect(row.fields);
  if (result !== null && !result.flagged) return null;
  try {
    const at = await effectiveRowTier(engine, origin);
    if (at === null || at.tier === "owner") return null;
    const { tier, sourceId } = at;
    const gateOrigin = writeGateOrigin(tier);
    if (gateOrigin === null || resolveRowGateMode(gateOrigin, sourceId, env) !== "quarantine") return null;
    if (result !== null && holdingFamilies(gateOrigin, result.families).length === 0) return null;
    const kind = holdKindOf(row.table);
    const detectorVersion = result?.detector_version ?? WRITE_GATE_DETECTOR_VERSION;
    const keyFields = row.identity === undefined ? row.fields : [...row.fields, { field: "identity", text: row.identity }];
    const prior = await findRowHold(engine, { kind, sourceId, slug: row.slug, fields: keyFields, detectorVersion });
    if (prior?.status === "released") return null;
    const families = result?.families ?? [];
    // The owner dropped this content under an earlier detector: it stays dropped.
    if (prior?.status === "dropped" && prior.detectorVersion !== detectorVersion) {
      return { hold_id: prior.id, ref: `h${prior.id}`, status: "dropped", families: [...families] };
    }
    const hold = await recordRowHold(engine, {
      kind, sourceId, slug: row.slug, fields: keyFields, payload: row.payload,
      origin: gateOrigin, tier, families, detectorVersion, detectorError: result === null,
    });
    if (hold === null || hold.status === "released") return null;
    return { hold_id: hold.id, ref: `h${hold.id}`, status: hold.status, families: [...families] };
  } catch (e) {
    console.warn(`[write-gate] could not assess a ${row.table} row for quarantine: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
