/**
 * The fixed-origin connector client under a fake clock and recorded responses:
 * origin pinning, request spacing, rate-limit waits and their cap, bounded
 * retries, and a token that never leaves the Authorization header.
 */
import { describe, expect, it } from "bun:test";
import { ConnectorClient, ConnectorRequestError, parseNextLink } from "../src/core/connectors/client.ts";
import { API as ORIGIN, fakeClock, recorded, replay, type Recorded } from "./github-recorded.ts";

// Assembled at run time: a token shape must not sit in the source.
const TOKEN = ["ght", "est", "-", "secret-value"].join("");

function client(responses: Array<Recorded | Error>, extra: Partial<ConstructorParameters<typeof ConnectorClient>[0]> = {}) {
  const clock = fakeClock();
  const fake = replay(responses);
  const c = new ConnectorClient({
    origin: ORIGIN,
    token: TOKEN,
    fetch: fake.fetch,
    now: clock.now,
    sleep: clock.sleep,
    minSpacingMs: 500,
    maxWaitMs: 10_000,
    maxRetries: 2,
    ...extra,
  });
  return { c, clock, fake };
}

const ok = (body: unknown = [], headers: Record<string, string> = {}): Recorded => ({
  status: 200,
  headers: { "content-type": "application/json", ...headers },
  body,
});

describe("ConnectorClient origin pinning", () => {
  it("refuses an absolute URL, a protocol-relative path and a backslash path", async () => {
    const { c, fake } = client([]);
    for (const bad of ["https://evil.example/x", "//evil.example/x", "repos/a/b", "/\\evil.example"]) {
      await expect(c.get(bad)).rejects.toBeInstanceOf(ConnectorRequestError);
    }
    expect(fake.urls).toEqual([]);
  });

  it("follows a same-origin next link as a path and refuses a cross-origin one", async () => {
    const { c } = client([
      ok([], { link: `<${ORIGIN}/repositories/7/issues?page=2>; rel="next"` }),
      ok([], { link: '<https://evil.example/steal?page=3>; rel="next"' }),
    ]);
    const first = await c.get("/repos/a/b/issues");
    expect(first.next).toBe("/repositories/7/issues?page=2");
    await expect(c.get(first.next!)).rejects.toThrow(`off ${ORIGIN}`);
  });

  it("never follows a redirect and sends the token only in the Authorization header", async () => {
    const { c, fake } = client([ok()]);
    await c.get("/repos/a/b/issues");
    expect(fake.urls[0]).toBe(`${ORIGIN}/repos/a/b/issues`);
    expect(fake.urls[0]).not.toContain(TOKEN);
    expect(fake.inits[0]!.redirect).toBe("manual");
    expect((fake.inits[0]!.headers as Record<string, string>)["Authorization"]).toBe(`Bearer ${TOKEN}`);
  });

  it("parses the next link out of a multi-part Link header", () => {
    expect(parseNextLink('<https://x/a?page=1>; rel="prev", <https://x/a?page=3>; rel="next"')).toBe("https://x/a?page=3");
    expect(parseNextLink('<https://x/a?page=9>; rel="last"')).toBeNull();
    expect(parseNextLink(null)).toBeNull();
  });
});

describe("ConnectorClient pacing", () => {
  it("spaces consecutive requests by the minimum interval", async () => {
    const { c, clock } = client([ok(), ok(), ok()]);
    await c.get("/a");
    clock.advance(100);
    await c.get("/b");
    await c.get("/c");
    expect(clock.sleeps).toEqual([400, 500]);
  });

  it("waits out Retry-After and then succeeds", async () => {
    const { c, clock } = client([recorded("too-many-requests"), ok([1])]);
    const r = await c.get("/a");
    expect(r.class).toBe("ok");
    expect(r.body).toEqual([1]);
    expect(clock.sleeps).toContain(2000);
  });

  it("waits until X-RateLimit-Reset when the primary limit is spent", async () => {
    const clock = fakeClock(1_800_000_025_000);
    const fake = replay([recorded("primary-limit"), ok()]);
    const c = new ConnectorClient({ origin: ORIGIN, token: TOKEN, fetch: fake.fetch, now: clock.now, sleep: clock.sleep, maxWaitMs: 10_000 });
    expect((await c.get("/a")).class).toBe("ok");
    expect(clock.sleeps).toEqual([5000]);
  });

  it("gives up with rate_limited, without sleeping, when the wait is past the cap", async () => {
    const { c, clock } = client([recorded("secondary-limit")]);
    const r = await c.get("/a");
    expect(r.class).toBe("rate_limited");
    expect(r.status).toBe(403);
    expect(clock.sleeps).toEqual([]);
  });

  it("retries a server error a bounded number of times, then surfaces it", async () => {
    const { c, clock, fake } = client([recorded("bad-gateway"), recorded("bad-gateway"), recorded("bad-gateway")]);
    const r = await c.get("/a");
    expect(r.class).toBe("server_error");
    expect(r.status).toBe(502);
    expect(fake.urls).toHaveLength(3);
    expect(clock.sleeps.filter((ms) => ms >= 1000)).toEqual([1000, 2000]);
  });

  it("recovers from one server error", async () => {
    const { c } = client([recorded("bad-gateway"), ok(["x"])]);
    expect((await c.get("/a")).body).toEqual(["x"]);
  });

  it("returns auth_required and forbidden at once, without retrying", async () => {
    const auth = client([recorded("unauthorized")]);
    expect((await auth.c.get("/a")).class).toBe("auth_required");
    expect(auth.fake.urls).toHaveLength(1);
    const denied = client([recorded("forbidden")]);
    expect((await denied.c.get("/a")).class).toBe("forbidden");
  });

  it("reads a 200 that is not JSON as a challenge", async () => {
    const { c } = client([{ status: 200, headers: { "content-type": "application/json" }, body: "not json" }]);
    expect((await c.get("/a")).class).toBe("challenge");
  });
});

