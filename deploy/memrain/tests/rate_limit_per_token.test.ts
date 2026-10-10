/**
 * Per-token-id rate limiter (post-auth). An authenticated OAuth client is
 * capped by its clientId even while rotating egress IPs, which would otherwise
 * defeat the per-IP bucket. Unauthenticated callers are not token-capped.
 */
import { describe, expect, test } from "bun:test";
import { RateLimiter } from "../src/mcp/rate_limit.ts";
import { makeMcpHandler } from "../src/mcp/http_transport.ts";

describe("per-token rate limiter", () => {
  test("caps an authed client across rotating IPs; leaves anon uncapped", async () => {
    let ip = 0;
    const perToken = new RateLimiter({ capacity: 1, refillPerSecond: 0 });
    const handler = makeMcpHandler({
      storage: { engine: () => ({ query: async () => ({ rows: [] }) }) } as never,
      publicRateLimiter: new RateLimiter({ capacity: 100, refillPerSecond: 100 }),
      internalRateLimiter: new RateLimiter({ capacity: 100, refillPerSecond: 100 }),
      perTokenRateLimiter: perToken,
      clientKey: () => `ip-${ip++}`, // unique IP per call → per-IP never trips
    });
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    const mk = () =>
      new Request("http://x/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
    const ctx = { isPublic: false, authInfo: { clientId: "tok1" } as never };

    const first = await handler(mk(), ctx);
    expect(first.status).toBe(200); // consumes the token bucket's only token

    const second = await handler(mk(), ctx);
    expect(second.status).toBe(429); // new IP, but per-token bucket is empty
    expect(second.headers.get("Retry-After")).not.toBeNull();

    // No clientId → not token-capped (must not collapse into a shared bucket).
    const anon = await handler(mk(), { isPublic: false });
    expect(anon.status).toBe(200);
  });

  test("an add_fact with items is charged one write per item", async () => {
    const perToken = new RateLimiter({ capacity: 5, refillPerSecond: 0 });
    const handler = makeMcpHandler({
      storage: { engine: () => ({ query: async () => ({ rows: [] }) }) } as never,
      internalRateLimiter: new RateLimiter({ capacity: 100, refillPerSecond: 0 }),
      perTokenRateLimiter: perToken,
      clientKey: () => "ip",
    });
    const call = (items: unknown[]) =>
      new Request("http://x/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "tools/call",
          params: { name: "add_fact", arguments: { items } },
        }),
      });
    const ctx = { isPublic: false, authInfo: { clientId: "tok1" } as never };
    const items = (n: number) => Array.from({ length: n }, (_, i) => ({ entity_slug: "people/a", fact: `f${i}` }));

    // Five items fit a five-write bucket; a sixth write does not.
    expect((await handler(call(items(5)), ctx)).status).not.toBe(429);
    const over = await handler(call(items(1)), ctx);
    expect(over.status).toBe(429);
    expect(over.headers.get("Retry-After")).not.toBeNull();
  });

  test("a JSON-RPC batch charges the per-token bucket once per element, add_fact items included", async () => {
    const perToken = new RateLimiter({ capacity: 6, refillPerSecond: 0 });
    let ip = 0;
    const handler = makeMcpHandler({
      storage: { engine: () => ({ query: async () => ({ rows: [] }) }) } as never,
      internalRateLimiter: new RateLimiter({ capacity: 100, refillPerSecond: 0 }),
      perTokenRateLimiter: perToken,
      clientKey: () => `ip-${ip++}`,
    });
    const ping = (id: number) => ({ jsonrpc: "2.0", id, method: "ping" });
    const addFacts = (id: number, n: number) => ({
      jsonrpc: "2.0", id, method: "tools/call",
      params: { name: "add_fact", arguments: { items: Array.from({ length: n }, (_, i) => ({ entity_slug: "people/a", fact: `f${i}` })) } },
    });
    const post = (payload: unknown) =>
      new Request("http://x/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    const ctx = { isPublic: false, authInfo: { clientId: "tok1" } as never };

    // Three pings plus a three-item add_fact: six dispatched writes/calls.
    expect((await handler(post([ping(1), ping(2), ping(3), addFacts(4, 3)]), ctx)).status).toBe(200);
    expect((await handler(post(ping(5)), ctx)).status).toBe(429);
  });
});
