import { useState } from "react";
import type { AsyncState } from "../hooks.ts";
import { describeError } from "../hooks.ts";
import { ApiError } from "../lib/passkey-fetch.ts";
import { fmtAgo } from "../lib/format.ts";
import { buildHash } from "../lib/route.ts";
import { outcomeCopy } from "./copy.ts";
import type { ThreadSummary } from "./events.ts";

/** A failed chat call in words: the chat codes through the shared copy, anything else as it came. */
export function chatErrorText(e: unknown): string {
  return e instanceof ApiError ? outcomeCopy(e.code).title : describeError(e);
}

export function ThreadList({ state, activeId, now, onNew, onDelete }: {
  state: AsyncState<ThreadSummary[]>;
  activeId: string | null;
  now: number;
  onNew: () => void;
  onDelete: (t: ThreadSummary) => Promise<void>;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");

  const remove = async (t: ThreadSummary) => {
    setDeleting(true);
    setError("");
    try {
      await onDelete(t);
      setConfirming(null);
    } catch (e) {
      setError(chatErrorText(e));
    } finally {
      setDeleting(false);
    }
  };

  const body = (() => {
    if (state.data === null) {
      if (state.status === "error") {
        return (
          <div className="tile-error">
            <span>{chatErrorText(state.error)}</span>
            <button className="btn-link" onClick={state.reload}>Retry</button>
          </div>
        );
      }
      return <div className="skeleton" aria-busy="true" aria-label="Loading conversations"><span /><span /><span /></div>;
    }
    if (state.data.length === 0) {
      return <p className="chat-threads-empty">Your conversations will appear here. Each question you ask starts or continues one.</p>;
    }
    return (
      <ul className="chat-thread-list">
        {state.data.map((t) => {
          const title = t.title || "Untitled conversation";
          const current = t.id === activeId;
          return (
            <li key={t.id} className={current ? "chat-thread active" : "chat-thread"}>
              {confirming === t.id ? (
                <div className="chat-thread-confirm" role="group" aria-label={`Delete ${title}?`}>
                  <span>Delete this conversation? Its answers go too; saved pages stay.</span>
                  <div className="chat-thread-confirm-actions">
                    <button className="btn btn-danger btn-sm" disabled={deleting} onClick={() => void remove(t)}>Delete</button>
                    <button className="btn btn-secondary btn-sm" disabled={deleting} onClick={() => setConfirming(null)}>Cancel</button>
                  </div>
                </div>
              ) : (
                <>
                  <a className="chat-thread-link" href={buildHash({ name: "ask", param: t.id })} aria-current={current ? "page" : undefined}>
                    <span className="chat-thread-title">{title}</span>
                    <span className="chat-thread-meta">
                      {t.message_count} {t.message_count === 1 ? "message" : "messages"} · {fmtAgo(t.updated_at, now)}
                    </span>
                  </a>
                  <button className="chat-thread-delete" aria-label={`Delete conversation: ${title}`} title="Delete" onClick={() => { setError(""); setConfirming(t.id); }}>
                    <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" className="icon">
                      <path d="M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10" />
                    </svg>
                  </button>
                </>
              )}
            </li>
          );
        })}
      </ul>
    );
  })();

  return (
    <>
      <button className="btn btn-primary chat-new" onClick={onNew}>New question</button>
      <h2 className="chat-threads-title">Conversations</h2>
      {error && <div className="tile-error tile-error-inline" role="alert">{error}</div>}
      {body}
    </>
  );
}
