import { useCallback, useEffect, useRef, useState } from "react";
import { createSseParser } from "./sse.ts";
import { toChatEvent } from "./events.ts";
import type { Answer, TraceEvent } from "./events.ts";

// One question in flight at a time. The question is POSTed and the answer
// read back as text/event-stream from the response body (EventSource cannot
// POST). Stop, a newer turn, and leaving the page all abort the request, which
// closes the stream so the server can release the money it set aside.

/**
 * streaming: waiting (an answer may already be on screen, unconfirmed);
 * answered: the answer arrived and the server closed the turn with done.
 */
export type TurnPhase = "streaming" | "answered" | "failed" | "stopped";

export interface LiveTurn {
  seq: number;
  question: string;
  /** The thread the question was asked in; null starts a new one. */
  threadId: string | null;
  model: string | null;
  phase: TurnPhase;
  trace: TraceEvent[];
  answer: Answer | null;
  /** Outcome code when the turn failed without an answer. */
  error: string | null;
}

/** The thread a turn belongs to once the server has named it. */
export const turnThread = (t: LiveTurn): string | null => t.answer?.thread_id ?? t.threadId;

const MAX_STEPS = 60;

/** The outcome code for a POST the server refused before streaming. */
export function refusalCode(status: number, body: unknown): string {
  const code = body && typeof body === "object" ? (body as { error?: unknown; code?: unknown }).error ?? (body as { code?: unknown }).code : undefined;
  if (typeof code === "string" && code !== "") return code;
  if (status === 429) return "rate_limited";
  if (status === 400) return "invalid_params";
  return `http_${status}`;
}

export function useChatStream(opts: { onAnswer?: (a: Answer) => void; onDone?: () => void } = {}) {
  const [turn, setTurn] = useState<LiveTurn | null>(null);
  const [busy, setBusy] = useState(false);
  // A ref, not state: two clicks in the same tick must not both pass.
  const busyRef = useRef(false);
  const ctrl = useRef<AbortController | null>(null);
  const seq = useRef(0);
  const cbs = useRef(opts);
  cbs.current = opts;

  useEffect(() => () => ctrl.current?.abort(), []);

  const run = useCallback(async (c: AbortController, mine: number, body: Record<string, string>) => {
    const update = (fn: (t: LiveTurn) => LiveTurn) => setTurn((t) => (t && t.seq === mine ? fn(t) : t));
    const fail = (code: string) => update((t) => ({ ...t, phase: "failed", error: code }));
    let answered = false;
    let failed = false;
    try {
      const res = await fetch("/admin/api/chat", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify(body),
        signal: c.signal,
      });
      if (res.status === 401) {
        window.location.hash = "#login";
        return fail("unauthorized");
      }
      if (!res.ok || !res.body || !(res.headers.get("Content-Type") ?? "").startsWith("text/event-stream")) {
        return fail(refusalCode(res.status, await res.json().catch(() => ({}))));
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let done = false;
      const parser = createSseParser((m) => {
        // Chunks already buffered when the turn was stopped or replaced are dropped.
        if (c.signal.aborted) return;
        const e = toChatEvent(m);
        if (!e) return;
        if (e.type === "trace") {
          update((t) => (t.trace.length >= MAX_STEPS ? t : { ...t, trace: [...t.trace, e.trace] }));
        } else if (e.type === "answer") {
          answered = true;
          update((t) => ({ ...t, answer: e.answer }));
          cbs.current.onAnswer?.(e.answer);
        } else if (e.type === "error") {
          // An error after the answer keeps the text on screen but marks the
          // turn failed: the server may not have kept that answer.
          failed = true;
          fail(e.error.code);
        } else {
          done = true;
        }
      });
      while (!done) {
        const { value, done: ended } = await reader.read();
        if (ended) break;
        parser.push(value);
      }
      parser.end();
      if (done) await reader.cancel().catch(() => undefined);
      if (c.signal.aborted) throw new DOMException("aborted", "AbortError");
      if (failed) return;
      // Only done confirms an answer; a stream that ends without it leaves the answer unconfirmed.
      if (!answered) return fail("stream_closed");
      if (!done) return fail("unconfirmed");
      update((t) => ({ ...t, phase: "answered" }));
      cbs.current.onDone?.();
    } catch {
      if (c.signal.aborted) {
        update((t) => (t.phase === "failed" ? t : { ...t, phase: "stopped" }));
      } else if (!failed) {
        fail(answered ? "unconfirmed" : "network");
      }
    }
  }, []);

  /** Starts a turn; false (and no request) while another is in flight. */
  const send = useCallback((question: string, threadId: string | null, model: string | null): boolean => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    const c = new AbortController();
    ctrl.current = c;
    const mine = ++seq.current;
    setTurn({ seq: mine, question, threadId, model, phase: "streaming", trace: [], answer: null, error: null });
    const body: Record<string, string> = { message: question };
    if (threadId) body.thread_id = threadId;
    if (model) body.model = model;
    void run(c, mine, body).finally(() => {
      if (ctrl.current !== c) return;
      ctrl.current = null;
      busyRef.current = false;
      setBusy(false);
    });
    return true;
  }, [run]);

  const stop = useCallback(() => ctrl.current?.abort(), []);

  /** Forgets the turn on screen, closing its stream if it is still open. */
  const clear = useCallback(() => {
    ctrl.current?.abort();
    ctrl.current = null;
    busyRef.current = false;
    setBusy(false);
    seq.current += 1;
    setTurn(null);
  }, []);

  return { turn, busy, send, stop, clear };
}
