/**
 * The connector client with a refreshable credential and a shared provider
 * limiter: one forced refresh on a 401, a refused refresh reported as
 * needing a reconnect, every token seen kept out of error text, and request
 * spacing plus a daily quota that hold across clients of one account.
 */
import { describe, expect, it } from "bun:test";
import { ConnectorClient, ConnectorRequestError, type TokenSource } from "../src/core/connectors/client.ts";
import { ProviderLimiter } from "../src/core/connectors/limiter.ts";
import { ReauthRequiredError } from "../src/core/connectors/types.ts";
import { fakeClock, replay, type Recorded } from "./github-recorded.ts";

const ORIGIN = ["https://api", "provider", "test"].join(".");
// Assembled at run time: a token shape must not sit in the source.
const OLD = ["acc", "ess", "-old-value"].join("");
const NEW = ["acc", "ess", "-new-value"].join("");

const ok = (body: unknown = { ok: true }): Recorded => ({ status: 200, headers: { "content-type": "application/json" }, body });
const unauthorized: Recorded = { status: 401, headers: { "content-type": "application/json" }, body: { error: "invalid_token" } };

function source(opts: { refresh?: () => Promise<string>; initial?: string } = {}) {
  let current = opts.initial ?? OLD;
  const refreshed: string[] = [];
  const s: TokenSource = {
    token: async () => current,
    refresh: async (stale) => {
      refreshed.push(stale);
      current = opts.refresh ? await opts.refresh() : NEW;
      return current;
    },
  };
  return { s, refreshed };
}

function client(responses: Array<Recorded | Error>, tokenSource: TokenSource, extra: Partial<ConstructorParameters<typeof ConnectorClient>[0]> = {}) {
  const clock = fakeClock();
  const fake = replay(responses);
  const c = new ConnectorClient({ origin: ORIGIN, tokenSource, fetch: fake.fetch, now: clock.now, sleep: clock.sleep, maxRetries: 2, ...extra });
  return { c, fake, clock };
}

const authHeaders = (inits: RequestInit[]) => inits.map((i) => (i.headers as Record<string, string>).Authorization);

describe("ConnectorClient with a token source", () => {
  it("takes either a static token or a token source, never both or neither", () => {
    const { s } = source();
    expect(() => new ConnectorClient({ origin: ORIGIN })).toThrow(ConnectorRequestError);
    expect(() => new ConnectorClient({ origin: ORIGIN, token: OLD, tokenSource: s })).toThrow(ConnectorRequestError);
  });

  it("refreshes once on a 401 and retries with the new token", async () => {
    const { s, refreshed } = source();
    const { c, fake } = client([unauthorized, ok({ n: 1 })], s);
    const res = await c.get("/v1/items");
    expect(res.class).toBe("ok");
    expect(res.body).toEqual({ n: 1 });
    expect(refreshed).toEqual([OLD]);
    expect(authHeaders(fake.inits)).toEqual([`Bearer ${OLD}`, `Bearer ${NEW}`]);
  });

  it("reports a second 401 after a refresh as needing a reconnect", async () => {
    const { s, refreshed } = source();
    const { c } = client([unauthorized, unauthorized], s);
    const res = await c.get("/v1/items");
    expect(res.class).toBe("auth_required");
    expect(res.reauth).toBe(true);
    expect(refreshed).toHaveLength(1);
  });

  it("reports a refused refresh as needing a reconnect without another request", async () => {
    const { s } = source({ refresh: async () => { throw new ReauthRequiredError("invalid_grant"); } });
    const { c, fake } = client([unauthorized], s);
    const res = await c.get("/v1/items");
    expect(res.class).toBe("auth_required");
    expect(res.reauth).toBe(true);
    expect(fake.urls).toHaveLength(1);
  });

  it("reports a refresh that failed for a transient reason as a server error, not a reconnect", async () => {
    const { s } = source({ refresh: async () => { throw new Error(`token endpoint down while sending ${OLD}`); } });
    const { c } = client([unauthorized], s);
    const res = await c.get("/v1/items");
    expect(res.class).toBe("server_error");
    expect(res.reauth).toBeFalsy();
    expect(res.error).not.toContain(OLD);
  });

  it("reports a token source that cannot produce a token as needing a reconnect", async () => {
    const s: TokenSource = {
      token: async () => { throw new ReauthRequiredError("refresh token revoked"); },
      refresh: async () => NEW,
    };
    const { c, fake } = client([], s);
    const res = await c.get("/v1/items");
    expect(res).toMatchObject({ class: "auth_required", reauth: true });
    expect(fake.urls).toEqual([]);
  });

  it("scrubs every token it sent, old and refreshed, from a network error", async () => {
    const { s } = source();
    const { c } = client([unauthorized, new Error(`reset after ${NEW} and ${OLD}`), new Error(`reset ${NEW}`), new Error(`reset ${NEW}`)], s);
    const res = await c.get("/v1/items");
    expect(res.class).toBe("server_error");
    expect(res.error).not.toContain(NEW);
    expect(res.error).not.toContain(OLD);
  });
});

describe("ProviderLimiter", () => {
  it("spaces requests from two clients sharing it", async () => {
    const clock = fakeClock();
    const limiter = new ProviderLimiter({ minSpacingMs: 1_000, now: clock.now, sleep: clock.sleep });
    const { s } = source();
    const fake = replay([ok(), ok()]);
    const opts = { origin: ORIGIN, tokenSource: s, fetch: fake.fetch, now: clock.now, sleep: clock.sleep, limiter };
    await new ConnectorClient(opts).get("/a");
    await new ConnectorClient(opts).get("/b");
    expect(clock.sleeps).toEqual([1_000]);
  });

  it("refuses past the daily quota until 00:00 UTC, then allows again", async () => {
    const clock = fakeClock(Date.parse("2026-11-14T23:00:00Z"));
    const limiter = new ProviderLimiter({ minSpacingMs: 0, dailyQuota: 2, now: clock.now, sleep: clock.sleep });
    const { s } = source();
    const fake = replay([ok(), ok(), ok()]);
    const c = new ConnectorClient({ origin: ORIGIN, tokenSource: s, fetch: fake.fetch, now: clock.now, sleep: clock.sleep, limiter });
    expect((await c.get("/1")).class).toBe("ok");
    expect((await c.get("/2")).class).toBe("ok");
    const third = await c.get("/3");
    expect(third.class).toBe("rate_limited");
    expect(third.error).toContain("daily request quota");
    expect(fake.urls).toHaveLength(2);
    clock.advance(60 * 60_000);
    expect((await c.get("/3")).class).toBe("ok");
  });
});