describe("ConnectorClient never leaks the token", () => {
  it("scrubs it from a network error that quotes it", async () => {
    const boom = () => new Error(`connect failed for Authorization: Bearer ${TOKEN}`);
    const { c } = client([boom(), boom(), boom()]);
    const r = await c.get("/a");
    expect(r.class).toBe("server_error");
    expect(r.error).not.toContain(TOKEN);
    expect(r.error).toContain("[token]");
  });

  it("keeps it out of every refusal message", async () => {
    const { c } = client([]);
    const err = await c.get("https://evil.example/").catch((e: Error) => e);
    expect(String((err as Error).message)).not.toContain(TOKEN);
  });
});

describe("ConnectorClient response size bound", () => {
  /** A 200 whose body streams `chunks` chunks of `size` bytes, counting what was pulled. */
  function streamed(chunks: number, size: number, headers: Record<string, string> = {}) {
    const state = { pulled: 0, cancelled: false, fetches: 0 };
    const fetch = async () => {
      state.fetches++;
      const body = new ReadableStream<Uint8Array>({
        pull(ctrl) {
          if (state.pulled >= chunks) return ctrl.close();
          state.pulled++;
          ctrl.enqueue(new Uint8Array(size).fill(0x20));
        },
        cancel() { state.cancelled = true; },
      });
      return new Response(body, { status: 200, headers: { "content-type": "application/json", ...headers } });
    };
    const clock = fakeClock();
    const c = new ConnectorClient({ origin: ORIGIN, token: TOKEN, fetch, now: clock.now, sleep: clock.sleep, maxRetries: 2 });
    return { c, state };
  }

  it("stops reading a body past the limit, says so, and does not retry", async () => {
    const { c, state } = streamed(100, 1024);
    const res = await c.get("/big", { maxBytes: 10 * 1024 });
    expect(res.class).toBe("challenge");
    expect(res.tooLarge).toBe(true);
    expect(res.body).toBeNull();
    expect(res.error).toContain("10240 bytes");
    expect(state.pulled).toBeLessThan(100);
    expect(state.cancelled).toBe(true);
    expect(state.fetches).toBe(1);
  });

  it("refuses a declared Content-Length past the limit before reading the body", async () => {
    const { c, state } = streamed(100, 1024, { "content-length": String(100 * 1024) });
    const res = await c.get("/big", { maxBytes: 10 * 1024 });
    expect(res.tooLarge).toBe(true);
    expect(state.pulled).toBeLessThanOrEqual(1);
  });

  it("reads a body within the limit, and any body when no limit is given", async () => {
    const { c } = streamed(3, 1024);
    // Spaces are whitespace around no value: not JSON, so the read itself is what is checked.
    const within = await c.get("/ok", { maxBytes: 4 * 1024 });
    expect(within.tooLarge).toBeUndefined();
    expect(within.error).toContain("not JSON");
    const json = new ConnectorClient({ origin: ORIGIN, token: TOKEN, fetch: async () => Response.json({ a: 1 }), sleep: async () => {} });
    expect((await json.get("/ok", { maxBytes: 64 })).body).toEqual({ a: 1 });
    const unbounded = streamed(100, 1024);
    expect((await unbounded.c.get("/big")).tooLarge).toBeUndefined();
    expect(unbounded.state.pulled).toBe(100);
  });
});
