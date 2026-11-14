import { useState } from "react";
import { automationApi } from "../api-automation.ts";
import { describeError, useAsync, useNow } from "../hooks.ts";
import { Section } from "../components/Tile.tsx";
import { PageIntro } from "../components/PageIntro.tsx";
import { fmtAgo, fmtUsd } from "../lib/format.ts";
import { daemonView, type DaemonRow, type DaemonsReport, type PausedSpendPath } from "../lib/automation.ts";

type Flash = { ok: boolean; message: string };
type Control = "pause" | "resume" | "enable" | "disable";

export function AutonomyPage() {
  const report = useAsync<DaemonsReport>(() => automationApi.daemons(), [], { intervalMs: 30_000 });
  const paused = useAsync<{ paths: PausedSpendPath[] }>(() => automationApi.pausedSpend(), [], { intervalMs: 60_000 });
  const now = useNow(15_000);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [busy, setBusy] = useState(false);

  const act = async (work: () => Promise<string>, reload: () => void) => {
    setBusy(true);
    try {
      setFlash({ ok: true, message: await work() });
    } catch (e) {
      setFlash({ ok: false, message: describeError(e) });
    } finally {
      setBusy(false);
      reload();
    }
  };

  const control = (action: Control, daemon: string) => act(async () => {
    await automationApi.controlDaemon(action, daemon);
    const who = daemon === "all" ? "Every daemon" : daemon;
    return {
      pause: `${who} is paused. A run already going stops at its next checkpoint.`,
      resume: `${who} is resumed.`,
      enable: `${who} is switched on.`,
      disable: `${who} is switched off.`,
    }[action];
  }, report.reload);

  const resumeSpend = (path: string) => act(async () => {
    const r = await automationApi.resumeSpend(path);
    return r.resumed ? `${path} may spend again.` : `${path} was not paused.`;
  }, paused.reload);

  return (
    <>
      <div className="page-head">
        <div className="page-head-text">
          <h1 className="page-title">Autonomy</h1>
          <PageIntro>
            Background daemons and the paid paths they use. Pause one or all of them here; a paused daemon skips its windows
            until resumed. A paid path that cost more than the amount held for it stays paused until you resume it.
          </PageIntro>
        </div>
        {report.data && (
          <div className="page-actions">
            {report.data.paused_all ? (
              <button className="btn btn-primary" disabled={busy} onClick={() => control("resume", "all")}>Resume all daemons</button>
            ) : (
              <button className="btn btn-danger" disabled={busy} onClick={() => control("pause", "all")}>Pause all daemons</button>
            )}
          </div>
        )}
      </div>

      {flash && (
        <div className={flash.ok ? "notice" : "warning-bar"} role={flash.ok ? "status" : "alert"}>
          {flash.message}
          <button className="btn-link flash-dismiss" onClick={() => setFlash(null)}>Dismiss</button>
        </div>
      )}

      <Section state={report}>
        {(r) => (
          <>
            <div className="status-line" role="status">
              <span className={`dot dot-${!r.scheduler.enabled_here ? "idle" : r.scheduler.leader?.live ? "ok" : "warn"}`} aria-hidden="true" />
              {!r.scheduler.enabled_here
                ? "The scheduler is off on this server; nothing runs on a schedule here."
                : r.scheduler.leader
                  ? <>Scheduler leader <span className="mono">{r.scheduler.leader.holder}</span>, last tick{" "}
                    {r.scheduler.leader.tick_age_s === null ? "unknown" : `${r.scheduler.leader.tick_age_s}s ago`}
                    {r.scheduler.leader.live ? "" : " (not answering)"}</>
                  : "No scheduler holds the lead yet."}
              {r.paused_all && <span className="warn-text"> · All daemons paused{r.paused_all.by ? ` by ${r.paused_all.by}` : ""}{r.paused_all.reason ? `: ${r.paused_all.reason}` : ""}</span>}
            </div>

            <h2 className="section-title">Daemons</h2>
            <section className="panel">
              {r.daemons.length === 0 ? (
                <div className="empty-note">No daemons are registered on this server.</div>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr><th>Daemon</th><th>Status</th><th>Schedule</th><th>Last run</th><th>Next window</th><th><span className="sr-only">Actions</span></th></tr>
                    </thead>
                    <tbody>
                      {r.daemons.map((d) => <DaemonLine key={d.name} d={d} report={r} now={now} busy={busy} onControl={control} />)}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
      </Section>

      <h2 className="section-title">Paused paid paths</h2>
      <section className="panel">
        <Section state={paused} isEmpty={(d) => d.paths.length === 0} emptyText="No paid path is paused. Every path is spending within what it holds.">
          {(d) => (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Path</th><th>Why</th><th className="num">Held</th><th className="num">Cost</th><th>Paused</th><th><span className="sr-only">Actions</span></th></tr>
                </thead>
                <tbody>
                  {d.paths.map((p) => (
                    <tr key={p.path}>
                      <td className="mono">{p.path}</td>
                      <td>{p.reason}{p.model ? <span className="muted"> · {p.model}</span> : null}</td>
                      <td className="num">{fmtUsd(p.heldUsd)}</td>
                      <td className="num">{fmtUsd(p.actualUsd)}</td>
                      <td>{fmtAgo(p.pausedAt, now)}</td>
                      <td className="row-actions">
                        <button className="btn btn-secondary btn-sm" disabled={busy} aria-label={`Resume ${p.path}`} onClick={() => resumeSpend(p.path)}>
                          Resume
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      </section>
    </>
  );
}

function DaemonLine({ d, report, now, busy, onControl }: {
  d: DaemonRow;
  report: DaemonsReport;
  now: number;
  busy: boolean;
  onControl: (action: Control, daemon: string) => void;
}) {
  const view = daemonView(d, report.paused_all);
  return (
    <tr>
      <td>
        <span className="mono">{d.name}</span>
        {d.paid && <span className="badge badge-write daemon-paid">paid</span>}
        <div className="muted small">{d.kind} · {d.lane} lane</div>
      </td>
      <td>
        <span className="status-cell"><span className={`dot dot-${view.tone}`} aria-hidden="true" />{view.label}</span>
        {d.paused?.reason && <div className="muted small">{d.paused.reason}</div>}
      </td>
      <td className="mono">{d.schedule}</td>
      <td>
        {d.last_run_at ? fmtAgo(d.last_run_at, now) : "never"}
        {d.last_outcome && <div className="muted small">{d.last_outcome}</div>}
      </td>
      <td className="mono">{d.next_window ?? "—"}</td>
      <td className="row-actions">
        {d.paused ? (
          <button className="btn btn-secondary btn-sm" disabled={busy} aria-label={`Resume ${d.name}`} onClick={() => onControl("resume", d.name)}>Resume</button>
        ) : (
          <button className="btn btn-secondary btn-sm" disabled={busy || !d.enabled} aria-label={`Pause ${d.name}`} onClick={() => onControl("pause", d.name)}>Pause</button>
        )}
        <button
          className="btn btn-secondary btn-sm"
          disabled={busy || d.env_disabled}
          title={d.env_disabled ? "Switched off by the environment; change MEMRAIN_DAEMONS_DISABLED to switch it on." : undefined}
          aria-label={`${d.enabled ? "Switch off" : "Switch on"} ${d.name}`}
          onClick={() => onControl(d.enabled ? "disable" : "enable", d.name)}
        >
          {d.enabled ? "Switch off" : "Switch on"}
        </button>
      </td>
    </tr>
  );
}
