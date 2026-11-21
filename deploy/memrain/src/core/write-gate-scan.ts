/**
 * One-time scan of facts, takes and timeline entries stored before the row
 * gate ran on them (`memrain write-gate scan`).
 *
 * Runs the detector over every live row and, for a match whose effective tier
 * is an agent's or outside text, records a `flag` receipt exactly as the
 * writer would have. It never holds, hides, rewrites or removes a row, in any
 * gate mode: rows already stored are only flagged. The owner's matches are
 * counted, never recorded. A dry run writes nothing.
 *
 * Keyset batches by id; a repeat run adds nothing (receipts are keyed by row,
 * text hash and detector version). The report holds counts and family names
 * only, never text, slugs or ids.
 */
import type { Engine } from "./engine/interface.ts";
import { logIngest } from "./ingest-log.ts";
import {
  detectInstructionLike,
  writeGateBinding,
  writeGateOrigin,
  WRITE_GATE_DETECTOR_VERSION,
  type GateField,
} from "./write-gate.ts";
import { effectiveRowTier, type GatedRowTable, type RowOrigin } from "./write-gate-rows.ts";

export const ROW_SCAN_TABLES: readonly GatedRowTable[] = ["entity_facts", "synth_takes", "timeline_events"];

export interface RowScanTableReport {
  scanned: number;
  /** Rows the detector matched, whatever their tier. */
  matched: number;
  /** Matches at an agent's or outside tier: the rows that get a receipt. */
  flagged: number;
  /** Matches the owner wrote: counted only. */
  owner: number;
  /** Matches whose tier could not be read (row gone mid-scan, or a take with no page or document). */
  unresolved: number;
  by_origin: { agent: number; external: number };
  /** Flagged rows per family. */
  families: Record<string, number>;
  /** Flagged rows per pattern name. */
  patterns: Record<string, number>;
}

export interface RowScanReport {
  detector_version: string;
  dry_run: boolean;
  receipts_written: number;
  tables: Record<GatedRowTable, RowScanTableReport>;
}

export interface RowScanOptions {
  dryRun?: boolean;
  batchSize?: number;
  onBatch?: (table: GatedRowTable, scanned: number) => void;
}

interface ScanRow { id: number; fields: GateField[]; origins: RowOrigin[] }

interface TableSpec {
  sql: string;
  toRow: (r: Record<string, unknown>) => ScanRow;
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");

// The fields each writer assesses, so a scan receipt carries the same binding
// the writer's own receipt would have.
const SPECS: Readonly<Record<GatedRowTable, TableSpec>> = {
  entity_facts: {
    // scope: operator-only a whole-brain scan run from the local CLI
    sql: `SELECT id, fact, context FROM entity_facts WHERE forgotten_at IS NULL AND id > $1 ORDER BY id LIMIT $2`,
    toRow: r => ({
      id: Number(r["id"]),
      fields: [{ field: "fact", text: text(r["fact"]) }, { field: "context", text: text(r["context"]) }],
      origins: [{ fact: Number(r["id"]) }],
    }),
  },
  synth_takes: {
    // scope: operator-only a whole-brain scan run from the local CLI
    sql: `SELECT id, source_ref, row_num, claim_text, resolved_source FROM synth_takes WHERE active AND id > $1 ORDER BY id LIMIT $2`,
    toRow: r => {
      const ref = text(r["source_ref"]);
      const fence = r["row_num"] !== null && r["row_num"] !== undefined;
      return {
        id: Number(r["id"]),
        fields: fence
          ? [{ field: "claim", text: text(r["claim_text"]) }, { field: "evidence", text: text(r["resolved_source"]) }]
          : [{ field: "claim", text: text(r["claim_text"]) }],
        // A fence take is its page's; a proposed take its document's; a think take its anchor page's.
        origins: fence ? [{ page: ref }] : [{ document: ref }, { page: ref }],
      };
    },
  },
  timeline_events: {
    // scope: operator-only a whole-brain scan run from the local CLI
    sql: `SELECT id, event, detail FROM timeline_events WHERE id > $1 ORDER BY id LIMIT $2`,
    toRow: r => ({
      id: Number(r["id"]),
      fields: [{ field: "event", text: text(r["event"]) }, { field: "detail", text: text(r["detail"]) }],
      origins: [{ event: Number(r["id"]) }],
    }),
  },
};

function emptyTable(): RowScanTableReport {
  return { scanned: 0, matched: 0, flagged: 0, owner: 0, unresolved: 0, by_origin: { agent: 0, external: 0 }, families: {}, patterns: {} };
}

const bump = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };

