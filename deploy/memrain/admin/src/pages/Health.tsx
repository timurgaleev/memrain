import React from "react";
import { api, tool } from "../api.ts";
import { useAsync, useNow } from "../hooks.ts";
import { Section, Tile } from "../components/Tile.tsx";
import { fmtAgo, fmtInt, fmtUsd } from "../lib/format.ts";
import { parsePageList } from "../lib/tool-result.ts";
import { buildHash } from "../lib/route.ts";
import { capUse, reviewItems } from "../admin-types.ts";
import type { AgentSpendRow, AgentUsageRow, FullStats, HealthBody, HealthIndicators, HealthReport, Stats } from "../admin-types.ts";
import { PageIntro } from "../components/PageIntro.tsx";
import { SetupChecklist } from "../components/SetupChecklist.tsx";

const HEALTH_MS = 30_000;
const REPORT_MS = 60_000;
const CORPUS_MS = 300_000;

const pct = (n: number) => `${(Math.floor(n * 1000) / 10).toFixed(1)}%`;

/** Housekeeping runs hourly; past this it is not running. */
const HOUSEKEEPING_STALE_MS = 3 * 3600_000;

interface Chip { label: string; href: string; tone: "error" | "warning" }

export function HealthPage() {
  const now = useNow(5000);
  const health = useAsync<HealthBody>(() => api.health(), [], { intervalMs: HEALTH_MS });
  const brain = useAsync<FullStats>(() => api.fullStats(false), [], { intervalMs: HEALTH_MS });
  const corpus = useAsync<FullStats>(() => api.fullStats(), [], { intervalMs: CORPUS_MS });
  const report = useAsync<HealthReport>(() => api.healthReport(), [], { intervalMs: REPORT_MS });
  const stats = useAsync<Stats>(() => api.stats(), [], { intervalMs: HEALTH_MS });
  const indicators = useAsync<HealthIndicators>(() => api.healthIndicators(), [], { intervalMs: HEALTH_MS });
  const agents = useAsync<{ agents: AgentUsageRow[] }>(() => api.agents(), [], { intervalMs: HEALTH_MS });
  const caps = useAsync<{ agents: AgentSpendRow[] }>(() => api.agentsSpend(), [], { intervalMs: REPORT_MS });
  const changed = useAsync(async (signal) => {
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    return parsePageList(await tool("page_list", { since, sort: "updated_desc", limit: 8 }, signal));
  }, [], { intervalMs: REPORT_MS });

  const h = brain.data?.health ?? null;
  const r = report.data;
  const capRows = (caps.data?.agents ?? [])
    .map((row) => ({ row, use: capUse(row) }))
    .filter((c): c is { row: AgentSpendRow; use: number } => c.use !== null)
    .sort((a, b) => b.use - a.use);
  const review = r ? reviewItems(r.review) : [];

  const chips: Chip[] = [];
  if (r && r.migrations.pending.length > 0) chips.push({ label: `${r.migrations.pending.length} migrations not applied`, href: "#health", tone: "error" });
  if (review.length > 0) chips.push({ label: "Items wait for review", href: "#health", tone: "warning" });
  if (indicators.data && indicators.data.error_rate_24h > 2) chips.push({ label: `Error rate ${indicators.data.error_rate_24h}%`, href: "#agents", tone: "error" });
  if (indicators.data && indicators.data.tokens_expiring_24h > 0) chips.push({ label: `${fmtInt(indicators.data.tokens_expiring_24h)} tokens expire in 24h`, href: "#agents", tone: "warning" });
  if (h && h.embed_coverage_pct < 0.99) chips.push({ label: `Embed coverage ${pct(h.embed_coverage_pct)}`, href: "#health", tone: "warning" });
  for (const c of capRows.filter((c) => c.use > 0.8)) {
    chips.push({ label: `${c.row.client_name ?? c.row.client_id} at ${Math.round(c.use * 100)}% of cap`, href: "#health", tone: c.use >= 1 ? "error" : "warning" });
  }

  const lastUpdate = Math.max(...[health, brain, report, stats, indicators].map((s) => s.updatedAt ?? 0));
  const topAgents = [...(agents.data?.agents ?? [])]
    .filter((a) => a.usage.requests_today > 0)
    .sort((a, b) => b.usage.requests_today - a.usage.requests_today)
    .slice(0, 3);

  return (
    <>
      <div className="status-strip" role="status">
        <span className="strip-item">
          <span className={`dot ${health.data ? (health.data.ok ? "dot-ok" : "dot-error") : health.status === "error" ? "dot-error" : "dot-idle"}`} />
          {health.data ? <span className="mono">{health.data.version ?? "unknown build"}</span> : health.status === "error" ? "health check failed" : "checking…"}
          {health.data?.maintenance === true && <span className="badge badge-write">maintenance</span>}
        </span>
        <span className="strip-item muted">{lastUpdate > 0 ? `updated ${fmtAgo(new Date(lastUpdate).toISOString(), now)}` : "loading…"}</span>
        {chips.length > 0 && (
          <span className="strip-chips">
            {chips.map((c) => <a key={c.label} href={c.href} className={`chip chip-${c.tone}`}>{c.label}</a>)}
          </span>
        )}
      </div>

      <h1 className="page-title">Health</h1>
      <PageIntro>
        Whether your brain is healthy: search coverage, schema, housekeeping, what it cost today and what waits for you.
        Tiles use the last 24 hours; spend uses the UTC day.
      </PageIntro>

      <SetupChecklist />

      {review.length > 0 && (
        <section className="panel" aria-label="Waiting for review">
          <h2 className="panel-title">Waiting for review</h2>
          <p className="hint">Held and quarantined content is reviewed from the command line on the server.</p>
          <ul className="link-list">
            {review.map((item) => (
              <li key={item.command}>
                <span className="ll-primary">{item.label}</span>
                <code className="ll-secondary">{item.command}</code>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="tiles">
        <Tile title="Search coverage" state={brain} intervalMs={HEALTH_MS} now={now} isEmpty={(d) => d.health === null} emptyText="Health metrics are unavailable on this engine.">
          {(d) => {
            const x = d.health;
            if (!x) return null;
            return (
              <>
                <div className="tile-figure">{pct(x.embed_coverage_pct)}<span className="tile-unit">embedded</span></div>
                <dl className="kv">
                  <dt>Chunks</dt><dd>{fmtInt(x.embedded_chunks)} / {fmtInt(x.embeddable_chunks)}</dd>
                  <dt>Last write</dt><dd>{x.lag_seconds === null ? "n/a" : fmtAgo(new Date(now - x.lag_seconds * 1000).toISOString(), now)}</dd>
                </dl>
              </>
            );
          }}
        </Tile>

        <Tile title="Schema and housekeeping" state={report} intervalMs={REPORT_MS} now={now}>
          {(d) => <MaintenanceFigures report={d} now={now} />}
        </Tile>

        <Tile title="Spend" window="today (UTC)" state={report} intervalMs={REPORT_MS} now={now}>
          {(d) => (
            <>
              <div className="tile-figure">{fmtUsd(d.spend_today.usd)}<span className="tile-unit">spent</span></div>
              <dl className="kv">
                <dt>Daily cap</dt><dd>{d.spend_today.cap_usd === null ? "none" : fmtUsd(d.spend_today.cap_usd)}</dd>
                <dt>Nearest agent cap</dt>
                <dd>{capRows[0] ? `${capRows[0].row.client_name ?? capRows[0].row.client_id} ${Math.round(capRows[0].use * 100)}%` : "no capped agents"}</dd>
              </dl>
            </>
          )}
        </Tile>

        <Tile title="Traffic" window="last 24h" state={stats} intervalMs={HEALTH_MS} now={now}>
          {(d) => (
            <>
              <div className="tile-figure">{fmtInt(d.requests_today ?? 0)}<span className="tile-unit">requests</span></div>
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
      </div>

      <section className="corpus" aria-label="Corpus">
        {(["pages", "documents", "chunks", "links"] as const).map((k) => (
          <div className="corpus-cell" key={k}>
            <div className="corpus-value">
              {corpus.data?.counts ? fmtInt(corpus.data.counts[k]) : corpus.status === "error" ? "—" : <span className="skeleton-inline" />}
            </div>
            <div className="corpus-label">{k}</div>
          </div>
        ))}
        {corpus.status === "error" && corpus.data === null && (
          <button className="btn-link corpus-retry" onClick={corpus.reload}>Counts failed to load. Retry</button>
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
              {rows.map((row) => (
                <li key={row.slug}>
                  <a href={buildHash({ name: "page", param: row.slug })}>
                    <span className="ll-primary">{row.title || row.slug}</span>
                    <span className="ll-secondary mono">{row.slug}</span>
                  </a>
                  <span className="muted ll-meta">{fmtAgo(row.updated_at, now)}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </section>

      <h2 className="section-title">Agents against their daily cap, today (UTC)</h2>
      <section className="panel">
        <Section state={caps} isEmpty={(d) => d.agents.length === 0} emptyText="No OAuth clients are registered.">
          {(d) => <CapTable rows={d.agents} />}
        </Section>
      </section>

      <h2 className="section-title">Build</h2>
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

function MaintenanceFigures({ report, now }: { report: HealthReport; now: number }) {
  const m = report.migrations;
  const hk = report.housekeeping;
  const hkAge = hk === null ? null : now - Date.parse(hk.finished_at);
  const hkStale = hkAge !== null && Number.isFinite(hkAge) && hkAge > HOUSEKEEPING_STALE_MS;
  const schemaNote = m.pending.length > 0
    ? `${m.pending.length} not applied: run memrain apply-migrations`
    : m.ahead.length > 0
      ? `ahead of this build (${m.ahead.join(", ")})`
      : m.gaps.length > 0
        ? `gap at ${m.gaps.join(", ")}`
        : m.files_readable ? "up to date" : "migration files unreadable";
  return (
    <>
      <div className="tile-figure">{m.head}<span className="tile-unit">schema</span></div>
      <dl className="kv">
        <dt>Migrations</dt>
        <dd className={m.pending.length > 0 ? "error-text" : m.ahead.length + m.gaps.length > 0 ? "warn-text" : undefined}>{schemaNote}</dd>
        <dt>Housekeeping</dt>
        <dd className={hk !== null && (hk.errors > 0 || hkStale) ? "warn-text" : undefined}>
          {hk === null ? "not run yet (hourly while serving)" : `${fmtAgo(hk.finished_at, now)}${hk.errors > 0 ? `, ${hk.errors} step(s) failed` : ""}`}
        </dd>
      </dl>
    </>
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
