/**
 * Token lifecycle: refresh families with reuse detection, grant_types
 * enforcement, the DCR scope default, per-client token lifetimes, operator
 * token invalidation, the consent re-check at code exchange, and personal
 * access tokens minted with a source and scopes.
 */
import { afterEach, beforeEach, describe, expect, it, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { Storage } from "../src/core/storage.ts";
import {
  GrantNotFoundError,
  GrantValidationError,
  OAuthProvider,
  REFRESH_REUSE_GRACE_SECONDS,
  clientAllowsGrant,
  resolvePatGrant,
  type GrantScope,
  type OAuthClientInfo,
  type OAuthTokens,
} from "../src/core/oauth-provider.ts";
import { handleAuthorizeRoute, handleTokenRoute } from "../src/http/oauth-endpoints.ts";
import { createAdminAuth } from "../src/http/admin.ts";
import { handleAdminApi } from "../src/http/admin-api.ts";
import { registerSource } from "../src/core/sources.ts";
import { parseClientTtlFlag } from "../src/commands/auth.ts";

const REDIRECT = "https://client.example/cb";

let tmp: string;
let storage: Storage;
let provider: OAuthProvider;

const sha = (v: string) => createHash("sha256").update(v, "utf8").digest("hex");

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-token-life-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  provider = new OAuthProvider({ engine: storage.raw() });
  await registerSource(storage.raw(), { id: "acme", kind: "other", pathPrefix: "/acme" });
  await registerSource(storage.raw(), { id: "beta", kind: "other", pathPrefix: "/beta" });
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function webClient(
  grantTypes: string[] = ["authorization_code", "refresh_token"],
  ttls?: { accessTtlSeconds?: number; refreshTtlSeconds?: number },
): Promise<OAuthClientInfo> {
  const { clientId } = await provider.registerClientManual(
    "web",
    grantTypes,
    "read write",
    [REDIRECT],
    "acme",
    undefined,
    undefined,
    undefined,
    "client",
    ttls,
  );
  return (await provider.getClient(clientId))!;
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function code(client: OAuthClientInfo, grant?: GrantScope): Promise<string> {
  const { challenge } = pkce();
  const { redirectUrl } = await provider.authorize(client, { codeChallenge: challenge, redirectUri: REDIRECT }, grant);
  return new URL(redirectUrl).searchParams.get("code")!;
}

async function signIn(client: OAuthClientInfo, grant?: GrantScope): Promise<OAuthTokens> {
  return provider.exchangeAuthorizationCode(client, await code(client, grant), undefined, REDIRECT);
}

async function tokenRow(token: string): Promise<{ family_id: string | null; expires_at: number } | undefined> {
  const r = await storage.raw().query<{ family_id: string | null; expires_at: number | string }>(
    "SELECT family_id, expires_at FROM oauth_tokens WHERE token_hash = $1",
    [sha(token)],
  );
  const row = r.rows[0];
  return row ? { family_id: row.family_id, expires_at: Number(row.expires_at) } : undefined;
}

/** Age the tombstone of a consumed refresh token past the grace window. */
async function ageTombstone(refreshToken: string): Promise<void> {
  await storage.raw().query(
    "UPDATE oauth_refresh_consumed SET consumed_at = consumed_at - $2 WHERE token_hash = $1",
    [sha(refreshToken), REFRESH_REUSE_GRACE_SECONDS + 5],
  );
}

describe("refresh token families", () => {
  it("every token of one sign-in shares a family, and rotation keeps it", async () => {
    const client = await webClient();
    const first = await signIn(client);
    const family = (await tokenRow(first.access_token))!.family_id;
    expect(family).toBeTruthy();
    expect((await tokenRow(first.refresh_token!))!.family_id).toBe(family);

    const second = await provider.exchangeRefreshToken(client, first.refresh_token!);
    expect((await tokenRow(second.access_token))!.family_id).toBe(family);
    expect((await tokenRow(second.refresh_token!))!.family_id).toBe(family);
    const spent = await storage.raw().query<{ family_id: string }>(
      "SELECT family_id FROM oauth_refresh_consumed WHERE token_hash = $1",
      [sha(first.refresh_token!)],
    );
    expect(spent.rows[0]?.family_id).toBe(family!);
  });

  it("a replay inside the grace window is refused and revokes nothing", async () => {
    const client = await webClient();
    const first = await signIn(client);
    const second = await provider.exchangeRefreshToken(client, first.refresh_token!);

    await expect(provider.exchangeRefreshToken(client, first.refresh_token!)).rejects.toThrow("already used");
    // The rotated session is untouched.
    expect((await provider.verifyAccessToken(second.access_token)).clientId).toBe(client.client_id);
    const third = await provider.exchangeRefreshToken(client, second.refresh_token!);
    expect(third.access_token).toMatch(/^memrain_at_/);
  });

  it("a replay after the grace window is refused and only logged by default", async () => {
    const saved = process.env.MEMRAIN_OAUTH_REFRESH_REUSE_REVOKE;
    delete process.env.MEMRAIN_OAUTH_REFRESH_REUSE_REVOKE;
    try {
      const client = await webClient();
      const first = await signIn(client);
      const second = await provider.exchangeRefreshToken(client, first.refresh_token!);
      await ageTombstone(first.refresh_token!);

      const err = await provider.exchangeRefreshToken(client, first.refresh_token!).catch((e: Error) => e);
      expect((err as Error).message).toBe("Refresh token reuse detected");
      expect((await provider.verifyAccessToken(second.access_token)).clientId).toBe(client.client_id);
      await provider.exchangeRefreshToken(client, second.refresh_token!);
    } finally {
      if (saved === undefined) delete process.env.MEMRAIN_OAUTH_REFRESH_REUSE_REVOKE;
      else process.env.MEMRAIN_OAUTH_REFRESH_REUSE_REVOKE = saved;
    }
  });

  it("a replay after the grace window revokes every live token of the family", async () => {
    const saved = process.env.MEMRAIN_OAUTH_REFRESH_REUSE_REVOKE;
    process.env.MEMRAIN_OAUTH_REFRESH_REUSE_REVOKE = "1";
    try {
      const client = await webClient();
      const other = await signIn(client); // a second, unrelated session
      const first = await signIn(client);
      const second = await provider.exchangeRefreshToken(client, first.refresh_token!);
      await ageTombstone(first.refresh_token!);

      await expect(provider.exchangeRefreshToken(client, first.refresh_token!)).rejects.toThrow("reuse detected");
      await expect(provider.verifyAccessToken(second.access_token)).rejects.toThrow();
      await expect(provider.exchangeRefreshToken(client, second.refresh_token!)).rejects.toThrow();
      // Another family of the same client is not touched.
      expect((await provider.verifyAccessToken(other.access_token)).clientId).toBe(client.client_id);
      await provider.exchangeRefreshToken(client, other.refresh_token!);
    } finally {
      if (saved === undefined) delete process.env.MEMRAIN_OAUTH_REFRESH_REUSE_REVOKE;
      else process.env.MEMRAIN_OAUTH_REFRESH_REUSE_REVOKE = saved;
    }
  });

  it("a spent token past its own expiry cannot revoke its family, swept or not", async () => {
    const saved = process.env.MEMRAIN_OAUTH_REFRESH_REUSE_REVOKE;
    process.env.MEMRAIN_OAUTH_REFRESH_REUSE_REVOKE = "1";
    try {
      const client = await webClient();
      const first = await signIn(client);
      const second = await provider.exchangeRefreshToken(client, first.refresh_token!);
      await ageTombstone(first.refresh_token!);
      await storage.raw().query(
        "UPDATE oauth_refresh_consumed SET expires_at = 1 WHERE token_hash = $1",
        [sha(first.refresh_token!)],
      );

      await expect(provider.exchangeRefreshToken(client, first.refresh_token!)).rejects.toThrow("not found");
      expect((await provider.verifyAccessToken(second.access_token)).clientId).toBe(client.client_id);
      await provider.exchangeRefreshToken(client, second.refresh_token!);
    } finally {
      if (saved === undefined) delete process.env.MEMRAIN_OAUTH_REFRESH_REUSE_REVOKE;
      else process.env.MEMRAIN_OAUTH_REFRESH_REUSE_REVOKE = saved;
    }
  });

  it("a spent token presented by ANOTHER client revokes nothing", async () => {
    const victim = await webClient();
    const attacker = await webClient();
    const first = await signIn(victim);
    const second = await provider.exchangeRefreshToken(victim, first.refresh_token!);
    await ageTombstone(first.refresh_token!);

    await expect(provider.exchangeRefreshToken(attacker, first.refresh_token!)).rejects.toThrow("not found");
    expect((await provider.verifyAccessToken(second.access_token)).clientId).toBe(victim.client_id);
  });

  it("a refresh token minted before families rotates normally and starts one", async () => {
    const client = await webClient();
    const legacy = await signIn(client);
    await storage.raw().query("UPDATE oauth_tokens SET family_id = NULL WHERE client_id = $1", [client.client_id]);

    const rotated = await provider.exchangeRefreshToken(client, legacy.refresh_token!);
    const family = (await tokenRow(rotated.refresh_token!))!.family_id;
    expect(family).toBeTruthy();
    expect((await tokenRow(rotated.access_token))!.family_id).toBe(family);
    // The old access token (no family) keeps working until it expires.
    expect((await provider.verifyAccessToken(legacy.access_token)).clientId).toBe(client.client_id);
    await provider.exchangeRefreshToken(client, rotated.refresh_token!);
  });

  it("two concurrent refreshes of one token: one wins, the other is refused, the winner lives", async () => {
    const client = await webClient();
    const first = await signIn(client);
    const results = await Promise.allSettled([
      provider.exchangeRefreshToken(client, first.refresh_token!),
      provider.exchangeRefreshToken(client, first.refresh_token!),
    ]);
    const won = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<OAuthTokens>[];
    expect(won.length).toBe(1);
    expect(results.filter((r) => r.status === "rejected").length).toBe(1);
    await provider.exchangeRefreshToken(client, won[0]!.value.refresh_token!);
  });

  it("the sweep prunes a tombstone once the spent token would have expired", async () => {
    const client = await webClient();
    const first = await signIn(client);
    await provider.exchangeRefreshToken(client, first.refresh_token!);
    await storage.raw().query("UPDATE oauth_refresh_consumed SET expires_at = 1");
    await provider.sweepExpiredTokens();
    const left = await storage.raw().query("SELECT 1 FROM oauth_refresh_consumed");
    expect(left.rows.length).toBe(0);
  });
});

describe("grant_types enforcement", () => {
  test("an empty list keeps the historical browser grants, never client_credentials", () => {
    expect(clientAllowsGrant([], "authorization_code")).toBe(true);
    expect(clientAllowsGrant([], "refresh_token")).toBe(true);
    expect(clientAllowsGrant([], "client_credentials")).toBe(false);
    expect(clientAllowsGrant(["client_credentials"], "authorization_code")).toBe(false);
  });

  it("a NULL row reads as client_credentials here exactly as getClient reads it", async () => {
    const client = await webClient();
    await storage.raw().query("UPDATE oauth_clients SET grant_types = NULL WHERE client_id = $1", [client.client_id]);
    const read = (await provider.getClient(client.client_id))!;
    for (const grant of ["authorization_code", "refresh_token", "client_credentials"]) {
      expect(clientAllowsGrant(null, grant)).toBe(clientAllowsGrant(read.grant_types, grant));
    }
    expect(clientAllowsGrant(null, "refresh_token")).toBe(false);
  });

  it("/authorize answers unauthorized_client for a client without authorization_code", async () => {
    const client = await webClient(["client_credentials"]);
    const { challenge } = pkce();
    const q = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      response_type: "code",
      code_challenge: challenge,
      state: "s1",
    });
    const res = await handleAuthorizeRoute(new Request(`http://localhost/authorize?${q}`), provider, () => true, true);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!);
    expect(loc.searchParams.get("error")).toBe("unauthorized_client");
    expect(loc.searchParams.get("state")).toBe("s1");
    expect(loc.searchParams.get("code")).toBeNull();
  });

  it("a client without refresh_token gets no refresh token and cannot refresh", async () => {
    const onlyCode = await webClient(["authorization_code"]);
    const tokens = await signIn(onlyCode);
    expect(tokens.refresh_token).toBeUndefined();

    // A refresh token it holds from before its grants were narrowed is refused.
    const client = await webClient();
    const held = await signIn(client);
    await storage.raw().query("UPDATE oauth_clients SET grant_types = '{authorization_code}' WHERE client_id = $1", [
      client.client_id,
    ]);
    const narrowed = (await provider.getClient(client.client_id))!;
    await expect(provider.exchangeRefreshToken(narrowed, held.refresh_token!)).rejects.toThrow("not authorized");

    const res = await handleTokenRoute(
      new Request("http://localhost/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: held.refresh_token!,
          client_id: client.client_id,
          client_secret: "wrong-on-purpose",
        }).toString(),
      }),
      provider,
      true,
    );
    // Client authentication runs first and fails closed on the bad secret.
    expect(res.status).toBe(401);
  });

  it("the refresh refusal at /token is unauthorized_client for an authenticated client", async () => {
    const { clientId, clientSecret } = await provider.registerClientManual(
      "narrow", ["authorization_code"], "read", [REDIRECT], "acme",
    );
    const res = await handleTokenRoute(
      new Request("http://localhost/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: "memex_rt_whatever",
          client_id: clientId,
          client_secret: clientSecret!,
        }).toString(),
      }),
      provider,
      true,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("unauthorized_client");
  });

  it("migration 117 records the browser grants an existing redirect-URI client was already using", async () => {
    const engine = storage.raw();
    await engine.query(
      `INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris, grant_types, scope, source_id, federated_read)
       VALUES ('old-web', 'h', 'old', $1::text[], '{client_credentials}', 'read', 'acme', '{acme}'),
              ('old-code', 'h', 'old', $1::text[], '{authorization_code}', 'read', 'acme', '{acme}'),
              ('machine', 'h', 'm', '{}', '{client_credentials}', 'read', 'acme', '{acme}'),
              ('nulled', 'h', 'n', '{}', NULL, 'read', 'acme', '{acme}')`,
      [[REDIRECT]],
    );
    const sql = readFileSync(join(import.meta.dir, "../src/core/migrations/117_oauth_token_lifecycle.sql"), "utf8");
    await engine.exec(sql);
    await engine.exec(sql); // idempotent
    const rows = await engine.query<{ client_id: string; grant_types: string[] }>(
      "SELECT client_id, grant_types FROM oauth_clients WHERE client_id IN ('old-web','old-code','machine','nulled') ORDER BY client_id",
    );
    const by = Object.fromEntries(rows.rows.map((r) => [r.client_id, r.grant_types]));
    expect(by["old-web"]).toEqual(["client_credentials", "authorization_code", "refresh_token"]);
    expect(by["old-code"]).toEqual(["authorization_code", "refresh_token"]);
    expect(by["machine"]).toEqual(["client_credentials"]);
    expect(by["nulled"]).toEqual(["client_credentials"]);
  });
});

