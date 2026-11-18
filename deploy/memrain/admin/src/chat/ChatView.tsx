import React, { useEffect, useId, useRef, useState } from "react";
import { tool } from "../api.ts";
import { useAsync, useNow } from "../hooks.ts";
import { Markdown } from "../components/Markdown.tsx";
import { PageIntro } from "../components/PageIntro.tsx";
import { ApiError } from "../lib/passkey-fetch.ts";
import { buildHash } from "../lib/route.ts";
import { parseChronicle } from "../lib/tool-result.ts";
import { chatApi } from "./chat-api.ts";
import { answerOutcome, exampleQuestions, outcomeCopy } from "./copy.ts";
import type { AnswerStatus, ChatMessage, Citation, ModelsReport, ThreadSummary, TraceEvent } from "./events.ts";
import { CitationChip } from "./CitationChip.tsx";
import { CostBadge } from "./CostBadge.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { onPendingQuestion, takePendingQuestion } from "./pending.ts";
import { chatErrorText, ThreadList } from "./ThreadList.tsx";
import { TraceTimeline } from "./TraceTimeline.tsx";
import { turnThread, useChatStream } from "./useChatStream.ts";
import type { LiveTurn } from "./useChatStream.ts";

const go = (threadId: string | null) => {
  window.location.hash = buildHash({ name: "ask", param: threadId });
};

/** The model to send: the operator's pick, else the server default, else the first priced one. */
function effectiveModel(report: ModelsReport | null, picked: string | null): string | null {
  const ids = report?.models.map((m) => m.id) ?? [];
  if (picked && ids.includes(picked)) return picked;
  if (report?.default && ids.includes(report.default)) return report.default;
  return ids[0] ?? null;
}

