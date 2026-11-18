// Shapes the Ask page reads from /admin/api/chat*. Every field is checked
// before the page uses it: a malformed citation is dropped rather than
// rendered as a broken link, and an answer with an unknown status is refused
// outright. No DOM, so the root test runner can load it.

import type { SseMessage } from "./sse.ts";

export interface TraceEvent {
  step: string;
  count?: number;
  slugs?: string[];
  ms?: number;
  usd?: number;
  note?: string;
}

export interface Citation { n: number; slug: string; title: string }

export const ANSWER_STATUSES = ["ok", "refused", "budget", "error", "disabled"] as const;
export type AnswerStatus = (typeof ANSWER_STATUSES)[number];

export interface Answer {
  thread_id: string;
  message_id: string;
  status: AnswerStatus;
  answer: string;
  citations: Citation[];
  gaps: string[];
  model: string | null;
  cost_usd: number | null;
  duration_ms: number | null;
  code: string | null;
}

export interface StreamError { code: string; message: string }

export type ChatEvent =
  | { type: "trace"; trace: TraceEvent }
  | { type: "answer"; answer: Answer }
  | { type: "done" }
  | { type: "error"; error: StreamError };

export interface ThreadSummary { id: string; title: string | null; updated_at: string | null; message_count: number }

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: AnswerStatus | null;
  citations: Citation[];
  gaps: string[];
  model: string | null;
  cost_usd: number | null;
  trace: TraceEvent[];
  created_at: string | null;
  saved_slug: string | null;
}

export interface ThreadDetail {
  thread: { id: string; title: string | null; created_at: string | null; updated_at: string | null };
  messages: ChatMessage[];
}

export interface ChatModel {
  id: string;
  label: string;
  input_usd_per_m: number;
  output_usd_per_m: number;
  estimate_usd: number | null;
}

export interface ModelsReport { enabled: boolean; default: string | null; answer_cap_usd: number | null; models: ChatModel[] }

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const id = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s !== "") : []);
const status = (v: unknown): AnswerStatus | null => (ANSWER_STATUSES as readonly unknown[]).includes(v) ? v as AnswerStatus : null;

export function parseTrace(v: unknown): TraceEvent | null {
  if (!isObj(v)) return null;
  const step = str(v.step);
  if (!step) return null;
  const t: TraceEvent = { step };
  const count = num(v.count);
  if (count !== null) t.count = count;
  if (Array.isArray(v.slugs)) t.slugs = strings(v.slugs);
  const ms = num(v.ms);
  if (ms !== null) t.ms = ms;
  const usd = num(v.usd);
  if (usd !== null) t.usd = usd;
  const note = str(v.note);
  if (note) t.note = note;
  return t;
}

export function parseTraceList(v: unknown): TraceEvent[] {
  if (!Array.isArray(v)) return [];
  return v.map(parseTrace).filter((t): t is TraceEvent => t !== null);
}

export function parseCitations(v: unknown): Citation[] {
  if (!Array.isArray(v)) return [];
  const out: Citation[] = [];
  for (const c of v) {
    if (!isObj(c)) continue;
    const n = num(c.n);
    const slug = str(c.slug);
    if (n === null || !slug) continue;
    out.push({ n, slug, title: str(c.title) || slug });
  }
  return out;
}

export function parseAnswer(v: unknown): Answer | null {
  if (!isObj(v)) return null;
  const thread = id(v.thread_id);
  const message = id(v.message_id);
  const st = status(v.status);
  if (!thread || !message || !st) return null;
  return {
    thread_id: thread,
    message_id: message,
    status: st,
    answer: str(v.answer) ?? "",
    citations: parseCitations(v.citations),
    gaps: strings(v.gaps),
    model: str(v.model),
    cost_usd: num(v.cost_usd),
    duration_ms: num(v.duration_ms),
    code: str(v.code),
  };
}

export function toChatEvent(m: SseMessage): ChatEvent | null {
  let data: unknown;
  try {
    data = JSON.parse(m.data);
  } catch {
    return null;
  }
  switch (m.event) {
    case "trace": {
      const trace = parseTrace(data);
      return trace ? { type: "trace", trace } : null;
    }
    case "answer": {
      const answer = parseAnswer(data);
      return answer ? { type: "answer", answer } : null;
    }
    case "done":
      return { type: "done" };
    case "error": {
      const o = isObj(data) ? data : {};
      return { type: "error", error: { code: str(o.code) || "provider_error", message: str(o.message) ?? "" } };
    }
    default:
      return null;
  }
}

export function parseThreads(v: unknown): ThreadSummary[] {
  const rows = isObj(v) && Array.isArray(v.threads) ? v.threads : [];
  const out: ThreadSummary[] = [];
  for (const r of rows) {
    if (!isObj(r)) continue;
    const tid = id(r.id);
    if (!tid) continue;
    out.push({ id: tid, title: str(r.title), updated_at: str(r.updated_at), message_count: num(r.message_count) ?? 0 });
  }
  return out;
}

function parseMessage(v: unknown): ChatMessage | null {
  if (!isObj(v)) return null;
  const mid = id(v.id);
  if (!mid || (v.role !== "user" && v.role !== "assistant")) return null;
  return {
    id: mid,
    role: v.role,
    content: str(v.content) ?? "",
    status: status(v.status),
    citations: parseCitations(v.citations),
    gaps: strings(v.gaps),
    model: str(v.model),
    cost_usd: num(v.cost_usd),
    trace: parseTraceList(v.trace),
    created_at: str(v.created_at),
    saved_slug: str(v.saved_slug),
  };
}

export function parseThread(v: unknown): ThreadDetail {
  const o = isObj(v) ? v : {};
  const t = isObj(o.thread) ? o.thread : {};
  const messages = Array.isArray(o.messages) ? o.messages.map(parseMessage).filter((m): m is ChatMessage => m !== null) : [];
  return {
    thread: { id: id(t.id) ?? "", title: str(t.title), created_at: str(t.created_at), updated_at: str(t.updated_at) },
    messages,
  };
}

export function parseModels(v: unknown): ModelsReport {
  const o = isObj(v) ? v : {};
  const models: ChatModel[] = [];
  for (const m of Array.isArray(o.models) ? o.models : []) {
    if (!isObj(m)) continue;
    const mid = str(m.id);
    const input = num(m.input_usd_per_m);
    const output = num(m.output_usd_per_m);
    // A model with no price is never offered: its cost could not be capped.
    if (!mid || input === null || output === null) continue;
    models.push({ id: mid, label: str(m.label) || mid, input_usd_per_m: input, output_usd_per_m: output, estimate_usd: num(m.estimate_usd) });
  }
  return { enabled: o.enabled === true, default: str(o.default), answer_cap_usd: num(o.answer_cap_usd), models };
}
