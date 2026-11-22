/**
 * Doctor checks for who reads the brain: owner-identity, unscoped-shared-reads
 * and owner-only-sources. None of them prints a personal identifier.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { putPage } from "../src/core/pages.ts";
import { registerSource } from "../src/core/sources.ts";
import { addMember, disableMember, enableMember, type MemberActor } from "../src/core/members.ts";
import { setOwner } from "../src/core/brain-owner.ts";
import { provenanceBackfill, setSourceOwnerOnly } from "../src/core/owner-only.ts";
import { checkOwnerIdentity, checkOwnerOnlySources, checkUnscopedSharedReads } from "../src/core/doctor-access.ts";

const OPS: MemberActor = { actor: "ops", via: "cli" };

for (const engine of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`doctor access checks ${engine.name}`, () => {
  let db: Awaited<ReturnType<typeof engine.open>>;
  beforeAll(async () => {
    db = await engine.open();
    await registerSource(db.storage.engine(), { id: "me-mail", kind: "mailbox", pathPrefix: "mail:me" });
  });
  afterAll(async () => { await db.close(); });

  it("a fresh brain is ok on all three", async () => {
    const e = db.storage.engine();
    expect((await checkOwnerIdentity(e, "")).status).toBe("ok");
    expect((await checkUnscopedSharedReads(e)).status).toBe("ok");
    expect((await checkOwnerOnlySources(e)).status).toBe("ok");
  });

  it("an owner with an email is ok, and the email never reaches the check", async () => {
    const e = db.storage.engine();
    await addMember(e, "ora", { email: "owner@example.com" }, OPS);
    await setOwner(e, "ora");
    await putPage(db.storage, { slug: "people/ora", type: "person", markdown_body: "Me", compiled_truth: { email: "owner@example.com" } });
    const c = await checkOwnerIdentity(e, "");
    expect(c.status).toBe("ok");
    expect(c.detail).toContain("owner page people/ora");
    expect(c.detail).not.toContain("example.com");
  });

  it("a second page carrying the owner email warns as ambiguous, still with no identifier", async () => {
    const e = db.storage.engine();
    await putPage(db.storage, { slug: "people/ora-old", type: "person", markdown_body: "Old me", compiled_truth: { emails: ["owner@example.com"] } });
    const c = await checkOwnerIdentity(e, "");
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("2 person pages carry an owner email");
    expect(c.detail).not.toContain("example.com");
  });

  it("an owner that is disabled warns; an unusable MEMRAIN_OWNER_ENTITY warns", async () => {
    const e = db.storage.engine();
    await disableMember(e, "ora", OPS);
    expect((await checkOwnerIdentity(e, "")).detail).toContain("not an enabled member");
    await enableMember(e, "ora", OPS);
    expect((await checkOwnerIdentity(e, "Not A Slug!!")).detail).toContain("MEMRAIN_OWNER_ENTITY is set but is not a usable entity slug");
  });

  it("a shared brain lists unbound credentials and open personal sources", async () => {
    const e = db.storage.engine();
    await addMember(e, "alice", {}, OPS);
    await db.storage.raw().query(`INSERT INTO access_tokens (name, token_hash, scopes, permissions) VALUES ('loose', 'h-loose', ARRAY['read'], '{}'::jsonb)`);
    const unscoped = await checkUnscopedSharedReads(e);
    expect(unscoped.status).toBe("warn");
    expect(unscoped.detail).toContain("token loose (fix: memrain member bind <member> --token loose)");
    const open = await checkOwnerOnlySources(e);
    expect(open.status).toBe("warn");
    expect(open.detail).toContain("me-mail");
    await setSourceOwnerOnly(e, "me-mail", true);
    const pending = await checkOwnerOnlySources(e);
    expect(pending.status).toBe("warn");
    expect(pending.detail).toContain("memrain sources provenance --apply");
    await provenanceBackfill(e, { apply: true });
    expect((await checkOwnerOnlySources(e)).status).toBe("ok");
  });

  it("a shared brain with no owner warns that nobody reads private facts", async () => {
    const e = db.storage.engine();
    await e.query(`DELETE FROM config WHERE key = 'access.owner_member'`);
    // Owner-only sources with no owner: only the local operator reads them.
    expect((await checkOwnerOnlySources(e)).detail).toContain("no owner member is set");
    expect((await checkOwnerIdentity(e, "")).detail).toContain("names no owner member");
  });
});
