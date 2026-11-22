/**
 * Team operations without shell access to the host: enrollment codes and
 * member grants over the admin API, a replacement code that keeps a person's
 * spend key, redirect URIs changed without rotating the secret, a soft revoke
 * of a client, and the OAuth client hygiene doctor check.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { OAuthProvider, type OAuthClientInfo } from "../src/core/oauth-provider.ts";
import { registerSource } from "../src/core/sources.ts";
import { runWithSpendClient, setSpendLedgerEngine, trackedInvoke } from "../src/core/budget.ts";
import { createAdminAuth } from "../src/http/admin.ts";
import { handleAdminApi } from "../src/http/admin-api.ts";
import { checkOauthClientHygiene } from "../src/core/doctor-tenancy.ts";
import { runAuth } from "../src/commands/auth.ts";

const HAIKU = "eu.anthropic.claude-haiku-4-5-20251001-v1:0";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const CB = "https://claude.example/api/mcp/auth_callback";
const CB2 = "https://claude.example/api/mcp/auth_callback_v2";
const OPS = { actor: "test", via: "cli" } as const;

let tmp: string;
let pgPath: string;
let storage: Storage;
let provider: OAuthProvider;
const origConfigPath = process.env.MEMRAIN_CONFIG_PATH;

async function open(): Promise<void> {
  storage = new Storage({ dbPath: pgPath });
  await storage.init();
  setSpendLedgerEngine(storage.engine());
  provider = new OAuthProvider({ engine: storage.raw() });
}

async function close(): Promise<void> {
  setSpendLedgerEngine(null);
  await storage.close();
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-teamops-"));
  const cfgDir = join(tmp, ".memex");
  mkdirSync(cfgDir, { recursive: true });
  pgPath = join(cfgDir, "brain.pglite");
  const cfgPath = join(cfgDir, "config.json");
  writeFileSync(
    cfgPath,
    JSON.stringify({
      database: { type: "pglite", path: pgPath },
      embedding: { provider: "bedrock-titan", model: "amazon.titan-embed-text-v2:0", region: "eu-west-1" },
      storage: {},
    }),
  );
  process.env.MEMRAIN_CONFIG_PATH = cfgPath;
  await open();
  const e = storage.engine();
  await registerSource(e, { id: "alice", kind: "other", pathPrefix: "tenant:alice" });
  await registerSource(e, { id: "bob", kind: "other", pathPrefix: "tenant:bob" });
});

afterEach(async () => {
  await close();
  rmSync(tmp, { recursive: true, force: true });
});

afterAll(() => {
  if (origConfigPath === undefined) delete process.env.MEMRAIN_CONFIG_PATH;
  else process.env.MEMRAIN_CONFIG_PATH = origConfigPath;
});

/** A confidential browser connector shaped like claude-web. */
async function connector(tenantMode: "client" | "enrollment" = "enrollment"): Promise<{ client: OAuthClientInfo; secret: string }> {
  const reg = await provider.registerClientManual(
    "team-connector",
    ["authorization_code", "refresh_token"],
    "read write",
    [CB],
    "default",
    undefined,
    undefined,
    undefined,
    tenantMode,
  );
  return { client: (await provider.getClient(reg.clientId))!, secret: reg.clientSecret! };
}

/** Redeem `code` on `client` and run the rest of the OAuth dance. */
async function redeem(client: OAuthClientInfo, code: string) {
  const grant = await provider.claimEnrollment(code, client.client_id);
  expect(grant).toBeDefined();
  const { redirectUrl } = await provider.authorize(
    client,
    { redirectUri: CB, codeChallenge: CHALLENGE, scopes: ["read", "write"] },
    grant,
  );
  const authCode = new URL(redirectUrl).searchParams.get("code")!;
  return provider.exchangeAuthorizationCode(client, authCode, undefined, CB);
}

async function spendAs(token: string, usd: number): Promise<void> {
  const info = await provider.verifyAccessToken(token);
  await runWithSpendClient({ clientId: info.spendId ?? info.clientId, capUsd: info.budgetUsdPerDay }, () =>
    trackedInvoke({ operation: "think", model: HAIKU, worstCase: { input: "x", maxOutputTokens: 0 } }, async (m) => {
      m.report({ inputTokens: Math.round(usd * 1_000_000), outputTokens: 0 });
    }),
  );
}

