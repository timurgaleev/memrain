import { api } from "../api";
import { describeError, useAsync } from "../hooks.ts";
import { PageIntro } from "../components/PageIntro.tsx";

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
  const state = useAsync<{ counts: { status: string; n: number }[]; recent: Job[] }>(
    (signal) => api.jobsWatch(signal), [], { intervalMs: 15000 },
  );
  const counts = state.data?.counts ?? [];
  const recent = state.data?.recent ?? [];
  const error = state.status === "error" ? describeError(state.error) : "";

  return (
    <>
      <h1 className="page-title">Jobs Watch</h1>
      <PageIntro>
        Background work the server runs on its own, such as indexing new text and nightly maintenance. Failed jobs are
        listed with their error so you can see what needs attention.
      </PageIntro>
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
