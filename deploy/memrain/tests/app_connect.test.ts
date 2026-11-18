/**
 * Connecting a client from /app (B8).
 *
 *   POST /app/api/connect/enrollment   a one-time code for the tenant's
 *     connector, bound to the member and its personal source; a new one
 *     revokes the last unused one. Issue, member binding and audit commit
 *     together or not at all.
 *   POST /app/api/connect/token        a member PAT, shown once.
 *   DELETE /app/api/connect/token/:name  revokes one of the member's own.
 *
 * A redeemed code and a PAT both read the member's read set and nothing
 * else, and both stop when the member is disabled.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { InvalidTokenError, OAuthProvider, type OAuthClientInfo } from "../src/core/oauth-provider.ts";
import { registerSource } from "../src/core/sources.ts";
import { addMember, disableMember, type MemberActor } from "../src/core/members.ts";
import { APP_COOKIE, createMemberSession } from "../src/core/member-sessions.ts";
import { handleApp } from "../src/http/app.ts";
import { handleAuthorizeRoute } from "../src/http/oauth-endpoints.ts";
import type { Engine } from "../src/core/engine/interface.ts";

const ORIGIN = "https://acme.example.test";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const OPS: MemberActor = { actor: "ops", via: "cli" };

let tmp: string;
let storage: Storage;
let provider: OAuthProvider;
let connector: OAuthClientInfo;
const cookies = new Map<string, string>();
const savedApp = process.env["MEMRAIN_APP"];

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-app-connect-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  const e = storage.engine();
  for (const id of ["alice", "bob"]) {
    await registerSource(e, { id: `person-${id}`, kind: "other", pathPrefix: `/person-${id}` });
    await addMember(e, id, { personalSource: `person-${id}` }, OPS);
    cookies.set(id, (await createMemberSession(e, id, "passkey")).id);
  }
  await registerSource(e, { id: "team-docs", kind: "other", pathPrefix: "/team-docs" });
  await e.query(`INSERT INTO groups (id) VALUES ('team')`);
  await e.query(`INSERT INTO group_sources (group_id, source_id) VALUES ('team', 'team-docs')`);
  await e.query(`INSERT INTO group_members (group_id, member_id) VALUES ('team', 'alice')`);
  provider = new OAuthProvider({ engine: e });
  const c = await provider.registerClientManual(
    "acme-connector", ["authorization_code", "refresh_token"], "read write", [REDIRECT], "default",
    undefined, "none", undefined, "enrollment",
  );
  connector = (await provider.getClient(c.clientId))!;
}, 30_000);
afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  process.env["MEMRAIN_APP"] = "1";
});
afterEach(() => {
  if (savedApp === undefined) delete process.env["MEMRAIN_APP"];
  else process.env["MEMRAIN_APP"] = savedApp;
});

async function call(member: string | null, method: string, path: string, body?: unknown, store: Storage = storage): Promise<Response> {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (member) headers.cookie = `${APP_COOKIE}=${cookies.get(member)}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const req = new Request(`${ORIGIN}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const res = await handleApp(req, new URL(req.url), { storage: store, publicUrl: ORIGIN, oauthProvider: new OAuthProvider({ engine: store.engine() }) });
  if (!res) throw new Error(`not handled: ${path}`);
  return res;
}

async function redeem(code: string): Promise<string> {
  const q = new URLSearchParams({
    client_id: connector.client_id, redirect_uri: REDIRECT, response_type: "code", code_challenge: CHALLENGE, code_challenge_method: "S256", state: "s",
  });
  const res = await handleAuthorizeRoute(new Request(`${ORIGIN}/authorize?${q}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ enrollment_code: code }).toString(),
  }), provider);
  expect(res.status).toBe(303);
  const authCode = new URL(res.headers.get("location")!).searchParams.get("code")!;
  return (await provider.exchangeAuthorizationCode(connector, authCode, VERIFIER, REDIRECT)).access_token;
}

describe("connect from /app", () => {
  it("names the MCP URL and the connector", async () => {
    const res = await call("alice", "GET", "/app/api/connect");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mcp_url: `${ORIGIN}/mcp`, client_id: connector.client_id });
  });

  it("needs a session", async () => {
    expect((await call(null, "POST", "/app/api/connect/enrollment", {})).status).toBe(401);
    expect((await call(null, "POST", "/app/api/connect/token", { label: "x" })).status).toBe(401);
  });

  it("issues a code bound to the member that redeems into the member's grant", async () => {
    const res = await call("alice", "POST", "/app/api/connect/enrollment", {});
    expect(res.status).toBe(200);
    const issued = (await res.json()) as { code: string; client_id: string; expires_at: string };
    expect(issued.client_id).toBe(connector.client_id);
    expect(Date.parse(issued.expires_at) - Date.now()).toBeLessThanOrEqual(24 * 3600_000);
    const row = await storage.engine().query<{ member_id: string; source_id: string; client_id: string }>(
      `SELECT member_id, source_id, client_id FROM oauth_enrollments WHERE member_id = 'alice' AND revoked_at IS NULL AND used_at IS NULL`,
    );
    expect(row.rows).toEqual([{ member_id: "alice", source_id: "person-alice", client_id: connector.client_id }]);

    const token = await redeem(issued.code);
    const info = await provider.verifyAccessToken(token);
    expect(info.sourceId).toBe("person-alice");
    expect([...(info.allowedSources ?? [])].sort()).toEqual(["person-alice", "team-docs"]);
  });

  it("a second code revokes the first unused one", async () => {
    const first = (await (await call("bob", "POST", "/app/api/connect/enrollment", {})).json()) as { code: string };
    const second = (await (await call("bob", "POST", "/app/api/connect/enrollment", {})).json()) as { code: string };
    expect(first.code).not.toBe(second.code);
    const live = await storage.engine().query(`SELECT 1 FROM oauth_enrollments WHERE member_id = 'bob' AND revoked_at IS NULL AND used_at IS NULL`);
    expect(live.rows.length).toBe(1);
    expect(await provider.claimEnrollment(first.code, connector.client_id)).toBeUndefined();
  });

  it("a failure inside the issue leaves no code and no binding", async () => {
    const before = await storage.engine().query<{ n: number }>(`SELECT count(*)::int AS n FROM oauth_enrollments`);
    for (const failOn of ["INSERT INTO oauth_enrollments", "INSERT INTO oauth_enrollment_audit", "INSERT INTO member_audit"]) {
      const res = await call("alice", "POST", "/app/api/connect/enrollment", {}, failing(failOn));
      expect({ failOn, status: res.status }).toEqual({ failOn, status: 500 });
      const after = await storage.engine().query<{ n: number }>(`SELECT count(*)::int AS n FROM oauth_enrollments`);
      expect({ failOn, n: after.rows[0]!.n }).toEqual({ failOn, n: before.rows[0]!.n });
    }
  });

  it("mints a member PAT shown once that reads the member's read set only", async () => {
    const res = await call("alice", "POST", "/app/api/connect/token", { label: "Claude Code" });
    expect(res.status).toBe(200);
    const { name, token } = (await res.json()) as { name: string; token: string };
    const dump = JSON.stringify((await storage.engine().query(`SELECT * FROM access_tokens WHERE name = $1`, [name])).rows);
    expect(dump).not.toContain(token);
    const info = await provider.verifyAccessToken(token);
    expect(info.sourceId).toBe("person-alice");
    expect([...(info.allowedSources ?? [])].sort()).toEqual(["person-alice", "team-docs"]);
    const list = (await (await call("alice", "GET", "/app/api/connect/tokens")).json()) as { tokens: Array<{ name: string }> };
    expect(list.tokens.map(t => t.name)).toContain(name);
    expect(((await (await call("bob", "GET", "/app/api/connect/tokens")).json()) as { tokens: unknown[] }).tokens).toEqual([]);

    // Bob cannot revoke it; Alice can.
    expect((await call("bob", "DELETE", `/app/api/connect/token/${encodeURIComponent(name)}`)).status).toBe(404);
    expect((await call("alice", "DELETE", `/app/api/connect/token/${encodeURIComponent(name)}`)).status).toBe(200);
    await expect(provider.verifyAccessToken(token)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("disabling the member stops both the redeemed code and the PAT", async () => {
    const e = storage.engine();
    await registerSource(e, { id: "person-carol", kind: "other", pathPrefix: "/person-carol" });
    await addMember(e, "carol", { personalSource: "person-carol" }, OPS);
    cookies.set("carol", (await createMemberSession(e, "carol", "passkey")).id);
    const code = ((await (await call("carol", "POST", "/app/api/connect/enrollment", {})).json()) as { code: string }).code;
    const oauthToken = await redeem(code);
    const pat = ((await (await call("carol", "POST", "/app/api/connect/token", { label: "cli" })).json()) as { token: string }).token;
    await disableMember(e, "carol", OPS);
    await expect(provider.verifyAccessToken(oauthToken)).rejects.toBeInstanceOf(InvalidTokenError);
    await expect(provider.verifyAccessToken(pat)).rejects.toBeInstanceOf(InvalidTokenError);
  });
});

/** The test storage, with the first statement starting with `prefix` failing (inside transactions too). */
function failing(prefix: string): Storage {
  const fail = (sql: string) => sql.trimStart().startsWith(prefix);
  const wrap = (target: Engine): Engine => new Proxy(target, {
    get(t, k) {
      if (k === "query") {
        return async (sql: string, params?: unknown[]) => {
          if (fail(sql)) throw new Error(`injected failure at ${prefix}`);
          return t.query(sql, params);
        };
      }
      if (k === "transaction") return <T>(fn: (tx: Engine) => Promise<T>) => t.transaction(tx => fn(wrap(tx)));
      const v = Reflect.get(t, k, t) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
  const engine = wrap(storage.engine());
  return new Proxy(storage, {
    get(t, k) {
      if (k === "engine" || k === "raw") return () => engine;
      const v = Reflect.get(t, k, t) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
}
