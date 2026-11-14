/**
 * `memrain write-gate <list|approve|reject>` — the operator's review queue for
 * documents the write gate held (core/write-gate-holds.ts).
 *
 *   list    [--all] [--json]   open holds (every hold with --all), newest first
 *   approve <id> [--json]      release the document into search; it keeps its
 *                              instruction_like flag and strong read frame
 *   reject  <id> [--json]      keep the document hidden
 *
 * Local CLI only: the operator decides, recorded as `operator`.
 */
import { loadConfig } from "../core/config.ts";
import { Storage } from "../core/storage.ts";
import { decideWriteGateHold, listWriteGateHolds } from "../core/write-gate-holds.ts";
import { withStorage } from "./with-storage.ts";

export type WriteGateSub = "list" | "approve" | "reject";

export interface WriteGateCmdOptions {
  sub: WriteGateSub;
  /** approve/reject: the hold id from `list`. */
  id?: number;
  /** list: include decided holds. */
  all?: boolean;
  json?: boolean;
  configPath?: string;
}

export async function runWriteGate(opts: WriteGateCmdOptions): Promise<number> {
  const storage = new Storage(loadConfig(opts.configPath));
  return withStorage(storage, async () => {
    const engine = storage.engine();
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
