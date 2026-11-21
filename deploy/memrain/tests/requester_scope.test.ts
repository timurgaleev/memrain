/**
 * Requester scope: on a brain that serves several people, a remote read from a
 * connection bound to nobody (no member, no source) is refused at once, with
 * no grace period. Bound and source-scoped credentials, the trusted operator
 * path and every one-person brain read as before.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { addFact } from "../src/core/facts.ts";
import { putPage } from "../src/core/pages.ts";
import { registerSource } from "../src/core/sources.ts";
import { addMember, disableMember, enableMember, type MemberActor } from "../src/core/members.ts";
import { OPERATIONS } from "../src/mcp/operations.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import { READING_WRITES, REQUESTER_SCOPE_EXEMPT, assertCredentialScoped, requiresRequesterScope, unscopedConnections } from "../src/core/requester-scope.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";

const OPS: MemberActor = { actor: "ops", via: "cli" };

describe("requiresRequesterScope: every operation is classified (deny by default)", () => {
  it("covers every read, admin and agent op, and the writes that read; the exempt list is exactly the reviewed one", () => {
    expect([...REQUESTER_SCOPE_EXEMPT].sort()).toEqual(["get_brain_identity", "whoami"]);
    expect([...READING_WRITES].sort()).toEqual(["takes_resolve", "takes_update", "think"]);
    for (const op of OPERATIONS) {
      const expected = !REQUESTER_SCOPE_EXEMPT.has(op.name) && (op.scope !== "write" || READING_WRITES.has(op.name));
      expect(`${op.name}: ${requiresRequesterScope(op, op.name)}`).toBe(`${op.name}: ${expected}`);
    }
    // An op this build does not know is covered too.
    expect(requiresRequesterScope(undefined, "a_future_read")).toBe(true);
  });
});

for (const engine of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`requester scope ${engine.name}`, () => {
  let db: Awaited<ReturnType<typeof engine.open>>;
  const unbound: AuthInfo = { token: "t", clientId: "laptop", scopes: ["read", "write"], isPublic: false, principal: { kind: "pat", id: "1" } };
  const call = (name: string, args: Record<string, unknown>, opts: Parameters<typeof dispatchTool>[2]) =>
    dispatchTool(db.storage, { name, arguments: args }, opts);
  const errorCode = async (name: string, args: Record<string, unknown>, opts: Parameters<typeof dispatchTool>[2]) => {
    const r = await call(name, args, opts);
    if (!r.isError) return "ok";
    try { return JSON.parse(r.content[0]!.text).error as string; } catch { return r.content[0]!.text; }
  };

  beforeAll(async () => {
    db = await engine.open();
    await registerSource(db.storage.engine(), { id: "team", kind: "vault", pathPrefix: "/team" });
    await putPage(db.storage, { slug: "notes/plan", markdown_body: "The plan", source_id: "team" });
    await addFact(db.storage, { entity_slug: "people/one", fact: "a world fact", visibility: "world" });
  });
  afterAll(async () => { await db.close(); });

  it("a one-person brain reads exactly as before", async () => {
    await addMember(db.storage.engine(), "alice", {}, OPS);
    expect(await errorCode("entity_facts", { entity_slug: "people/one" }, { authInfo: unbound })).toBe("ok");
    expect(await errorCode("page_get", { slug: "notes/plan" }, { authInfo: unbound })).toBe("ok");
    expect(await unscopedConnections(db.storage.engine())).toBeNull();
  });

  it("the second enabled member refuses an unbound connection's reads, with the fix", async () => {
    await addMember(db.storage.engine(), "bob", {}, OPS);
    const r = await call("entity_facts", { entity_slug: "people/one" }, { authInfo: unbound });
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0]!.text);
    expect(body.error).toBe("requester_scope_required");
    expect(body.message).toContain("2 enabled members");
    expect(body.suggestion).toContain("memrain member bind <member> --token laptop");
    expect(await errorCode("page_get", { slug: "notes/plan" }, { authInfo: unbound })).toBe("requester_scope_required");
    expect(await errorCode("search", { q: "plan" }, { authInfo: unbound })).toBe("requester_scope_required");
  });

  it("whoami and get_brain_identity still answer, and whoami names the state", async () => {
    const who = await call("whoami", {}, { authInfo: unbound });
    expect(who.isError).toBeFalsy();
    expect(JSON.parse(who.content[0]!.text).requester_scope).toBe("refused");
    expect(await errorCode("get_brain_identity", {}, { authInfo: unbound })).toBe("ok");
  });

  it("enumeration: every covered op is refused for an unbound key before its handler runs", async () => {
    for (const op of OPERATIONS) {
      if (!requiresRequesterScope(op, op.name)) continue;
      expect(`${op.name}: ${await errorCode(op.name, {}, { authInfo: unbound })}`).toBe(`${op.name}: requester_scope_required`);
    }
  });

  it("a member-bound key, a source-scoped key and the operator path read", async () => {
    expect(await errorCode("entity_facts", { entity_slug: "people/one" }, { authInfo: { ...unbound, memberId: "alice" } })).toBe("ok");
    expect(await errorCode("page_get", { slug: "notes/plan" }, { authInfo: { ...unbound, sourceId: "team", allowedSources: ["team"] } })).toBe("ok");
    expect(await errorCode("entity_facts", { entity_slug: "people/one" }, {})).toBe("ok");
    const who = await call("whoami", {}, { authInfo: { ...unbound, memberId: "alice" } });
    expect(JSON.parse(who.content[0]!.text).requester_scope).toBe("scoped");
  });

  it("the public bearer is refused too", async () => {
    expect(await errorCode("entity_facts", { entity_slug: "people/one" }, { isPublic: true })).toBe("requester_scope_required");
  });

  it("writes are out of scope", async () => {
    expect(await errorCode("page_put", { slug: "notes/new", markdown_body: "x" }, { authInfo: unbound })).not.toBe("requester_scope_required");
  });

  it("access.serves=several makes a one-person brain shared, and nothing unshares two enabled members", async () => {
    const engine = db.storage.engine();
    await engine.query(`INSERT INTO config (key, value) VALUES ('access.serves', 'one')`);
    expect(await errorCode("entity_facts", { entity_slug: "people/one" }, { authInfo: unbound })).toBe("requester_scope_required");
    await engine.query(`UPDATE config SET value = 'several' WHERE key = 'access.serves'`);
    await disableMember(engine, "bob", OPS);
    expect(await errorCode("entity_facts", { entity_slug: "people/one" }, { authInfo: unbound })).toBe("requester_scope_required");
    await engine.query(`DELETE FROM config WHERE key = 'access.serves'`);
    expect(await errorCode("entity_facts", { entity_slug: "people/one" }, { authInfo: unbound })).toBe("ok");
    await enableMember(engine, "bob", OPS);
  });

  it("creating an unbound credential on this brain is refused; a member or source passes", async () => {
    const engine = db.storage.engine();
    await expect(assertCredentialScoped(engine, {}, "token", "new-key")).rejects.toThrow(/serves several people/);
    await assertCredentialScoped(engine, { memberId: "alice" }, "token", "new-key");
    await assertCredentialScoped(engine, { sourceId: "team" }, "token", "new-key");
  });

  it("doctor lists every live unbound credential with its fix", async () => {
    await db.storage.raw().query(
      `INSERT INTO access_tokens (name, token_hash, scopes, permissions) VALUES
         ('loose', 'h-loose', ARRAY['read'], '{"takes_holders":["world"]}'::jsonb),
         ('scoped', 'h-scoped', ARRAY['read'], '{"source_id":"team"}'::jsonb)`,
    );
    const found = await unscopedConnections(db.storage.engine());
    expect(found?.connections.map((c) => c.name)).toEqual(["loose"]);
    expect(found?.connections[0]?.fix).toBe("memrain member bind <member> --token loose");
  });
});
