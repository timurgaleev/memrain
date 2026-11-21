/**
 * The brain owner: a credential bound to the member named owner reads the
 * brain as its owner (private facts, diary-derived facts, private takes),
 * while every other caller keeps today's visibility. The owner is named
 * explicitly by the operator, never guessed.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { storageEngines } from "./helpers/storage-engines.ts";
import { addFact } from "../src/core/facts.ts";
import { putPage } from "../src/core/pages.ts";
import { registerSource } from "../src/core/sources.ts";
import { addMember, bindCredential, disableMember, enableMember, type MemberActor } from "../src/core/members.ts";
import { clearOwner, ownerMemberId, ownerView, setOwner } from "../src/core/brain-owner.ts";
import { OAuthProvider } from "../src/core/oauth-provider.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";

const OPS: MemberActor = { actor: "ops", via: "cli" };

for (const engine of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`brain owner ${engine.name}`, () => {
  let db: Awaited<ReturnType<typeof engine.open>>;
  const base: AuthInfo = { token: "t", clientId: "laptop", scopes: ["read", "write"], isPublic: false };
  const facts = async (opts: Parameters<typeof dispatchTool>[2]) => {
    const r = await dispatchTool(db.storage, { name: "entity_facts", arguments: { entity_slug: "people/me" } }, opts);
    expect(r.isError).toBeFalsy();
    return (JSON.parse(r.content[0]!.text).facts as Array<{ fact: string }>).map((f) => f.fact).sort();
  };
  const whoami = async (opts: Parameters<typeof dispatchTool>[2]) => {
    const r = await dispatchTool(db.storage, { name: "whoami", arguments: {} }, opts);
    expect(r.isError).toBeFalsy();
    return JSON.parse(r.content[0]!.text);
  };

  beforeAll(async () => {
    db = await engine.open();
    await registerSource(db.storage.engine(), { id: "home", kind: "vault", pathPrefix: "/home" });
    await putPage(db.storage, { slug: "life/diary/2026-11-01", type: "diary", markdown_body: "Diary", source_id: "default" });
    await addFact(db.storage, { entity_slug: "people/me", fact: "world fact", visibility: "world" });
    await addFact(db.storage, { entity_slug: "people/me", fact: "private fact", visibility: "private" });
    await addFact(db.storage, { entity_slug: "people/me", fact: "diary fact", visibility: "world", source_slug: "life/diary/2026-11-01" });
    for (const id of ["ora", "alice"]) await addMember(db.storage.engine(), id, {}, OPS);
  });
  afterAll(async () => { await db.close(); });

  it("names an enabled member as owner and refuses anything else", async () => {
    const engine = db.storage.engine();
    expect(await ownerMemberId(engine)).toBeNull();
    await expect(setOwner(engine, "nobody")).rejects.toThrow(/no member/);
    await expect(setOwner(engine, "Bad Id")).rejects.toThrow(/not a valid member id/);
    await disableMember(engine, "alice", OPS);
    await expect(setOwner(engine, "alice")).rejects.toThrow(/enabled/);
    await enableMember(engine, "alice", OPS);
    expect((await setOwner(engine, "ora")).owner).toBe("ora");
    expect(await ownerMemberId(engine)).toBe("ora");
  });

  it("the owner's credential reads private and diary-derived facts", async () => {
    expect(await facts({ authInfo: { ...base, memberId: "ora" } })).toEqual(["diary fact", "private fact", "world fact"]);
  });

  it("every other caller keeps world-only visibility", async () => {
    expect(await facts({ authInfo: { ...base, memberId: "alice" } })).toEqual(["world fact"]);
    // The owner flag never comes from the caller: only the stored member id counts.
    expect(await facts({ authInfo: { ...base, memberId: "ora ", clientId: "ora" } })).toEqual(["world fact"]);
    // With one person enabled, an unbound key and the public ingress read world facts only.
    await disableMember(db.storage.engine(), "alice", OPS);
    try {
      expect(await facts({ authInfo: base })).toEqual(["world fact"]);
      // The public ingress redacts fact text, so only the count is compared.
      expect(await facts({ isPublic: true })).toHaveLength(1);
    } finally {
      await enableMember(db.storage.engine(), "alice", OPS);
    }
  });

  it("the trusted operator path is unchanged", async () => {
    expect(await facts({})).toEqual(["diary fact", "private fact", "world fact"]);
  });

  it("an owner that is no longer enabled reads nothing extra", async () => {
    const engine = db.storage.engine();
    await disableMember(engine, "ora", OPS);
    const view = await ownerView(engine);
    expect(view.owner).toBeNull();
    expect(view.inactive?.value).toBe("ora");
    expect(await facts({ authInfo: { ...base, memberId: "ora" } })).toEqual(["world fact"]);
    await enableMember(engine, "ora", OPS);
    expect((await ownerView(engine)).owner).toBe("ora");
  });

  it("whoami says whether the caller reads as the owner", async () => {
    expect((await whoami({ authInfo: { ...base, memberId: "ora" } })).owner).toBe(true);
    expect((await whoami({ authInfo: { ...base, memberId: "alice" } })).owner).toBe(false);
    expect((await whoami({ authInfo: base })).owner).toBe(false);
  });

  it("the verifier carries the bound member onto the credential", async () => {
    const token = "memrain_" + randomBytes(24).toString("hex");
    const hash = createHash("sha256").update(token).digest("hex");
    await db.storage.raw().query(
      `INSERT INTO access_tokens (name, token_hash, scopes, permissions) VALUES ('owner-laptop', $1, ARRAY['read','write'], '{}'::jsonb)`,
      [hash],
    );
    const provider = new OAuthProvider({ engine: db.storage.raw() });
    expect((await provider.verifyAccessToken(token)).memberId).toBeUndefined();
    await bindCredential(db.storage.engine(), "ora", { kind: "token", id: "owner-laptop" }, OPS);
    const info = await provider.verifyAccessToken(token);
    expect(info.memberId).toBe("ora");
    expect(await facts({ authInfo: { ...info, isPublic: false } })).toEqual(["diary fact", "private fact", "world fact"]);
  });

  it("clearing the owner turns the owner's credential back into an ordinary one", async () => {
    await clearOwner(db.storage.engine());
    expect(await facts({ authInfo: { ...base, memberId: "ora" } })).toEqual(["world fact"]);
    await setOwner(db.storage.engine(), "ora");
  });
});
