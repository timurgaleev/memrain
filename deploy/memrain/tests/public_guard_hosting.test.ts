/**
 * The ingress of a hosted tenant's container.
 *
 *   B6  MEMRAIN_PUBLIC_AUTH=oauth: there is no static public bearer. A
 *       missing or unknown credential gets 401 with the resource-metadata
 *       challenge (not 503), so the OAuth token and PAT path runs; a static
 *       bearer configured alongside refuses to start.
 *   B7  In hosting mode the process refuses to start without its own
 *       MEMRAIN_INTERNAL_TOKEN, and with MEMRAIN_ASSUME_PUBLIC=1 a sibling
 *       container gets 401 whatever it sends: nothing, its own PAT from
 *       another brain, or its own internal token.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { OAuthProvider } from "../src/core/oauth-provider.ts";
import { startServer, type ServerHandle } from "../src/http/server.ts";
import { assertIngressConfig } from "../src/http/public_guard.ts";

const KEYS = ["MEMRAIN_TENANT_ID", "MEMRAIN_CONTROL_URL", "MEMRAIN_PUBLIC_AUTH", "MEMRAIN_ASSUME_PUBLIC", "MEMRAIN_REQUIRE_MEMBER"] as const;
const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
const restore = () => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
};

const OWN_INTERNAL = ["own", "internal", "token", "for", "tenant", "a"].join("-");
const NEIGHBOUR_INTERNAL = ["other", "internal", "token", "for", "tenant", "b"].join("-");
const PAT = `memrain_${"a1".repeat(32)}`;
const NEIGHBOUR_PAT = `memrain_${"b2".repeat(32)}`;

let tmp: string;
let storage: Storage;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-guard-hosting-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  await storage.engine().query(
    `INSERT INTO access_tokens (name, token_hash, scopes) VALUES ('laptop', $1, ARRAY['read'])`,
    [createHash("sha256").update(PAT).digest("hex")],
  );
});
afterAll(async () => {
  restore();
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});
afterEach(restore);

describe("start-up refusals", () => {
  it("hosting mode without an internal token does not start", () => {
    expect(() => assertIngressConfig({}, { MEMRAIN_TENANT_ID: "acme" })).toThrow(/MEMRAIN_INTERNAL_TOKEN/);
    expect(() => assertIngressConfig({}, { MEMRAIN_CONTROL_URL: "x" })).toThrow(/MEMRAIN_INTERNAL_TOKEN/);
    expect(() => assertIngressConfig({ internalToken: OWN_INTERNAL }, { MEMRAIN_TENANT_ID: "acme" })).not.toThrow();
    process.env["MEMRAIN_TENANT_ID"] = "acme";
    expect(() => startServer({ host: "127.0.0.1", port: 0, storage })).toThrow(/MEMRAIN_INTERNAL_TOKEN/);
  });

  it("oauth ingress with a static public bearer does not start", () => {
    expect(() => assertIngressConfig({ publicBearerToken: "pub" }, { MEMRAIN_PUBLIC_AUTH: "oauth" })).toThrow(/MEMRAIN_PUBLIC_BEARER/);
    expect(() => assertIngressConfig({}, { MEMRAIN_PUBLIC_AUTH: "bearer" })).toThrow(/MEMRAIN_PUBLIC_AUTH/);
  });

  it("a single-tenant brain starts as before", () => {
    expect(() => assertIngressConfig({}, {})).not.toThrow();
    expect(() => assertIngressConfig({ publicBearerToken: "pub" }, {})).not.toThrow();
  });
});

describe("a hosted tenant's /mcp", () => {
  let server: ServerHandle;
  let base: string;
  let oauthToken: string;

  beforeAll(async () => {
    process.env["MEMRAIN_TENANT_ID"] = "acme";
    process.env["MEMRAIN_PUBLIC_AUTH"] = "oauth";
    process.env["MEMRAIN_ASSUME_PUBLIC"] = "1";
    const provider = new OAuthProvider({ engine: storage.engine() });
    const client = await provider.registerClientManual("svc", ["client_credentials"], "read");
    oauthToken = (await provider.exchangeClientCredentials(client.clientId, client.clientSecret!)).access_token;
    server = startServer({ host: "127.0.0.1", port: 0, storage, internalToken: OWN_INTERNAL, oauthProvider: provider });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(async () => {
    await server.stop();
  });

  const mcp = (headers: Record<string, string> = {}) => fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

  it("no credential: 401 with the metadata challenge, never 503", async () => {
    process.env["MEMRAIN_TENANT_ID"] = "acme";
    process.env["MEMRAIN_PUBLIC_AUTH"] = "oauth";
    process.env["MEMRAIN_ASSUME_PUBLIC"] = "1";
    const res = await mcp();
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("resource_metadata");
  });

  it("this brain's PAT and OAuth token are served", async () => {
    process.env["MEMRAIN_TENANT_ID"] = "acme";
    process.env["MEMRAIN_PUBLIC_AUTH"] = "oauth";
    process.env["MEMRAIN_ASSUME_PUBLIC"] = "1";
    expect((await mcp({ authorization: `Bearer ${PAT}` })).status).toBe(200);
    expect((await mcp({ authorization: `Bearer ${oauthToken}` })).status).toBe(200);
  });

  it("a sibling gets 401 with anything it sends", async () => {
    process.env["MEMRAIN_TENANT_ID"] = "acme";
    process.env["MEMRAIN_PUBLIC_AUTH"] = "oauth";
    process.env["MEMRAIN_ASSUME_PUBLIC"] = "1";
    for (const auth of [`Bearer ${NEIGHBOUR_PAT}`, `Bearer ${NEIGHBOUR_INTERNAL}`, `Bearer ${OWN_INTERNAL}`, "Bearer not-a-token"]) {
      const res = await mcp({ authorization: auth });
      expect({ auth, status: res.status }).toEqual({ auth, status: 401 });
    }
  });
});