async function auditActions(enrollmentId: string): Promise<string[]> {
  const r = await storage.raw().query<{ action: string }>(
    "SELECT action FROM oauth_enrollment_audit WHERE enrollment_id = $1 ORDER BY id",
    [enrollmentId],
  );
  return r.rows.map((x) => x.action);
}

describe("enroll --replaces", () => {
  it("keeps the person's spend key and cap, and revokes the old grant on redemption", async () => {
    const { client } = await connector();
    const first = await provider.issueEnrollment({ sourceId: "alice", label: "alice", clientId: client.client_id }, OPS);
    const oldTokens = await redeem(client, first.code);
    expect(await provider.setClientBudget(first.id, 0.5)).toBe(true);
    await spendAs(oldTokens.access_token, 0.3);

    const second = await provider.issueEnrollment({ replaces: first.id }, OPS);
    expect(second.spendId).toBe(first.id);
    expect(second.sourceId).toBe("alice");
    expect(second.clientId).toBe(client.client_id);
    expect(second.label).toBe("alice");
    // Issuing the replacement changes nothing yet: the old grant still works.
    await provider.verifyAccessToken(oldTokens.access_token);

    const newTokens = await redeem(client, second.code);
    const info = await provider.verifyAccessToken(newTokens.access_token);
    expect(info.spendId).toBe(first.id);
    expect(info.sourceId).toBe("alice");
    expect(info.budgetUsdPerDay).toBe(0.5);

    // The old grant died with the redemption, refresh included.
    await expect(provider.verifyAccessToken(oldTokens.access_token)).rejects.toThrow();
    await expect(provider.exchangeRefreshToken(client, oldTokens.refresh_token!)).rejects.toThrow();

    // 0.3 already spent under the key: 0.3 more crosses the 0.5 cap.
    await spendAs(newTokens.access_token, 0.3);
    await expect(spendAs(newTokens.access_token, 0.01)).rejects.toMatchObject({ code: "budget_exhausted" });
    const booked = await storage.raw().query<{ client_id: string }>(
      "SELECT DISTINCT client_id FROM mcp_spend_log",
    );
    expect(booked.rows.map((r) => r.client_id)).toEqual([first.id]);

    // The cap is still addressable by the original key after the swap.
    expect(await provider.setClientBudget(first.id, 5)).toBe(true);
    expect((await provider.verifyAccessToken(newTokens.access_token)).budgetUsdPerDay).toBe(5);

    expect(await auditActions(first.id)).toEqual(["issue", "replaced"]);
    expect(await auditActions(second.id)).toEqual(["issue"]);
  });

  it("chains: a replacement of a replacement still spends under the first key", async () => {
    const { client } = await connector();
    const a = await provider.issueEnrollment({ sourceId: "alice", clientId: client.client_id }, OPS);
    const b = await provider.issueEnrollment({ replaces: a.id }, OPS);
    const c = await provider.issueEnrollment({ replaces: b.id }, OPS);
    expect(c.spendId).toBe(a.id);
    const tokens = await redeem(client, c.code);
    expect((await provider.verifyAccessToken(tokens.access_token)).spendId).toBe(a.id);
  });

  it("a new replacement revokes the unredeemed one it supersedes", async () => {
    const { client } = await connector();
    const first = await provider.issueEnrollment({ sourceId: "alice", clientId: client.client_id }, OPS);
    await redeem(client, first.code);
    const stale = await provider.issueEnrollment({ replaces: first.id }, OPS);
    const fresh = await provider.issueEnrollment({ replaces: first.id }, OPS);
    expect(await provider.claimEnrollment(stale.code, client.client_id)).toBeUndefined();
    expect(await auditActions(stale.id)).toEqual(["issue", "revoke_code"]);
    await redeem(client, fresh.code);
  });

  it("refuses to inherit a predecessor's client that was deleted", async () => {
    const { client } = await connector();
    const first = await provider.issueEnrollment({ sourceId: "alice", clientId: client.client_id }, OPS);
    await storage.raw().query("UPDATE oauth_clients SET deleted_at = NOW() WHERE client_id = $1", [client.client_id]);
    await expect(provider.issueEnrollment({ replaces: first.id }, OPS)).rejects.toThrow(
      `Unknown client '${client.client_id}'`,
    );
    const other = (await connector()).client;
    const r = await provider.issueEnrollment({ replaces: first.id, clientId: other.client_id }, OPS);
    expect(r.clientId).toBe(other.client_id);
  });

  it("refuses an unknown predecessor and a code with no source at all", async () => {
    await expect(provider.issueEnrollment({ replaces: "memex_enr_nope" }, OPS)).rejects.toThrow("Unknown enrollment");
    await expect(provider.issueEnrollment({}, OPS)).rejects.toThrow("needs a source");
  });
});

