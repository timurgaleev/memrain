import { useState, useEffect } from "react";
import { api } from "../api";
import { useDebounced } from "../hooks.ts";
import { PageIntro } from "../components/PageIntro.tsx";

interface Row {
  id: number;
  agent_name: string | null;
  operation: string;
  latency_ms: number | null;
  status: string;
  error_message: string | null;
  created_at: string;
}

interface Data { page: number; per_page: number; total: number; rows: Row[]; db_enabled?: boolean }

export function RequestLogPage() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [agent, setAgent] = useState("");
  const agentFilter = useDebounced(agent.trim(), 300);

  const load = (page: number) => {
    setLoading(true);
    return api.requests(page, agentFilter || undefined)
      .then((d: Data) => { setData(d); setError(""); })
      .catch((e) => setError(String(e.message ?? e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(1); }, [agentFilter]);

  const pages = data ? Math.max(1, Math.ceil(data.total / data.per_page)) : 1;

  return (
    <>
      <h1 className="page-title">Request Log</h1>
      <PageIntro>
        Every tool call an agent made: who called, which tool, how long it took and whether it worked. Your own clicks in
        this panel are not counted.
        {data?.db_enabled === false && (
          <> This instance logs only OAuth connections; logging every call is a server setting (<code>MEMRAIN_REQUEST_LOG_DB</code>).</>
        )}
      </PageIntro>
      <div className="filter-bar filter-wrap">
        <label className="field">
          <span>Agent</span>
          <input
            value={agent}
            onChange={(e) => setAgent(e.target.value)}
            placeholder="all agents"
            list="known-agents"
            aria-label="Filter by agent name"
          />
          <datalist id="known-agents"><option value="admin-panel" /></datalist>
        </label>
        {agent && <button className="btn-link" onClick={() => setAgent("")}>Clear</button>}
      </div>
      {error && <div className="warning-bar">{error}</div>}

      {data === null ? (
        loading ? <div className="skeleton" aria-busy="true" aria-label="Loading"><span /><span /><span /></div> : null
      ) : data.rows.length === 0 ? (
        <div className="feed-empty">{agentFilter ? `No requests from “${agentFilter}”.` : "No request log entries yet."}</div>
      ) : (
        <div className={loading ? "is-loading" : undefined}>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Time</th><th>Agent</th><th>Operation</th><th className="num">Latency</th><th>Status</th></tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id} title={r.error_message ?? undefined}>
                    <td style={{ color: "var(--text-secondary)" }}>{new Date(r.created_at).toLocaleString()}</td>
                    <td className="mono">{r.agent_name ?? "—"}</td>
                    <td className="mono">{r.operation}</td>
                    <td className="mono num">{r.latency_ms == null ? "—" : `${r.latency_ms} ms`}</td>
                    <td><span className={`badge badge-${r.status === "success" ? "success" : "error"}`}>{r.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pagination">
            <button disabled={loading || data.page <= 1} onClick={() => load(data.page - 1)}>← Prev</button>
            <span>Page {data.page} / {pages} · {data.total} total</span>
            <button disabled={loading || data.page >= pages} onClick={() => load(data.page + 1)}>Next →</button>
          </div>
        </div>
      )}
    </>
  );
}
