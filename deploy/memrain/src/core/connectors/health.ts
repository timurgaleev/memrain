/**
 * Doctor check for connectors: every connector account (its state, last clean
 * sync and last run; one waiting on a reconnect; one whose sync stalled; a
 * Google grant near or past its Testing-mode limit), the recipe connectors (a
 * credential the provider stopped honouring, a last clean run that is too
 * old, items refused for a reason a retry cannot fix), and the sync engine's
 * other open notices (deletions or items held).
 *
 * Accounts are named by provider, id prefix and source, never by mailbox
 * address: doctor output can reach an MCP client.
 *
 * Warn, never fail: a connector is optional capture, and a stale mirror is not
 * a broken brain. The detail names the connector and what to do.
 */
import type { Engine } from "../engine/interface.ts";
import type { OpsCheckResult } from "../doctor-ops.ts";
import { needsReauth } from "./types.ts";
import { CONNECTOR_RECIPE_PREFIX, listConnectorStates } from "./watermark.ts";
import { listOpenNotices, type OpenNotice } from "./sync-store.ts";
import { grantExpiryText, listAccountStatus, runCountsText, type AccountStatus } from "./account-status.ts";

const DEFAULT_STALL_DAYS = 7;
const DAY_MS = 86_400_000;
/** Refused items named per connector; the rest are counted. */
const REFUSED_NAMED = 3;

/** MEMRAIN_CONNECTOR_STALL_DAYS, a positive integer (default 7). */
export function connectorStallDays(): number {
  const n = Number((process.env.MEMRAIN_CONNECTOR_STALL_DAYS ?? "").trim());
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_STALL_DAYS;
}

const NOTICE_TEXT: Record<OpenNotice["kind"], string> = {
  needs_reconnect: "needs a reconnect",
  mass_delete_held: "deletions held for confirmation",
  items_held: "items held",
};

/**
 * What the sync engine's open notices tell the owner, one line per account and
 * kind. A reconnect is left to the account's own line.
 */
function noticeProblems(notices: readonly OpenNotice[]): string[] {
  return notices
    .filter((n) => n.kind !== "needs_reconnect")
    .map((n) => `connector account ${n.account_id}: ${NOTICE_TEXT[n.kind]} since ${n.created_at} (${n.detail})`);
}

/** Provider, id prefix and source: enough to find the account, no address. */
export function accountRef(a: Pick<AccountStatus, "provider" | "id" | "source_id">): string {
  return `${a.provider}/${a.id.slice(0, 8)} into ${a.source_id}`;
}

/** One account's line, and whether it is a problem. */
function accountLine(a: AccountStatus, stallDays: number, now: number): { text: string; problem: boolean } {
  const ref = accountRef(a);
  const run = a.last_run;
  if (a.needs_reconnect) {
    const why = a.status_reason ? ` (${a.status_reason})` : "";
    const cause = a.grant_expiry?.state === "lapsed" ? `; ${grantExpiryText(a.grant_expiry)}` : "";
    return { text: `${ref}: needs a reconnect since ${a.reconnect_since}${why}${cause}`, problem: true };
  }
  const clean = a.last_success_at ? `, last clean sync ${a.last_success_at}` : ", no clean sync yet";
  const lastRun = run ? `, last run ${run.status}${run.stop_reason ? ` (${run.stop_reason})` : ""} at ${run.at}, ${runCountsText(run)}` : "";
  const text = `${ref}: ${a.state}${clean}${lastRun}`;
  if (a.status !== "active" || !a.enabled) return { text, problem: false };
  if (run && (run.status === "forbidden" || run.status === "auth_required")) return { text, problem: true };
  if (a.grant_expiry?.state === "upcoming" && a.grant_expiry.due_soon) {
    return { text: `${text}; ${grantExpiryText(a.grant_expiry)}`, problem: true };
  }
  const lastSuccess = a.last_success_at === null ? Number.NaN : Date.parse(a.last_success_at);
  if (Number.isFinite(lastSuccess) && now - lastSuccess > stallDays * DAY_MS) {
    return { text: `${text}; stalled, no clean sync in over ${stallDays} day(s)`, problem: true };
  }
  // Runs that never once finished clean are a problem; an account that has not run yet is not.
  return { text, problem: !Number.isFinite(lastSuccess) && run !== null };
}

export async function checkConnectorHealth(engine: Engine, now: number = Date.now()): Promise<OpsCheckResult> {
  const states = await listConnectorStates(engine);
  const runs = states.filter((s) => s.last_run !== null || s.refused.length > 0);
  const notices = noticeProblems(await listOpenNotices(engine));
  const accounts = await listAccountStatus(engine, now);
  if (runs.length === 0 && notices.length === 0 && accounts.length === 0) {
    return { ok: true, status: "ok", detail: "no connector account and no connector has run" };
  }

  const stallDays = connectorStallDays();
  const lines = accounts.map((a) => accountLine(a, stallDays, now));
  const problems: string[] = [...lines.filter((l) => l.problem).map((l) => l.text), ...notices];
  for (const s of runs) {
    const name = s.recipe_id.slice(CONNECTOR_RECIPE_PREFIX.length);
    if (s.refused.length > 0) {
      const named = s.refused.slice(0, REFUSED_NAMED).map((r) => `${r.slug} (${r.code}: ${r.reason})`);
      const more = s.refused.length > REFUSED_NAMED ? ` and ${s.refused.length - REFUSED_NAMED} more` : "";
      problems.push(`${name}: ${s.refused.length} item(s) refused, ${named.join("; ")}${more}`);
    }
    const run = s.last_run;
    if (run === null) continue;
    if (needsReauth(run.status)) {
      problems.push(`${name}: re-auth needed (last run ${run.status}${run.http_status ? ` HTTP ${run.http_status}` : ""} at ${run.at})`);
      continue;
    }
    const lastSuccess = run.last_success_at === null ? Number.NaN : Date.parse(run.last_success_at);
    if (!Number.isFinite(lastSuccess)) {
      problems.push(`${name}: no clean run yet (last run ${run.status} at ${run.at})`);
    } else if (now - lastSuccess > stallDays * DAY_MS) {
      problems.push(`${name}: stalled, last clean run ${run.last_success_at} is over ${stallDays} day(s) old (last run ${run.status})`);
    }
  }
  if (problems.length === 0) {
    const parts = [
      ...(accounts.length > 0 ? [`${accounts.length} connector account(s): ${lines.map((l) => l.text).join("; ")}`] : []),
      ...(runs.length > 0 ? [`${runs.length} connector(s), all current`] : []),
    ];
    return { ok: true, status: "ok", detail: parts.join("; ") };
  }
  // Problems first, then the accounts that are fine, so an incident still shows every account.
  const healthy = lines.filter((l) => !l.problem).map((l) => l.text);
  return { ok: true, status: "warn", detail: [...problems, ...healthy].join("; ") };
}