describe("setRedirectUris", () => {
  it("changes a confidential client's redirect URIs and keeps its secret and sessions", async () => {
    const { client, secret } = await connector("client");
    const hashBefore = (
      await storage.raw().query<{ h: string }>("SELECT client_secret_hash AS h FROM oauth_clients WHERE client_id = $1", [
        client.client_id,
      ])
    ).rows[0]!.h;

    const live = await (async () => {
      const { redirectUrl } = await provider.authorize(client, { redirectUri: CB, codeChallenge: CHALLENGE });
      const code = new URL(redirectUrl).searchParams.get("code")!;
      return provider.exchangeAuthorizationCode(client, code, undefined, CB);
    })();
    // A code approved for the URI about to be removed, still in flight.
    const { redirectUrl: pending } = await provider.authorize(client, { redirectUri: CB, codeChallenge: CHALLENGE });
    const inFlight = new URL(pending).searchParams.get("code")!;

    const r = await provider.setRedirectUris(client.client_id, [CB2, "http://127.0.0.1:8765/cb"], OPS);
    expect(r.before).toEqual([CB]);
    expect(r.after).toEqual([CB2, "http://127.0.0.1:8765/cb"]);
    expect(r.removed).toEqual([CB]);

    const after = (await provider.getClient(client.client_id))!;
    expect(after.redirect_uris).toEqual([CB2, "http://127.0.0.1:8765/cb"]);
    const hashAfter = (
      await storage.raw().query<{ h: string }>("SELECT client_secret_hash AS h FROM oauth_clients WHERE client_id = $1", [
        client.client_id,
      ])
    ).rows[0]!.h;
    expect(hashAfter).toBe(hashBefore);
    expect(await provider.verifyConfidentialClientSecret(client.client_id, secret)).toBeDefined();

    // Issued sessions carry on; the in-flight code for the old URI does not.
    await provider.verifyAccessToken(live.access_token);
    const rotated = await provider.exchangeRefreshToken(after, live.refresh_token!);
    await provider.verifyAccessToken(rotated.access_token);
    await expect(provider.exchangeAuthorizationCode(after, inFlight, undefined, CB)).rejects.toThrow();

    const history = await provider.listGrantAudit(client.client_id);
    expect(history[0]!.revision).toBe(r.revision);
    expect(history[0]!.after).toMatchObject({ action: "set_redirect_uris", redirect_uris: r.after });
    expect(history[0]!.before).toMatchObject({ redirect_uris: [CB] });
  });

  it("an approval made before the change mints no code for the removed URI", async () => {
    const { client } = await connector("client");
    // `client` is the endpoint's earlier read; the change commits before authorize runs.
    await provider.setRedirectUris(client.client_id, [CB2], OPS);
    await expect(
      provider.authorize(client, { redirectUri: CB, codeChallenge: CHALLENGE }),
    ).rejects.toMatchObject({ code: "grant_conflict" });

    const enrolled = (await connector()).client;
    const enr = await provider.issueEnrollment({ sourceId: "alice", clientId: enrolled.client_id }, OPS);
    const grant = await provider.claimEnrollment(enr.code, enrolled.client_id);
    await provider.setRedirectUris(enrolled.client_id, [CB2], OPS);
    await expect(
      provider.authorize(enrolled, { redirectUri: CB, codeChallenge: CHALLENGE }, grant),
    ).rejects.toMatchObject({ code: "grant_conflict" });
    const codes = await storage.raw().query<{ n: number }>("SELECT count(*)::int AS n FROM oauth_codes");
    expect(Number(codes.rows[0]!.n)).toBe(0);
  });

  it("refuses plain http off loopback, an empty list and a stale revision", async () => {
    const { client } = await connector("client");
    await expect(provider.setRedirectUris(client.client_id, ["http://evil.example/cb"], OPS)).rejects.toThrow("https");
    await expect(provider.setRedirectUris(client.client_id, [], OPS)).rejects.toThrow("at least one");
    await expect(
      provider.setRedirectUris(client.client_id, [CB2], { ...OPS, expectedRevision: 7 }),
    ).rejects.toMatchObject({ code: "grant_conflict" });
    expect((await provider.getClient(client.client_id))!.redirect_uris).toEqual([CB]);
  });
});

