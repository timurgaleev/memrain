/**
 * `memrain write-gate <list|approve|reject|rows|release|drop|scan>` — the
 * operator's review queues for what the write gate held.
 *
 * Documents (core/write-gate-holds.ts):
 *   list    [--all] [--json]   open holds (every hold with --all), newest first
 *   approve <id> [--json]      release the document into search; it keeps its
 *                              instruction_like flag and strong read frame
 *   reject  <id> [--json]      keep the document hidden
 *
 * Facts, takes and timeline entries (core/write-gate-row-holds.ts):
 *   rows    [--all] [--json]   held rows (every decided one too with --all)
 *   release <id> [--json]      store the row as its writer wrote it, still flagged
 *   drop    <id> [--json]      keep the row out
 *   scan    [--dry-run] [--json]  flag rows stored before the gate ran on them;
 *                              never holds or changes a row
 *
 * Local CLI only: the operator decides, recorded as `operator`.
 */
import { loadConfig } from "../core/config.ts";
import { Storage } from "../core/storage.ts";
import { decideWriteGateHold, listWriteGateHolds } from "../core/write-gate-holds.ts";
import { dropRowHold, listRowHolds, releaseRowHold, type RowHoldDecisionStatus } from "../core/write-gate-row-holds.ts";
import { scanExistingRows, type RowScanReport } from "../core/write-gate-scan.ts";
import { withStorage } from "./with-storage.ts";

export type WriteGateSub = "list" | "approve" | "reject" | "rows" | "release" | "drop" | "scan";

export interface WriteGateCmdOptions {
  sub: WriteGateSub;
  /** approve/reject: the hold id from `list`. */
  id?: number;
  /** list/rows: include decided holds. */
  all?: boolean;
  /** scan: count only, write no receipt. */
  dryRun?: boolean;
  json?: boolean;
  configPath?: string;
}

export async function runWriteGate(opts: WriteGateCmdOptions): Promise<number> {
  const storage = new Storage(loadConfig(opts.configPath));
  return withStorage(storage, async () => {
    const engine = storage.engine();
    if (opts.sub === "rows" || opts.sub === "release" || opts.sub === "drop" || opts.sub === "scan") return rowsCommand(storage, opts);
    if (opts.sub === "list") {
      const holds = await listWriteGateHolds(engine, { status: opts.all ? "all" : "open" });
      if (opts.json) {
        console.log(JSON.stringify(holds, null, 2));
        return 0;
      }
      if (holds.length === 0) {
        console.log(opts.all ? "No write-gate holds." : "No write-gate holds await a decision.");
        return 0;
      }
      for (const h of holds) {
        const state = h.decision ? `${h.decision} by ${h.decided_by}` : h.current ? "open" : "open (document changed since)";
        console.log(`#${h.id}  ${h.created_at}  ${h.origin}  ${h.source_id}  ${h.target_ref}  [${h.families.join(", ") || "detector_error"}]  ${state}`);
        // The excerpt is outside text: JSON-quoted so it cannot pose as CLI output.
        if (h.excerpt) console.log(`      ${JSON.stringify(h.excerpt)}`);
      }
      return 0;
    }
    if (!Number.isInteger(opts.id) || (opts.id as number) < 1) {
      console.error(`memrain write-gate ${opts.sub}: <id> must be a hold id from \`memrain write-gate list\``);
      return 1;
    }
    const { status } = await decideWriteGateHold(engine, {
      holdId: opts.id as number,
      decision: opts.sub === "approve" ? "approve" : "reject",
      decidedBy: "operator",
    });
    const ok = status === "approved" || status === "rejected";
    const notes: Record<typeof status, string> = {
      approved: `Hold #${opts.id} approved: the document is back in search, still flagged as instruction-like.`,
      rejected: `Hold #${opts.id} rejected: the document stays hidden.`,
      stale: `Hold #${opts.id} is stale: the document changed since it was held. Nothing was released.`,
      already_decided: `Hold #${opts.id} was already decided.`,
      not_found: `No hold #${opts.id}.`,
    };
    if (opts.json) console.log(JSON.stringify({ id: opts.id, status }));
    else if (ok) console.log(notes[status]);
    else console.error(notes[status]);
    return ok ? 0 : 1;
  });
}

async function rowsCommand(storage: Storage, opts: WriteGateCmdOptions): Promise<number> {
  const engine = storage.engine();
  if (opts.sub === "scan") {
    const report = await scanExistingRows(engine, { dryRun: opts.dryRun === true });
    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else printScan(report);
    return 0;
  }
  if (opts.sub === "rows") {
    const holds = await listRowHolds(engine, { status: opts.all ? "all" : "held" });
    if (opts.json) {
      console.log(JSON.stringify(holds, null, 2));
      return 0;
    }
    if (holds.length === 0) {
      console.log(opts.all ? "No held rows." : "No held rows await a decision.");
      return 0;
    }
    for (const h of holds) {
      const state = h.status === "held" ? "held" : `${h.status} by ${h.decided_by}`;
      console.log(`#${h.id}  ${h.created_at}  ${h.kind}  ${h.origin}  ${h.source_id}  ${h.slug || "-"}  [${h.families.join(", ") || "detector_error"}]  seen ${h.seen_count}  ${state}`);
      // Held text is untrusted: JSON-quoted so it cannot pose as CLI output.
      const text = h.payload["fact"] ?? h.payload["claim_text"] ?? h.payload["event"];
      if (typeof text === "string") console.log(`      ${JSON.stringify(text)}`);
      if (typeof h.payload["detail"] === "string" && h.payload["detail"]) console.log(`      ${JSON.stringify(h.payload["detail"])}`);
    }
    return 0;
  }
  if (!Number.isInteger(opts.id) || (opts.id as number) < 1) {
    console.error(`memrain write-gate ${opts.sub}: <id> must be a held row id from \`memrain write-gate rows\``);
    return 1;
  }
  const id = opts.id as number;
  const r = opts.sub === "release" ? await releaseRowHold(storage, id, "operator") : await dropRowHold(engine, id, "operator");
  const notes: Record<RowHoldDecisionStatus, string> = {
    released: `Held row #${id} released: it is stored as written, still flagged as instruction-like.`,
    dropped: `Held row #${id} dropped: it stays out.`,
    already_decided: `Held row #${id} was already decided.`,
    not_found: `No held row #${id}.`,
  };
  const ok = r.status === "released" || r.status === "dropped";
  if (opts.json) console.log(JSON.stringify({ id, ...r }));
  else if (ok) console.log(notes[r.status]);
  else console.error(notes[r.status]);
  return ok ? 0 : 1;
}

function printScan(report: RowScanReport): void {
  console.log(`Write gate row scan [${report.detector_version}]${report.dry_run ? " (dry run, nothing written)" : ""}`);
  for (const [table, t] of Object.entries(report.tables)) {
    const families = Object.entries(t.families).map(([f, n]) => `${f} ${n}`).join(", ") || "none";
    console.log(`  ${table}: scanned ${t.scanned}, matched ${t.matched}, flagged ${t.flagged} (agent ${t.by_origin.agent}, external ${t.by_origin.external}), owner ${t.owner}, unresolved ${t.unresolved}; families: ${families}`);
  }
  if (!report.dry_run) console.log(`  new receipts: ${report.receipts_written}`);
}
