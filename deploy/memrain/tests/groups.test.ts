/**
 * Groups open shared sources to their members (core/groups.ts).
 *
 * Adding a member to a group widens that member's credentials' reads on the
 * very next verification; removing the member takes it away again. A group
 * never changes where a credential writes, and the owner's own source joins a
 * group only on an explicit, audited override.
 */
import { describe, expect, it } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { storageEngines } from "./helpers/storage-engines.ts";
import { registerSource } from "../src/core/sources.ts";
import { OAuthProvider } from "../src/core/oauth-provider.ts";
import { addMember, bindCredential, listMemberAudit, MemberError, removeMember, type MemberActor } from "../src/core/members.ts";
import {
  addGroup,
  addGroupMember,
  getGroup,
  grantGroupSource,
  listGroups,
  removeGroup,
  removeGroupMember,
  revokeGroupSource,
} from "../src/core/groups.ts";
import type { Engine } from "../src/core/engine/interface.ts";

const OPS: MemberActor = { actor: "ops", via: "cli" };

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof MemberError) return e.code;
    throw e;
  }
  return "no error";
}

async function mintPat(e: Engine, name: string, source: string): Promise<string> {
  const token = "memrain_" + randomBytes(24).toString("hex");
  await e.query(
    `INSERT INTO access_tokens (name, token_hash, scopes, permissions) VALUES ($1, $2, ARRAY['read','write'], $3::jsonb)`,
    [name, createHash("sha256").update(token).digest("hex"), { source_id: source }],
  );
  return token;
}

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`groups (${name})`, () => {
  it("creates groups, grants sources and members, and audits each change", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await registerSource(e, { id: "sales", kind: "other", pathPrefix: "tenant:sales" });
      await addMember(e, "alice", {}, OPS);
      expect(await addGroup(e, "team-sales", { displayName: "Sales" }, OPS)).toMatchObject({ id: "team-sales", sources: [], members: [] });
      expect(await code(addGroup(e, "team-sales", {}, OPS))).toBe("member_exists");
      expect(await code(grantGroupSource(e, "team-sales", "nope", {}, OPS))).toBe("not_found");
      await grantGroupSource(e, "team-sales", "sales", {}, OPS);
      await addGroupMember(e, "team-sales", "alice", OPS);
      expect(await code(addGroupMember(e, "team-sales", "ghost", OPS))).toBe("not_found");
      expect(await getGroup(e, "team-sales")).toMatchObject({ sources: ["sales"], members: ["alice"] });
      expect((await listGroups(e)).map(g => g.id)).toEqual(["team-sales"]);
      const audit = await listMemberAudit(e, { groupId: "team-sales" });
      expect(audit.map(a => a.action)).toEqual(["group_add_member", "group_grant_source", "group_add"]);
      expect(audit[0]).toMatchObject({ member_id: "alice", group_id: "team-sales" });

      await removeGroupMember(e, "team-sales", "alice", OPS);
      await revokeGroupSource(e, "team-sales", "sales", OPS);
      expect(await getGroup(e, "team-sales")).toMatchObject({ sources: [], members: [] });
      await removeGroup(e, "team-sales", OPS);
      expect(await getGroup(e, "team-sales")).toBeNull();
      expect((await listMemberAudit(e, { groupId: "team-sales" }))[0]!.action).toBe("group_remove");
    } finally { await db.close(); }
  });

  it("the owner's source joins a group only with the explicit override", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await addGroup(e, "everyone", {}, OPS);
      expect(await code(grantGroupSource(e, "everyone", "default", {}, OPS))).toBe("owner_source");
      await grantGroupSource(e, "everyone", "default", { allowOwnerSource: true }, OPS);
      const audit = await listMemberAudit(e, { groupId: "everyone" });
      expect(audit[0]).toMatchObject({ action: "group_grant_source", detail: { source_id: "default", owner_source_override: true } });
    } finally { await db.close(); }
  });

  it("a removed member cannot join a group", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await addMember(e, "gone", {}, OPS);
      await removeMember(e, "gone", OPS);
      await addGroup(e, "g1", {}, OPS);
      expect(await code(addGroupMember(e, "g1", "gone", OPS))).toBe("member_retired");
    } finally { await db.close(); }
  });
});