describe("DCR scope default", () => {
  it("a registration that names no scope gets read write", async () => {
    const reg = await provider.registerClient({ client_name: "dcr", redirect_uris: [REDIRECT] });
    expect(reg.scope).toBe("read write");
    expect((await provider.getClient(reg.client_id))!.scope).toBe("read write");
    const blank = await provider.registerClient({ client_name: "dcr2", redirect_uris: [REDIRECT], scope: " " });
    expect(blank.scope).toBe("read write");
  });

  it("a named scope is still clamped as before", async () => {
    const reg = await provider.registerClient({ client_name: "dcr", redirect_uris: [REDIRECT], scope: "read admin" });
    expect(reg.scope).toBe("read");
  });
});

describe("per-client token lifetimes", () => {
  it("are honoured at code exchange and at refresh", async () => {
    const client = await webClient(undefined, { accessTtlSeconds: 600, refreshTtlSeconds: 7200 });
    const now = Math.floor(Date.now() / 1000);
    const t = await signIn(client);
    expect(t.expires_in).toBe(600);
    const r = (await tokenRow(t.refresh_token!))!;
    expect(r.expires_at).toBeGreaterThanOrEqual(now + 7200);
    expect(r.expires_at).toBeLessThanOrEqual(now + 7205);
    const rotated = await provider.exchangeRefreshToken(client, t.refresh_token!);
    expect(rotated.expires_in).toBe(600);
  });

  test("the CLI flag reads durations, and 'default' clears", () => {
    expect(parseClientTtlFlag("access-ttl", undefined)).toBeUndefined();
    expect(parseClientTtlFlag("access-ttl", "15m")).toBe(900);
    expect(parseClientTtlFlag("refresh-ttl", "30d")).toBe(30 * 86_400);
    expect(parseClientTtlFlag("refresh-ttl", "default")).toBeNull();
    expect(() => parseClientTtlFlag("access-ttl", "soon")).toThrow("--access-ttl");
    expect(() => parseClientTtlFlag("access-ttl", "")).toThrow("--access-ttl");
  });

  it("NULL keeps the server defaults", async () => {
    const t = await signIn(await webClient());
    expect(t.expires_in).toBe(3600);
    const r = (await tokenRow(t.refresh_token!))!;
    expect(r.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000) + 29 * 86_400);
  });

  it("are bounded at registration", async () => {
    await expect(webClient(undefined, { accessTtlSeconds: 60 })).rejects.toThrow("access_ttl_seconds");
    await expect(webClient(undefined, { refreshTtlSeconds: 91 * 86_400 })).rejects.toThrow("refresh_ttl_seconds");
  });

  it("are set and cleared by rescope, audited, and bounded there too", async () => {
    const client = await webClient();
    const set = await provider.rescopeClient(
      client.client_id,
      { sourceId: "acme", accessTtlSeconds: 900, refreshTtlSeconds: 86_400 },
      { actor: "ops", via: "cli" },
    );
    expect(set.ttls).toEqual({ accessTtlSeconds: 900, refreshTtlSeconds: 86_400 });
    expect((await signIn(client)).expires_in).toBe(900);
    const audit = await provider.listGrantAudit(client.client_id);
    expect((audit[0]!.after as unknown as Record<string, unknown>)["access_ttl_seconds"]).toBe(900);

    const cleared = await provider.rescopeClient(
      client.client_id,
      { sourceId: "acme", accessTtlSeconds: null },
      { actor: "ops", via: "cli" },
    );
    expect(cleared.ttls).toEqual({ accessTtlSeconds: null, refreshTtlSeconds: 86_400 });
    expect((await signIn(client)).expires_in).toBe(3600);

    const err = await provider
      .rescopeClient(client.client_id, { sourceId: "acme", accessTtlSeconds: 10 }, { actor: "ops", via: "cli" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GrantValidationError);
    expect((err as GrantValidationError).reasons.map((r) => r.code)).toEqual(["invalid_ttl"]);
  });

  it("client_credentials prefers access_ttl_seconds over the older token_ttl", async () => {
    const { clientId, clientSecret } = await provider.registerClientManual(
      "m2m", ["client_credentials"], "read", [], "acme", undefined, undefined, undefined, "client",
      { accessTtlSeconds: 1200 },
    );
    await storage.raw().query("UPDATE oauth_clients SET token_ttl = 5000 WHERE client_id = $1", [clientId]);
    expect((await provider.exchangeClientCredentials(clientId, clientSecret!)).expires_in).toBe(1200);
    await storage.raw().query("UPDATE oauth_clients SET access_ttl_seconds = NULL WHERE client_id = $1", [clientId]);
    expect((await provider.exchangeClientCredentials(clientId, clientSecret!)).expires_in).toBe(5000);
  });
});

