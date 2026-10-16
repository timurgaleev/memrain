/**
 * Per-UTC-day series behind the admin Overview charts: agent requests,
 * searches, estimated model cost and new content, each with totals for the
 * current window and for the equal-length window just before it.
 *
 * Windows are computed here from an injectable clock, never with `now()` in
 * SQL, so the day buckets and the previous-period cutoff are deterministic.
 * The previous window ends at the same time of day as `now`, so a delta read
 * early in the morning compares like with like. Searches are stored per date,
 * so their totals compare completed days only.
 */
import type { Engine } from "./engine/interface.ts";
import { brainDailyCapUsd } from "./budget.ts";
import { MADE } from "./spend-report.ts";
import { requestLogDbEnabled } from "../mcp/request-log-db.ts";

/**
 * The operator's own admin-panel calls are not agent traffic. They are the
 * rows with agent 'admin-panel' and no credential; IS DISTINCT FROM keeps rows
 * whose agent_name is NULL.
 */
export const NOT_PANEL_ROW = "(agent_name IS DISTINCT FROM 'admin-panel' OR token_name IS NOT NULL)";

// Rows that are not an agent's tool call: the MCP handshake and the
// webhook ingest path. rate_limited stays in: the agent did call and was refused.
export const AGENT_CALL = `operation NOT IN ('tools/list', 'webhook_ingest')`;

export type TimeseriesDays = 7 | 30 | 90;
const ALLOWED_DAYS: readonly number[] = [7, 30, 90];

export interface TsTotals {
  requests: number;
  errors: number;
  searches: number;
  usd: number;
  priced_calls: number;
  unpriced_calls: number;
  pages_created: number;
  page_edits: number;
  facts_added: number;
}

export interface AdminTimeseries {
  days: TimeseriesDays;
  /** ISO of the first bucket's UTC midnight. */
  since: string;
  /** ISO of `now`. */
  generated_at: string;
  /** 'YYYY-MM-DD', ascending, length === days; the last one is today (partial). */
  buckets: string[];
  requests: { day: string; requests: number; errors: number }[];
  searches: { day: string; searches: number }[];
  spend: { day: string; usd: number; priced_calls: number; unpriced_calls: number; by_model: Record<string, number> }[];
  /** Top four models by window cost, then `__other` when more exist. */
  spend_models: { key: string; label: string }[];
  content: { day: string; pages_created: number; page_edits: number; facts_added: number }[];
  /** Live counts at generated_at, for the caption only. */
  corpus_now: { pages: number; facts: number };
  top_tools: { operation: string; calls: number; errors: number }[];
  /** `agent` is the display label: the OAuth client name when there is one. */
  top_agents: { id: string; agent: string; calls: number }[];
  totals: TsTotals;
  /** The equal-length previous window (searches: completed days only). */
  previous: TsTotals;
  request_log: { db_enabled: boolean; rows_in_window: number };
  /** The current daily brain cap, for the reference line; null = none. */
  brain_cap_usd: number | null;
}

const DAY = 86_400_000;
const OTHER_MODELS = "__other";
const TOP_MODELS = 4;
const DAY_KEY = (col: string) => `to_char(date_trunc('day', ${col} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`;

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function zeroTotals(): TsTotals {
  return {
    requests: 0,
    errors: 0,
    searches: 0,
    usd: 0,
    priced_calls: 0,
    unpriced_calls: 0,
    pages_created: 0,
    page_edits: 0,
    facts_added: 0,
  };
}

/** One entry per bucket, in bucket order; days with no row read as `empty()`. */
function fillDays<T>(buckets: string[], byDay: Map<string, T>, empty: () => T): (T & { day: string })[] {
  return buckets.map((day) => ({ day, ...(byDay.get(day) ?? empty()) }));
}

/** Add `row`'s numeric fields into the entry for `key`. */
function accumulate<T extends Record<string, number>>(map: Map<string, T>, key: string, row: T): void {
  const cur = map.get(key);
  if (!cur) {
    map.set(key, { ...row });
    return;
  }
  const sum = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, (cur[k] ?? 0) + v]));
  map.set(key, sum as T);
}

