/**
 * Where the money went: the spend ledger rolled up by model, by feature, by
 * spender, by cycle phase and by job over the last N days, with what the
 * totals cannot see, how the calls ended, how long they took, and where
 * today stands against the brain-wide and cycle daily caps.
 *
 * Coverage matters as much as the totals. A call on an unpriced model books an
 * unknown (NULL) cost and a call that failed before Bedrock reported usage books
 * no tokens, so both are counted and named rather than silently folded in. A
 * call a cap refused never reached the provider: it appears under `outcomes`
 * only, never in the call counts or groups.
 */
import type { Engine } from "./engine/interface.ts";
import {
  brainDailyCapUsd,
  brainDaySpendUsd,
  configuredCycleDailyCapUsd,
  cycleDaySpendUsd,
} from "./budget.ts";

export interface SpendGroup {
  key: string | null;
  calls: number;
  usd: number;
  input_tokens: number;
  output_tokens: number;
}

export interface SpendLatency {
  operation: string;
  /** Calls that recorded a latency (booked since the ledger kept it). */
  calls: number;
  p50_ms: number;
  p95_ms: number;
}

export interface SpendReport {
  since: string;
  days: number;
  total_usd: number;
  calls: number;
  by_model: SpendGroup[];
  by_operation: SpendGroup[];
  by_client: SpendGroup[];
  /** Cycle phase; key null = outside any phase. */
  by_phase: SpendGroup[];
  /** The costliest jobs (top 25); key null = outside any job. */
  by_job: SpendGroup[];
  /** ok | error | halted | refused; key null = booked before outcomes were kept. */
  outcomes: SpendGroup[];
  latency: SpendLatency[];
  coverage: {
    /** Calls whose model has no price: their cost is missing from every total. */
    unpriced_calls: number;
    unpriced_models: string[];
    /** Calls that failed before the provider reported usage (nothing billed). */
    no_usage_calls: number;
    /** Priced rows with no token counts: booked before the ledger kept tokens,
     *  so the group token sums leave them out. */
    tokens_unrecorded_calls: number;
  };
  /** The current UTC day against the daily caps, as this process's environment
   *  configures them (null cap = none). Held calls count. */
  today: {
    brain_usd: number;
    brain_cap_usd: number | null;
    cycle_usd: number;
    cycle_cap_usd: number | null;
  };
}

/** Rows that stand for a call that reached the provider. */
const MADE = "outcome IS DISTINCT FROM 'refused'";

const GROUPS = {
  by_model: { column: "model", where: MADE, limit: "" },
  by_operation: { column: "operation", where: MADE, limit: "" },
  by_client: { column: "client_id", where: MADE, limit: "" },
  by_phase: { column: "phase", where: MADE, limit: "" },
  by_job: { column: "job_id", where: MADE, limit: "LIMIT 25" },
  outcomes: { column: "outcome", where: "TRUE", limit: "" },
} as const;

export async function spendReport(engine: Engine, opts: { days?: number; now?: Date } = {}): Promise<SpendReport> {
  const days = opts.days ?? 7;
  if (!Number.isInteger(days) || days < 1 || days > 366) {
    throw new Error(`days must be a whole number from 1 to 366 (got ${days})`);
  }
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();

  const groups = {} as Record<keyof typeof GROUPS, SpendGroup[]>;
  for (const [name, g] of Object.entries(GROUPS) as [keyof typeof GROUPS, (typeof GROUPS)[keyof typeof GROUPS]][]) {
    const r = await engine.query<Record<string, unknown>>(
      `SELECT ${g.column} AS key, count(*)::int AS calls,
              COALESCE(SUM(spend_cents), 0)::float8 / 100 AS usd,
              COALESCE(SUM(input_tokens), 0)::float8 AS input_tokens,
              COALESCE(SUM(output_tokens), 0)::float8 AS output_tokens
         FROM mcp_spend_log
        WHERE created_at >= $1::timestamptz AND ${g.where}
        GROUP BY ${g.column}
        ORDER BY usd DESC, calls DESC
        ${g.limit}`,
      [since],
    );
    groups[name] = r.rows.map((row) => ({
      key: (row.key as string | null) ?? null,
      calls: Number(row.calls),
      usd: Number(row.usd),
      input_tokens: Number(row.input_tokens),
      output_tokens: Number(row.output_tokens),
    }));
  }

  const lat = await engine.query<Record<string, unknown>>(
    `SELECT operation, count(*)::int AS calls,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms)::float8 AS p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)::float8 AS p95
       FROM mcp_spend_log
      WHERE created_at >= $1::timestamptz AND latency_ms IS NOT NULL AND ${MADE}
      GROUP BY operation
      ORDER BY p95 DESC, operation`,
    [since],
  );

  const cov = await engine.query<Record<string, unknown>>(
    `SELECT count(*) FILTER (WHERE spend_cents IS NULL)::int AS unpriced_calls,
            count(*) FILTER (WHERE input_tokens IS NULL AND spend_cents = 0)::int AS no_usage_calls,
            count(*) FILTER (WHERE input_tokens IS NULL AND spend_cents > 0)::int AS tokens_unrecorded_calls,
            COALESCE(array_agg(DISTINCT model) FILTER (WHERE spend_cents IS NULL), '{}') AS unpriced_models
       FROM mcp_spend_log
      WHERE created_at >= $1::timestamptz AND ${MADE}`,
    [since],
  );
  const c = cov.rows[0] ?? {};
  const byModel = groups.by_model;
  return {
    since,
    days,
    total_usd: byModel.reduce((s, g) => s + g.usd, 0),
    calls: byModel.reduce((s, g) => s + g.calls, 0),
    ...groups,
    latency: lat.rows.map((row) => ({
      operation: String(row.operation),
      calls: Number(row.calls),
      p50_ms: Number(row.p50),
      p95_ms: Number(row.p95),
    })),
    coverage: {
      unpriced_calls: Number(c.unpriced_calls ?? 0),
      unpriced_models: ((c.unpriced_models as (string | null)[] | null) ?? []).filter((m): m is string => !!m),
      no_usage_calls: Number(c.no_usage_calls ?? 0),
      tokens_unrecorded_calls: Number(c.tokens_unrecorded_calls ?? 0),
    },
    today: {
      brain_usd: await brainDaySpendUsd(engine, now),
      brain_cap_usd: brainDailyCapUsd(),
      cycle_usd: await cycleDaySpendUsd(engine, now),
      cycle_cap_usd: configuredCycleDailyCapUsd(),
    },
  };
}
