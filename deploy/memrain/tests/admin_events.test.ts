/**
 * Admin SSE feed (deferred #2) — auth gating, the event-stream Response, and the
 * redacted publish path. Reads frames off the stream directly.
 */
import { describe, expect, it } from "bun:test";
import { handleAdminEventsRoute, publishJobEvent, publishToolCallEvent, adminEventBus } from "../src/http/admin-events.ts";

function req(): Request {
  return new Request("http://localhost:8080/admin/events", { method: "GET" });
}

describe("admin SSE feed", () => {
  it("returns null for a non-events path", () => {
    const r = handleAdminEventsRoute(new Request("http://h/admin/api/grants"), () => true);
    expect(r).toBeNull();
  });

  it("401s without an admin session", () => {
    const r = handleAdminEventsRoute(req(), () => false);
    expect(r?.status).toBe(401);
  });

  it("opens an event-stream and delivers a published, redacted event", async () => {
    const r = handleAdminEventsRoute(req(), () => true)!;
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toContain("text/event-stream");

    const reader = r.body!.getReader();
    const dec = new TextDecoder();
    // First read: the ": connected" comment.
    const first = dec.decode((await reader.read()).value);
    expect(first).toContain("connected");

    // Publish — an unknown tool name must store as "unknown", raw never leaks.
    publishToolCallEvent({ tool: "search", agent: "client-1", latencyMs: 7, ok: true });
    const frame = dec.decode((await reader.read()).value);
    expect(frame.startsWith("data: ")).toBe(true);
    const evt = JSON.parse(frame.slice("data: ".length).trim());
    expect(evt.operation).toBe("search");
    expect(evt.agent).toBe("client-1");
    expect(evt.status).toBe("success");

    await reader.cancel();
  });

  it("redacts an unknown tool name to 'unknown'", async () => {
    const r = handleAdminEventsRoute(req(), () => true)!;
    const reader = r.body!.getReader();
    const dec = new TextDecoder();
    await reader.read(); // connected comment
    publishToolCallEvent({ tool: "../evil", agent: "x", latencyMs: 1, ok: false });
    const evt = JSON.parse(dec.decode((await reader.read()).value).slice(6).trim());
    expect(evt.operation).toBe("unknown");
    expect(evt.status).toBe("error");
    await reader.cancel();
  });

  async function openFeed() {
    const r = handleAdminEventsRoute(req(), () => true)!;
    const reader = r.body!.getReader();
    const dec = new TextDecoder();
    await reader.read(); // connected comment
    const next = async () => JSON.parse(dec.decode((await reader.read()).value).slice(6).trim());
    return { reader, next };
  }

  it("publishes a job start event with only allowlisted fields", async () => {
    const { reader, next } = await openFeed();
    publishJobEvent({ worker: "connector_sync", kind: "connector_sync", phase: "start" });
    const evt = await next();
    expect(Object.keys(evt).sort()).toEqual(["agent", "kind", "latency_ms", "operation", "phase", "status", "timestamp"]);
    expect(evt.kind).toBe("job");
    expect(evt.status).toBe("running");
    expect(evt.agent).toBe("connector_sync");
    await reader.cancel();
  });

  it("publishes a job end event with error status", async () => {
    const { reader, next } = await openFeed();
    publishJobEvent({ worker: "w", kind: "k", phase: "end", ok: false, latencyMs: 12.6 });
    const evt = await next();
    expect(evt.status).toBe("error");
    expect(evt.latency_ms).toBe(13);
    expect(evt.phase).toBe("end");
    await reader.cancel();
  });

  it("tool events now carry kind tool and phase end", async () => {
    const { reader, next } = await openFeed();
    publishToolCallEvent({ tool: "search", agent: "client-1", latencyMs: 7, ok: true });
    const evt = await next();
    expect(evt.kind).toBe("tool");
    expect(evt.phase).toBe("end");
    await reader.cancel();
  });

  it("publish is a no-op with no subscribers (never throws)", () => {
    // After the prior streams cancel, the bus may still hold them until GC; just
    // assert publish never throws regardless of subscriber state.
    expect(() => adminEventBus.publish({ agent: "a", operation: "search", latency_ms: 1, status: "success", timestamp: new Date().toISOString(), kind: "tool", phase: "end" })).not.toThrow();
  });
});
