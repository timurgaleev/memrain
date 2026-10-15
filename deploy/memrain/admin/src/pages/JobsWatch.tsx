import { useState, useEffect } from "react";
import { api } from "../api";

interface Job {
  id: string;
  kind: string;
  status: string;
  retry_count: number;
  last_error: string | null;
  created_at: string;
  finished_at: string | null;
}

const statusBadge = (s: string) =>
  s === "succeeded" ? "success" : s === "failed" ? "error" : s === "running" ? "write" : "read";

export function JobsWatchPage() {
  const [counts, setCounts] = useState<{ status: string; n: number }[]>([]);
  const [recent, setRecent] = useState<Job[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    const load = () =>
      api.jobsWatch()
        .then((r: { counts: { status: string; n: number }[]; recent: Job[] }) => { setCounts(r.counts); setRecent(r.recent); })
        .catch((e) => setError(String(e.message ?? e)));
    load();
    const interval = setInterval(load, 15000); // poll every 15s
    return () => clearInterval(interval);
  }, []);

  return (
    <>
      <h1 className="page-title">Jobs Watch</h1>
      {error && <div className="warning-bar">{error}</div>}

      <div className="metrics">
        {counts.length === 0 ? (
          <div className="metric"><div className="metric-value">0</div><div className="metric-label">Jobs</div></div>
        ) : counts.map((c) => (
          <div className="metric" key={c.status}>
            <div className="metric-value">{c.n}</div>
            <div className="metric-label">{c.status}</div>
          </div>
        ))}
      </div>

      <h2 className="section-title">Recent jobs</h2>
      {recent.length === 0 ? (
        <div className="feed-empty">No jobs yet.</div>
      ) : (
        <table>
          <thead>
            <tr><th>Kind</th><th>Status</th><th>Retries</th><th>Created</th><th>Finished</th></tr>
          </thead>
          <tbody>
            {recent.map((j) => (
              <tr key={j.id} title={j.last_error ?? undefined}>
                <td className="mono">{j.kind}</td>
                <td><span className={`badge badge-${statusBadge(j.status)}`}>{j.status}</span></td>
                <td className="mono">{j.retry_count}</td>
                <td style={{ color: "var(--text-secondary)" }}>{new Date(j.created_at).toLocaleString()}</td>
                <td style={{ color: "var(--text-secondary)" }}>{j.finished_at ? new Date(j.finished_at).toLocaleString() : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
