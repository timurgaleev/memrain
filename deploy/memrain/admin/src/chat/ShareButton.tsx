import { useId, useState } from "react";
import { CopyField } from "../components/CopyField.tsx";
import { chatApi, actionErrorText } from "./chat-api.ts";

const MIN = 8;

type Phase =
  | { kind: "idle" }
  | { kind: "asking" }
  | { kind: "shared"; url: string; expiresAt: string }
  | { kind: "ended" };

/**
 * Share one answer as a password link that works for 7 days. The person
 * opening it sees the answer and its source titles, nothing else. The link is
 * shown once; ending it stops every link to this answer.
 */
export function ShareButton({ messageId }: { messageId: string }) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const id = useId();
  const hintId = useId();

  const create = async () => {
    if (password.length < MIN) {
      setError(`Use at least ${MIN} characters.`);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const r = await chatApi.share(messageId, password);
      setPassword("");
      setPhase({ kind: "shared", url: new URL(r.url, window.location.origin).toString(), expiresAt: r.expiresAt });
    } catch (e) {
      setError(actionErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  const end = async () => {
    setBusy(true);
    setError("");
    try {
      await chatApi.unshare(messageId);
      setPhase({ kind: "ended" });
    } catch (e) {
      setError(actionErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (phase.kind === "idle" || phase.kind === "ended") {
    return (
      <span className="chat-share">
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPhase({ kind: "asking" })}>Share link</button>
        {phase.kind === "ended" && <span className="chat-saved" role="status">Link ended.</span>}
      </span>
    );
  }

  if (phase.kind === "asking") {
    return (
      <form className="chat-share chat-share-form" onSubmit={(e) => { e.preventDefault(); if (!busy) void create(); }}>
        <label htmlFor={id} className="small">Password for the link</label>
        <input
          id={id}
          type="password"
          autoComplete="new-password"
          maxLength={200}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-describedby={hintId}
          autoFocus
        />
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>{busy ? "Creating…" : "Create link"}</button>
        <button type="button" className="btn-link" onClick={() => { setPhase({ kind: "idle" }); setPassword(""); setError(""); }}>Cancel</button>
        <span id={hintId} className="chat-share-hint">
          Anyone with the link and this password can read the answer and its source titles for 7 days. Send the password separately.
        </span>
        {error && <span className="error-text small" role="alert">{error}</span>}
      </form>
    );
  }

  return (
    <div className="chat-share chat-share-done">
      <CopyField value={phase.url} label="Share link" />
      <span className="chat-share-hint">
        Works until {new Date(phase.expiresAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}. This is the only time the link is shown.
      </span>
      <button type="button" className="btn-link" disabled={busy} onClick={() => void end()}>End link</button>
      {error && <span className="error-text small" role="alert">{error}</span>}
    </div>
  );
}
