import { useCallback, useEffect, useState } from "react";
import { appApi, errorText, type KeyRow } from "./api.ts";

/** The member's own conversations and keys: download, delete, revoke. */
export function MyData() {
  const [threads, setThreads] = useState<Array<{ id: string; title: string | null }> | null>(null);
  const [keys, setKeys] = useState<KeyRow[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [t, k] = await Promise.all([appApi.threads(), appApi.keys()]);
      setThreads(t.threads);
      setKeys(k.tokens);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const download = () => act(async () => {
    const all = await Promise.all((threads ?? []).map((t) => appApi.thread(t.id)));
    const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), threads: all }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `memrain-conversations-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  return (
    <div>
      <div className="page-head">
        <div className="page-head-text">
          <h1 className="page-title">My data</h1>
          <p className="muted">Your conversations and the keys your tools use. Only you see them.</p>
        </div>
      </div>
      {error && <div className="notice" role="alert">{error}</div>}
      <section className="panel" style={{ marginBottom: 16 }}>
        <h2>Conversations</h2>
        <button className="btn btn-secondary btn-sm" disabled={busy || !threads?.length} onClick={download}>Download all</button>
        {threads?.length === 0 && <p className="muted">No conversations yet.</p>}
        <ul className="link-list">
          {threads?.map((t) => (
            <li key={t.id}>
              <a href={`#ask/${encodeURIComponent(t.id)}`}>{t.title ?? "Untitled"}</a>{" "}
              <button className="btn btn-link btn-sm" disabled={busy} onClick={() => {
                if (window.confirm("Delete this conversation? This cannot be undone.")) void act(() => appApi.deleteThread(t.id));
              }}>Delete</button>
            </li>
          ))}
        </ul>
      </section>
      <section className="panel">
        <h2>Keys</h2>
        {keys?.length === 0 && <p className="muted">No keys. Create one under Get started.</p>}
        <ul className="link-list">
          {keys?.map((k) => (
            <li key={k.name}>
              <span className="mono">{k.name}</span>{" "}
              <span className="muted">{k.last_used_at ? `last used ${new Date(k.last_used_at).toLocaleString()}` : "never used"}</span>{" "}
              <button className="btn btn-link btn-sm" disabled={busy} onClick={() => void act(() => appApi.revokeKey(k.name))}>Revoke</button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