/** The target id a writer records for a row: a take is keyed by its take_key. */
async function targetIdOf(engine: Engine, table: GatedRowTable, id: number): Promise<string> {
  if (table !== "synth_takes") return String(id);
  // scope: upstream the take row this scan just read, by its id
  const r = await engine.query<{ take_key: string }>(`SELECT take_key FROM synth_takes WHERE id = $1`, [id]);
  return r.rows[0]?.take_key ?? String(id);
}

export async function scanExistingRows(engine: Engine, opts: RowScanOptions = {}): Promise<RowScanReport> {
  const batch = Math.max(1, Math.min(opts.batchSize ?? 500, 5000));
  const report: RowScanReport = {
    detector_version: WRITE_GATE_DETECTOR_VERSION,
    dry_run: opts.dryRun === true,
    receipts_written: 0,
    tables: { entity_facts: emptyTable(), synth_takes: emptyTable(), timeline_events: emptyTable() },
  };
  for (const table of ROW_SCAN_TABLES) {
    const spec = SPECS[table];
    const out = report.tables[table];
    let cursor = 0;
    for (;;) {
      const rows = (await engine.query<Record<string, unknown>>(spec.sql, [cursor, batch])).rows;
      for (const raw of rows) {
        const row = spec.toRow(raw);
        const result = detectInstructionLike(row.fields);
        if (!result.flagged) continue;
        out.matched++;
        let at: Awaited<ReturnType<typeof effectiveRowTier>> = null;
        for (const origin of row.origins) {
          at = await effectiveRowTier(engine, origin);
          if (at !== null) break;
        }
        if (at === null) { out.unresolved++; continue; }
        const origin = writeGateOrigin(at.tier);
        if (origin === null) { out.owner++; continue; }
        out.flagged++;
        out.by_origin[origin]++;
        for (const f of result.families) bump(out.families, f);
        for (const p of new Set(result.matches.map(m => m.pattern))) bump(out.patterns, p);
        if (opts.dryRun) continue;
        const written = await engine.query<{ id: number }>(
          `INSERT INTO write_gate_receipts
             (target_table, target_id, source_id, origin, verdict, reason_families, detector_version, detector_error, binding)
           SELECT $1, $2, $3, $4, 'flag', $5::text[], $6, false, $7
            WHERE EXISTS (SELECT 1 FROM sources WHERE id = $3)
           ON CONFLICT (target_table, target_id, binding, detector_version) DO NOTHING
           RETURNING id`,
          [table, await targetIdOf(engine, table, row.id), at.sourceId, origin, result.families, result.detector_version,
            writeGateBinding(row.fields)],
        );
        report.receipts_written += written.rows.length;
      }
      out.scanned += rows.length;
      opts.onBatch?.(table, out.scanned);
      if (rows.length < batch) break;
      cursor = Number(rows[rows.length - 1]!["id"]);
    }
  }
  if (!opts.dryRun) {
    const t = report.tables;
    await logIngest(engine, {
      source_type: "write_gate",
      source_ref: "row-scan",
      summary: `row scan [${report.detector_version}]: flagged facts ${t.entity_facts.flagged}, takes ${t.synth_takes.flagged}, `
        + `timeline ${t.timeline_events.flagged}; ${report.receipts_written} new receipts`,
    });
  }
  return report;
}
