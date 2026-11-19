// A stand-in for the chat routes behind the Ask page. Each check sets
// `chat.state`; every request the page makes lands in `chat.requests`, and a
// stream the page closes early counts in `chat.closed`.

export interface SseStep { event: string; data: unknown }

export interface ChatState {
  models: Record<string, unknown>;
  threads: Array<Record<string, unknown>>;
  details: Record<string, Record<string, unknown>>;
  /** Events the next POST /admin/api/chat sends, in order. */
  script: SseStep[];
  /** Keep the stream open after the script, the way a slow model would. */
  hold: boolean;
  /** Answer the POST with this status and JSON body instead of a stream. */
  refuse: { status: number; body: Record<string, unknown> } | null;
  failThreads: number;
  saveSlug: string;
  /** MEMRAIN_FEEDBACK and MEMRAIN_CHAT_SHARE on the server. */
  feedback: boolean;
  share: boolean;
}

export const MODELS = {
  enabled: true, default: "m1", answer_cap_usd: 0.02,
  models: [
    { id: "m1", label: "Small", input_usd_per_m: 0.25, output_usd_per_m: 1.25, estimate_usd: 0.004 },
    { id: "m2", label: "Large", input_usd_per_m: 3, output_usd_per_m: 15, estimate_usd: 0.06 },
  ],
};

export const ANSWER = {
  thread_id: "t-new", message_id: "m-1", status: "ok", answer: "The offsite is in **March** [1].",
  citations: [{ n: 1, slug: "notes/history", title: "History fixture" }], gaps: ["the exact date"],
  model: "small-1", cost_usd: 0.0012, duration_ms: 2100,
};

export const OK_SCRIPT: SseStep[] = [
  { event: "trace", data: { step: "intent", ms: 3 } },
  { event: "trace", data: { step: "gather", count: 2, slugs: ["notes/history", "notes/plans"], ms: 40 } },
  { event: "trace", data: { step: "settle", usd: 0.0012 } },
  { event: "answer", data: ANSWER },
  { event: "done", data: {} },
];

export function chatScenario(over: Partial<ChatState> = {}): ChatState {
  return { models: MODELS, threads: [], details: {}, script: OK_SCRIPT, hold: false, refuse: null, failThreads: 0, saveSlug: "chats/2026-11-09-offsite", feedback: false, share: false, ...over };
}

export const chat = {
  state: chatScenario(),
  requests: [] as Array<{ method: string; path: string; body: Record<string, unknown> | null }>,
  closed: 0,
  reset(next: ChatState) {
    this.state = next;
    this.requests = [];
    this.closed = 0;
  },
  posts(path: string) {
    return this.requests.filter((r) => r.method === "POST" && r.path === path);
  },
};

const enc = new TextEncoder();
const frame = (s: SseStep) => enc.encode(`event: ${s.event}\ndata: ${JSON.stringify(s.data)}\n\n`);

function stream(request: Request): Response {
  const st = chat.state;
  // An answer names its thread, which then exists like it would on the server.
  for (const step of st.script) {
    const tid = step.event === "answer" ? (step.data as { thread_id?: string }).thread_id : undefined;
    if (!tid || st.details[tid]) continue;
    st.details[tid] = { thread: { id: tid, title: "New thread", created_at: "2026-11-09T12:00:00Z", updated_at: "2026-11-09T12:00:00Z" }, messages: [] };
    st.threads = [{ id: tid, title: "New thread", updated_at: "2026-11-09T12:00:00Z", message_count: 2 }, ...st.threads];
  }
  let closed = false;
  const markClosed = () => {
    if (closed) return;
    closed = true;
    chat.closed += 1;
  };
  request.signal.addEventListener("abort", markClosed);
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const step of st.script) c.enqueue(frame(step));
      if (!st.hold) c.close();
    },
    cancel: markClosed,
  });
  return new Response(body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
}

/** Answers a chat route, or null for a path it does not own. */
export async function chatRoute(request: Request): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/admin/api/chat") && path !== "/admin/api/feedback") return null;
  const st = chat.state;
  const body = request.method === "POST" ? (await request.json().catch(() => ({}))) as Record<string, unknown> : null;
  chat.requests.push({ method: request.method, path, body });
  const off = Response.json({ error: "not_found" }, { status: 404 });
  if (path === "/admin/api/feedback") {
    if (!st.feedback) return off;
    return request.method === "POST" ? Response.json({ ok: true }) : Response.json({ enabled: true });
  }
  if (path === "/admin/api/chat/share") return st.share ? Response.json({ enabled: true }) : off;
  if (/^\/admin\/api\/chat\/messages\/[^/]+\/share$/.test(path)) {
    if (!st.share) return off;
    if (request.method === "DELETE") return Response.json({ ok: true, revoked: 1 });
    return Response.json({ url: `/s/${"t".repeat(43)}`, expires_at: "2026-11-16T12:00:00Z" });
  }
  if (path === "/admin/api/chat" && request.method === "POST") {
    if (st.refuse) return Response.json(st.refuse.body, { status: st.refuse.status });
    return stream(request);
  }
  if (path === "/admin/api/chat/models") return Response.json(st.models);
  if (path === "/admin/api/chat/threads") {
    if (st.failThreads > 0) {
      st.failThreads -= 1;
      return Response.json({ error: "db_busy" }, { status: 503 });
    }
    return Response.json({ threads: st.threads });
  }
  const thread = /^\/admin\/api\/chat\/threads\/([^/]+)$/.exec(path);
  if (thread) {
    const id = decodeURIComponent(thread[1]!);
    const detail = st.details[id];
    if (!detail) return Response.json({ error: "not_found" }, { status: 404 });
    if (request.method === "DELETE") {
      delete st.details[id];
      st.threads = st.threads.filter((t) => t.id !== id);
      return Response.json({ ok: true });
    }
    return Response.json(detail);
  }
  if (/^\/admin\/api\/chat\/messages\/[^/]+\/save$/.test(path)) return Response.json({ slug: st.saveSlug });
  return Response.json({ error: "not_found" }, { status: 404 });
}