describe("revokeClient", () => {
  it("soft-deletes, kills tokens and codes, and keeps audit and spend rows", async () => {
    const { client } = await connector("client");
    const { redirectUrl } = await provider.authorize(client, { redirectUri: CB, codeChallenge: CHALLENGE });
    const code = new URL(redirectUrl).searchParams.get("code")!;
    const tokens = await provider.exchangeAuthorizationCode(client, code, undefined, CB);
    await spendAs(tokens.access_token, 0.01);
    const { redirectUrl: pending } = await provider.authorize(client, { redirectUri: CB, codeChallenge: CHALLENGE });

    const r = await provider.revokeClient(client.client_id, OPS);
    expect(r.revoked).toBe(true);
    expect(r.deleted).toEqual({ accessTokens: 1, refreshTokens: 1, codes: 1 });

    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow();
    await expect(provider.exchangeRefreshToken(client, tokens.refresh_token!)).rejects.toThrow();
    const pendingCode = new URL(pending).searchParams.get("code")!;
    await expect(provider.exchangeAuthorizationCode(client, pendingCode, undefined, CB)).rejects.toThrow();
    expect(await provider.getClient(client.client_id)).toBeUndefined();

    const row = await storage.raw().query<{ deleted: boolean }>(
      "SELECT deleted_at IS NOT NULL AS deleted FROM oauth_clients WHERE client_id = $1",
      [client.client_id],
    );
    expect(row.rows[0]?.deleted).toBe(true);
    const spend = await storage.raw().query<{ n: number }>(
      "SELECT count(*)::int AS n FROM mcp_spend_log WHERE client_id = $1",
      [client.client_id],
    );
    expect(spend.rows[0]?.n).toBe(1);
    expect((await provider.listGrantAudit(client.client_id))[0]!.after).toMatchObject({ action: "revoke_client" });

    // Again: nothing left to revoke, and no second audit row.
    const again = await provider.revokeClient(client.client_id, OPS);
    expect(again.revoked).toBe(false);
    expect(await provider.listGrantAudit(client.client_id)).toHaveLength(1);
    await expect(provider.revokeClient("memex_cl_nope", OPS)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("auth CLI", () => {
  async function cli(args: string[]): Promise<Record<string, unknown>> {
    const logs: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    });
    try {
      await runAuth(args);
    } finally {
      spy.mockRestore();
    }
    return JSON.parse(logs.join("\n")) as Record<string, unknown>;
  }

  it("revoke-client soft-deletes; set-redirect-uris keeps the secret; enroll --replaces carries the key", async () => {
    const { client } = await connector();
    const first = await provider.issueEnrollment({ sourceId: "alice", clientId: client.client_id }, OPS);
    const other = await connector("client");
    await close();

    const redirects = await cli(["set-redirect-uris", client.client_id, CB2]);
    expect(redirects).toMatchObject({ after: [CB2], removed: [CB] });

    const replaced = await cli(["enroll", "--replaces", first.id, "--ttl", "1d"]);
    expect(replaced).toMatchObject({ source_id: "alice", spend_id: first.id, replaces: first.id });
    expect(typeof replaced["code"]).toBe("string");

    const revoked = await cli(["revoke-client", other.client.client_id]);
    expect(revoked).toMatchObject({ revoked: true, client_id: other.client.client_id });

    await open();
    const rows = await storage.raw().query<{ client_id: string; deleted: boolean; secret: string | null }>(
      `SELECT client_id, deleted_at IS NOT NULL AS deleted, client_secret_hash AS secret
         FROM oauth_clients ORDER BY client_id`,
    );
    const byId = new Map(rows.rows.map((r) => [r.client_id, r]));
    expect(byId.get(other.client.client_id)?.deleted).toBe(true);
    expect(byId.get(client.client_id)?.deleted).toBe(false);
    expect(byId.get(client.client_id)?.secret).not.toBeNull();
    const enrollAudit = await storage.raw().query<{ actor: string; via: string }>(
      "SELECT actor, via FROM oauth_enrollment_audit WHERE enrollment_id = $1",
      [replaced["enrollment_id"]],
    );
    expect(enrollAudit.rows[0]?.via).toBe("cli");
  });

  it("revoke-client --purge still hard-deletes", async () => {
    const { client } = await connector("client");
    await close();
    expect(await cli(["revoke-client", client.client_id, "--purge"])).toMatchObject({ purged: true });
    await open();
    const n = await storage.raw().query<{ n: number }>("SELECT count(*)::int AS n FROM oauth_clients WHERE client_id = $1", [
      client.client_id,
    ]);
    expect(n.rows[0]?.n).toBe(0);
  });
});

describe("admin API: enrollments and member grants", () => {
  const BOOT = "boot-secret";
  let auth: ReturnType<typeof createAdminAuth>;
  let cookie: string;

  beforeAll(() => {
    auth = createAdminAuth({ bootstrapToken: BOOT });
  });

  async function login(): Promise<void> {
    const r = await auth.handleAuthRoute(
      new Request("http://localhost:8080/admin/login", { method: "POST", body: JSON.stringify({ token: BOOT }) }),
      new URL("http://localhost:8080/admin/login"),
    );
    cookie = (r!.headers.get("Set-Cookie") ?? "").split(";")[0]!;
  }

  async function call(path: string, body?: unknown, withCookie = true): Promise<Response> {
    const init: RequestInit = body === undefined ? {} : { method: "POST", body: JSON.stringify(body) };
    if (withCookie) init.headers = { cookie };
    const res = await handleAdminApi(new Request(`http://localhost:8080${path}`, init), new URL(`http://localhost:8080${path}`), {
      storage,
      requireAdmin: auth.requireAdmin,
      sessionFresh: auth.sessionFresh,
    });
    return res!;
  }

  it("401s the new routes without a session", async () => {
    for (const [path, body] of [
      ["/admin/api/enrollments?client_id=x", undefined],
      ["/admin/api/enrollments", {}],
      ["/admin/api/revoke-enrollment", {}],
      ["/admin/api/revoke-grant", {}],
      ["/admin/api/set-redirect-uris", {}],
    ] as const) {
      expect((await call(path, body, false)).status).toBe(401);
    }
  });

  it("issues, lists, and revokes codes and redeemed members, audited as admin", async () => {
    await login();
    const { client } = await connector();
    const issued = (await (
      await call("/admin/api/enrollments", { source: "alice", label: "Alice", client_id: client.client_id })
    ).json()) as { enrollment_id: string; code: string };
    const tokens = await redeem(client, issued.code);
    const pending = (await (
      await call("/admin/api/enrollments", { source: "bob", label: "Bob", client_id: client.client_id })
    ).json()) as { enrollment_id: string };

    const listed = (await (await call(`/admin/api/enrollments?client_id=${client.client_id}`)).json()) as {
      enrollments: { id: string; used_at: string | null; last_token_at: string | null; spend_id: string }[];
    };
    const alice = listed.enrollments.find((e) => e.id === issued.enrollment_id)!;
    expect(alice.used_at).not.toBeNull();
    expect(alice.last_token_at).not.toBeNull();
    expect(alice.spend_id).toBe(issued.enrollment_id);
    expect(JSON.stringify(listed)).not.toContain(issued.code);

    // A redeemed member is not a live code: revoke-enrollment refuses it.
    expect((await call("/admin/api/revoke-enrollment", { id: issued.enrollment_id })).status).toBe(404);
    expect((await call("/admin/api/revoke-enrollment", { id: pending.enrollment_id })).status).toBe(200);

    const cut = await call("/admin/api/revoke-grant", { id: issued.enrollment_id });
    expect(cut.status).toBe(200);
    expect(((await cut.json()) as { tokens_deleted: number }).tokens_deleted).toBe(2);
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow();
    expect((await call("/admin/api/revoke-grant", { id: "memex_enr_nope" })).status).toBe(404);

    const trail = await storage.raw().query<{ action: string; actor: string; via: string }>(
      "SELECT action, actor, via FROM oauth_enrollment_audit WHERE enrollment_id = ANY($1::text[]) ORDER BY id",
      [[issued.enrollment_id, pending.enrollment_id]],
    );
    expect(trail.rows.map((r) => r.action)).toEqual(["issue", "issue", "revoke_code", "revoke_grant"]);
    expect(trail.rows.every((r) => r.actor === "admin" && r.via === "admin_api")).toBe(true);
  });

  it("refuses bad input with 400 and an unknown client with 404", async () => {
    await login();
    const { client } = await connector("client");
    expect((await call("/admin/api/enrollments", { label: "x" })).status).toBe(400);
    expect((await call("/admin/api/enrollments", { source: "nope" })).status).toBe(400);
    // Pinning a code to a client-mode connector is refused, as on the CLI.
    expect((await call("/admin/api/enrollments", { source: "alice", client_id: client.client_id })).status).toBe(400);
    expect(
      (await call("/admin/api/set-redirect-uris", { client_id: client.client_id, redirect_uris: ["http://evil.example/cb"] }))
        .status,
    ).toBe(400);
    expect((await call("/admin/api/set-redirect-uris", { client_id: "memex_cl_nope", redirect_uris: [CB2] })).status).toBe(404);
    const ok = await call("/admin/api/set-redirect-uris", { client_id: client.client_id, redirect_uris: [CB2] });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { removed: string[] }).removed).toEqual([CB]);
  });
});

describe("oauth-client-hygiene", () => {
  it("is ok with no clients, and for a used confidential read/write connector", async () => {
    expect((await checkOauthClientHygiene(storage.raw())).detail).toContain("no OAuth clients");
    const { client } = await connector("client");
    await storage.raw().query(
      `INSERT INTO mcp_request_log (token_name, operation, latency_ms, status) VALUES ($1, 'search', 5, 'success')`,
      [client.client_id],
    );
    const c = await checkOauthClientHygiene(storage.raw());
    expect(c.status).toBe("ok");
  });

  it("warns on idle, public client-mode, non-https redirect and wide-scoped connectors", async () => {
    const e = storage.raw();
    await e.query(
      `INSERT INTO oauth_clients (client_id, client_name, client_secret_hash, grant_types, scope, redirect_uris, tenant_mode)
       VALUES ('c-idle', 'cloud-app', 'h', '{client_credentials}', 'read', '{}', 'client'),
              ('c-pub', 'pub', NULL, '{authorization_code}', 'read', '{https://ok.example/cb}', 'client'),
              ('c-pub-enr', 'pub-enr', NULL, '{authorization_code}', 'read', '{https://ok.example/cb}', 'enrollment'),
              ('c-http', 'plain', 'h', '{authorization_code}', 'read', '{http://plain.example/cb}', 'client'),
              ('c-wide', 'wide', 'h', '{authorization_code,refresh_token}', 'read write admin', '{https://ok.example/cb}', 'client'),
              ('c-gone', 'gone', NULL, '{authorization_code}', 'admin', '{http://gone.example/cb}', 'client')`,
    );
    await e.query(`UPDATE oauth_clients SET deleted_at = now() WHERE client_id = 'c-gone'`);
    for (const id of ["c-pub", "c-pub-enr", "c-http", "c-wide"]) {
      await e.query(
        `INSERT INTO mcp_request_log (token_name, operation, latency_ms, status) VALUES ($1, 'search', 5, 'success')`,
        [id],
      );
    }
    // A call older than 90 days does not count.
    await e.query(
      `INSERT INTO mcp_request_log (token_name, operation, latency_ms, status, created_at)
       VALUES ('c-idle', 'search', 5, 'success', now() - interval '91 days')`,
    );
    const c = await checkOauthClientHygiene(e);
    expect(c.status).toBe("warn");
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("1 client(s) with no call in 90 days: cloud-app (c-idle)");
    expect(c.detail).toContain("1 public client(s) in client tenant mode: pub (c-pub)");
    expect(c.detail).toContain("plain (c-http): http://plain.example/cb");
    expect(c.detail).toContain("wide (c-wide) [read write admin]");
    expect(c.detail).not.toContain("gone");
    expect(c.detail).not.toContain("pub-enr");
  });

  it("reports a probe that throws as a warn", async () => {
    await storage.raw().query("ALTER TABLE mcp_request_log RENAME TO mcp_request_log_hidden");
    await storage.raw().query(`INSERT INTO oauth_clients (client_id, client_name) VALUES ('c1', 'one')`);
    const c = await checkOauthClientHygiene(storage.raw());
    expect(c.status).toBe("warn");
    expect(c.detail).toStartWith("could not check oauth-client-hygiene: ");
  });
});