export function ChatView({ threadId }: { threadId: string | null }) {
  const now = useNow(30_000);
  const models = useAsync((s) => chatApi.models(s), []);
  const threads = useAsync((s) => chatApi.threads(s), []);
  const thread = useAsync((s) => chatApi.thread(threadId ?? "", s), [threadId], { enabled: threadId !== null });
  // While the model list loads nothing is sent; if it cannot load, sending is
  // allowed and the server answers chat_disabled itself when chat is off.
  const enabled = models.data ? models.data.enabled : models.status === "error";
  const examples = useAsync(async (s) => {
    const since = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
    return exampleQuestions(parseChronicle(await tool("chronicle_since", { since, limit: 20 }, s)));
  }, [], { enabled: threadId === null && enabled });

  const [text, setText] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [drawer, setDrawer] = useState(false);
  const threadRef = useRef(threadId);
  threadRef.current = threadId;
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const turnRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const drawerId = useId();

  const stream = useChatStream({
    onAnswer: (a) => {
      // A first question creates its thread; move to it so a reload keeps the conversation.
      if (a.thread_id !== threadRef.current) go(a.thread_id);
      threads.reload();
    },
    onDone: () => {
      if (threadRef.current) thread.reload();
    },
  });
  const liveTurn = stream.turn;
  const liveRef = useRef(liveTurn);
  liveRef.current = liveTurn;

  // Opening another conversation drops the turn on screen and closes its stream.
  useEffect(() => {
    const t = liveRef.current;
    if (t && turnThread(t) !== threadId) stream.clear();
    setDrawer(false);
  }, [threadId]);

  useEffect(() => {
    const fill = () => {
      const q = takePendingQuestion();
      if (q === null) return;
      setText(q);
      boxRef.current?.focus();
    };
    fill();
    return onPendingQuestion(fill);
  }, []);

  useEffect(() => {
    if (liveTurn?.phase === "streaming") turnRef.current?.scrollIntoView({ block: "nearest" });
  }, [liveTurn?.seq]);

  useEffect(() => {
    if (!drawer) return;
    drawerRef.current?.querySelector<HTMLElement>("a, button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      closeDrawer();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawer]);

  function closeDrawer() {
    setDrawer(false);
    toggleRef.current?.focus();
  }

  // While the drawer covers the page, Tab cycles inside it.
  const trapTab = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const items = drawerRef.current?.querySelectorAll<HTMLElement>("a[href], button:not([disabled])");
    if (!items || items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  const model = effectiveModel(models.data, picked);
  const canSend = enabled && !stream.busy && text.trim() !== "";

  const submit = () => {
    const q = text.trim();
    if (!enabled || q === "") return;
    if (stream.send(q, threadId, model)) setText("");
  };
  const retry = (t: LiveTurn) => { stream.send(t.question, turnThread(t), model); };
  const startNew = () => {
    setDrawer(false);
    stream.clear();
    setText("");
    go(null);
    boxRef.current?.focus();
  };
  const deleteThread = async (t: ThreadSummary) => {
    await chatApi.deleteThread(t.id);
    if (t.id === threadId) {
      stream.clear();
      go(null);
    }
    threads.reload();
  };
  const markSaved = (messageId: string, slug: string) => setSaved((s) => ({ ...s, [messageId]: slug }));

  const stored: ChatMessage[] = threadId !== null && thread.data ? thread.data.messages : [];
  // A confirmed turn gives way to its stored copy once the thread reloads. An
  // unconfirmed or failed one stays on screen with its warning, and its stored
  // copy is held back so it cannot be saved from there.
  const liveId = liveTurn?.answer?.message_id ?? null;
  const turnStored = liveId !== null && stored.some((m) => m.id === liveId);
  const confirmed = liveTurn?.phase === "answered";
  const history = turnStored && !confirmed ? withoutTurn(stored, liveId) : stored;
  const showTurn = liveTurn !== null && !(turnStored && confirmed);
  const threadMissing = threadId !== null && thread.status === "error" && thread.error instanceof ApiError && thread.error.status === 404;
  const blank = threadId === null && !showTurn;

  return (
    <>
      <div className="page-head">
        <div className="page-head-text">
          <h1 className="page-title">Ask</h1>
          <PageIntro>
            Ask a question and get an answer written only from your own pages, with numbered sources you can open. You see
            each search step and what the answer cost.
          </PageIntro>
        </div>
        <button
          ref={toggleRef}
          className="btn btn-secondary btn-sm chat-threads-toggle"
          aria-expanded={drawer}
          aria-controls={drawerId}
          onClick={() => setDrawer((d) => !d)}
        >
          Conversations
        </button>
      </div>

      {models.data && !models.data.enabled && <DisabledNote />}

      <div className="chat">
        {drawer && <div className="chat-backdrop" aria-hidden="true" onClick={closeDrawer} />}
        <nav
          ref={drawerRef}
          id={drawerId}
          className={drawer ? "chat-threads open" : "chat-threads"}
          aria-label="Conversations"
          onKeyDown={drawer ? trapTab : undefined}
        >
          <ThreadList state={threads} activeId={threadId} now={now} onNew={startNew} onDelete={deleteThread} />
        </nav>

        <section className="chat-main" aria-label="Conversation">
          {threadId !== null && thread.data === null && thread.status === "loading" && (
            <div className="skeleton" aria-busy="true" aria-label="Loading the conversation"><span /><span /><span /></div>
          )}
          {threadMissing && (
            <div className="empty-note">
              <p>This conversation does not exist, or it is not yours.</p>
              <button className="btn-link" onClick={startNew}>Ask a new question</button>
            </div>
          )}
          {threadId !== null && thread.status === "error" && !threadMissing && (
            <div className="tile-error">
              <span>{chatErrorText(thread.error)}</span>
              <button className="btn-link" onClick={thread.reload}>Retry</button>
            </div>
          )}

          {blank && (
            <div className="chat-blank">
              <h2 className="chat-blank-title">What do you want to know?</h2>
              <p className="chat-blank-text">
                The answer is written from what your memory holds and nothing else. If it holds nothing on the question,
                it says so instead of guessing.
              </p>
              {examples.data && examples.data.length > 0 && (
                <div className="chat-examples" role="group" aria-label="Starter questions from recent pages">
                  {examples.data.map((q) => (
                    <button key={q} className="chat-example" onClick={() => { setText(q); boxRef.current?.focus(); }}>{q}</button>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="chat-log">
            {history.map((m) => m.role === "user"
              ? <Question key={m.id} text={m.content} />
              : (
                <AnswerView
                  key={m.id}
                  messageId={m.id}
                  status={m.status ?? "ok"}
                  code={null}
                  text={m.content}
                  citations={m.citations}
                  gaps={m.gaps}
                  model={m.model}
                  costUsd={m.cost_usd}
                  durationMs={null}
                  trace={m.trace}
                  savedSlug={saved[m.id] ?? m.saved_slug}
                  onSaved={markSaved}
                />
              ))}
            {showTurn && liveTurn && (
              <div ref={turnRef} className="chat-turn">
                <Question text={liveTurn.question} />
                <LiveAnswer turn={liveTurn} saved={saved} onSaved={markSaved} onRetry={() => retry(liveTurn)} />
              </div>
            )}
          </div>

          <Composer
            boxRef={boxRef}
            text={text}
            onText={setText}
            onSubmit={submit}
            onStop={stream.stop}
            busy={stream.busy}
            canSend={canSend}
            disabled={!enabled}
            picker={models.data && models.data.enabled
              ? <ModelPicker report={models.data} value={model} onChange={setPicked} disabled={stream.busy} />
              : null}
          />
        </section>
      </div>
    </>
  );
}

/** The stored messages minus one assistant answer and the question just before it. */
function withoutTurn(messages: ChatMessage[], answerId: string | null): ChatMessage[] {
  const i = messages.findIndex((m) => m.id === answerId);
  if (i === -1) return messages;
  const from = i > 0 && messages[i - 1]?.role === "user" ? i - 1 : i;
  return [...messages.slice(0, from), ...messages.slice(i + 1)];
}

function DisabledNote() {
  const c = outcomeCopy("chat_disabled");
  return (
    <div className="warning-bar" role="status">
      <strong>{c.title}.</strong> To turn it on, set <code>MEMRAIN_CHAT=1</code> in the server's <code>.env</code> and restart
      Memrain. Each answer then costs a little money, inside the per-answer and daily caps.
    </div>
  );
}

function Question({ text }: { text: string }) {
  return (
    <div className="chat-q">
      <span className="sr-only">You asked: </span>
      <span>{text}</span>
    </div>
  );
}

function LiveAnswer({ turn, saved, onSaved, onRetry }: {
  turn: LiveTurn;
  saved: Record<string, string>;
  onSaved: (messageId: string, slug: string) => void;
  onRetry: () => void;
}) {
  if (turn.answer) {
    const a = turn.answer;
    // Saving waits for done; a turn stopped or broken after its answer shows why.
    const problem = turn.phase === "failed" ? turn.error ?? "unconfirmed" : turn.phase === "stopped" ? "unconfirmed" : null;
    return (
      <>
      <AnswerView
        messageId={a.message_id}
        status={a.status}
        code={a.code}
        text={a.answer}
        citations={a.citations}
        gaps={a.gaps}
        model={a.model}
        costUsd={a.cost_usd}
        durationMs={a.duration_ms}
        trace={turn.trace}
        savedSlug={saved[a.message_id] ?? null}
        onSaved={onSaved}
        onRetry={onRetry}
        canSave={turn.phase === "answered"}
        live
      />
      {problem && <Outcome code={problem} pages={[]} onRetry={onRetry} live />}
      </>
    );
  }
  return (
    <div className="chat-a" aria-busy={turn.phase === "streaming"}>
      <TraceTimeline trace={turn.trace} live={turn.phase === "streaming"} costUsd={null} />
      {turn.phase === "streaming" && (
        <div className="skeleton chat-a-skeleton" aria-hidden="true"><span /><span /><span /></div>
      )}
      {turn.phase === "stopped" && (
        <div className="chat-outcome" role="status">
          <p className="chat-outcome-title">Stopped before the answer arrived.</p>
          <button className="btn btn-secondary btn-sm" onClick={onRetry}>Ask again</button>
        </div>
      )}
      {turn.phase === "failed" && <Outcome code={turn.error ?? "stream_closed"} pages={[]} onRetry={onRetry} live />}
    </div>
  );
}

/** Slugs the turn looked at: its citations first, then what the search steps reported. */
function pagesLookedAt(citations: Citation[], trace: TraceEvent[]): string[] {
  const out = new Set(citations.map((c) => c.slug));
  for (const t of trace) for (const s of t.slugs ?? []) out.add(s);
  return [...out];
}

function Outcome({ code, pages, onRetry, live = false }: { code: string; pages: string[]; onRetry?: () => void; live?: boolean }) {
  const c = outcomeCopy(code);
  return (
    <div className={code === "refused" ? "chat-outcome" : "chat-outcome chat-outcome-problem"} role={live ? "alert" : undefined}>
      <p className="chat-outcome-title">{c.title}</p>
      <p className="chat-outcome-detail">
        {c.detail}
        {c.spendLink && <> <a href="#spend">Open Spend</a> for today's totals and caps.</>}
        {c.enableHint && <> To turn it on, set <code>MEMRAIN_CHAT=1</code> in the server's <code>.env</code> and restart Memrain.</>}
      </p>
      {code === "refused" && pages.length > 0 && (
        <ul className="chat-looked">
          {pages.map((s) => <li key={s}><a className="mono" href={buildHash({ name: "page", param: s })}>{s}</a></li>)}
        </ul>
      )}
      {live && c.retry && onRetry && <button className="btn btn-secondary btn-sm" onClick={onRetry}>Try again</button>}
    </div>
  );
}

function AnswerView(p: {
  messageId: string;
  status: AnswerStatus;
  code: string | null;
  text: string;
  citations: Citation[];
  gaps: string[];
  model: string | null;
  costUsd: number | null;
  durationMs: number | null;
  trace: TraceEvent[];
  savedSlug: string | null;
  onSaved: (messageId: string, slug: string) => void;
  onRetry?: () => void;
  /** False when the stream failed after this answer arrived: the server may not have kept it. */
  canSave?: boolean;
  live?: boolean;
}) {
  const outcome = answerOutcome(p.status, p.code);
  return (
    <div className="chat-a">
      <TraceTimeline trace={p.trace} live={false} costUsd={p.costUsd} />
      {outcome === null ? (
        <>
          <div className="chat-answer">
            {p.text.trim() === "" ? <p className="muted">The model returned an empty answer.</p> : <Markdown source={p.text} />}
          </div>
          {p.gaps.length > 0 && <p className="chat-gaps"><strong>Not found:</strong> {p.gaps.join("; ")}</p>}
          {p.citations.length > 0 && (
            <ol className="chat-sources" aria-label="Sources">
              {p.citations.map((c) => <li key={`${c.n}:${c.slug}`}><CitationChip citation={c} /></li>)}
            </ol>
          )}
          <div className="chat-a-foot">
            <CostBadge costUsd={p.costUsd} model={p.model} durationMs={p.durationMs} />
            {p.canSave !== false && <SaveAnswer messageId={p.messageId} savedSlug={p.savedSlug} onSaved={p.onSaved} />}
          </div>
        </>
      ) : (
        <>
          <Outcome code={outcome} pages={pagesLookedAt(p.citations, p.trace)} onRetry={p.onRetry} live={p.live} />
          {outcome === "refused" && p.gaps.length > 0 && <p className="chat-gaps"><strong>Not found:</strong> {p.gaps.join("; ")}</p>}
        </>
      )}
    </div>
  );
}

function SaveAnswer({ messageId, savedSlug, onSaved }: { messageId: string; savedSlug: string | null; onSaved: (id: string, slug: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (savedSlug) {
    return (
      <span className="chat-saved">
        Saved as <a className="mono" href={buildHash({ name: "page", param: savedSlug })}>{savedSlug}</a>
      </span>
    );
  }
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      onSaved(messageId, await chatApi.save(messageId));
    } catch (e) {
      setError(chatErrorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="chat-save">
      <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save as page"}</button>
      {error && <span className="error-text small" role="alert">{error}</span>}
    </span>
  );
}

function Composer({ boxRef, text, onText, onSubmit, onStop, busy, canSend, disabled, picker }: {
  boxRef: React.RefObject<HTMLTextAreaElement | null>;
  text: string;
  onText: (t: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  busy: boolean;
  canSend: boolean;
  disabled: boolean;
  picker: React.ReactNode;
}) {
  const id = useId();
  const hintId = useId();
  return (
    <form className="chat-composer" onSubmit={(e) => { e.preventDefault(); if (!busy) onSubmit(); }}>
      <label htmlFor={id} className="chat-composer-label">Question</label>
      <textarea
        ref={boxRef}
        id={id}
        className="chat-input"
        rows={3}
        value={text}
        onChange={(e) => onText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
          e.preventDefault();
          if (!busy) onSubmit();
        }}
        placeholder="Ask what your memory knows…"
        aria-describedby={hintId}
        disabled={disabled}
      />
      <div className="chat-composer-bar">
        {picker}
        <span id={hintId} className="chat-composer-hint">Enter sends, Shift+Enter adds a line</span>
        {/* Separate keys: Stop settles the stream before its click finishes, and a
            reused node that had become a submit button would send the box again. */}
        {busy
          ? <button key="stop" type="button" className="btn btn-secondary" onClick={onStop}>Stop</button>
          : <button key="send" type="submit" className="btn btn-primary" disabled={!canSend}>Send</button>}
      </div>
    </form>
  );
}
