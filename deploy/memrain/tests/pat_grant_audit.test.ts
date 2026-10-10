/**
 * A personal access token's grant never changes without a trace.
 *
 * `auth permissions <name> set-scopes` (up to admin), `set-takes-holders` and
 * `auth set-budget <token>` used to be one blind UPDATE each: no revision, no
 * audit row. Each now bumps the token's `grant_revision` and writes one
 * `oauth_grant_audit` row keyed `pat:<id>` in the same statement, and the row
 * carries the grant only — never the token or its hash.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { OAuthProvider, type GrantActor } from "../src/core/oauth-provider.ts";
import { revertMigration, runMigrations } from "../src/core/migrate.ts";

const OPS: GrantActor = { actor: "ops", via: "cli" };

let tmp: string;
let storage: Storage;
let provider: OAuthProvider;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-pat-audit-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  provider = new OAuthProvider({ engine: storage.raw() });
}, 30_000);

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
}, 30_000);

async function mint(
  name: string,
  permissions: Record<string, unknown> = { takes_holders: ["world"] },
): Promise<{ id: number; token: string; hash: string }> {
  const token = "memrain_" + randomBytes(24).toString("hex");
  const hash = createHash("sha256").update(token).digest("hex");
  const r = await storage.raw().query<{ id: number }>(
    `INSERT INTO access_tokens (name, token_hash, scopes, permissions)
     VALUES ($1, $2, ARRAY['read','write'], $3::text::jsonb) RETURNING id`,
    [name, hash, JSON.stringify(permissions)],
  );
  return { id: Number(r.rows[0]!.id), token, hash };
}

async function audit(id: number) {
  const r = await storage.raw().query<{
    revision: number;
    actor: string;
    via: string;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
    raw: string;
  }>(
    `SELECT revision, actor, via, before, after, before::text || after::text AS raw
       FROM oauth_grant_audit WHERE client_id = $1 ORDER BY revision`,
    [`pat:${id}`],
  );
  return r.rows.map((x) => ({ ...x, revision: Number(x.revision) }));
}

async function revision(id: number): Promise<number> {
  const r = await storage.raw().query<{ grant_revision: number }>(
    "SELECT grant_revision FROM access_tokens WHERE id = $1",
    [id],
  );
  return Number(r.rows[0]!.grant_revision);
}

describe("set-scopes", () => {
  it("promotes a token to admin with a revision bump and one audit row", async () => {
    const pat = await mint("promote-me");
    expect(await revision(pat.id)).toBe(0);

    const changed = await provider.setPatScopes("promote-me", ["read", "write", "admin"], OPS);
    expect(changed.map((c) => c.revision)).toEqual([1]);
    expect(await revision(pat.id)).toBe(1);

    const rows = await audit(pat.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ revision: 1, actor: "ops", via: "cli" });
    expect(rows[0]!.before.scopes).toEqual(["read", "write"]);
    expect(rows[0]!.after).toMatchObject({ scopes: ["admin", "read", "write"], action: "set_scopes" });
    expect((await provider.verifyAccessToken(pat.token)).scopes.sort()).toEqual(["admin", "read", "write"]);
  });

  it("never writes the token or its hash into the audit row", async () => {
    const pat = await mint("no-secrets");
    await provider.setPatScopes("no-secrets", ["read"], OPS);
    await provider.setClientBudget("no-secrets", 3, OPS);
    for (const row of await audit(pat.id)) {
      expect(row.raw).not.toContain(pat.hash);
      expect(row.raw).not.toContain(pat.token);
      expect(Object.keys(row.after).sort()).toEqual(
        ["action", "budget_usd_per_day", "name", "scopes", "source_id", "takes_holders"],
      );
    }
  });

  it("refuses an unknown or retired scope and writes nothing", async () => {
    const pat = await mint("bad-scope");
    await expect(provider.setPatScopes("bad-scope", ["read", "sources_admin"], OPS)).rejects.toThrow();
    await expect(provider.setPatScopes("bad-scope", [], OPS)).rejects.toThrow("cannot be empty");
    expect(await audit(pat.id)).toEqual([]);
    expect(await revision(pat.id)).toBe(0);
  });

  it("changes nothing for a name no live token has", async () => {
    expect(await provider.setPatScopes("nobody", ["read"], OPS)).toEqual([]);
  });

  it("applies the change and its audit row together, or neither", async () => {
    const pat = await mint("atomic");
    // A history row already holding revision 1 makes the audit insert fail.
    await storage.raw().query(
      `INSERT INTO oauth_grant_audit (client_id, revision, actor, via, before, after)
       VALUES ($1, 1, 'x', 'cli', '{}'::jsonb, '{}'::jsonb)`,
      [`pat:${pat.id}`],
    );
    await expect(provider.setPatScopes("atomic", ["admin"], OPS)).rejects.toThrow();
    expect(await revision(pat.id)).toBe(0);
    expect((await provider.verifyAccessToken(pat.token)).scopes).toEqual(["read", "write"]);
  });
});

describe("set-takes-holders", () => {
  it("merges the holders, keeps the source grant, and is audited", async () => {
    const pat = await mint("holders", { takes_holders: ["world"], source_id: "default" });
    const changed = await provider.setPatTakesHolders("holders", ["world", "grace"], {
      actor: "admin",
      via: "admin_api",
    });
    expect(changed).toHaveLength(1);
    const [row] = await audit(pat.id);
    expect(row).toMatchObject({ revision: 1, actor: "admin", via: "admin_api" });
    expect(row!.before).toMatchObject({ takes_holders: ["world"], source_id: "default" });
    expect(row!.after).toMatchObject({ takes_holders: ["world", "grace"], source_id: "default" });
    const info = await provider.verifyAccessToken(pat.token);
    expect(info.takesHolders).toEqual(["world", "grace"]);
    expect(info.sourceId).toBe("default");
  });
});

describe("set-budget", () => {
  it("audits a token's cap change with the actor who made it", async () => {
    const pat = await mint("capped-pat");
    expect(await provider.setClientBudget("capped-pat", 1.5, OPS)).toBe(true);
    expect(await provider.setClientBudget("capped-pat", null, OPS)).toBe(true);
    const rows = await audit(pat.id);
    expect(rows.map((r) => r.revision)).toEqual([1, 2]);
    expect(rows[0]!.after).toMatchObject({ budget_usd_per_day: 1.5, action: "set_budget" });
    expect(rows[1]!.before.budget_usd_per_day).toBe(1.5);
    expect(rows[1]!.after.budget_usd_per_day).toBeNull();
    expect((await provider.verifyAccessToken(pat.token)).budgetUsdPerDay).toBeNull();
  });
});

describe("migration 123", () => {
  it("drops the revision on the way down, keeps the history, and resumes from it on the way up", async () => {
    const pat = await mint("down-up");
    await provider.setPatScopes("down-up", ["read"], OPS);
    await provider.setPatScopes("down-up", ["read", "write"], OPS);
    const e = storage.raw();
    // A down file reverts only the latest migration. Set any later ones aside in
    // the bookkeeping (their schema stays) so this exercises 124's and 123's
    // own down files, then put them back so only 123 and 124 re-apply.
    const later = await e.query<{ id: number; name: string | null }>(
      "DELETE FROM migrations WHERE id > 124 RETURNING id, name",
    );
    await revertMigration(e, 124);
    await revertMigration(e, 123);
    for (const m of later.rows) {
      await e.query("INSERT INTO migrations (id, name) VALUES ($1, $2)", [m.id, m.name]);
    }
    const cols = await e.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'access_tokens' AND column_name = 'grant_revision'`,
    );
    expect(cols.rows).toEqual([]);
    expect((await audit(pat.id)).map((r) => r.revision)).toEqual([1, 2]);

    const again = await runMigrations(e);
    expect(again.applied.map((m) => m.id)).toEqual([123, 124]);
    expect(await revision(pat.id)).toBe(2);
    const next = await provider.setPatScopes("down-up", ["read"], OPS);
    expect(next.map((c) => c.revision)).toEqual([3]);
  });
});
