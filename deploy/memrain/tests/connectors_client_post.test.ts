/**
 * The connector client's POST: a JSON body to a path on the fixed origin
 * (GraphQL providers such as Fireflies take every query this way), with the
 * same token, refresh and retry handling as a GET, and the error body of a
 * refused request kept for the caller to read its provider error code.
 */
import { describe, expect, it } from "bun:test";
import { ConnectorClient, ConnectorRequestError, type TokenSource } from "../src/core/connectors/client.ts";
import { ReauthRequiredError } from "../src/core/connectors/types.ts";
import { fakeClock, replay, type Recorded } from "./github-recorded.ts";

const ORIGIN = ["https://api", "provider", "test"].join(".");
const KEY = ["static", "-api-", "key-value"].join("");

const json = (status: number, body: unknown): Recorded => ({ status, headers: { "content-type": "application/json" }, body });

function keySource(): TokenSource {
  return {
    token: async () => KEY,
    refresh: async () => {
      throw new ReauthRequiredError("the provider refused the API key");
    },
  };
}

function client(responses: Recorded[]) {
  const clock = fakeClock();
  const fake = replay(responses);
  const c = new ConnectorClient({ origin: ORIGIN, tokenSource: keySource(), fetch: fake.fetch, now: clock.now, sleep: clock.sleep, maxRetries: 2 });
  return { c, fake, clock };
}

describe("ConnectorClient.post", () => {
  it("sends a JSON body with the bearer token to a path on the origin", async () => {
    const { c, fake } = client([json(200, { data: { ok: true } })]);
    const res = await c.post("/graphql", { query: "{ user { email } }" });
    expect(res.class).toBe("ok");
    expect(res.body).toEqual({ data: { ok: true } });
    expect(fake.urls).toEqual([`${ORIGIN}/graphql`]);
    const init = fake.inits[0]!;
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({ query: "{ user { email } }" });
  });

  it("refuses a URL instead of a path", async () => {
    const { c } = client([]);
    await expect(c.post("https://elsewhere.test/graphql", {})).rejects.toThrow(ConnectorRequestError);
  });

  it("reports a refused static key as needing a reconnect", async () => {
    const { c, fake } = client([json(401, { errors: [{ code: "auth_failed" }] })]);
    const res = await c.post("/graphql", {});
    expect(res.class).toBe("auth_required");
    expect(res.reauth).toBe(true);
    expect(fake.urls.length).toBe(1);
    expect(res.error).not.toContain(KEY);
  });

  it("retries a server error and keeps the error body of a final refusal", async () => {
    const { c, fake } = client([json(502, { errors: [] }), json(400, { errors: [{ code: "auth_failed", message: "Invalid API key" }] })]);
    const res = await c.post("/graphql", {});
    expect(fake.urls.length).toBe(2);
    expect(res.class).toBe("forbidden");
    expect(res.body).toBeNull();
    expect(res.errorBody).toEqual({ errors: [{ code: "auth_failed", message: "Invalid API key" }] });
  });

  it("leaves errorBody unset when a refusal carries no JSON", async () => {
    const { c } = client([{ status: 404, headers: { "content-type": "text/plain" }, body: "nope" }]);
    const res = await c.post("/graphql", {});
    expect(res.class).toBe("forbidden");
    expect(res.errorBody).toBeUndefined();
  });
});