describe("invalidateClientTokens", () => {
  async function enrollment(id: string, clientId: string): Promise<void> {
    await storage.raw().query(
      `INSERT INTO oauth_enrollments (id, code_hash, client_id, source_id, federated_read, expires_at)
       VALUES ($1, $2, $3, 'beta', ARRAY['beta'], NOW() + INTERVAL '1 day')`,
      [id, `hash-${id}`, clientId],
    );
  }

  async function counts(clientId: string): Promise<{ tokens: number; codes: number }> {
    const t = await storage.raw().query("SELECT 1 FROM oauth_tokens WHERE client_id = $1", [clientId]);
    const c = await storage.raw().query("SELECT 1 FROM oauth_codes WHERE client_id = $1", [clientId]);
    return { tokens: t.rows.length, codes: c.rows.length };
  }

  it("deletes every token and code, keeps the client, bumps the revision and audits it", async () => {
    const client = await webClient();
    const t = await signIn(client);
    await code(client);
    const r = await provider.invalidateClientTokens(client.client_id, { actor: "ops", via: "cli" });
    expect(r.deleted).toEqual({ accessTokens: 1, refreshTokens: 1, codes: 1 });
    expect(r.revision).toBe(1);
    expect(await counts(client.client_id)).toEqual({ tokens: 0, codes: 0 });
    expect(await provider.getClient(client.client_id)).toBeDefined();
    await expect(provider.verifyAccessToken(t.access_token)).rejects.toThrow();
    const audit = await provider.listGrantAudit(client.client_id);
    expect(audit.length).toBe(1);
    expect((audit[0]!.after as unknown as Record<string, unknown>)["action"]).toBe("invalidate_tokens");
    // The client signs in again.
    expect((await signIn(client)).access_token).toMatch(/^memrain_at_/);
  });

  it("with a grant id, only that grant's tokens go", async () => {
    const client = await webClient();
    await enrollment("memex_enr_x", client.client_id);
    const mine = await signIn(client, { sourceId: "beta", federatedRead: ["beta"], grantId: "memex_enr_x" });
    const theirs = await signIn(client);
    const r = await provider.invalidateClientTokens(client.client_id, {
      actor: "ops",
      via: "cli",
      grantId: "memex_enr_x",
    });
    expect(r.deleted.accessTokens).toBe(1);
    expect(r.deleted.refreshTokens).toBe(1);
    await expect(provider.verifyAccessToken(mine.access_token)).rejects.toThrow();
    expect((await provider.verifyAccessToken(theirs.access_token)).clientId).toBe(client.client_id);
  });

  it("refuses an unknown client", async () => {
    await expect(provider.invalidateClientTokens("nope", { actor: "ops", via: "cli" })).rejects.toBeInstanceOf(
      GrantNotFoundError,
    );
  });

  it("refuses a grant id that is not an enrollment of this client, and bumps nothing", async () => {
    const client = await webClient();
    const other = await webClient();
    await enrollment("memex_enr_other", other.client_id);
    await code(client);
    for (const grantId of ["memex_enr_typo", "memex_enr_other"]) {
      await expect(
        provider.invalidateClientTokens(client.client_id, { actor: "ops", via: "cli", grantId }),
      ).rejects.toMatchObject({ code: "not_found", grantId });
    }
    expect(await provider.listGrantAudit(client.client_id)).toEqual([]);
    expect(await counts(client.client_id)).toEqual({ tokens: 0, codes: 1 });
  });

  it("is reachable from the admin API", async () => {
    const client = await webClient();
    await signIn(client);
    const auth = createAdminAuth({ bootstrapToken: "boot" });
    const call = (path: string, body: unknown, requireAdmin = auth.requireAdmin) =>
      handleAdminApi(
        new Request(`http://localhost${path}`, { method: "POST", body: JSON.stringify(body) }),
        new URL(`http://localhost${path}`),
        { storage, requireAdmin },
      );
    expect((await call("/admin/api/invalidate-tokens", { client_id: client.client_id }))?.status).toBe(401);
    const ok = await call("/admin/api/invalidate-tokens", { client_id: client.client_id }, () => true);
    expect(ok?.status).toBe(200);
    expect(((await ok!.json()) as { deleted: { access_tokens: number } }).deleted.access_tokens).toBe(1);
    expect((await call("/admin/api/invalidate-tokens", { client_id: "nope" }, () => true))?.status).toBe(404);
  });
});

