import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { CopyField } from "../components/CopyField.tsx";
import { setPendingQuestion } from "../chat/pending.ts";
import { appApi, AppError, errorText, type ConnectInfo, type Enrollment, type MintedKey, type Onboarding, type Step } from "./api.ts";
import { keySetups } from "./commands.ts";

const POLL_MS = 4000;
const ORDER: Step[] = ["connect", "fill", "ask", "done"];
const reached = (now: Step, step: Step) => ORDER.indexOf(now) > ORDER.indexOf(step);

/** Connect → fill → ask. Each step closes itself once the server has seen it happen. */
export function Wizard() {
  const [state, setState] = useState<Onboarding | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      setState(await appApi.onboarding());
      setError("");
    } catch (e) {
      setError(errorText(e));
    }
  }, []);
  useEffect(() => {
    void load();
    const t = window.setInterval(() => { void load(); }, POLL_MS);
    return () => window.clearInterval(t);
  }, [load]);

  if (!state) return error ? <div className="notice" role="alert">{error}</div> : <div aria-busy="true">Loading…</div>;
  return (
    <div>
      <div className="page-head">
        <div className="page-head-text">
          <h1 className="page-title">Get started</h1>
          <p className="muted">Three steps: connect your AI, give it something to remember, ask it.</p>
        </div>
      </div>
      {error && <div className="notice" role="alert">{error}</div>}
      <StepCard n={1} title="Connect Claude, ChatGPT or your editor" done={state.connected_at !== null} open={state.step === "connect"}>
        <ConnectStep />
      </StepCard>
      <StepCard n={2} title="Give it something to remember" done={state.first_write_at !== null} open={state.step === "fill"}>
        <FillStep demoLoaded={state.demo_loaded} onChange={load} />
      </StepCard>
      <StepCard n={3} title="Ask a question" done={state.first_answer_at !== null} open={state.step === "ask"}>
        <AskStep />
      </StepCard>
      {reached(state.step, "ask") && <div className="notice">All set. Your memory answers in Claude, ChatGPT and here under Ask.</div>}
    </div>
  );
}

function StepCard({ n, title, done, open, children }: { n: number; title: string; done: boolean; open: boolean; children: ReactNode }) {
  return (
    <details className="panel" open={open || undefined} style={{ marginBottom: 16 }}>
      <summary>
        <strong>{n}. {title}</strong>{" "}
        <span className={`badge ${done ? "badge-success" : "badge-read"}`}>{done ? "Done" : "To do"}</span>
      </summary>
      <div style={{ marginTop: 12 }}>{children}</div>
    </details>
  );
}