export async function adminTimeseries(
  engine: Engine,
  opts: { days: TimeseriesDays; now?: Date },
): Promise<AdminTimeseries> {
  const { days } = opts;
  if (!ALLOWED_DAYS.includes(days)) throw new Error(`days must be 7, 30 or 90 (got ${String(days)})`);
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const sinceMs = todayStart - (days - 1) * DAY;
  const prevSinceMs = sinceMs - days * DAY;
  // Upper bounds are exclusive and one millisecond past the cutoff: the
  // columns keep microseconds, so a row written in the same millisecond as
  // `now` would otherwise fall outside the window it belongs to.
  const window = [
    new Date(sinceMs).toISOString(),
    new Date(nowMs + 1).toISOString(),
    new Date(prevSinceMs).toISOString(),
    new Date(nowMs - days * DAY + 1).toISOString(),
  ];
  const buckets = Array.from({ length: days }, (_, i) => isoDay(sinceMs + i * DAY));
  const totals = zeroTotals();
  const previous = zeroTotals();
  const twoWindows = (col: string) =>
    `((${col} >= $1::timestamptz AND ${col} < $2::timestamptz)
       OR (${col} >= $3::timestamptz AND ${col} < $4::timestamptz))`;

  // Agent requests: the series plus both totals in one scan.
  const reqRows = await engine.query<{ day: string; cur: boolean; requests: number; errors: number }>(
    `SELECT ${DAY_KEY("created_at")} AS day,
            (created_at >= $1::timestamptz) AS cur,
            count(*)::int AS requests,
            count(*) FILTER (WHERE status <> 'success')::int AS errors
       FROM mcp_request_log
      WHERE ${twoWindows("created_at")}
        AND ${NOT_PANEL_ROW} AND ${AGENT_CALL}
      GROUP BY 1, 2`,
    window,
  );
  const reqByDay = new Map<string, { requests: number; errors: number }>();
  for (const r of reqRows.rows) {
    const row = { requests: Number(r.requests), errors: Number(r.errors) };
    const t = r.cur ? totals : previous;
    t.requests += row.requests;
    t.errors += row.errors;
    if (r.cur) accumulate(reqByDay, r.day, row);
  }

  const tools = await engine.query<{ operation: string; calls: number; errors: number }>(
    `SELECT operation, count(*)::int AS calls,
            count(*) FILTER (WHERE status <> 'success')::int AS errors
       FROM mcp_request_log
      WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
        AND ${NOT_PANEL_ROW} AND ${AGENT_CALL}
      GROUP BY operation
      ORDER BY calls DESC, operation
      LIMIT 8`,
    window.slice(0, 2),
  );

  // OAuth rows carry the client id as their credential; deleted clients keep
  // their name so history stays readable. oauth_clients shares no column name
  // with the two filters, so they need no table alias.
  const agents = await engine.query<{ id: string; agent: string; calls: number }>(
    `SELECT COALESCE(r.token_name, r.agent_name, 'unknown') AS id,
            COALESCE(max(c.client_name), max(r.token_name), max(r.agent_name), 'unknown') AS agent,
            count(*)::int AS calls
       FROM mcp_request_log r
       LEFT JOIN oauth_clients c ON c.client_id = COALESCE(r.token_name, r.agent_name)
      WHERE r.created_at >= $1::timestamptz AND r.created_at < $2::timestamptz
        AND ${NOT_PANEL_ROW} AND ${AGENT_CALL}
      GROUP BY 1
      ORDER BY calls DESC, id
      LIMIT 6`,
    window.slice(0, 2),
  );

  // Searches are day-granular: the series includes today, the totals compare
  // the completed days of each window.
  const prevFirstDay = isoDay(prevSinceMs);
  const prevLastDay = isoDay(prevSinceMs + (days - 2) * DAY);
  const firstDay = buckets[0]!;
  const today = buckets[days - 1]!;
  const tele = await engine.query<{ day: string; searches: number }>(
    `SELECT date AS day, COALESCE(SUM(count), 0)::int AS searches
       FROM search_telemetry
      WHERE date >= $1 AND date <= $2
      GROUP BY date`,
    [prevFirstDay, today],
  );
  const searchByDay = new Map<string, { searches: number }>();
  for (const r of tele.rows) {
    const n = Number(r.searches);
    if (r.day >= firstDay) searchByDay.set(r.day, { searches: n });
    if (r.day >= firstDay && r.day < today) totals.searches += n;
    else if (r.day >= prevFirstDay && r.day <= prevLastDay) previous.searches += n;
  }

  // Spend: refused calls never reached the provider, and a NULL cost is an
  // unknown price, counted apart instead of summed as zero.
  const spendRows = await engine.query<{
    day: string;
    cur: boolean;
    model: string;
    usd: number;
    priced_calls: number;
    unpriced_calls: number;
  }>(
    `SELECT ${DAY_KEY("created_at")} AS day,
            (created_at >= $1::timestamptz) AS cur,
            COALESCE(model, 'unknown') AS model,
            COALESCE(SUM(spend_cents) FILTER (WHERE spend_cents IS NOT NULL), 0)::float8 / 100 AS usd,
            count(*) FILTER (WHERE spend_cents IS NOT NULL)::int AS priced_calls,
            count(*) FILTER (WHERE spend_cents IS NULL)::int AS unpriced_calls
       FROM mcp_spend_log
      WHERE ${twoWindows("created_at")}
        AND ${MADE}
      GROUP BY 1, 2, 3`,
    window,
  );
  const modelUsd = new Map<string, number>();
  for (const r of spendRows.rows) {
    const t = r.cur ? totals : previous;
    t.usd += Number(r.usd);
    t.priced_calls += Number(r.priced_calls);
    t.unpriced_calls += Number(r.unpriced_calls);
    if (r.cur) modelUsd.set(r.model, (modelUsd.get(r.model) ?? 0) + Number(r.usd));
  }
  const ranked = [...modelUsd.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const topKeys = ranked.slice(0, TOP_MODELS).map(([m]) => m);
  const spendModels = topKeys.map((key) => ({ key, label: key }));
  if (ranked.length > TOP_MODELS) spendModels.push({ key: OTHER_MODELS, label: "Other" });
  const top = new Set(topKeys);
  const emptyByModel = () => Object.fromEntries(spendModels.map((m) => [m.key, 0])) as Record<string, number>;
  const spendByDay = new Map<string, { usd: number; priced_calls: number; unpriced_calls: number; by_model: Record<string, number> }>();
  for (const r of spendRows.rows) {
    if (!r.cur) continue;
    const day = spendByDay.get(r.day) ?? { usd: 0, priced_calls: 0, unpriced_calls: 0, by_model: emptyByModel() };
    const key = top.has(r.model) ? r.model : OTHER_MODELS;
    spendByDay.set(r.day, {
      usd: day.usd + Number(r.usd),
      priced_calls: day.priced_calls + Number(r.priced_calls),
      unpriced_calls: day.unpriced_calls + Number(r.unpriced_calls),
      by_model: { ...day.by_model, [key]: (day.by_model[key] ?? 0) + Number(r.usd) },
    });
  }

  // Page writes as mutually exclusive events: version 1 is the creation, a
  // later version is an edit unless it is a delete or restore marker.
  const pageRows = await engine.query<{ day: string; cur: boolean; pages_created: number; page_edits: number }>(
    `SELECT ${DAY_KEY("written_at")} AS day,
            (written_at >= $1::timestamptz) AS cur,
            count(*) FILTER (WHERE version_n = 1)::int AS pages_created,
            count(*) FILTER (WHERE version_n > 1
              AND NOT (body_snapshot = ''
                       AND (compiled_truth_snapshot->>'deleted_at' IS NOT NULL
                            OR compiled_truth_snapshot->>'restored_at' IS NOT NULL)))::int AS page_edits
       FROM page_versions
      WHERE ${twoWindows("written_at")}
      GROUP BY 1, 2`,
    window,
  );
  const factRows = await engine.query<{ day: string; cur: boolean; facts_added: number }>(
    `SELECT ${DAY_KEY("written_at")} AS day,
            (written_at >= $1::timestamptz) AS cur,
            count(*)::int AS facts_added
       FROM entity_facts
      WHERE ${twoWindows("written_at")}
      GROUP BY 1, 2`,
    window,
  );
  const contentByDay = new Map<string, { pages_created: number; page_edits: number; facts_added: number }>();
  for (const r of pageRows.rows) {
    const row = { pages_created: Number(r.pages_created), page_edits: Number(r.page_edits), facts_added: 0 };
    const t = r.cur ? totals : previous;
    t.pages_created += row.pages_created;
    t.page_edits += row.page_edits;
    if (r.cur) accumulate(contentByDay, r.day, row);
  }
  for (const r of factRows.rows) {
    const row = { pages_created: 0, page_edits: 0, facts_added: Number(r.facts_added) };
    (r.cur ? totals : previous).facts_added += row.facts_added;
    if (r.cur) accumulate(contentByDay, r.day, row);
  }

  const corpus = await engine.query<{ pages: number; facts: number }>(
    `SELECT (SELECT count(*) FROM pages WHERE deleted_at IS NULL)::int AS pages,
            (SELECT count(*) FROM entity_facts WHERE forgotten_at IS NULL)::int AS facts`,
  );

  return {
    days,
    since: window[0]!,
    generated_at: now.toISOString(),
    buckets,
    requests: fillDays(buckets, reqByDay, () => ({ requests: 0, errors: 0 })),
    searches: fillDays(buckets, searchByDay, () => ({ searches: 0 })),
    spend: fillDays(buckets, spendByDay, () => ({ usd: 0, priced_calls: 0, unpriced_calls: 0, by_model: emptyByModel() })),
    spend_models: spendModels,
    content: fillDays(buckets, contentByDay, () => ({ pages_created: 0, page_edits: 0, facts_added: 0 })),
    corpus_now: { pages: Number(corpus.rows[0]?.pages ?? 0), facts: Number(corpus.rows[0]?.facts ?? 0) },
    top_tools: tools.rows.map((r) => ({ operation: r.operation, calls: Number(r.calls), errors: Number(r.errors) })),
    top_agents: agents.rows.map((r) => ({ id: r.id, agent: r.agent, calls: Number(r.calls) })),
    totals,
    previous,
    request_log: { db_enabled: requestLogDbEnabled(), rows_in_window: totals.requests },
    brain_cap_usd: brainDailyCapUsd(),
  };
}
