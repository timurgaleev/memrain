/**
 * What the spend wallet tells the operator: a path paused after a call cost
 * more than its hold, overruns in the last week, and a paid daemon switched on
 * while the brain has no daily cap (it would be refused on every run). Read by
 * doctor (`spend-wallet`) and the advisor. Read-only.
 */
import type { Engine } from "./engine/interface.ts";
import type { OpsCheckResult } from "./doctor-ops.ts";
import type { AdvisorCollector, AdvisorFinding } from "./advisor/types.ts";
import { brainDailyCapUsd, pausedSpendPaths } from "./budget.ts";
import { listDaemons } from "./daemons/registry.ts";

const OVERRUN_WINDOW_DAYS = 7;
const NAMED = 5;

/** Paid daemons that would run (enabled, not env-disabled) but cannot spend. */
async function paidDaemonsWithoutBrainCap(engine: Engine, env: Record<string, string | undefined>): Promise<string[]> {
  if (brainDailyCapUsd(env) !== null) return [];
  const paid = listDaemons().filter((d) => d.paid);
  if (paid.length === 0) return [];
  // scope: operator-only doctor reads the operator's daemon switches, brain-wide
  const r = await engine.query<{ daemon: string; enabled: boolean | null }>(
    `SELECT daemon, enabled FROM daemon_controls WHERE source_id = '*' AND daemon = ANY($1::text[])`,
    [paid.map((d) => d.name)],
  );
  const switched = new Map(r.rows.map((row) => [row.daemon, row.enabled]));
  return paid.filter((d) => switched.get(d.name) ?? d.defaultEnabled).map((d) => d.name);
}

export async function checkSpendWallet(
  engine: Engine,
  env: Record<string, string | undefined> = process.env,
): Promise<OpsCheckResult> {
  const problems: string[] = [];
  const paused = await pausedSpendPaths(engine);
  if (paused.length > 0) {
    const named = paused.slice(0, NAMED).map((p) => `${p.path} (memrain spend resume ${p.path})`);
    const more = paused.length > NAMED ? ` and ${paused.length - NAMED} more` : "";
    problems.push(`${paused.length} spend path(s) paused after a call cost more than its hold: ${named.join("; ")}${more}`);
  }
  // scope: operator-only overruns are brain-wide accounting errors, counted for the operator
  const over = await engine.query<{ n: number; roles: string[] | null }>(
    `SELECT count(*)::int AS n, array_agg(DISTINCT role) FILTER (WHERE role IS NOT NULL) AS roles
       FROM mcp_spend_log
      WHERE overrun_cents > 0 AND created_at >= NOW() - ($1::int * INTERVAL '1 day')`,
    [OVERRUN_WINDOW_DAYS],
  );
  const overruns = Number(over.rows[0]?.n ?? 0);
  if (overruns > 0) {
    const roles = (over.rows[0]?.roles ?? []).slice(0, NAMED).join(", ");
    problems.push(`${overruns} call(s) overran their hold in the last ${OVERRUN_WINDOW_DAYS} days (${roles}); check MODEL_PRICING for the models they used`);
  }
  const stuck = await paidDaemonsWithoutBrainCap(engine, env);
  if (stuck.length > 0) {
    problems.push(`paid daemon(s) ${stuck.join(", ")} switched on, but MEMRAIN_DAILY_BUDGET_USD is unset, so every run is refused`);
  }
  if (problems.length === 0) {
    const cap = brainDailyCapUsd(env);
    return { ok: true, status: "ok", detail: cap === null ? "no paused path; no brain-wide daily cap set" : `no paused path; brain-wide daily cap $${cap}` };
  }
  return { ok: true, status: "warn", detail: problems.join("; ") };
}

export const collectSpendWallet: AdvisorCollector = {
  id: "spend-wallet",
  collect: async (ctx): Promise<AdvisorFinding[]> => (await pausedSpendPaths(ctx.engine)).map((p) => ({
    id: "spend_path_paused",
    severity: "high",
    title: `Paid path '${p.path}' is paused: one of its calls cost more than the maximum held for it`,
    detail: "Its calls are refused until resumed. memrain doctor (spend-wallet) shows the overrun; check the model's price first.",
    fix_command: `memrain spend resume ${p.path}`,
    collector: "spend-wallet",
  })),
};
