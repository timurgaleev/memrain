import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { putPage } from "../src/core/pages.ts";
import { registerSource } from "../src/core/sources.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import { checkFactsWithoutEntityPages } from "../src/core/doctor-ops.ts";
import { addFact } from "../src/core/facts.ts";
import { resolveFactEntity } from "../src/core/entity-resolve.ts";

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`fact entity resolution (${name})`, () => {
  let db: Awaited<ReturnType<typeof open>>;
  const opts = { authInfo: { token: "test", clientId: "test", scopes: ["read", "write"], sourceId: "default", allowedSources: ["default"], isPublic: false } };
  beforeAll(async () => {
    db = await open();
    await registerSource(db.storage.engine(), { id: "resolution-other", kind: "vault", pathPrefix: "/resolution-other" });
    for (const slug of ["people/alice", "people/bob", "teams/bob", "people/foreignname", "life/diary/secretname"]) {
      await putPage(db.storage, { slug, title: slug.split("/").at(-1), source_id: slug.endsWith("foreignname") ? "resolution-other" : "default" });
    }
  });
  afterAll(async () => { await db.close(); });
  const write = async (args: Record<string, unknown>) => {
    const result = await dispatchTool(db.storage, { name: "add_fact", arguments: args }, opts);
    expect(result.isError).toBeFalsy();
    return JSON.parse(result.content[0]!.text);
  };
  const entity = async (id: number) => (await db.storage.engine().query<{ entity_slug: string }>("SELECT entity_slug FROM entity_facts WHERE id = $1", [id])).rows[0]!.entity_slug;

  it("resolves a unique bare name and reports the original spelling", async () => {
    const result = await write({ entity_slug: "alice", fact: "Likes deterministic tests" });
    expect(result.entity_resolved_from).toBe("alice");
    expect(result.entity_slug).toBe("people/alice");
    expect(await entity(result.id)).toBe("people/alice");
  });

  it("preserves ambiguous or missing names without confirming private candidates", async () => {
    for (const name of ["bob", "notpresent", "foreignname", "secretname"]) {
      const result = await write({ entity_slug: name, fact: `Record for ${name}` });
      expect(await entity(result.id)).toBe(name);
      expect(result.notice).toBe("entity_unresolved");
      expect(result.candidates.length).toBeLessThanOrEqual(5);
      expect(result.candidates).not.toContain("people/foreignname");
      expect(result.candidates).not.toContain("life/diary/secretname");
      if (name === "bob") expect(result.candidates.sort()).toEqual(["people/bob", "teams/bob"]);
    }
  });

  it("reports each batch resolution and preserves explicit qualified subjects", async () => {
    const batch = await write({ items: [{ entity_slug: "alice", fact: "Batch unique" }, { entity_slug: "bob", fact: "Batch ambiguous" }] });
    expect(batch.items[0].entity_resolved_from).toBe("alice");
    expect(batch.items[1].notice).toBe("entity_unresolved");
    const exact = await write({ entity_slug: "future/subject", fact: "Explicit subject" });
    expect(exact.notice).toBeUndefined();
    expect(await entity(exact.id)).toBe("future/subject");
  });

  it("does not widen a credential's prefix grant when a bare name resolves", async () => {
    await expect(resolveFactEntity(db.storage, "alice", { sourceIds: ["default"], remote: true,
      allowed: slug => slug.startsWith("notes/") })).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("reports missing entity pages without counting forgotten facts or accepting foreign pages", async () => {
    const before = await checkFactsWithoutEntityPages(db.storage.engine());
    const n = Number(before.detail.split(" ")[0]);
    const fact = await addFact(db.storage, { entity_slug: "people/foreignname", fact: "Foreign page is not our entity page", source_id: "default" });
    const added = await checkFactsWithoutEntityPages(db.storage.engine());
    expect(added).toMatchObject({ ok: true, status: "warn" });
    expect(Number(added.detail.split(" ")[0])).toBe(n + 1);
    await db.storage.engine().query("UPDATE entity_facts SET forgotten_at = NOW() WHERE id = $1", [fact.id]);
    expect((await checkFactsWithoutEntityPages(db.storage.engine())).detail).toBe(before.detail);
  });
});
