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
import { GATE_OWNED_KEYS } from "./quarantine.ts";
import { PAGE_MIRROR_PATH_SQL } from "./page-index.ts";
import { documentRankSql, isTrustTier, rankTierSql } from "./trust-tier.ts";
import { documentGateMode } from "./write-gate-index.ts";
import type { GateFamily } from "./write-gate-patterns.ts";
import {
  assessWriteGate,
  detectInstructionLike,
  writeGateBinding,
  writeGateFields,
  writeGateOrigin,
  WRITE_GATE_DETECTOR_VERSION,
  WRITE_GATE_APPROVAL_KEY,
  WRITE_GATE_KEY,
  type GateField,
  type WriteGateAction,
  type WriteGateOrigin,
} from "./write-gate.ts";
import { effectiveRowTier, resolveRowGateMode, type GatedRowTable, type RowOrigin } from "./write-gate-rows.ts";

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
  /** Matches at an origin whose row gate is off: counted only, as the writer would record nothing. */
  gate_off: number;
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
    sql: `SELECT id, source_ref, row_num, claim_text, resolved_source, trust_tier FROM synth_takes WHERE active AND id > $1 ORDER BY id LIMIT $2`,
    toRow: r => {
      const ref = text(r["source_ref"]);
      const fence = r["row_num"] !== null && r["row_num"] !== undefined;
      // The tier the take recorded (a think take is at most an agent's) can only lower its page's or document's.
      const floor = isTrustTier(r["trust_tier"]) ? r["trust_tier"] : null;
      return {
        id: Number(r["id"]),
        fields: fence
          ? [{ field: "claim", text: text(r["claim_text"]) }, { field: "evidence", text: text(r["resolved_source"]) }]
          : [{ field: "claim", text: text(r["claim_text"]) }],
        // A fence take is its page's; a proposed take its document's; a think take its anchor page's.
        origins: fence ? [{ page: ref, floor }] : [{ document: ref, floor }, { page: ref, floor }],
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
  return { scanned: 0, matched: 0, flagged: 0, owner: 0, unresolved: 0, gate_off: 0, by_origin: { agent: 0, external: 0 }, families: {}, patterns: {} };
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
        // The writer records nothing for an origin whose gate is off, and neither does the scan.
        if (resolveRowGateMode(origin, at.sourceId) === "off") { out.gate_off++; continue; }
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

// --- Documents: what the next index would do --------------------------------

export interface DocumentScanSource { scanned: number; matched: number; flag: number; quarantine: number; reject: number }

export interface DocumentScanMatch {
  document_id: string;
  source_id: string;
  origin: WriteGateOrigin;
  /** What the gate would do on the next index under the current modes (`allow`: the gate is off for this origin). */
  action: WriteGateAction;
  /** The verdict stored on the document now (`write_gate.action`), if any. */
  stored: string | null;
  /** The owner approved this content before: the next index keeps it released (counted as `flag`). */
  approved: boolean;
  families: GateFamily[];
  patterns: string[];
}

export interface DocumentScanReport {
  detector_version: string;
  /** Documents an agent or an outside source wrote. */
  scanned: number;
  matched: number;
  /** The owner's documents the detector matched: counted only, never gated. */
  owner_matched: number;
  by_source: Record<string, DocumentScanSource>;
  families: Record<string, number>;
  patterns: Record<string, number>;
  matches: DocumentScanMatch[];
}

/**
 * Run the current detector over stored documents and report, by count and
 * document id, what the gate would do when each is indexed again. Writes
 * nothing. The body is read back from the document's chunks plus, for a page's
 * mirror, the rows of its facts and takes fences, which never become chunks; a
 * fence in any other document is not stored outside its rows and is not read.
 */
export async function scanDocuments(engine: Engine, opts: { batchSize?: number } = {}): Promise<DocumentScanReport> {
  const batch = Math.max(1, Math.min(opts.batchSize ?? 200, 2000));
  const report: DocumentScanReport = {
    detector_version: WRITE_GATE_DETECTOR_VERSION, scanned: 0, matched: 0, owner_matched: 0, by_source: {}, families: {}, patterns: {}, matches: [],
  };
  const modes = new Map<string, Awaited<ReturnType<typeof documentGateMode>>>();
  let cursor = "";
  for (;;) {
    const docs = (await engine.query<{ id: string; source_id: string; title: string | null; frontmatter: Record<string, unknown> | null; tier: string | null }>(
      // scope: operator-only a whole-brain count run from the local CLI
      `SELECT d.id, COALESCE(d.source_id, 'default') AS source_id, d.title, d.frontmatter, ${rankTierSql(documentRankSql("d"))} AS tier
         FROM documents d WHERE d.id > $1 AND d.deleted_at IS NULL ORDER BY d.id LIMIT $2`,
      [cursor, batch],
    )).rows;
    if (docs.length === 0) break;
    const bodies = new Map((await engine.query<{ document_id: string; body: string }>(
      // scope: operator-only the chunks of the documents this scan just read
      `SELECT document_id, string_agg(content, E'\n\n' ORDER BY chunk_index) AS body FROM chunks WHERE document_id = ANY($1::text[]) GROUP BY document_id`,
      [docs.map(d => d.id)],
    )).rows.map(r => [r.document_id, r.body]));
    const fences = new Map((await engine.query<{ id: string; fences: string }>(
      // scope: operator-only the fence rows of the page mirrors this scan just read
      `SELECT d.id, concat_ws(E'\n',
              (SELECT string_agg(concat_ws(' | ', f.fact, f.context), E'\n' ORDER BY f.row_num) FROM entity_facts f
                WHERE f.source_markdown_slug = p.slug AND f.source_id = p.source_id AND f.row_num IS NOT NULL AND f.forgotten_at IS NULL),
              (SELECT string_agg(concat_ws(' | ', t.claim_text, t.resolved_source), E'\n' ORDER BY t.row_num) FROM synth_takes t
                WHERE t.source_ref = p.slug AND t.row_num IS NOT NULL AND t.active
                  -- takes carry no source: read them only when no other live page shares the slug
                  AND NOT EXISTS (SELECT 1 FROM pages p2 WHERE p2.slug = p.slug AND p2.source_id <> p.source_id AND p2.deleted_at IS NULL))) AS fences
         FROM documents d JOIN pages p ON p.source_id = COALESCE(d.source_id, 'default') AND d.source_path = ${PAGE_MIRROR_PATH_SQL}
        WHERE d.id = ANY($1::text[])`,
      [docs.map(d => d.id)],
    )).rows.filter(r => r.fences).map(r => [r.id, r.fences]));
    for (const d of docs) {
      const frontmatter = d.frontmatter ?? {};
      const body = [bodies.get(d.id), fences.get(d.id)].filter(Boolean).join("\n\n");
      const fields = writeGateFields(d.title ?? "", body, frontmatter, GATE_OWNED_KEYS);
      const origin = isTrustTier(d.tier) ? writeGateOrigin(d.tier) : null;
      if (origin === null) {
        if (detectInstructionLike(fields).flagged) report.owner_matched++;
        continue;
      }
      const src = (report.by_source[d.source_id] ??= { scanned: 0, matched: 0, flag: 0, quarantine: 0, reject: 0 });
      src.scanned++;
      report.scanned++;
      const key = `${origin}:${d.source_id}`;
      if (!modes.has(key)) modes.set(key, await documentGateMode(engine, origin, d.source_id));
      const mode = modes.get(key)!;
      const result = detectInstructionLike(fields);
      if (!result.flagged) continue;
      // In `off` mode the verdict is `allow`: matched, but the gate would not act on it.
      const verdict = mode === "off"
        ? { action: "allow" as const }
        : assessWriteGate({ origin, mode, fields, binding: "" }, () => result);
      const stored = frontmatter[WRITE_GATE_KEY] as Record<string, unknown> | undefined;
      const approval = frontmatter[WRITE_GATE_APPROVAL_KEY] as Record<string, unknown> | undefined;
      // The scan cannot rebuild the exact binding (it reads chunks), so an approval counts while it still matches the stored verdict.
      const approved = verdict.action === "quarantine" && typeof approval?.["binding"] === "string" && approval["binding"] === stored?.["binding"];
      src.matched++;
      report.matched++;
      const counted = approved ? "flag" : verdict.action;
      if (counted === "flag" || counted === "quarantine" || counted === "reject") src[counted]++;
      for (const f of result.families) bump(report.families, f);
      const patterns = [...new Set(result.matches.map(m => m.pattern))];
      for (const p of patterns) bump(report.patterns, p);
      report.matches.push({
        document_id: d.id, source_id: d.source_id, origin, action: verdict.action,
        stored: typeof stored?.["action"] === "string" ? stored["action"] : null,
        approved, families: result.families, patterns,
      });
    }
    cursor = docs[docs.length - 1]!.id;
    if (docs.length < batch) break;
  }
  return report;
}

