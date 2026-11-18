import { useEffect, useId, useState } from "react";
import { automationApi } from "../api-automation.ts";
import { ApiError } from "../lib/passkey-fetch.ts";
import { fmtInt } from "../lib/format.ts";
import { MAX_SLACK_HISTORY_DAYS, type ChannelsReport, type ConnectorAccountView } from "../lib/automation.ts";
import { actionError } from "./connection-actions.ts";

/** Past this many channels the list gets a filter field. */
const FILTER_FROM = 12;

/** A whole number of days the server accepts, or null. */
function parseDays(text: string): number | null {
  if (!/^\d{1,3}$/.test(text.trim())) return null;
  const n = Number(text.trim());
  return n >= 1 && n <= MAX_SLACK_HISTORY_DAYS ? n : null;
}

/** The server's own sentence for a refusal it explained, else the shared copy. */
function pickerError(e: unknown): string {
  if (e instanceof ApiError && typeof e.body.message === "string" && e.body.message !== "") return e.body.message;
  return actionError(e);
}

/**
 * Which of a Slack account's channels sync, and how far back a channel's
 * first sync reads. The list comes from Slack with the account's own token;
 * only a channel the bot was invited to can be ticked.
 */
export function ChannelPicker({ account, id, onClose, onSaved }: {
  account: ConnectorAccountView;
  id: string;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [report, setReport] = useState<ChannelsReport | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [days, setDays] = useState("");
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const daysId = useId();
  const filterId = useId();

  useEffect(() => {
    let live = true;
    automationApi.channels(account.id).then((r) => {
      if (!live) return;
      setReport(r);
      setChosen(new Set(r.channels.filter((c) => c.selected).map((c) => c.id)));
      setDays(String(r.history_days));
    }).catch((e: unknown) => { if (live) setError(pickerError(e)); });
    return () => { live = false; };
  }, [account.id]);

  const toggle = (channelId: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(channelId);
    else next.delete(channelId);
    setChosen(next);
  };

  const historyDays = parseDays(days);
  const save = async () => {
    if (report === null || historyDays === null) return;
    setBusy(true);
    setError("");
    try {
      const channels = report.channels.filter((c) => chosen.has(c.id)).map((c) => c.id);
      await automationApi.saveChannels(account.id, channels, historyDays);
      onSaved(`Saved: ${fmtInt(channels.length)} ${channels.length === 1 ? "channel syncs" : "channels sync"} for ${account.account_label}. The next sync picks them up.`);
    } catch (e) {
      setError(pickerError(e));
    } finally {
      setBusy(false);
    }
  };

  const needle = filter.trim().replace(/^#/, "").toLowerCase();
  const shown = report === null ? [] : report.channels.filter((c) => needle === "" || c.name.toLowerCase().includes(needle) || chosen.has(c.id));

  return (
    <div className="calendar-picker" id={id}>
      {report === null ? (
        error ? null : <div className="skeleton" aria-busy="true" aria-label="Loading the channels this account can see"><span /><span /></div>
      ) : (
        <form className="calendar-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          {report.channels.length > FILTER_FROM && (
            <div className="field calendar-days">
              <label htmlFor={filterId}>Find a channel</label>
              <input id={filterId} type="search" value={filter} autoComplete="off" spellCheck={false} onChange={(e) => setFilter(e.target.value)} />
            </div>
          )}
          <fieldset className="calendar-list channel-list">
            <legend>Channels to sync</legend>
            {report.channels.length === 0 && <p className="empty-note">Slack lists no channel this bot can see.</p>}
            {report.channels.length > 0 && shown.length === 0 && <p className="empty-note">No channel matches “{filter.trim()}”.</p>}
            {shown.map((c) => (
              <label key={c.id} className="checkbox-label calendar-option">
                <input
                  type="checkbox"
                  checked={chosen.has(c.id)}
                  disabled={busy || (!c.is_member && !chosen.has(c.id))}
                  onChange={(e) => toggle(c.id, e.target.checked)}
                />
                <span className="calendar-name">#{c.name}</span>
                <span className="muted small">
                  {c.is_member ? (c.is_private ? "private" : "public") : <>invite the bot first: type <code>/invite @your-app</code> in the channel</>}
                </span>
              </label>
            ))}
          </fieldset>
          {!report.private_channels && (
            <p className="hint">Private channels are not listed. To read them, reconnect with Private channels too ticked and invite the bot to each.</p>
          )}
          <div className="field calendar-days">
            <label htmlFor={daysId}>History window in days</label>
            <input
              id={daysId}
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_SLACK_HISTORY_DAYS}
              value={days}
              onChange={(e) => setDays(e.target.value)}
              aria-invalid={historyDays === null}
              aria-describedby={`${daysId}-hint`}
            />
          </div>
          <p className="hint" id={`${daysId}-hint`}>
            How far back a channel's first sync reads, from 1 to {fmtInt(MAX_SLACK_HISTORY_DAYS)} days. After that every sync re-reads the
            last three days, so edits and deletions there come through.
          </p>
          {error && <p className="error-text" role="alert">{error}</p>}
          <div className="dialog-actions">
            <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy || historyDays === null}>
              {busy ? "Saving…" : "Save channels"}
            </button>
          </div>
        </form>
      )}
      {report === null && error && (
        <>
          <p className="error-text" role="alert">{error}</p>
          <div className="dialog-actions">
            <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>Close</button>
          </div>
        </>
      )}
    </div>
  );
}
