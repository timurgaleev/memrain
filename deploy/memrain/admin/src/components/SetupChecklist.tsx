import React, { useEffect, useId, useRef, useState } from "react";
import { api } from "../api.ts";
import { describeError, useAsync, useNow } from "../hooks.ts";
import type { OnboardingStatus } from "../admin-types.ts";
import { buildSnippets, checklistProgress } from "../lib/onboarding.ts";
import { nextTab } from "../lib/tabs.ts";
import { browserStorage } from "../lib/range.ts";
import { fmtAgo } from "../lib/format.ts";
import { CopyField } from "./CopyField.tsx";

const DISMISS_KEY = "memrain.admin.setup.dismissed";
const POLL_MS = 30_000;
const POLL_FOR_MS = 10 * 60_000;
const TIMEOUT_MS = 10_000;

async function loadOnboarding(signal: AbortSignal): Promise<OnboardingStatus> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  try {
    return (await api.onboarding(AbortSignal.any([signal, timeout]))) as OnboardingStatus;
  } catch (e) {
    if (timeout.aborted && !signal.aborted) throw new Error("The server did not answer within 10 seconds.");
    throw e;
  }
}

function readDismissed(): boolean {
  try {
    return browserStorage()?.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function CheckIcon({ done }: { done: boolean }) {
  return (
    <svg className={`step-icon${done ? " step-icon-done" : ""}`} viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
      <circle cx="10" cy="10" r="8.5" />
      {done && <path d="M6 10.4 8.7 13 14 7.5" />}
    </svg>
  );
}

const TABS = ["Claude Code", "claude.ai", "ChatGPT"] as const;

function ConnectTabs({ mcpUrl }: { mcpUrl: string }) {
  const [sel, setSel] = useState(0);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const base = useId();
  const s = buildSnippets(mcpUrl);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const n = nextTab(e.key, sel, TABS.length);
    if (n === null) return;
    e.preventDefault();
    setSel(n);
    tabs.current[n]?.focus();
  };

  return (
    <div className="conn">
      <div className="tabs conn-tabs" role="tablist" aria-label="Connect an agent" onKeyDown={onKeyDown}>
        {TABS.map((t, i) => (
          <button
            key={t}
            ref={(el) => { tabs.current[i] = el; }}
            type="button"
            role="tab"
            id={`${base}-tab-${i}`}
            className={`tab${i === sel ? " active" : ""}`}
            aria-selected={i === sel}
            aria-controls={`${base}-panel-${i}`}
            tabIndex={i === sel ? 0 : -1}
            onClick={() => setSel(i)}
          >
            {t}
          </button>
        ))}
      </div>
      {TABS.map((t, i) => (
        <div key={t} role="tabpanel" id={`${base}-panel-${i}`} aria-labelledby={`${base}-tab-${i}`} tabIndex={0} hidden={i !== sel} className="conn-panel">
          {i === 0 && (
            <>
              <p>Create a personal access token on the <a href="#agents">Agents</a> page, then run this with the token in place of <code>&lt;PAT&gt;</code>:</p>
              <CopyField value={s.claudeCode} label="Claude Code command" multiline />
            </>
          )}
          {i === 1 && <ol className="conn-steps">{s.claudeAi.map((x) => <li key={x}>{x}</li>)}</ol>}
          {i === 2 && <ol className="conn-steps">{s.chatgpt.map((x) => <li key={x}>{x}</li>)}</ol>}
          <p className="hint">Click paths change often; docs/clients in the repository has the full guide.</p>
        </div>
      ))}
    </div>
  );
}

interface StepProps { done: boolean; title: string; meta?: React.ReactNode; open: boolean; children: React.ReactNode }

function Step({ done, title, meta, open, children }: StepProps) {
  return (
    <li className={`step${done ? " step-done" : ""}`}>
      <CheckIcon done={done} />
      <div className="step-body">
        <div className="step-title">
          <span>{title}</span>
          {done && <span className="sr-only">(done)</span>}
          {meta && <span className="step-meta">{meta}</span>}
        </div>
        {open && <div className="step-detail">{children}</div>}
      </div>
    </li>
  );
}

// The four first-run steps, each ticked from real activity on the brain. On
// the Overview it shows until every step is done or it is dismissed; `force`
// (the #setup page) always shows it in full.
export function SetupChecklist({ force = false }: { force?: boolean }) {
  const now = useNow(15_000);
  const status = useAsync<OnboardingStatus>(loadOnboarding, []);
  const [dismissed, setDismissed] = useState(readDismissed);
  const [pollStart, setPollStart] = useState(() => Date.now());
  const progress = status.data ? checklistProgress(status.data) : null;
  const polling = progress !== null && !progress.complete && now - pollStart < POLL_FOR_MS;
  const { reload } = status;

  useEffect(() => {
    if (!polling) return;
    const t = setInterval(() => { if (!document.hidden) reload(); }, POLL_MS);
    return () => clearInterval(t);
  }, [polling, reload]);

  if (!force && dismissed) return null;
  if (!force && progress?.complete) return null;

  const dismiss = () => {
    try {
      browserStorage()?.setItem(DISMISS_KEY, "1");
    } catch { /* hidden for this visit only */ }
    setDismissed(true);
  };
  const checkAgain = () => { setPollStart(Date.now()); reload(); };

  if (status.data === null) {
    if (status.status === "error") {
      return (
        <section className="panel setup" aria-label="Get started">
          <div className="tile-error">
            <span>Could not check your setup: {describeError(status.error)}</span>
            <button className="btn-link" onClick={reload}>Retry</button>
          </div>
        </section>
      );
    }
    return force ? <section className="panel setup"><div className="skeleton" aria-busy="true" aria-label="Loading"><span /><span /><span /></div></section> : null;
  }

  const d = status.data;
  const p = progress as NonNullable<typeof progress>;
  const st = d.steps;
  const firstOpen = [st.credential.done, st.agent_connected.done, st.first_page.done, st.first_search.done].indexOf(false);
  const isOpen = (i: number) => force || i === firstOpen;

  return (
    <section className="panel setup" aria-labelledby="setup-title">
      <header className="setup-head">
        <div>
          <h2 id="setup-title" className="setup-title">Get started</h2>
          <p className="setup-sub">Four steps get you started. Each one ticks itself when it happens.</p>
        </div>
        <div className="setup-progress" aria-label={`${p.done} of ${p.total} steps done`}>
          <span className="mono">{p.done}/{p.total}</span>
          <span className="bar"><span className="bar-fill" style={{ width: `${(p.done / p.total) * 100}%` }} /></span>
        </div>
      </header>
      <ol className="steps">
        <Step done={st.credential.done} title="Create a credential" open={isOpen(0)}>
          <p>An agent needs a credential to reach the brain: a personal access token for a CLI, or an OAuth client for claude.ai and ChatGPT. Brains that use a single shared bearer token can skip this step.</p>
          <a className="btn btn-secondary btn-sm" href="#agents">Open Agents</a>
        </Step>
        <Step
          done={st.agent_connected.done}
          title="Connect an agent"
          meta={st.agent_connected.last_seen ? `last seen ${fmtAgo(st.agent_connected.last_seen, now)}` : undefined}
          open={isOpen(1)}
        >
          <p>Point the agent at this address:</p>
          <CopyField value={d.mcp_url} label="MCP server address" />
          {!d.public_url_set && (
            <p className="hint">This address comes from your browser. The server setting <code>MEMRAIN_PUBLIC_URL</code> gives agents the public address; if someone else runs your brain, ask them to set it.</p>
          )}
          <ConnectTabs mcpUrl={d.mcp_url} />
        </Step>
        <Step done={st.first_page.done} title="Write your first page" open={isOpen(2)}>
          <p>Ask your agent to save something, for example: “Remember that our launch is on Friday.” It will write a page.</p>
        </Step>
        <Step
          done={st.first_search.done}
          title="Run a first search"
          meta={st.first_search.source === "any" ? "A search has run on the brain." : undefined}
          open={isOpen(3)}
        >
          <p>Ask your agent a question about what it saved. Searches can take a minute to show here.</p>
        </Step>
      </ol>
      <footer className="setup-foot">
        <span className="muted">Verify a connection: ask your agent to call memrain’s <code>whoami</code> tool.</span>
        <span className="setup-actions">
          {!polling && !p.complete && <button className="btn-link" onClick={checkAgain}>Check again</button>}
          {!force && <button className="btn-link" onClick={dismiss}>Dismiss</button>}
        </span>
      </footer>
    </section>
  );
}
