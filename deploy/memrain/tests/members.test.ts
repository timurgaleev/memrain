/**
 * Members: the people of a team brain (core/members.ts).
 *
 * Ids are never reused, removal clears the email and leaves a tombstone, a
 * credential can only be bound to an enabled member, and a credential bound
 * to a removed member can never be unbound back into a working key. Every
 * change writes one member_audit row, never the email itself.
 */
import { describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import {
  addMember,
  bindCredential,
  boundCredentials,
  disableMember,
  enableMember,
  getMember,
  listMemberAudit,
  listMembers,
  MemberError,
  removeMember,
  type MemberActor,
} from "../src/core/members.ts";
import type { Engine } from "../src/core/engine/interface.ts";

const OPS: MemberActor = { actor: "ops", via: "cli" };

async function pat(e: Engine, name: string, hash: string): Promise<void> {
  await e.query(`INSERT INTO access_tokens (name, token_hash, scopes) VALUES ($1, $2, ARRAY['read'])`, [name, hash]);
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof MemberError) return e.code;
    throw e;
  }
  return "no error";
}

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`members (${name})`, () => {
  it("adds, lists, disables and enables a member with an audit row each", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      const m = await addMember(e, "alice", { displayName: "Alice", email: "Alice@Example.com" }, OPS);
      expect(m).toMatchObject({ id: "alice", display_name: "Alice", email: "alice@example.com", status: "enabled", groups: [] });
      expect(await code(addMember(e, "alice", {}, OPS))).toBe("member_exists");
      expect(await code(addMember(e, "Not Valid", {}, OPS))).toBe("member_invalid");
      expect(await code(addMember(e, "bob", { email: "alice@example.com" }, OPS))).toBe("email_taken");
      expect((await disableMember(e, "alice", OPS)).status).toBe("disabled");
      expect((await enableMember(e, "alice", OPS)).status).toBe("enabled");
      expect((await listMembers(e)).map(x => x.id)).toEqual(["alice"]);
      const audit = await listMemberAudit(e, { memberId: "alice" });
      expect(audit.map(a => a.action)).toEqual(["enable", "disable", "add"]);
      // The email is personal data: the audit records that one was set, never the address.
      expect(JSON.stringify(audit)).not.toContain("example.com");
      expect(audit[2]!.detail).toMatchObject({ email_set: true });
      expect(audit[0]).toMatchObject({ actor: "ops", via: "cli" });
    } finally { await db.close(); }
  });

  it("removal is a tombstone: email cleared, id never reused, cannot be enabled", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await addMember(e, "carol", { email: "carol@example.com" }, OPS);
      await pat(e, "carol-laptop", "h-carol");
      await bindCredential(e, "carol", { kind: "token", id: "carol-laptop" }, OPS);
      const removed = await removeMember(e, "carol", OPS);
      expect(removed.member).toMatchObject({ id: "carol", status: "removed", email: null });
      expect(removed.bound_credentials).toEqual([{ kind: "token", id: "carol-laptop" }]);
      expect(await code(addMember(e, "carol", {}, OPS))).toBe("member_retired");
      expect(await code(enableMember(e, "carol", OPS))).toBe("member_retired");
      expect((await listMembers(e)).map(x => x.id)).toEqual([]);
      expect((await listMembers(e, { includeRemoved: true })).map(x => x.id)).toEqual(["carol"]);
      // The address is free again for a new person.
      await addMember(e, "carol-2", { email: "carol@example.com" }, OPS);
    } finally { await db.close(); }
  });

  it("binds tokens, clients and enrollments only to an enabled member", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await addMember(e, "dan", {}, OPS);
      await pat(e, "dan-cli", "h-dan-1");
      await pat(e, "dan-cli-old", "h-dan-2");
      await e.query(`INSERT INTO oauth_clients (client_id, client_name, redirect_uris, grant_types, scope) VALUES ('cl-dan', 'dan', '{}', ARRAY['client_credentials'], 'read')`);
      const r = await bindCredential(e, "dan", { kind: "token", id: "dan-cli" }, OPS);
      expect(r).toEqual({ kind: "token", id: "dan-cli", member_id: "dan", previous_member_id: null, rows: 1 });
      await bindCredential(e, "dan", { kind: "client", id: "cl-dan" }, OPS);
      expect(await code(bindCredential(e, "dan", { kind: "token", id: "no-such-token" }, OPS))).toBe("not_found");
      expect(await code(bindCredential(e, "nobody", { kind: "token", id: "dan-cli-old" }, OPS))).toBe("not_found");
      await disableMember(e, "dan", OPS);
      expect(await code(bindCredential(e, "dan", { kind: "token", id: "dan-cli-old" }, OPS))).toBe("member_not_enabled");
      expect((await boundCredentials(e, "dan")).sort((a, b) => a.kind.localeCompare(b.kind)))
        .toEqual([{ kind: "client", id: "cl-dan" }, { kind: "token", id: "dan-cli" }]);
      // Unbinding from a disabled member is an explicit operator choice, and audited.
      const un = await bindCredential(e, null, { kind: "token", id: "dan-cli" }, OPS);
      expect(un).toMatchObject({ member_id: null, previous_member_id: "dan" });
      expect((await listMemberAudit(e, { memberId: "dan" }))[0]).toMatchObject({ action: "unbind" });
    } finally { await db.close(); }
  });

  it("a credential bound to a removed member can never be rebound into a working key", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await addMember(e, "erin", {}, OPS);
      await addMember(e, "frank", {}, OPS);
      await pat(e, "erin-key", "h-erin");
      await bindCredential(e, "erin", { kind: "token", id: "erin-key" }, OPS);
      await removeMember(e, "erin", OPS);
      expect(await code(bindCredential(e, null, { kind: "token", id: "erin-key" }, OPS))).toBe("member_retired");
      expect(await code(bindCredential(e, "frank", { kind: "token", id: "erin-key" }, OPS))).toBe("member_retired");
      expect((await getMember(e, "erin"))?.status).toBe("removed");
    } finally { await db.close(); }
  });
});
