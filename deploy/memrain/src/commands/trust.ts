/**
 * `memrain trust <proposals|accept|reject>` — the owner's queue of writes that
 * would have replaced a more trusted fact or ontology value
 * (core/trust-proposals.ts).
 *
 *   proposals [--all] [--json]  pending proposals (every one with --all)
 *   accept <id> [--json]        apply the replacement the writer asked for
 *   reject <id> [--json]        keep the more trusted fact; the other is retired
 *
 * Local CLI only: the operator decides, recorded as `operator`.
 */
import { loadConfig } from "../core/config.ts";
import { Storage } from "../core/storage.ts";
import { decideTrustProposal, listTrustProposals, type TrustDecisionStatus } from "../core/trust-proposals.ts";
import { withStorage } from "./with-storage.ts";

export interface TrustCmdOptions {
  sub: "proposals" | "accept" | "reject";
  id?: number;
  all?: boolean;
  json?: boolean;
  configPath?: string;
}

const NOTES: Record<TrustDecisionStatus, (id: number) => string> = {
  accepted: id => `Proposal #${id} accepted: the change it asked for is applied.`,
  rejected: id => `Proposal #${id} rejected: the more trusted fact stays.`,
  stale: id => `Proposal #${id} is stale: one of its facts changed since, so nothing was applied.`,
  already_decided: id => `Proposal #${id} was already decided.`,
  not_found: id => `No trust proposal #${id}.`,
};

export async function runTrust(opts: TrustCmdOptions): Promise<number> {
  const storage = new Storage(loadConfig(opts.configPath));
  return withStorage(storage, async () => {
    const engine = storage.engine();
    if (opts.sub === "proposals") {
      const rows = await listTrustProposals(engine, { status: opts.all ? "all" : "pending" });
      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
        return 0;
      }
      if (rows.length === 0) {
        console.log(opts.all ? "No trust proposals." : "No trust proposals await a decision.");
        return 0;
      }
      for (const p of rows) {
        const state = p.status === "pending" ? "pending" : `${p.status} by ${p.decided_by}`;
        const what = p.dimension ? `${p.entity_slug} ${p.dimension}` : (p.entity_slug ?? "");
        const change = p.action === "forget" ? `forget asked by an ${p.new_tier} credential` : `${p.new_tier} fact ${p.related_id}`;
        console.log(`#${p.id}  ${p.created_at}  ${p.guard}  ${p.source_id}  ${what}  ${p.old_tier} fact ${p.target_id} <- ${change}  ${state}`);
        // Fact text may be outside text: JSON-quoted so it cannot pose as CLI output.
        console.log(`      current:  ${JSON.stringify(p.old_fact ?? "")}`);
        if (p.action === "forget") console.log("      proposed: forget it (accept forgets the fact, reject keeps it)");
        else console.log(`      proposed: ${JSON.stringify(p.new_fact ?? "")}`);
      }
      return 0;
    }
    const id = opts.id as number;
    const { status } = await decideTrustProposal(engine, id, opts.sub === "accept" ? "accept" : "reject", "operator");
    if (opts.json) console.log(JSON.stringify({ id, status }));
    else console.log(NOTES[status](id));
    return status === "accepted" || status === "rejected" ? 0 : 1;
  });
}
