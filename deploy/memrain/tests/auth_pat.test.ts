/**
 * Personal access tokens (auth create / revoke) on the live MCP ingress.
 *
 * Proves the access_tokens fallback path end to end: a PAT row minted the
 * way `memrain auth create` does (name + sha256 hash + permissions) clears
 * the /mcp guard, its tenant scope resolves from `permissions.source_id`
 * (scalar = write+read source; array = federated read set anchored on its
 * first element), migration 072's default keeps takes_holders=['world'],
 * and a revoked PAT 401s.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { startServer, type ServerHandle } from "../src/http/server.ts";
import { OAuthProvider } from "../src/core/oauth-provider.ts";

const PUB_TOKEN = "pub-bearer-pat-test";
const readCall = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "get_stats", arguments: {} },
};

function mintPat(): { token: string; hash: string } {
  const token = "memex_" + randomBytes(32).toString("hex");
  const hash = createHash("sha256").update(token, "utf8").digest("hex");
  return { token, hash };
}

describe("personal access tokens (access_tokens fallback)", () => {
  let tmp: string;
  let storage: Storage;
  let provider: OAuthProvider;
  let server: ServerHandle;
  let url: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "memrain-pat-"));
    storage = new Storage({ dbPath: join(tmp, "db") });
    await storage.init();
    provider = new OAuthProvider({ engine: storage.raw() });
    server = startServer({
      host: "127.0.0.1",
      port: 0,
      storage,
      publicBearerToken: PUB_TOKEN,
      oauthProvider: provider,
    });
    url = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    await server.stop();
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function insertPat(
    name: string,
    hash: string,
    permissions?: Record<string, unknown>,
  ): Promise<void> {
    if (permissions === undefined) {
      await storage
        .raw()
        .query(
          `INSERT INTO access_tokens (name, token_hash, scopes)
           VALUES ($1, $2, $3::text[])`,
          [name, hash, ["read", "write"]],
        );
      return;
    }
    // Object, NOT JSON.stringify — a string bound to a jsonb position becomes
    // a jsonb string (double-encode), which is exactly the bug class these
    // tests must catch.
    await storage
      .raw()
      .query(
        `INSERT INTO access_tokens (name, token_hash, scopes, permissions)
         VALUES ($1, $2, $3::text[], $4::jsonb)`,
        [name, hash, ["read", "write"], permissions],
      );
  }

  async function mcp(bearer: string): Promise<Response> {
    // Cf-Connecting-Ip marks the request as public-ingress — without it the
    // guard treats the caller as the trusted internal docker path.
    return fetch(`${url}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer}`,
        "Cf-Connecting-Ip": "9.9.9.9",
      },
      body: JSON.stringify(readCall),
    });
  }

  it("migration 072 gives new rows permissions {takes_holders:['world']}", async () => {
    const { hash } = mintPat();
    await insertPat("mig-default", hash);
    const r = await storage
      .raw()
      .query<{ permissions: unknown; t: string }>(
        "SELECT permissions, jsonb_typeof(permissions) AS t FROM access_tokens WHERE name = $1",
        ["mig-default"],
      );
    // jsonb_typeof must be 'object' — a 'string' here means a double-encoded
    // write slipped through and scope resolution would silently break.
    expect(r.rows[0]!.t).toBe("object");
    const perms = r.rows[0]!.permissions as { takes_holders?: string[] };
    expect(perms.takes_holders).toEqual(["world"]);
  });

  it("a PAT clears the /mcp guard", async () => {
    const { token, hash } = mintPat();
    await insertPat("laptop", hash);
    const r = await mcp(token);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { error?: { code?: number } };
    expect(body.error?.code).not.toBe(-32001);
  });

  it("verifyToken records last use at most once a minute", async () => {
    const { token, hash } = mintPat();
    await insertPat("debounced", hash);
    await provider.verifyAccessToken(token);
    const first = await storage.raw().query<{ t: string }>(
      `SELECT last_used_at::text AS t FROM access_tokens WHERE name = 'debounced'`,
    );
    await provider.verifyAccessToken(token);
    const second = await storage.raw().query<{ t: string }>(
      `SELECT last_used_at::text AS t FROM access_tokens WHERE name = 'debounced'`,
    );
    expect(first.rows[0]!.t).not.toBeNull();
    expect(second.rows[0]!.t).toBe(first.rows[0]!.t);
  });

  it("verifyToken derives tenant scope from permissions.source_id array", async () => {
    const { token, hash } = mintPat();
    await insertPat("scoped", hash, {
      takes_holders: ["world"],
      source_id: ["timur", "gcal"],
    });
    const info = await provider.verifyAccessToken(token);
    expect(info.sourceId).toBe("timur");
    expect(info.allowedSources).toEqual(["timur", "gcal"]);
    expect(info.scopes).toContain("read");
  });

  it("verifyToken treats a scalar source_id as write+sole-read source", async () => {
    const { token, hash } = mintPat();
    await insertPat("scoped-scalar", hash, {
      takes_holders: ["world"],
      source_id: "guest",
    });
    const info = await provider.verifyAccessToken(token);
    expect(info.sourceId).toBe("guest");
    expect(info.allowedSources).toEqual(["guest"]);
  });

  it("a PAT without a source grant falls back to the 'default' floor", async () => {
    const { token, hash } = mintPat();
    await insertPat("unscoped", hash);
    const info = await provider.verifyAccessToken(token);
    expect(info.sourceId).toBe("default");
  });

  it("set-takes-holders style merge preserves the source_id grant", async () => {
    const { token, hash } = mintPat();
    await insertPat("merge-keeps-scope", hash, {
      takes_holders: ["world"],
      source_id: ["timur", "gcal"],
    });
    // Same statement setPermissions runs — merge, not replace.
    await storage
      .raw()
      .query(
        `UPDATE access_tokens
            SET permissions = COALESCE(permissions, '{}'::jsonb) || $2::jsonb
          WHERE name = $1 AND revoked_at IS NULL`,
        ["merge-keeps-scope", JSON.stringify({ takes_holders: ["world", "grace"] })],
      );
    const info = await provider.verifyAccessToken(token);
    expect(info.sourceId).toBe("timur");
    expect(info.allowedSources).toEqual(["timur", "gcal"]);
  });

  it("a revoked PAT is rejected with 401", async () => {
    const { token, hash } = mintPat();
    await insertPat("doomed", hash);
    await storage
      .raw()
      .query(
        "UPDATE access_tokens SET revoked_at = now() WHERE name = $1",
        ["doomed"],
      );
    const r = await mcp(token);
    expect(r.status).toBe(401);
  });

  it("a PAT's daily cap refuses its paid ops over the wire", async () => {
    const { token, hash } = mintPat();
    await insertPat("capped-pat", hash);
    await storage.raw().query(
      "UPDATE access_tokens SET budget_usd_per_day = 0 WHERE name = $1",
      ["capped-pat"],
    );
    const r = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "Cf-Connecting-Ip": "9.9.9.9",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "search", arguments: { q: "who founded Acme" } },
      }),
    });
    expect(r.status).toBe(200);
    expect(JSON.stringify(await r.json())).toContain("budget_exhausted");
  });
});
