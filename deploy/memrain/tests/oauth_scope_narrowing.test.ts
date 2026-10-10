/**
 * Narrowing a client's scopes binds the tokens it already handed out.
 *
 * Verification used to return a token's issued scopes as stored, and refresh
 * compared a request against that same stored set, so the only way to take a
 * scope away from a live client was revoke + re-register. A token now holds
 * what it was issued AND its client still holds: on the next verification, on
 * refresh (which can never win the scope back) and on code exchange. Nothing
 * left means the token is refused.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import {
  GrantValidationError,
  InvalidTokenError,
  OAuthProvider,
  type GrantMutationOptions,
  type OAuthClientInfo,
} from "../src/core/oauth-provider.ts";
import { discoverMigrations } from "../src/core/migrate.ts";

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const CLI: GrantMutationOptions = { actor: "ops", via: "cli" };

let tmp: string;
let storage: Storage;
let provider: OAuthProvider;
let seq = 0;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-scope-narrowing-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  provider = new OAuthProvider({ engine: storage.raw() });
}, 30_000);

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
}, 30_000);

async function browserClient(scope = "read write"): Promise<OAuthClientInfo> {
  seq++;
  const reg = await provider.registerClientManual(
    `narrow-${seq}`,
    ["authorization_code", "refresh_token"],
    scope,
    [REDIRECT],
  );
  return (await provider.getClient(reg.clientId))!;
}

async function code(client: OAuthClientInfo): Promise<string> {
  const { redirectUrl } = await provider.authorize(client, { redirectUri: REDIRECT, codeChallenge: CHALLENGE });
  return new URL(redirectUrl).searchParams.get("code")!;
}

async function pair(client: OAuthClientInfo) {
  return provider.exchangeAuthorizationCode(client, await code(client), undefined, REDIRECT);
}

function rescope(client: OAuthClientInfo, scopes: string[]) {
  return provider.rescopeClient(client.client_id, { sourceId: "default", scopes }, CLI);
}

describe("verify", () => {
  it("holds an issued token to the client's narrowed scopes on its next use", async () => {
    const client = await browserClient();
    const tokens = await pair(client);
    expect((await provider.verifyAccessToken(tokens.access_token)).scopes.sort()).toEqual(["read", "write"]);

    await rescope(client, ["read"]);
    expect((await provider.verifyAccessToken(tokens.access_token)).scopes).toEqual(["read"]);
  });

  it("intersects capabilities: an admin token under a client cut to write holds write", async () => {
    const client = await browserClient("admin");
    const tokens = await pair(client);
    await rescope(client, ["write"]);
    expect((await provider.verifyAccessToken(tokens.access_token)).scopes).toEqual(["write"]);
  });

  it("widening the client gives an issued token nothing it was not issued", async () => {
    const client = await browserClient("read");
    const tokens = await pair(client);
    await rescope(client, ["admin"]);
    expect((await provider.verifyAccessToken(tokens.access_token)).scopes).toEqual(["read"]);
  });

  it("refuses a token once nothing it was issued is left", async () => {
    const client = await browserClient();
    const tokens = await pair(client);
    await rescope(client, ["agent"]);
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toBeInstanceOf(InvalidTokenError);
  });
});

describe("refresh", () => {
  it("never wins back a removed scope, even after the client is widened again", async () => {
    const client = await browserClient();
    const first = await pair(client);
    await rescope(client, ["read"]);

    const second = await provider.exchangeRefreshToken(client, first.refresh_token!);
    expect(second.scope).toBe("read");

    await rescope(client, ["read", "write"]);
    expect((await provider.verifyAccessToken(second.access_token)).scopes).toEqual(["read"]);
    await expect(provider.exchangeRefreshToken(client, second.refresh_token!, ["write"])).rejects.toThrow(
      "exceeds refresh token grant",
    );
  });

  it("is refused when nothing the refresh token was granted is left", async () => {
    const client = await browserClient();
    const first = await pair(client);
    await rescope(client, ["agent"]);
    // The rescope deleted it outright.
    await expect(provider.exchangeRefreshToken(client, first.refresh_token!)).rejects.toThrow(
      "Refresh token not found",
    );
  });

  it("is refused for a stored grant the client no longer covers", async () => {
    const client = await browserClient();
    const first = await pair(client);
    // A row written before rescopes rewrote stored scopes.
    await storage.raw().query("UPDATE oauth_clients SET scope = 'agent' WHERE client_id = $1", [client.client_id]);
    await expect(provider.exchangeRefreshToken(client, first.refresh_token!)).rejects.toThrow(
      "no longer holds any scope",
    );
  });
});

describe("code exchange", () => {
  it("cuts a code's approved scopes down to what the client holds now", async () => {
    const client = await browserClient();
    const pending = await code(client);
    // A code from before revisions were recorded is not refused for the
    // rescope below, so the intersection is what stands between it and write.
    await storage.raw().query("UPDATE oauth_codes SET grant_revision = NULL");
    await rescope(client, ["read"]);
    const tokens = await provider.exchangeAuthorizationCode(client, pending, undefined, REDIRECT);
    expect(tokens.scope).toBe("read");
    expect((await provider.verifyAccessToken(tokens.access_token)).scopes).toEqual(["read"]);
  });
});

describe("rescopeClient — scopes axis", () => {
  it("records the scopes before and after, and names them as changed", async () => {
    const client = await browserClient();
    const res = await rescope(client, ["read"]);
    expect(res.changed).toEqual(["scopes"]);
    expect(res.before.scopes).toEqual(["read", "write"]);
    expect(res.after.scopes).toEqual(["read"]);
    const [row] = await provider.listGrantAudit(client.client_id);
    expect(row!.before.scopes).toEqual(["read", "write"]);
    expect(row!.after.scopes).toEqual(["read"]);
    expect((await provider.getClient(client.client_id))!.scope).toBe("read");
  });

  it("leaves the scopes alone when the change does not name them", async () => {
    const client = await browserClient();
    const res = await provider.rescopeClient(client.client_id, { sourceId: "default" }, CLI);
    expect(res.changed).toEqual([]);
    expect((await provider.getClient(client.client_id))!.scope).toBe("read write");
  });

  it("refuses an unknown or empty scope list with invalid_scope and writes nothing", async () => {
    const client = await browserClient();
    for (const scopes of [["read", "sources_admin"], []]) {
      const err = await rescope(client, scopes).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GrantValidationError);
      expect((err as GrantValidationError).reasons.map((r) => r.code)).toEqual(["invalid_scope"]);
    }
    expect(await provider.listGrantAudit(client.client_id)).toEqual([]);
    expect((await provider.getClient(client.client_id))!.scope).toBe("read write");
  });
});

describe("migration 124", () => {
  const sql = discoverMigrations().find((m) => m.id === 124)!.sql;

  it("strips the retired scope names from every stored grant, and is idempotent", async () => {
    const e = storage.raw();
    const client = await browserClient("admin read");
    await pair(client);
    await code(client);
    // Written by hand: the server no longer accepts these names.
    await e.query(`UPDATE oauth_clients SET scope = 'admin sources_admin  read users_admin' WHERE client_id = $1`, [
      client.client_id,
    ]);
    await e.query(
      `UPDATE oauth_tokens SET scopes = ARRAY['read','users_admin','write'] WHERE client_id = $1`,
      [client.client_id],
    );
    await e.query(
      `UPDATE oauth_codes SET scopes = ARRAY['sources_admin','read'] WHERE client_id = $1`,
      [client.client_id],
    );
    await e.query(
      `INSERT INTO access_tokens (name, token_hash, scopes)
       VALUES ('m124-a', 'm124-hash-a', ARRAY['read','sources_admin']),
              ('m124-b', 'm124-hash-b', ARRAY['users_admin']),
              ('m124-c', 'm124-hash-c', NULL)`,
    );

    for (let run = 0; run < 2; run++) {
      await e.exec(sql);
      const c = await e.query<{ scope: string }>("SELECT scope FROM oauth_clients WHERE client_id = $1", [
        client.client_id,
      ]);
      expect(c.rows[0]!.scope).toBe("admin read");
      const t = await e.query<{ scopes: string[] }>("SELECT scopes FROM oauth_tokens WHERE client_id = $1", [
        client.client_id,
      ]);
      for (const row of t.rows) expect(row.scopes).toEqual(["read", "write"]);
      const k = await e.query<{ scopes: string[] }>("SELECT scopes FROM oauth_codes WHERE client_id = $1", [
        client.client_id,
      ]);
      for (const row of k.rows) expect(row.scopes).toEqual(["read"]);
      const p = await e.query<{ name: string; scopes: string[] | null }>(
        "SELECT name, scopes FROM access_tokens WHERE name LIKE 'm124-%' ORDER BY name",
      );
      expect(p.rows).toEqual([
        { name: "m124-a", scopes: ["read"] },
        { name: "m124-b", scopes: [] },
        { name: "m124-c", scopes: null },
      ]);
    }
  });

  it("leaves a client without a retired name untouched", async () => {
    const client = await browserClient("read  write");
    await storage.raw().exec(sql);
    expect((await provider.getClient(client.client_id))!.scope).toBe("read  write");
  });
});

describe("rescopeClient — narrowing rewrites issued tokens", () => {
  async function storedScopes(clientId: string): Promise<string[][]> {
    const r = await storage.raw().query<{ scopes: string[] }>(
      "SELECT scopes FROM oauth_tokens WHERE client_id = $1 ORDER BY token_type",
      [clientId],
    );
    return r.rows.map((row) => [...row.scopes].sort());
  }

  it("a token issued before a narrowing stays narrowed after the client is widened back", async () => {
    const client = await browserClient("admin");
    const tokens = await pair(client);
    await rescope(client, ["read"]);
    expect(await storedScopes(client.client_id)).toEqual([["read"], ["read"]]);

    await rescope(client, ["admin"]);
    expect((await provider.verifyAccessToken(tokens.access_token)).scopes).toEqual(["read"]);
    const rotated = await provider.exchangeRefreshToken(client, tokens.refresh_token!);
    expect(rotated.scope).toBe("read");
    expect((await provider.verifyAccessToken(rotated.access_token)).scopes).toEqual(["read"]);
  });

  it("deletes a token with nothing left, so widening back cannot revive it", async () => {
    const client = await browserClient();
    const tokens = await pair(client);
    await rescope(client, ["agent"]);
    expect(await storedScopes(client.client_id)).toEqual([]);

    await rescope(client, ["read", "write"]);
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toBeInstanceOf(InvalidTokenError);
    await expect(provider.exchangeRefreshToken(client, tokens.refresh_token!)).rejects.toThrow();
  });

  it("leaves issued tokens alone on a dry run or a change that keeps the scopes", async () => {
    const client = await browserClient();
    await pair(client);
    await provider.rescopeClient(client.client_id, { sourceId: "default", scopes: ["read"] }, { ...CLI, dryRun: true });
    await provider.rescopeClient(client.client_id, { sourceId: "default" }, CLI);
    expect(await storedScopes(client.client_id)).toEqual([["read", "write"], ["read", "write"]]);
  });
});

describe("refresh — explicit scope list", () => {
  it("refuses an empty requested scope list with invalid_scope and leaves the refresh token usable", async () => {
    const client = await browserClient();
    const tokens = await pair(client);
    await expect(provider.exchangeRefreshToken(client, tokens.refresh_token!, [])).rejects.toThrow("invalid_scope");
    const rotated = await provider.exchangeRefreshToken(client, tokens.refresh_token!);
    expect(rotated.scope?.split(" ").sort()).toEqual(["read", "write"]);
  });
});
