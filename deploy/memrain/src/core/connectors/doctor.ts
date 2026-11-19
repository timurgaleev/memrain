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
  // scope: operator-only doctor reports every account (run_doctor is operator-only)
  const accounts = await engine.query<{ id: string; provider: string; status: string; status_reason: string | null }>(
    `SELECT id::text AS id, provider, status, status_reason FROM connector_accounts ORDER BY created_at, id`,
  );
  const total = accounts.rows.length;
  const problems: string[] = [];

  if (st.kekId !== null) {
    // scope: operator-only doctor counts rows sealed under another key, brain-wide
    const foreign = await engine.query<{ credentials: number; clients: number; states: number }>(
      `SELECT (SELECT count(*) FROM connector_credentials WHERE kek_id <> $1)::int AS credentials,
              (SELECT count(*) FROM connector_oauth_clients WHERE kek_id <> $1)::int AS clients,
              (SELECT count(*) FROM connector_oauth_states
                WHERE kek_id <> $1 AND consumed_at IS NULL AND expires_at > NOW())::int AS states`,
      [st.kekId],
    );
    const f = foreign.rows[0];
    const parts = [
      [Number(f?.credentials ?? 0), "credential(s)"],
      [Number(f?.clients ?? 0), "oauth client(s)"],
      [Number(f?.states ?? 0), "pending connect(s)"],
    ].filter(([n]) => (n as number) > 0).map(([n, what]) => `${n} ${what}`);
    if (parts.length > 0) {
      problems.push(`${parts.join(", ")} sealed by another key; load that key or run connectors rotate-kek`);
    }
  }

  if (total === 0 && problems.length === 0) {
    const flagSet = (env.MEMRAIN_CONNECTORS_ENABLED ?? "").trim() !== "";
    if (st.enabled) return { ok: true, status: "ok", detail: "connectors on, no account connected" };
    return flagSet
      ? { ok: true, status: "warn", detail: `connectors requested but closed: ${st.reason}` }
      : { ok: true, status: "ok", detail: st.reason ?? "connectors off" };
  }

  if (!st.enabled && total > 0) problems.unshift(`${total} connector account(s) cannot sync: ${st.reason}`);
  const parked = accounts.rows.filter((a) => a.status !== "active");
  if (parked.length > 0) {
    const named = parked.slice(0, NAMED).map((a) => `${a.provider}/${a.id.slice(0, 8)}: ${a.status}${a.status_reason ? ` (${a.status_reason})` : ""}`);
    const more = parked.length > NAMED ? ` and ${parked.length - NAMED} more` : "";
    problems.push(`${named.join("; ")}${more}`);
  }
  if (problems.length === 0) return { ok: true, status: "ok", detail: `${total} connector account(s), all active` };
  return { ok: true, status: "warn", detail: problems.join("; ") };
}
