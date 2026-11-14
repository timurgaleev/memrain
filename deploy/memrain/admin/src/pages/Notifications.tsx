import { useState } from "react";
import { api } from "../api.ts";
import { useAsync } from "../hooks.ts";
import { Section } from "../components/Tile.tsx";
import { PageIntro } from "../components/PageIntro.tsx";
import { fmtAgo } from "../lib/format.ts";
import { kindLabel, linkedNotificationId } from "../lib/notifications.ts";
import type { NotificationList } from "../admin-types.ts";

const WEBHOOK_COPY: Record<NotificationList["webhook"]["state"], string> = {
  off: "Webhook off: notifications show here and in memrain doctor only.",
  refused: "Webhook set but refused; memrain doctor (notifications) says why.",
  on: "Webhook on: each new notification is also sent, as a signed pointer, to the configured URL.",
};

export function NotificationsPage({ param, onChange }: { param: string | null; onChange: () => void }) {
  const [all, setAll] = useState(false);
  const [error, setError] = useState("");
  const list = useAsync<NotificationList>((signal) => api.notifications(all, signal), [all], { intervalMs: 60_000 });
  const linked = linkedNotificationId(param);
  const now = Date.now();

  const markRead = async (ids: number[] | "all") => {
    setError("");
    try {
      await api.markNotificationsRead(ids);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not mark read.");
    }
    list.reload();
    onChange();
  };

  return (
    <>
      <div className="page-head">
        <div className="page-head-text">
          <h1 className="page-title">Notifications</h1>
          <PageIntro>
            Problems that need the owner: a connector that lost its authorization, deletions or items held, a paused
            spend path, an auto-paused daemon, writes held by the write gate. Each one says what happened and what to do;
            the detail stays in memrain doctor. A notification closes by itself once its problem is gone.
          </PageIntro>
        </div>
        <div className="segmented" role="group" aria-label="Show">
          <button className={all ? "" : "active"} aria-pressed={!all} onClick={() => setAll(false)}>Open</button>
          <button className={all ? "active" : ""} aria-pressed={all} onClick={() => setAll(true)}>All kept</button>
        </div>
      </div>

      {error && <div className="tile-error tile-error-inline"><span>{error}</span></div>}

      <Section state={list}>
        {(r) => (
          <>
            <div className="empty-note">{WEBHOOK_COPY[r.webhook.state]}</div>
            {r.notifications.length === 0 ? (
              <div className="empty-note">{all ? "No notifications kept." : "Nothing needs attention."}</div>
            ) : (
              <>
                {r.summary.unread > 0 && (
                  <button className="btn btn-secondary btn-sm" onClick={() => markRead("all")}>Mark all read</button>
                )}
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr><th>What</th><th>Source</th><th>Opened</th><th>What to do</th><th /></tr>
                    </thead>
                    <tbody>
                      {r.notifications.map((n) => (
                        <tr key={n.id} id={`notification-${n.id}`} className={n.id === linked ? "active" : undefined}>
                          <td>
                            {n.read_at === null && n.resolved_at === null && <span className="badge badge-write">new</span>}{" "}
                            {kindLabel(n.kind)}
                            <div className="muted mono">{n.ref}</div>
                          </td>
                          <td className="mono">{n.source_id}</td>
                          <td>
                            {fmtAgo(n.reopened_at ?? n.created_at, now)}
                            {n.resolved_at !== null && <div className="muted">resolved {fmtAgo(n.resolved_at, now)}</div>}
                          </td>
                          <td>{n.hint}</td>
                          <td>
                            {n.read_at === null && n.resolved_at === null && (
                              <button className="btn-link" onClick={() => markRead([n.id])}>Mark read</button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}
      </Section>
    </>
  );
}
