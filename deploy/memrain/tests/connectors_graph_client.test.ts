/**
 * The small Microsoft Graph layer the Outlook adapters share, over the
 * fixed-origin connector client: per-request Prefer headers reach the wire, a
 * 503 that names a Retry-After is waited out for that long (Graph's
 * throttling answer), a delta link is followed only on the Graph origin and
 * under /v1.0, and a lost sync state (410, syncStateNotFound) is told apart
 * from a permission refusal.
 */
import { describe, expect, it } from "bun:test";
import { ConnectorClient } from "../src/core/connectors/client.ts";
import { graphGet, graphLinkPath, GRAPH_API_ORIGIN, isSyncStateLost, preferHeader } from "../src/core/connectors/microsoft/graph-client.ts";
import { fakeClock, replay, type Recorded } from "./github-recorded.ts";

const TOKEN = ["graph", "-test-", "access"].join("");

function client(responses: Recorded[]) {
  const clock = fakeClock();
  const fake = replay(responses);
  const c = new ConnectorClient({ origin: GRAPH_API_ORIGIN, token: TOKEN, fetch: fake.fetch, now: clock.now, sleep: clock.sleep, minSpacingMs: 0, maxWaitMs: 30_000, maxRetries: 2 });
  return { c, clock, fake };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Recorded => ({
  status, headers: { "content-type": "application/json", ...headers }, body,
});

describe("graph client", () => {
  it("sends the request's Prefer header and keeps the token in Authorization only", async () => {
    const { c, fake } = client([json(200, { value: [] })]);
    const prefer = preferHeader({ maxPageSize: 25, textBody: true, immutableIds: true });
    const r = await graphGet(c, "/v1.0/me/mailFolders/inbox/messages/delta", { prefer });
    expect(r.class).toBe("ok");
    const headers = fake.inits[0]!.headers as Record<string, string>;
    expect(headers["Prefer"]).toBe('odata.maxpagesize=25, outlook.body-content-type="text", IdType="ImmutableId"');
    expect(headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
  });

  it("waits out the Retry-After of a 503 before retrying", async () => {
    const { c, clock } = client([json(503, { error: { code: "ServiceUnavailable" } }, { "retry-after": "7" }), json(200, { value: [1] })]);
    const r = await graphGet(c, "/v1.0/me/mailFolders/inbox");
    expect(r.class).toBe("ok");
    expect(clock.sleeps).toEqual([7000]);
  });

  it("stops, without retrying early, when a 503 asks for longer than the wait cap", async () => {
    const { c, clock, fake } = client([json(503, { error: { code: "ServiceUnavailable" } }, { "retry-after": "600" }), json(200, {})]);
    const r = await graphGet(c, "/v1.0/me");
    expect(r.class).toBe("rate_limited");
    expect(r.status).toBe(503);
    expect(clock.sleeps).toEqual([]);
    expect(fake.urls).toHaveLength(1);
  });

  it("waits out the Retry-After of a 429 and stops when Graph asks for longer than the cap", async () => {
    const a = client([json(429, { error: { code: "TooManyRequests" } }, { "retry-after": "10" }), json(200, {})]);
    expect((await graphGet(a.c, "/v1.0/me")).class).toBe("ok");
    expect(a.clock.sleeps).toEqual([10_000]);
    const b = client([json(429, { error: { code: "TooManyRequests" } }, { "retry-after": "600" })]);
    const r = await graphGet(b.c, "/v1.0/me");
    expect(r.class).toBe("rate_limited");
    expect(b.clock.sleeps).toEqual([]);
  });

  it("turns a delta link into a path only on the Graph origin under /v1.0", () => {
    expect(graphLinkPath("https://graph.microsoft.com/v1.0/me/mailFolders('AQMk')/messages/delta?$skiptoken=abc"))
      .toBe("/v1.0/me/mailFolders('AQMk')/messages/delta?$skiptoken=abc");
    for (const bad of [
      "https://graph.microsoft.com.evil.example/v1.0/me/messages/delta",
      "http://graph.microsoft.com/v1.0/me/messages/delta",
      "https://graph.microsoft.com/beta/me/messages/delta",
      "https://user:pw@graph.microsoft.com/v1.0/me",
      "/v1.0/me/messages/delta",
      `https://graph.microsoft.com/v1.0/me?${"x".repeat(9000)}`,
      42,
    ]) expect(graphLinkPath(bad)).toBeNull();
  });

  it("reads a lost sync state from a 410 or a syncStateNotFound code, not from a plain refusal", async () => {
    const { c } = client([
      json(410, { error: { code: "SyncStateNotFound", message: "The sync state was not found." } }),
      json(400, { error: { code: "syncStateNotFound" } }),
      json(403, { error: { code: "ErrorAccessDenied" } }),
    ]);
    expect(isSyncStateLost(await graphGet(c, "/v1.0/a"))).toBe(true);
    expect(isSyncStateLost(await graphGet(c, "/v1.0/b"))).toBe(true);
    expect(isSyncStateLost(await graphGet(c, "/v1.0/c"))).toBe(false);
  });
});
