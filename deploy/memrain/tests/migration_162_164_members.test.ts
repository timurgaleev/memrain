import { describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { discoverMigrations, revertMigration, runMigrations } from "../src/core/migrate.ts";
import type { Engine } from "../src/core/engine/interface.ts";

const table = async (e: Engine, name: string) => (await e.query<{ t: string | null }>(
  `SELECT to_regclass($1)::text AS t`, [name])).rows[0]!.t;

const column = async (e: Engine, tbl: string, col: string) => (await e.query<{ n: number }>(
  `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`, [tbl, col])).rows[0]!.n === 1;

async function revertLaterThan(e: Engine, id: number): Promise<void> {
  for (const later of discoverMigrations().map(m => m.id).filter(m => m > id).sort((a, b) => b - a)) await revertMigration(e, later);
}

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`migrations 162-164 (${name})`, () => {
  it("162 creates members and member_audit and binds credentials to a member", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      expect(await table(e, "members")).toBe("members");
      expect(await table(e, "member_audit")).toBe("member_audit");
      for (const t of ["access_tokens", "oauth_clients", "oauth_enrollments"]) expect(await column(e, t, "member_id")).toBe(true);
      await e.query(`INSERT INTO members (id, display_name) VALUES ('alice', 'Alice')`);
      // Ids are lower-case slugs; status is one of three.
      await expect(e.query(`INSERT INTO members (id) VALUES ('Bad Id')`)).rejects.toThrow();
      await expect(e.query(`UPDATE members SET status = 'gone' WHERE id = 'alice'`)).rejects.toThrow();
      // One live member per email, case-insensitively.
      await e.query(`UPDATE members SET email = 'a@example.com' WHERE id = 'alice'`);
      await e.query(`INSERT INTO members (id) VALUES ('bob')`);
      await expect(e.query(`UPDATE members SET email = 'A@example.com' WHERE id = 'bob'`)).rejects.toThrow();
      // A credential may only name an existing member.
      await expect(e.query(
        `INSERT INTO access_tokens (name, token_hash, member_id) VALUES ('t', 'h1', 'nobody')`)).rejects.toThrow();
      await e.query(`INSERT INTO access_tokens (name, token_hash, member_id) VALUES ('t', 'h1', 'alice')`);
      expect((await runMigrations(e)).applied).toEqual([]);
    } finally { await db.close(); }
  });

  it("163 creates groups with their sources and members", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      for (const t of ["groups", "group_sources", "group_members"]) expect(await table(e, t)).toBe(t);
      await e.query(`INSERT INTO sources (id, kind, path_prefix) VALUES ('sales', 'other', 'sales/')`);
      await e.query(`INSERT INTO members (id) VALUES ('alice')`);
      await e.query(`INSERT INTO groups (id) VALUES ('team-sales')`);
      await e.query(`INSERT INTO group_sources (group_id, source_id) VALUES ('team-sales', 'sales')`);
      await e.query(`INSERT INTO group_members (group_id, member_id) VALUES ('team-sales', 'alice')`);
      await expect(e.query(`INSERT INTO group_sources (group_id, source_id) VALUES ('team-sales', 'no-such-source')`)).rejects.toThrow();
      // Deleting a source severs the group's grant on it; it never dangles.
      await e.query(`DELETE FROM sources WHERE id = 'sales'`);
      expect((await e.query<{ n: number }>(`SELECT count(*)::int AS n FROM group_sources`)).rows[0]!.n).toBe(0);
    } finally { await db.close(); }
  });

  it("164 records a grant profile and a tool surface on tokens and clients", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      for (const t of ["access_tokens", "oauth_clients"]) {
        for (const c of ["profile", "profile_catalog_version", "tool_surface"]) expect(await column(e, t, c)).toBe(true);
      }
      await e.query(`INSERT INTO access_tokens (name, token_hash) VALUES ('t', 'h1')`);
      const row = (await e.query<{ tool_surface: string; profile: string | null }>(
        `SELECT tool_surface, profile FROM access_tokens WHERE name = 't'`)).rows[0]!;
      expect(row).toEqual({ tool_surface: "full", profile: null });
      await expect(e.query(`UPDATE access_tokens SET tool_surface = 'everything'`)).rejects.toThrow();
    } finally { await db.close(); }
  });

  it("down refuses while members or groups exist, then up again restores them", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await revertLaterThan(e, 164);
      await revertMigration(e, 164);
      expect(await column(e, "access_tokens", "tool_surface")).toBe(false);

      await e.query(`INSERT INTO members (id) VALUES ('alice')`);
      await e.query(`INSERT INTO groups (id) VALUES ('team')`);
      await expect(revertMigration(e, 163)).rejects.toThrow("groups");
      await e.query(`DELETE FROM groups`);
      await revertMigration(e, 163);
      expect(await table(e, "groups")).toBeNull();

      await expect(revertMigration(e, 162)).rejects.toThrow("members");
      await e.query(`DELETE FROM members`);
      await revertMigration(e, 162);
      expect(await table(e, "members")).toBeNull();
      expect(await column(e, "access_tokens", "member_id")).toBe(false);

      const again = await runMigrations(e);
      expect(again.applied.map(m => m.id)).toEqual(expect.arrayContaining([162, 163, 164]));
      expect(await table(e, "members")).toBe("members");
    } finally { await db.close(); }
  });
});