describe("consent re-check at code exchange", () => {
  it("refuses a code approved before the client was rescoped, and the code is spent", async () => {
    const client = await webClient();
    const c = await code(client);
    // Widening the read set keeps the write source, so the rescope itself
    // leaves the unbound code in place: only the revision check catches it.
    await provider.rescopeClient(
      client.client_id,
      { sourceId: "acme", federatedRead: ["acme", "beta"] },
      { actor: "ops", via: "cli" },
    );
    await expect(provider.exchangeAuthorizationCode(client, c, undefined, REDIRECT)).rejects.toThrow("grant changed");
    await expect(provider.exchangeAuthorizationCode(client, c, undefined, REDIRECT)).rejects.toThrow("not found");
  });

  it("refuses an enrollment-bound code once the client's revision moved", async () => {
    const client = await webClient();
    const c = await code(client, { sourceId: "beta", federatedRead: ["beta"] });
    await provider.rescopeClient(client.client_id, { sourceId: "acme" }, { actor: "ops", via: "cli" });
    await expect(provider.exchangeAuthorizationCode(client, c, undefined, REDIRECT)).rejects.toThrow("grant changed");
  });

  it("redeems a code minted before the revision was recorded", async () => {
    const client = await webClient();
    const c = await code(client);
    await storage.raw().query("UPDATE oauth_codes SET grant_revision = NULL");
    const t = await provider.exchangeAuthorizationCode(client, c, undefined, REDIRECT);
    expect(t.access_token).toMatch(/^memrain_at_/);
  });
});

