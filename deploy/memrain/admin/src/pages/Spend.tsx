import { useState } from "react";
import { api } from "../api.ts";
import { useAsync } from "../hooks.ts";
import { Section } from "../components/Tile.tsx";
import { fmtInt, fmtUsd } from "../lib/format.ts";
import type { AgentSpendRow, SpendReport } from "../admin-types.ts";
import { CapTable, SpendTable } from "./Overview.tsx";

const WINDOWS = [1, 7, 30] as const;

export function SpendPage() {
  const [days, setDays] = useState<(typeof WINDOWS)[number]>(7);
  const report = useAsync<SpendReport>(() => api.spendReport(days), [days], { intervalMs: 60_000 });
  const caps = useAsync<{ agents: AgentSpendRow[] }>(() => api.agentsSpend(), [], { intervalMs: 60_000 });
  const win = days === 1 ? "last 24h" : `last ${days} days`;

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Spend</h1>
        <div className="segmented" role="group" aria-label="Window">
          {WINDOWS.map((d) => (
            <button key={d} className={d === days ? "active" : ""} aria-pressed={d === days} onClick={() => setDays(d)}>
              {d === 1 ? "24h" : `${d}d`}
            </button>
          ))}
        </div>
      </div>

      <Section state={report}>
        {(r) => (
          <>
            <div className="metrics">
              <div className="metric"><div className="metric-value">{fmtUsd(r.total_usd)}</div><div className="metric-label">Total, {win}</div></div>
              <div className="metric"><div className="metric-value">{fmtInt(r.calls)}</div><div className="metric-label">Paid calls</div></div>
              <div className="metric">
                <div className="metric-value">{fmtUsd(r.today.brain_usd)}</div>
                <div className="metric-label">Brain today (UTC){r.today.brain_cap_usd !== null ? ` of ${fmtUsd(r.today.brain_cap_usd)}` : ", no cap"}</div>
              </div>
              <div className="metric">
                <div className="metric-value">{fmtUsd(r.today.cycle_usd)}</div>
                <div className="metric-label">Cycle today (UTC){r.today.cycle_cap_usd !== null ? ` of ${fmtUsd(r.today.cycle_cap_usd)}` : ", no cap"}</div>
              </div>
            </div>

            {(r.coverage.unpriced_calls > 0 || r.coverage.no_usage_calls > 0 || r.coverage.tokens_unrecorded_calls > 0) && (
              <div className="warning-bar">
                Totals leave out {fmtInt(r.coverage.unpriced_calls)} unpriced calls
                {r.coverage.unpriced_models.length > 0 && <> ({r.coverage.unpriced_models.join(", ")})</>}.
                {" "}{fmtInt(r.coverage.no_usage_calls)} calls failed before usage was reported;
                {" "}{fmtInt(r.coverage.tokens_unrecorded_calls)} priced calls have no token counts.
              </div>
            )}

            {r.calls === 0 && r.outcomes.length === 0 ? (
              <div className="empty-note">No paid calls in the {win}.</div>
            ) : (
              <div className="split split-even">
                <section className="panel"><h2 className="panel-title">By model</h2><SpendTable rows={r.by_model} label="Model" /></section>
                <section className="panel"><h2 className="panel-title">By operation</h2><SpendTable rows={r.by_operation} label="Operation" /></section>
                <section className="panel"><h2 className="panel-title">By client</h2><SpendTable rows={r.by_client} label="Client" /></section>
                <section className="panel"><h2 className="panel-title">Outcomes</h2><SpendTable rows={r.outcomes} label="Outcome" /></section>
              </div>
            )}

            <h2 className="section-title">Coverage, {win}</h2>
            <section className="panel">
              <dl className="kv kv-wide">
                <dt>Unpriced calls</dt><dd className="mono">{fmtInt(r.coverage.unpriced_calls)}</dd>
                <dt>Unpriced models</dt><dd className="mono">{r.coverage.unpriced_models.join(", ") || "none"}</dd>
                <dt>Failed before usage</dt><dd className="mono">{fmtInt(r.coverage.no_usage_calls)}</dd>
                <dt>Priced, tokens not recorded</dt><dd className="mono">{fmtInt(r.coverage.tokens_unrecorded_calls)}</dd>
              </dl>
            </section>
          </>
        )}
      </Section>

      <h2 className="section-title">Agents against their daily cap, today (UTC)</h2>
      <section className="panel">
        <Section state={caps} isEmpty={(d) => d.agents.length === 0} emptyText="No OAuth clients are registered.">
          {(d) => <CapTable rows={d.agents} />}
        </Section>
      </section>
    </>
  );
}
