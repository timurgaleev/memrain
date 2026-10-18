import React, { useEffect, useState } from "react";
import { api, tool } from "../api.ts";
import { useAsync, useNow } from "../hooks.ts";
import type { AsyncState } from "../hooks.ts";
import { Section, Tile } from "../components/Tile.tsx";
import { fmtAgo, fmtInt, fmtUsd } from "../lib/format.ts";
import { parsePageList } from "../lib/tool-result.ts";
import { buildHash } from "../lib/route.ts";
import { capUse } from "../admin-types.ts";
import type {
  AdminTimeseries, AgentSpendRow, AgentUsageRow, FeedEvent, FullStats, HealthBody, HealthIndicators, JobsWatch, SpendReport, Stats,
} from "../admin-types.ts";
import { InfoTip } from "../components/InfoTip.tsx";
import { PageIntro } from "../components/PageIntro.tsx";
import { RangePicker } from "../components/RangePicker.tsx";
import { SetupChecklist } from "../components/SetupChecklist.tsx";
import { ChartFrame } from "../components/charts/ChartFrame.tsx";
import { LineChart } from "../components/charts/LineChart.tsx";
import { BarChart } from "../components/charts/BarChart.tsx";
import { Sparkline } from "../components/charts/Sparkline.tsx";
import { HBarList } from "../components/charts/HBarList.tsx";
import { fmtPct, partialDayTotals, pctChange } from "../lib/chart.ts";
import { browserStorage, readRange, writeRange } from "../lib/range.ts";
import type { RangeDays } from "../lib/range.ts";
import type { MetricId } from "../lib/glossary.ts";

const JOBS_MS = 15_000;
const HEALTH_MS = 30_000;
const CORPUS_MS = 300_000;
const SPEND_MS = 60_000;
const TRENDS_MS = 300_000;
const PANEL_AGENT = "admin-panel";

const pct = (n: number) => `${(Math.floor(n * 1000) / 10).toFixed(1)}%`;

