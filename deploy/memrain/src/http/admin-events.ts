/**
 * http/admin-events.ts — the SSE live-activity feed for the admin Dashboard
 * (deferred item #2). A `/admin/events` route: a process-local pub/sub bus +
 * a `text/event-stream` response.
 *
 * memrain has no event bus, so this adds a tiny one. Tool calls publish a REDACTED
 * event (the MCP dispatch site, next to the DB request-log sink); each connected
 * admin browser holds an SSE stream that receives them. Bounded: at most
 * `MAX_SUBSCRIBERS` concurrent streams; a slow/closed client is dropped on its
 * first failed write. Best-effort — publishing never throws into the request
 * path.
 */
import { isKnownTool } from "../mcp/param-redaction.ts";
import { isKnownJobKind } from "../core/jobs/handlers.ts";
import { getDaemon } from "../core/daemons/registry.ts";

export interface AdminEvent {
  agent: string;
  operation: string;
  latency_ms: number;
  status: "success" | "error" | "running";
  timestamp: string;
  kind: "tool" | "job";
  phase: "start" | "end";
}

const MAX_SUBSCRIBERS = 50;
const encoder = new TextEncoder();

class AdminEventBus {
  private subscribers = new Set<ReadableStreamDefaultController>();

  add(c: ReadableStreamDefaultController): boolean {
    if (this.subscribers.size >= MAX_SUBSCRIBERS) return false;
    this.subscribers.add(c);
    return true;
  }
  remove(c: ReadableStreamDefaultController): void {
    this.subscribers.delete(c);
  }

  /** Push a redacted event to every live stream. A failed write drops that
   *  subscriber. Never throws. */
  publish(evt: AdminEvent): void {
    if (this.subscribers.size === 0) return;
    const frame = encoder.encode(`data: ${JSON.stringify(evt)}\n\n`);
    for (const c of [...this.subscribers]) {
      // Drop the frame (not the connection) for a backpressured client so a slow
      // reader can't make the in-memory queue grow unbounded. The feed
      // is a live tail, so a dropped event is acceptable; a dead client still
      // gets evicted by the enqueue throw below.
      if (c.desiredSize !== null && c.desiredSize <= 0) continue;
      try {
        c.enqueue(frame);
      } catch {
        this.subscribers.delete(c);
      }
    }
  }

  /** SSE keepalive comment to every stream, so proxies don't reap an idle one. */
  ping(): void {
    const frame = encoder.encode(`: ping\n\n`);
    for (const c of [...this.subscribers]) {
      try {
        c.enqueue(frame);
      } catch {
        this.subscribers.delete(c);
      }
    }
  }
}

/** Process-local singleton — shared by the publish site (mcp/http_transport)
 *  and the SSE route (http/server). */
export const adminEventBus = new AdminEventBus();

// One keepalive timer for the whole process (unref'd so it never pins exit).
const pinger = setInterval(() => adminEventBus.ping(), 25_000);
(pinger as unknown as { unref?: () => void }).unref?.();

/**
 * Publish a redacted tool-call event. Mirrors the DB sink's redaction: a
 * known-only operation name, the caller identity, coarse latency, ok status.
 * Never the raw params. Best-effort.
 */
export function publishToolCallEvent(e: {
  tool: string;
  agent: string;
  latencyMs: number;
  ok: boolean;
}): void {
  try {
    adminEventBus.publish({
      agent: e.agent,
      operation: isKnownTool(e.tool) ? e.tool : "unknown",
      latency_ms: Math.round(e.latencyMs),
      status: e.ok ? "success" : "error",
      timestamp: new Date().toISOString(),
      kind: "tool",
      phase: "end",
    });
  } catch {
    /* never break the request path */
  }
}

const JOB_WORKER_NAMES = new Set(["worker", "assistant", "cycle"]);

/**
 * Publish a background-job or cycle event. Same redaction stance as tool
 * calls: only registered job kinds and worker names go out, anything else
 * becomes a fixed placeholder. Best-effort.
 */
export function publishJobEvent(e: {
  worker: string;
  kind: string;
  phase: "start" | "end";
  ok?: boolean;
  latencyMs?: number;
}): void {
  try {
    adminEventBus.publish({
      agent: JOB_WORKER_NAMES.has(e.worker) || getDaemon(e.worker) ? e.worker : "worker",
      operation: isKnownJobKind(e.kind) || e.kind === "cycle" ? e.kind : "other",
      latency_ms: Math.round(e.latencyMs ?? 0),
      status: e.phase === "start" ? "running" : e.ok ? "success" : "error",
      timestamp: new Date().toISOString(),
      kind: "job",
      phase: e.phase,
    });
  } catch {
    /* never break the worker */
  }
}

/**
 * Handle `GET /admin/events`. Requires an admin session. Returns an SSE stream
 * that receives published events until the client disconnects. Returns a 401
 * when unauthenticated, or a 503 when the subscriber cap is reached.
 */
export function handleAdminEventsRoute(req: Request, requireAdmin: (req: Request) => boolean): Response | null {
  const url = new URL(req.url);
  if (url.pathname !== "/admin/events" || req.method !== "GET") return null;
  if (!requireAdmin(req)) {
    return Response.json({ error: "Admin authentication required" }, { status: 401 });
  }

  // start() runs inside the constructor, so `controllerRef` is known right after it.
  let controllerRef: ReadableStreamDefaultController | null = null;
  const stream = new ReadableStream({
    start(controller) {
      if (!adminEventBus.add(controller)) return;
      controllerRef = controller;
      controller.enqueue(encoder.encode(`: connected\n\n`)); // initial comment
    },
    cancel() {
      if (controllerRef) adminEventBus.remove(controllerRef);
    },
  });
  // A plain error rather than a stream that closes at once, which EventSource would reopen in a loop.
  if (!controllerRef) {
    return Response.json({ error: "Too many live feeds are open" }, { status: 503 });
  }

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
