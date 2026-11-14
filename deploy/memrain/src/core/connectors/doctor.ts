/**
 * doctor `connector-accounts`: are connectors on, can the key open what is
 * stored, and which accounts cannot sync. Accounts are named by provider and
 * id prefix only — never by mailbox address or token.
 */
import type { Engine } from "../engine/interface.ts";
import type { OpsCheckResult } from "../doctor-ops.ts";
import { connectorsStatus } from "./vault.ts";

const NAMED = 5;

export async function checkConnectorAccounts(engine: Engine, env: NodeJS.ProcessEnv = process.env): Promise<OpsCheckResult> {
  const st = connectorsStatus(env);
  const accounts = await engine.query<{ id: string; provider: string; status: string; status_reason: string | null }>(
    `SELECT id::text AS id, provider, status, status_reason FROM connector_accounts ORDER BY created_at, id`,
  );
  const total = accounts.rows.length;
  const flagSet = (env.MEMRAIN_CONNECTORS_ENABLED ?? "").trim() !== "";
  if (total === 0) {
    return st.enabled || !flagSet
      ? { ok: true, status: "ok", detail: st.enabled ? "connectors on, no account connected" : st.reason ?? "connectors off" }
      : { ok: true, status: "warn", detail: `connectors requested but closed: ${st.reason}` };
  }

  const problems: string[] = [];
  if (!st.enabled) problems.push(`${total} connector account(s) cannot sync: ${st.reason}`);
  if (st.kekId !== null) {
    const foreign = await engine.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM connector_credentials WHERE kek_id <> $1`, [st.kekId]);
    const n = Number(foreign.rows[0]?.n ?? 0);
    if (n > 0) problems.push(`${n} credential(s) sealed by another key; load that key or run connectors rotate-kek`);
  }
  const parked = accounts.rows.filter((a) => a.status !== "active");
  if (parked.length > 0) {
    const named = parked.slice(0, NAMED).map((a) => `${a.provider}/${a.id.slice(0, 8)}: ${a.status}${a.status_reason ? ` (${a.status_reason})` : ""}`);
    const more = parked.length > NAMED ? ` and ${parked.length - NAMED} more` : "";
    problems.push(`${named.join("; ")}${more}`);
  }
  if (problems.length === 0) return { ok: true, status: "ok", detail: `${total} connector account(s), all active` };
  return { ok: true, status: "warn", detail: problems.join("; ") };
}