describe("personal access tokens with a source and scopes", () => {
  test("omitted flags keep today's token: read+write, no source", async () => {
    expect(await resolvePatGrant(storage.raw(), {})).toEqual({ scopes: ["read", "write"] });
  });

  test("a registered source is the write source; read sources join it", async () => {
    expect(await resolvePatGrant(storage.raw(), { sourceId: "acme" })).toEqual({
      scopes: ["read", "write"],
      sourceGrant: "acme",
    });
    expect(
      await resolvePatGrant(storage.raw(), { sourceId: "acme", federatedRead: ["beta"], scopes: ["read"] }),
    ).toEqual({ scopes: ["read"], sourceGrant: ["acme", "beta"] });
  });

  test("an unknown source, admin, an empty scope list, or read sources without a source are refused", async () => {
    await expect(resolvePatGrant(storage.raw(), { sourceId: "ghost" })).rejects.toThrow("Unknown source");
    await expect(resolvePatGrant(storage.raw(), { sourceId: "acme", federatedRead: ["ghost"] })).rejects.toThrow(
      "ghost",
    );
    await expect(resolvePatGrant(storage.raw(), { scopes: ["read", "admin"] })).rejects.toThrow("admin is granted afterwards");
    await expect(resolvePatGrant(storage.raw(), { scopes: [] })).rejects.toThrow("empty");
    await expect(resolvePatGrant(storage.raw(), { federatedRead: ["acme"] })).rejects.toThrow("a read set needs a write source");
  });

  it("an admin-minted token reports its source and scopes on verification", async () => {
    const mint = (body: unknown) =>
      handleAdminApi(
        new Request("http://localhost/admin/api/api-keys", { method: "POST", body: JSON.stringify(body) }),
        new URL("http://localhost/admin/api/api-keys"),
        { storage, requireAdmin: () => true, sessionFresh: async () => true },
      );
    const res = await mint({ name: "laptop-2", source: "acme", read: ["beta"], scopes: ["read"] });
    expect(res?.status).toBe(200);
    const { token } = (await res!.json()) as { token: string };
    const info = await provider.verifyAccessToken(token);
    expect(info.sourceId).toBe("acme");
    expect(info.allowedSources).toEqual(["acme", "beta"]);
    expect(info.scopes).toEqual(["read"]);

    const plain = await mint({ name: "laptop-3" });
    const plainInfo = await provider.verifyAccessToken(((await plain!.json()) as { token: string }).token);
    expect(plainInfo.scopes).toEqual(["read", "write"]);
    expect(plainInfo.sourceId).toBe("default");

    expect((await mint({ name: "x", source: "ghost" }))?.status).toBe(400);
    expect((await mint({ name: "y", scopes: ["admin"] }))?.status).toBe(400);
  });
});
