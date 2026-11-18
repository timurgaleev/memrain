// The words the Ask page shows: trace steps, costs, and one line for every
// outcome code the chat API can return. No DOM.

import type { AnswerStatus, TraceEvent } from "./events.ts";

/** Chat answers cost fractions of a cent, so four decimals; unknown is never shown as $0. */
export function fmtCost(usd: number | null | undefined): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return "price unknown";
  if (usd === 0) return "$0";
  if (usd < 0.0001) return "<$0.0001";
  return usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`;
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function traceLabel(t: TraceEvent): string {
  switch (t.step) {
    case "condense": return "Rewrote the follow-up as a full question";
    case "intent": return "Worked out what you are asking";
    case "gather": return t.count === undefined ? "Searched memory" : `Searched memory, found ${t.count}`;
    case "reserve": return t.usd === undefined ? "Set money aside for the answer" : `Set aside up to ${fmtCost(t.usd)} for the answer`;
    case "model_start": return "Asked the model";
    case "model_end": return "The model answered";
    case "citations": return t.count === undefined ? "Checked the sources" : `Checked ${plural(t.count, "source", "sources")}`;
    case "quote_check": return "Checked quotes against the pages";
    case "settle": return t.usd === undefined ? "Booked the cost" : `Final cost ${fmtCost(t.usd)}`;
    default: return t.step;
  }
}

/** One line for a finished turn: how many places were searched, and what it cost. */
export function traceSummary(trace: TraceEvent[], costUsd: number | null): string {
  const places = trace.filter((t) => t.step === "gather").length;
  const settled = [...trace].reverse().find((t) => t.step === "settle" && t.usd !== undefined)?.usd;
  const cost = costUsd ?? settled ?? null;
  if (places === 0 && cost === null) return "No search steps recorded";
  const parts = [`Searched ${plural(places, "place", "places")}`];
  if (cost !== null) parts.push(fmtCost(cost));
  return parts.join(" · ");
}

/** The outcome code an answer status stands for; null for a normal answer. */
export function answerOutcome(status: AnswerStatus, code: string | null): string | null {
  switch (status) {
    case "ok": return null;
    case "refused": return "refused";
    case "budget": return "budget_exhausted";
    case "disabled": return "chat_disabled";
    case "error": return code || "provider_error";
  }
}

export interface OutcomeCopy {
  title: string;
  detail: string;
  /** Asking the same question again may work. */
  retry: boolean;
  /** Point at the Spend page. */
  spendLink: boolean;
  /** Explain how to switch chat on. */
  enableHint: boolean;
}

const COPY: Record<string, Omit<OutcomeCopy, "spendLink" | "enableHint"> & Partial<OutcomeCopy>> = {
  refused: { title: "Your memory has no answer to this", detail: "Nothing it holds supports an answer. The pages it looked at are listed below.", retry: false },
  budget_exhausted: {
    title: "Today's chat spending limit is used up",
    detail: "The daily limit resets at 00:00 UTC.",
    retry: false, spendLink: true,
  },
  chat_disabled: { title: "Ask is switched off on this server", detail: "No model was called and nothing was charged.", retry: false, enableHint: true },
  timeout: { title: "The model took too long to answer", detail: "Try again in a moment.", retry: true },
  rate_limited: { title: "The model is busy right now", detail: "The provider asked us to slow down. Try again in a minute.", retry: true },
  network: { title: "The model could not be reached", detail: "A network problem stopped the call. Try again.", retry: true },
  provider_error: { title: "The model returned an error", detail: "No answer was saved. Try again, or pick another model.", retry: true },
  invalid_params: { title: "The server refused this question", detail: "Check that the question is not empty or too long, and that the model is still on the list.", retry: false },
  db_busy: { title: "Memory is busy right now", detail: "The search could not finish. Try again in a moment.", retry: true },
  unconfirmed: {
    title: "The connection closed before the server confirmed this answer",
    detail: "It may not have been kept. Ask again to be sure.",
    retry: true,
  },
  stream_closed: { title: "The connection closed before an answer arrived", detail: "Try again. If it keeps happening, check that the server is running.", retry: true },
};

export function outcomeCopy(code: string): OutcomeCopy {
  const c = COPY[code] ?? { title: "Something went wrong", detail: "The answer did not arrive. Try again.", retry: true };
  return { spendLink: false, enableHint: false, ...c };
}

export function overCap(estimateUsd: number | null, capUsd: number | null): boolean {
  return estimateUsd !== null && capUsd !== null && estimateUsd > capUsd;
}

const MAX_TOPIC = 80;

/** Up to three starter questions from recent page titles; no model involved. */
export function exampleQuestions(events: ReadonlyArray<{ summary: string; slug: string | null }>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of events) {
    const topic = e.summary.replace(/\s+/g, " ").trim();
    if (topic === "" || seen.has(topic.toLowerCase())) continue;
    seen.add(topic.toLowerCase());
    const short = topic.length > MAX_TOPIC ? `${topic.slice(0, MAX_TOPIC - 1)}…` : topic;
    out.push(`What do I know about ${short}?`);
    if (out.length === 3) break;
  }
  return out;
}