/** Dollars at the precision small model bills need: $0.0034, $0.42, $12.50. */
function fmtUsdFine(n: number): string {
  if (n === 0) return "$0";
  if (Math.abs(n) >= 0.01) return `$${n.toFixed(2)}`;
  return `$${Number(n.toPrecision(2))}`;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function useFeed() {
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [sse, setSse] = useState<"connecting" | "connected" | "disconnected">("connecting");
  useEffect(() => {
    // EventSource reconnects on its own; the state just follows it.
    const es = new EventSource("/admin/events");
    es.onopen = () => setSse("connected");
    es.onmessage = (e) => {
      try {
        setEvents((prev) => [JSON.parse(e.data) as FeedEvent, ...prev].slice(0, 100));
      } catch { /* ignore a malformed frame */ }
    };
    es.onerror = () => setSse(es.readyState === EventSource.CLOSED ? "disconnected" : "connecting");
    return () => es.close();
  }, []);
  return { events, sse };
}

interface Chip { label: string; href: string; tone: "error" | "warning" }

export function OverviewPage() {
  const now = useNow(5000);
  const health = useAsync<HealthBody>(() => api.health(), [], { intervalMs: HEALTH_MS });
  const brain = useAsync<FullStats>(() => api.fullStats(false), [], { intervalMs: HEALTH_MS });
  const corpus = useAsync<FullStats>(() => api.fullStats(), [], { intervalMs: CORPUS_MS });
  const stats = useAsync<Stats>(() => api.stats(), [], { intervalMs: HEALTH_MS });
  const indicators = useAsync<HealthIndicators>(() => api.healthIndicators(), [], { intervalMs: HEALTH_MS });
  const agents = useAsync<{ agents: AgentUsageRow[] }>(() => api.agents(), [], { intervalMs: HEALTH_MS });
  const spend1 = useAsync<SpendReport>(() => api.spendReport(1), [], { intervalMs: SPEND_MS });
  const spend7 = useAsync<SpendReport>(() => api.spendReport(7), [], { intervalMs: SPEND_MS });
  const caps = useAsync<{ agents: AgentSpendRow[] }>(() => api.agentsSpend(), [], { intervalMs: SPEND_MS });
  const jobs = useAsync<JobsWatch>(() => api.jobsWatch(), [], { intervalMs: JOBS_MS });
  const changed = useAsync(async (signal) => {
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    return parsePageList(await tool("page_list", { since, sort: "updated_desc", limit: 8 }, signal));
  }, [], { intervalMs: SPEND_MS });
  const { events, sse } = useFeed();
  const [showMine, setShowMine] = useState(false);
  const [range, setRange] = useState<RangeDays>(() => readRange(browserStorage()));
  const trends = useAsync<AdminTimeseries>((signal) => api.timeseries(range, signal), [range], { intervalMs: TRENDS_MS });
  const pickRange = (d: RangeDays) => { setRange(d); writeRange(browserStorage(), d); };
  const last7 = (xs: number[]) => xs.slice(-7);

  const h = brain.data?.health ?? null;
  const capRows = (caps.data?.agents ?? [])
    .map((r) => ({ row: r, use: capUse(r) }))
    .filter((r): r is { row: AgentSpendRow; use: number } => r.use !== null)
    .sort((a, b) => b.use - a.use);

  const chips: Chip[] = [];
  if (h && h.failed_jobs_24h > 0) chips.push({ label: `${fmtInt(h.failed_jobs_24h)} failed jobs (24h)`, href: "#jobs", tone: "error" });
  if (indicators.data && indicators.data.error_rate_24h > 2) chips.push({ label: `Error rate ${indicators.data.error_rate_24h}%`, href: "#log", tone: "error" });
  if (indicators.data && indicators.data.tokens_expiring_24h > 0) chips.push({ label: `${fmtInt(indicators.data.tokens_expiring_24h)} tokens expire in 24h`, href: "#agents", tone: "warning" });
  if (h && h.embed_coverage_pct < 0.99) chips.push({ label: `Embed coverage ${pct(h.embed_coverage_pct)}`, href: "#overview", tone: "warning" });
  if (spend7.data && spend7.data.coverage.unpriced_calls > 0) chips.push({ label: `${fmtInt(spend7.data.coverage.unpriced_calls)} unpriced calls (7d)`, href: "#spend", tone: "warning" });
  for (const c of capRows.filter((c) => c.use > 0.8)) {
    chips.push({ label: `${c.row.client_name ?? c.row.client_id} at ${Math.round(c.use * 100)}% of cap`, href: "#spend", tone: c.use >= 1 ? "error" : "warning" });
  }

  const lastUpdate = Math.max(...[health, brain, stats, indicators, spend1, jobs].map((s) => s.updatedAt ?? 0));
  const visibleEvents = events.filter((e) => showMine || e.agent !== PANEL_AGENT).slice(0, 15);
  const jobCount = (s: string) => jobs.data?.counts.find((c) => c.status === s)?.n ?? 0;
  const topAgents = [...(agents.data?.agents ?? [])]
    .filter((a) => a.usage.requests_today > 0)
    .sort((a, b) => b.usage.requests_today - a.usage.requests_today)
    .slice(0, 3);
  const topModel = [...(spend7.data?.by_model ?? [])].sort((a, b) => b.usd - a.usd)[0];

  return (
    <>
      <div className="status-strip" role="status">
        <span className="strip-item">
          <span className={`dot ${health.data ? (health.data.ok ? "dot-ok" : "dot-error") : health.status === "error" ? "dot-error" : "dot-idle"}`} />
          {health.data ? <span className="mono">{health.data.version ?? "unknown build"}</span> : health.status === "error" ? "health check failed" : "checking…"}
          {health.data?.maintenance === true && <span className="badge badge-write">maintenance</span>}
        </span>
        <span className="strip-item">
          <span className={`dot ${sse === "connected" ? "dot-ok" : sse === "connecting" ? "dot-warn" : "dot-error"}`} />
          live feed {sse}
        </span>
        <span className="strip-item muted">{lastUpdate > 0 ? `updated ${fmtAgo(new Date(lastUpdate).toISOString(), now)}` : "loading…"}</span>
        {chips.length > 0 && (
          <span className="strip-chips">
            {chips.map((c) => <a key={c.label} href={c.href} className={`chip chip-${c.tone}`}>{c.label}</a>)}
          </span>
        )}
      </div>

      <div className="page-head">
        <div className="page-head-text">
          <h1 className="page-title">Overview</h1>
          <PageIntro>
            What your brain is doing: whether it is healthy, how much your agents use it, what it costs and what changed.
            Every number has a <span className="info-inline">?</span> that says what it counts and over which time window.
            Charts use UTC days; tiles use the last 24 hours.
          </PageIntro>
        </div>
        <RangePicker value={range} onChange={pickRange} />
      </div>

      <SetupChecklist />

      <div className="tiles">
        <Tile title="Health" help={<InfoTip id="tile.health" />} state={brain} intervalMs={HEALTH_MS} now={now} isEmpty={(d) => d.health === null} emptyText="Health metrics are unavailable on this engine.">
          {(d) => {
            const x = d.health;
            if (!x) return null;
            return (
              <>
                <div className="tile-figure">{pct(x.embed_coverage_pct)}<span className="tile-unit">embedded</span></div>
                <dl className="kv">
                  <dt>Chunks</dt><dd>{fmtInt(x.embedded_chunks)} / {fmtInt(x.embeddable_chunks)}</dd>
                  <dt>Last write</dt><dd>{x.lag_seconds === null ? "n/a" : fmtAgo(new Date(now - x.lag_seconds * 1000).toISOString(), now)}</dd>
                  <dt>Queue depth</dt><dd>{fmtInt(x.queue_depth)}</dd>
                  <dt>Failed jobs 24h</dt><dd className={x.failed_jobs_24h > 0 ? "error-text" : undefined}>{fmtInt(x.failed_jobs_24h)}</dd>
                </dl>
              </>
            );
          }}
        </Tile>

        <Tile title="Traffic" window="last 24h" help={<InfoTip id="tile.traffic" />} state={stats} intervalMs={HEALTH_MS} now={now}>
          {(d) => (
            <>
              <div className="tile-figure">{fmtInt(d.requests_today ?? 0)}<span className="tile-unit">requests</span></div>
              {trends.data && <><Sparkline values={last7(trends.data.requests.map((r) => r.requests))} tone={1} /><span className="tile-sub spark-caption">7-day trend</span></>}
              <dl className="kv">
                <dt>Error rate</dt>
                <dd className={(indicators.data?.error_rate_24h ?? 0) > 2 ? "error-text" : undefined}>
                  {indicators.data ? `${indicators.data.error_rate_24h}%` : indicators.status === "error" ? "unavailable" : "…"}
                </dd>
              </dl>
              <div className="tile-sub">Top agents, today (server day)</div>
              {topAgents.length === 0 ? (
                <div className="tile-empty-inline">{agents.status === "error" ? "Agent usage unavailable." : "No agent calls today."}</div>
              ) : (
                <ol className="rank">
                  {topAgents.map((a) => <li key={a.id}><span className="mono">{a.name}</span><span className="num">{fmtInt(a.usage.requests_today)}</span></li>)}
                </ol>
              )}
            </>
          )}
        </Tile>

        <Tile title="Spend" window="last 24h" help={<InfoTip id="tile.spend" />} state={spend1} intervalMs={SPEND_MS} now={now}>
          {(d) => (
            <>
              <div className="tile-figure">{fmtUsd(d.total_usd)}<span className="tile-unit">{fmtInt(d.calls)} calls</span></div>
              {trends.data && <><Sparkline values={last7(trends.data.spend.map((r) => r.usd))} tone={2} /><span className="tile-sub spark-caption">7-day trend</span></>}
              <dl className="kv">
                <dt>Last 7 days</dt><dd>{spend7.data ? fmtUsd(spend7.data.total_usd) : "…"}</dd>
                <dt>Top model (7d)</dt><dd className="mono ellipsis" title={topModel?.key ?? undefined}>{topModel ? topModel.key ?? "unknown" : "none"}</dd>
                <dt>Nearest cap, today (UTC)</dt>
                <dd>{capRows[0] ? `${capRows[0].row.client_name ?? capRows[0].row.client_id} ${Math.round(capRows[0].use * 100)}%` : "no capped agents"}</dd>
              </dl>
            </>
          )}
        </Tile>

        <Tile title="Jobs" help={<InfoTip id="tile.jobs" />} state={jobs} intervalMs={JOBS_MS} now={now}>
          {(d) => {
            const lastFail = d.recent.find((j) => j.status === "failed");
            return (
              <>
                <div className="tile-figure">{fmtInt(jobCount("running"))}<span className="tile-unit">running</span></div>
                <dl className="kv">
                  <dt>Queued</dt><dd>{fmtInt(jobCount("pending"))}</dd>
                  <dt>Failed (all time)</dt><dd className={jobCount("failed") > 0 ? "error-text" : undefined}>{fmtInt(jobCount("failed"))}</dd>
                  <dt>Last failure</dt>
                  <dd className="mono ellipsis" title={lastFail?.last_error ?? undefined}>{lastFail ? <a href="#jobs">{lastFail.kind}, {fmtAgo(lastFail.finished_at ?? lastFail.created_at, now)}</a> : "none recent"}</dd>
                </dl>
              </>
            );
          }}
        </Tile>
      </div>

      <section className="corpus" aria-label="Corpus">
        {(["pages", "documents", "chunks", "facts", "entities", "links"] as const).map((k) => (
          <div className="corpus-cell" key={k}>
            <div className="corpus-value">
              {corpus.data?.counts ? fmtInt(corpus.data.counts[k]) : corpus.status === "error" ? "—" : <span className="skeleton-inline" />}
            </div>
            <div className="corpus-label">{k} <InfoTip id={`corpus.${k}` as MetricId} /></div>
          </div>
        ))}
        {corpus.status === "error" && corpus.data === null && (
          <button className="btn-link corpus-retry" onClick={corpus.reload}>Counts failed to load. Retry</button>
        )}
      </section>

      <TrendCharts trends={trends} now={now} />

      <div className="split">
        <section className="panel">
          <header className="panel-head">
            <h2 className="panel-title">Live activity</h2>
            <label className="toggle">
              <input type="checkbox" checked={showMine} onChange={(e) => setShowMine(e.target.checked)} />
              show my calls
            </label>
          </header>
          {visibleEvents.length === 0 ? (
            <div className="empty-note">
              {sse === "connected"
                ? "No calls since this page opened. Tool calls appear here live."
                : sse === "connecting" ? "Connecting to the live feed…" : "Live feed disconnected. It reconnects on its own."}
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Agent</th><th>Operation</th><th className="num">Latency</th><th>Status</th><th>When</th></tr></thead>
                <tbody>
                  {visibleEvents.map((e, i) => (
                    <tr key={`${e.timestamp}:${i}`}>
                      <td className="mono">{e.agent}</td>
                      <td className="mono">{e.operation}</td>
                      <td className="mono num">{fmtInt(e.latency_ms)} ms</td>
                      <td><span className={`badge badge-${e.status === "success" ? "success" : "error"}`}>{e.status}</span></td>
                      <td className="muted">{fmtAgo(e.timestamp, now)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="panel">
          <header className="panel-head">
            <h2 className="panel-title">Changed in the last 24 hours</h2>
            <a href="#pages" className="panel-link">All pages</a>
          </header>
          <Section state={changed} isEmpty={(d) => d.length === 0} emptyText="No page changed in the last 24 hours.">
            {(rows) => (
              <ul className="link-list">
                {rows.map((r) => (
                  <li key={r.slug}>
                    <a href={buildHash({ name: "page", param: r.slug })}>
                      <span className="ll-primary">{r.title || r.slug}</span>
                      <span className="ll-secondary mono">{r.slug}</span>
                    </a>
                    <span className="muted ll-meta">{fmtAgo(r.updated_at, now)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </section>
      </div>

      <h2 className="section-title">Spend by model and operation, last 7 days <InfoTip id="section.spend_by_feature" /></h2>
      <div className="split split-even">
        <section className="panel">
          <Section state={spend7} isEmpty={(d) => d.by_model.length === 0} emptyText="No paid calls in 7d.">
            {(d) => <SpendTable rows={d.by_model} label="Model" />}
          </Section>
        </section>
        <section className="panel">
          <Section state={spend7} isEmpty={(d) => d.by_operation.length === 0} emptyText="No paid calls in 7d.">
            {(d) => <SpendTable rows={d.by_operation} label="Operation" />}
          </Section>
        </section>
      </div>

      <h2 className="section-title">Agents against their daily cap, today (UTC) <InfoTip id="section.caps" /></h2>
      <section className="panel">
        <Section state={caps} isEmpty={(d) => d.agents.length === 0} emptyText="No OAuth clients are registered.">
          {(d) => <CapTable rows={d.agents} />}
        </Section>
      </section>

      <h2 className="section-title">Build <InfoTip id="section.build" /></h2>
      <section className="panel">
        <Section state={health}>
          {(d) => (
            <dl className="kv kv-wide">
              {Object.entries(d)
                .filter(([, v]) => v === null || ["string", "number", "boolean"].includes(typeof v))
                .map(([k, v]) => (
                  <React.Fragment key={k}><dt>{k}</dt><dd className="mono">{String(v)}</dd></React.Fragment>
                ))}
            </dl>
          )}
        </Section>
      </section>
    </>
  );
}

function retentionNote(d: AdminTimeseries): React.ReactNode {
  return d.request_log.retention_days === null
    ? null
    : <> Calls older than {d.request_log.retention_days} days are deleted (<code>MEMRAIN_REQUEST_LOG_RETENTION_DAYS</code>).</>;
}

function activityEmpty(d: AdminTimeseries): React.ReactNode {
  return d.request_log.db_enabled
    ? <>No agent has called the brain in this range. Connect one from the <a href="#setup">setup guide</a>.{retentionNote(d)}</>
    : <>No agent calls recorded in this range. Calls with an OAuth connection or a personal access token are always logged; calls with the shared bearer are logged only with <code>MEMRAIN_REQUEST_LOG_DB</code> on.{retentionNote(d)} If someone else runs your brain, ask them.</>;
}

function oauthOnly(d: AdminTimeseries): React.ReactNode {
  return d.request_log.db_enabled
    ? null
    : <>Calls with the shared bearer are not logged on this instance (<code>MEMRAIN_REQUEST_LOG_DB</code>); OAuth and personal-access-token calls are.</>;
}

function TrendCharts({ trends, now }: { trends: AsyncState<AdminTimeseries>; now: number }) {
  const noCalls = (d: AdminTimeseries) => d.request_log.rows_in_window === 0;
  const searches = (d: AdminTimeseries) => partialDayTotals(d.searches.map((r) => r.searches), d.previous.searches);
  const frame = { state: trends, now, intervalMs: TRENDS_MS };
  const period = (d: AdminTimeseries) => `previous ${d.days} days`;
  return (
    <>
      <div className="split split-even chart-row">
        <ChartFrame
          {...frame}
          title="Activity"
          help="chart.activity"
          isEmpty={noCalls}
          empty={activityEmpty}
          note={oauthOnly}
          summary={(d) => `${fmtInt(d.totals.requests)} calls · ${fmtPct(pctChange(d.totals.requests, d.previous.requests))} vs ${period(d)} (same time of day)`}
        >
          {(d) => (
            <LineChart
              title="Agent calls per day"
              days={d.buckets}
              yFormat={fmtInt}
              series={[
                { key: "requests", label: "Calls", values: d.requests.map((r) => r.requests), tone: 1, area: true },
                { key: "errors", label: "Failed", values: d.requests.map((r) => r.errors), tone: "error" },
              ]}
            />
          )}
        </ChartFrame>
        <ChartFrame
          {...frame}
          title="Estimated model cost"
          help="chart.spend"
          isEmpty={(d) => d.totals.usd === 0 && d.totals.priced_calls === 0 && d.totals.unpriced_calls === 0}
          empty="Nothing was spent in this range. Spending starts when an agent searches with paid stages on or writes text that needs embedding."
          summary={(d) => (
            <>
              {fmtUsdFine(d.totals.usd)} known
              {d.totals.priced_calls > 0 && <> · {fmtUsdFine(d.totals.usd / d.totals.priced_calls)} per priced call</>}
              {d.totals.unpriced_calls > 0 && <> · <span className="warn-text">{fmtInt(d.totals.unpriced_calls)} calls without a price</span></>}
              {" "}· {fmtPct(pctChange(d.totals.usd, d.previous.usd))} vs {period(d)}
            </>
          )}
        >
          {(d) => (
            <BarChart
              title="Estimated model cost per day"
              days={d.buckets}
              yFormat={fmtUsdFine}
              series={d.spend_models.map((m, i) => ({
                key: m.key,
                label: m.label,
                values: d.spend.map((r) => r.by_model[m.key] ?? 0),
                tone: i + 1,
              }))}
              {...(d.brain_cap_usd !== null && d.brain_cap_usd > 0
                ? { refLine: { value: d.brain_cap_usd, label: `Current daily cap ${fmtUsdFine(d.brain_cap_usd)}` } }
                : {})}
            />
          )}
        </ChartFrame>
      </div>

      <div className="split split-even chart-row">
        <ChartFrame
          {...frame}
          title="New content"
          help="chart.content"
          isEmpty={(d) => d.totals.pages_created + d.totals.page_edits + d.totals.facts_added === 0}
          empty="Nothing was written in this range. Pages appear when an agent or an import saves a note."
          summary={(d) => `Pages now ${fmtInt(d.corpus_now.pages)} (+${fmtInt(d.totals.pages_created)} created in range) · Facts now ${fmtInt(d.corpus_now.facts)}`}
        >
          {(d) => (
            <LineChart
              title="New content per day"
              days={d.buckets}
              yFormat={fmtInt}
              series={[
                { key: "created", label: "Pages created", values: d.content.map((r) => r.pages_created), tone: 1 },
                { key: "edits", label: "Page edits", values: d.content.map((r) => r.page_edits), tone: 5 },
                { key: "facts", label: "Facts added", values: d.content.map((r) => r.facts_added), tone: 3 },
              ]}
            />
          )}
        </ChartFrame>
        <ChartFrame
          {...frame}
          title="Searches (all sources)"
          help="chart.searches"
          isEmpty={(d) => searches(d).total === 0}
          empty="No searches ran in this range. Your own searches in this panel are not counted. New searches can take a minute to appear."
          summary={(d) => {
            const s = searches(d);
            return `${fmtInt(s.total)} searches · ${fmtPct(s.change)} vs previous period (completed days)`;
          }}
        >
          {(d) => (
            <LineChart
              title="Searches per day"
              days={d.buckets}
              yFormat={fmtInt}
              series={[{ key: "searches", label: "Searches", values: d.searches.map((r) => r.searches), tone: 3, area: true }]}
            />
          )}
        </ChartFrame>
      </div>

      <div className="split split-even chart-row">
        <ChartFrame {...frame} title="Top tools" help="chart.top_tools" isEmpty={(d) => noCalls(d) || d.top_tools.length === 0} empty={activityEmpty} note={oauthOnly}>
          {(d) => (
            <HBarList
              label="Most called tools"
              format={fmtInt}
              rows={d.top_tools.map((t) => ({
                key: t.operation,
                label: t.operation,
                value: t.calls,
                href: "#log",
                ...(t.errors > 0 ? { note: `${fmtInt(t.errors)} ${t.errors === 1 ? "error" : "errors"}` } : {}),
              }))}
            />
          )}
        </ChartFrame>
        <ChartFrame {...frame} title="Who uses the brain" help="chart.agents" isEmpty={(d) => noCalls(d) || d.top_agents.length === 0} empty={activityEmpty} note={oauthOnly}>
          {(d) => {
            const rest = d.totals.requests - sum(d.top_agents.map((a) => a.calls));
            return (
              <>
                <HBarList
                  label="Calls per credential"
                  format={fmtInt}
                  rows={d.top_agents.map((a) => ({ key: a.id, label: a.agent, title: a.id, value: a.calls }))}
                />
                {rest > 0 && <p className="hint hbar-more">and {fmtInt(rest)} more calls</p>}
              </>
            );
          }}
        </ChartFrame>
      </div>
    </>
  );
}

export function SpendTable({ rows, label }: { rows: SpendReport["by_model"]; label: string }) {
  const sorted = [...rows].sort((a, b) => b.usd - a.usd);
  const max = Math.max(...sorted.map((r) => r.usd), 0);
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>{label}</th><th className="num">Calls</th><th className="num">USD</th><th className="bar-col" aria-hidden="true" /></tr></thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.key ?? "(none)"}>
              <td className="mono ellipsis" title={r.key ?? undefined}>{r.key ?? <span className="muted">(none)</span>}</td>
              <td className="num mono">{fmtInt(r.calls)}</td>
              <td className="num mono">{fmtUsd(r.usd)}</td>
              <td className="bar-col" aria-hidden="true">
                <span className="bar"><span className="bar-fill" style={{ width: `${max > 0 ? (r.usd / max) * 100 : 0}%` }} /></span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CapTable({ rows }: { rows: AgentSpendRow[] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Agent</th><th className="num">Spent</th><th className="num">Pending</th><th className="num">Cap</th><th className="bar-col">Used</th></tr></thead>
        <tbody>
          {rows.map((r) => {
            const use = capUse(r);
            const tone = use === null ? "" : use >= 1 ? " bar-error" : use > 0.8 ? " bar-warn" : "";
            return (
              <tr key={r.client_id}>
                <td className="ellipsis" title={r.client_id}>{r.client_name ?? r.client_id}</td>
                <td className="num mono">{fmtUsd(Number(r.spent_cents_today) / 100)}</td>
                <td className="num mono">{fmtUsd(Number(r.pending_cents) / 100)}</td>
                <td className="num mono">{use === null ? "none" : fmtUsd(Number(r.cap_usd_per_day))}</td>
                <td className="bar-col">
                  {use === null ? <span className="muted">uncapped</span> : (
                    <span className="bar-with-label">
                      <span className={`bar${tone}`}><span className="bar-fill" style={{ width: `${Math.min(100, use * 100)}%` }} /></span>
                      <span className="mono">{Math.round(use * 100)}%</span>
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
