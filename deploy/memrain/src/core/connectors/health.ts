/**
 * Doctor check for connectors: a credential the provider stopped honouring,
 * a connector whose last clean run is too old, items a connector refused
 * for a reason a retry cannot fix, and the sync engine's open notices (an
 * account paused for a reconnect, deletions or items held).
 *
 * Warn, never fail: a connector is optional capture, and a stale mirror is not
 * a broken brain. The detail names the connector and what to do.
 */
import type { Engine } from "../engine/interface.ts";
import type { OpsCheckResult } from "../doctor-ops.ts";
import { needsReauth } from "./types.ts";
import { CONNECTOR_RECIPE_PREFIX, listConnectorStates } from "./watermark.ts";
import { listOpenNotices, type OpenNotice } from "./sync-store.ts";

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

/** What the sync engine's open notices tell the owner, one line per account and kind. */
function noticeProblems(notices: readonly OpenNotice[]): string[] {
  return notices.map((n) => `connector account ${n.account_id}: ${NOTICE_TEXT[n.kind]} since ${n.created_at} (${n.detail})`);
}

export async function checkConnectorHealth(engine: Engine, now: number = Date.now()): Promise<OpsCheckResult> {
  const states = await listConnectorStates(engine);
  const runs = states.filter((s) => s.last_run !== null || s.refused.length > 0);
  const notices = noticeProblems(await listOpenNotices(engine));
  if (runs.length === 0 && notices.length === 0) return { ok: true, status: "ok", detail: "no connector has run" };

  const stallDays = connectorStallDays();
  const problems: string[] = [...notices];
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
    return { ok: true, status: "ok", detail: `${runs.length} connector(s), all current` };
  }
  return { ok: true, status: "warn", detail: problems.join("; ") };
}