function ConnectStep() {
  const [info, setInfo] = useState<ConnectInfo | null>(null);
  const [code, setCode] = useState<Enrollment | null>(null);
  const [key, setKey] = useState<MintedKey | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    appApi.connect().then(setInfo).catch((e) => setError(errorText(e)));
  }, []);
  const run = async (fn: () => Promise<void>) => {
    setError("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  if (!info) return error ? <div className="error-text" role="alert">{error}</div> : null;
  return (
    <div>
      <h3>Claude.ai or ChatGPT</h3>
      <p className="muted">Add a custom connector with this URL and client ID, then enter the one-time code when it asks.</p>
      <CopyField label="Connector URL" value={info.mcp_url} />
      {info.client_id ? <CopyField label="Client ID" value={info.client_id} /> : <p className="muted">Not set up on this server yet: use a key below.</p>}
      {info.client_id && (
        <button className="btn btn-primary" disabled={busy} onClick={() => run(async () => setCode(await appApi.enrollment()))}>
          Get a code
        </button>
      )}
      {code && (
        <div style={{ marginTop: 8 }}>
          <CopyField label="One-time code (shown once)" value={code.code} />
          <p className="muted">Valid until {new Date(code.expires_at).toLocaleString()}. Getting a new code cancels this one.</p>
        </div>
      )}
      <h3 style={{ marginTop: 20 }}>Claude Code, Codex or Cursor</h3>
      <p className="muted">Create a key and paste the setup into your tool. The key is shown once.</p>
      <button className="btn btn-secondary" disabled={busy} onClick={() => run(async () => setKey(await appApi.mintKey("editor")))}>
        Create a key
      </button>
      {key && keySetups(info.mcp_url, key.token).map((s) => (
        <div key={s.client} style={{ marginTop: 12 }}>
          <div className="field-label">{s.client}: {s.where}</div>
          <CopyField label={`${s.client} setup`} value={s.text} multiline />
        </div>
      ))}
      {error && <div className="error-text" role="alert">{error}</div>}
      <p className="muted" style={{ marginTop: 12 }}>This step closes by itself as soon as your tool makes its first call.</p>
    </div>
  );
}

function FillStep({ demoLoaded, onChange }: { demoLoaded: boolean; onChange: () => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [held, setHeld] = useState<{ file: File; estimate: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const run = async (fn: () => Promise<string>) => {
    setError("");
    setNote("");
    setBusy(true);
    try {
      setNote(await fn());
      await onChange();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const importFile = (file: File, confirm: boolean) => run(async () => {
    try {
      const r = await appApi.importExport(file, confirm);
      setHeld(null);
      return `Imported ${r.sessions} conversation${r.sessions === 1 ? "" : "s"}.`;
    } catch (e) {
      if (e instanceof AppError && e.code === "import_over_cap") {
        setHeld({ file, estimate: Number(e.body.estimate_usd ?? 0) });
        return "";
      }
      throw e;
    }
  });

  return (
    <div>
      <h3>Paste a note</h3>
      <label className="field">
        <span className="field-label">Title (optional)</span>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
      </label>
      <label className="field">
        <span className="field-label">Text</span>
        <textarea className="input" rows={5} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <button className="btn btn-primary" disabled={busy || text.trim() === ""} onClick={() => run(async () => {
        await appApi.paste(title, text);
        setText("");
        setTitle("");
        return "Saved.";
      })}>Save note</button>

      <h3 style={{ marginTop: 20 }}>Or import your ChatGPT or Claude history</h3>
      <p className="muted">Export your data from ChatGPT or Claude and choose conversations.json. The file is read once and not kept.</p>
      <input ref={fileRef} type="file" accept="application/json,.json" disabled={busy} onChange={(e) => {
        const f = e.target.files?.[0];
        if (f) void importFile(f, false);
        e.target.value = "";
      }} />
      {held && (
        <div className="notice" style={{ marginTop: 8 }}>
          This import costs about ${held.estimate.toFixed(2)} to index, more than the usual limit.{" "}
          <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void importFile(held.file, true)}>Import anyway</button>{" "}
          <button className="btn btn-link btn-sm" onClick={() => setHeld(null)}>Cancel</button>
        </div>
      )}

      <h3 style={{ marginTop: 20 }}>Or try it with demo data</h3>
      <p className="muted">A small made-up company: people, projects, meetings. Only you see it, and one click removes all of it.</p>
      {demoLoaded ? (
        <button className="btn btn-secondary" disabled={busy} onClick={() => run(async () => {
          await appApi.removeDemo();
          return "Demo data removed.";
        })}>Remove demo data</button>
      ) : (
        <button className="btn btn-secondary" disabled={busy} onClick={() => run(async () => {
          const r = await appApi.loadDemo();
          return `Loaded ${r.pages} demo pages. Ask about the Beacon project.`;
        })}>Load demo data</button>
      )}
      {note && <p role="status">{note}</p>}
      {error && <div className="error-text" role="alert">{error}</div>}
    </div>
  );
}

function AskStep() {
  const ask = (q: string) => {
    setPendingQuestion(q);
    window.location.hash = "#ask";
  };
  return (
    <div>
      <p className="muted">Ask about what you just added. The answer cites the pages it used.</p>
      <button className="btn btn-primary" onClick={() => ask("What do my notes say, in three bullet points?")}>Ask about my notes</button>{" "}
      <button className="btn btn-secondary" onClick={() => ask("Who leads the Beacon project, and what is it waiting on?")}>Ask about the demo</button>
    </div>
  );
}
