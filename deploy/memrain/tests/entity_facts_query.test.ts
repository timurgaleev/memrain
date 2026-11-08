import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { addFact } from "../src/core/facts.ts";
import { putPage } from "../src/core/pages.ts";
import { registerSource } from "../src/core/sources.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";

const vec = (x: number) => Array.from({ length: 1024 }, (_, i) => i === 0 ? x : i === 1 ? Math.sqrt(1 - x * x) : 0);
for (const engine of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`entity facts query ${engine.name}`, () => {
  let db: Awaited<ReturnType<typeof engine.open>>;
  let calls = 0;
  let embedded = "";
  const embedQuery = async (text: string) => { calls++; embedded = text; return vec(1); };
  const auth: AuthInfo = { token: "test", clientId: "facts-query", sourceId: "facts-a", allowedSources: ["facts-a"], scopes: ["read"], isPublic: false };
  const call = async (args: Record<string, unknown>, opts: Parameters<typeof dispatchTool>[2] = { authInfo: auth, embedQuery }) => {
    const r = await dispatchTool(db.storage, { name: "entity_facts", arguments: args }, opts);
    expect(r.isError).toBeFalsy();
    return JSON.parse(r.content[0]!.text);
  };
  beforeAll(async () => {
    db = await engine.open();
    for (const id of ["facts-a", "facts-b"]) await registerSource(db.storage.engine(), { id, kind: "vault", pathPrefix: `/${id}` });
    await putPage(db.storage, { slug: "notes/private-journal", type: "journal", markdown_body: "Journal", source_id: "facts-a" });
    for (const [fact, entity_slug, source_id, visibility, cosine, source_slug] of [
      ["strong topic", "people/one", "facts-a", "world", 0.9, undefined],
      ["weaker topic", "people/two", "facts-a", "world", 0.7, undefined],
      ["unrelated", "people/one", "facts-a", "world", 0, undefined],
      ["hidden private", "people/one", "facts-a", "private", 1, undefined],
      ["foreign topic", "people/one", "facts-b", "world", 1, undefined],
      ["journal topic", "people/one", "facts-a", "world", 1, "notes/private-journal"],
    ] as const) {
      const r = await addFact(db.storage, { entity_slug, fact, source_id, visibility, source_slug });
      await db.storage.engine().query("UPDATE entity_facts SET embedding = $1::vector WHERE id = $2", [JSON.stringify(vec(cosine)), r.id]);
    }
  });
  afterAll(async () => { await db.close(); });
  it("ranks related visible facts and groups an entity-less request", async () => {
    const r = await call({ query: "topic" });
    expect(r.facts.map((f: any) => f.fact)).toEqual(["strong topic", "weaker topic"]);
    expect(r.facts_groups.map((g: any) => [g.entity_slug, g.facts.map((f: any) => f.fact)])).toEqual([
      ["people/one", ["strong topic"]], ["people/two", ["weaker topic"]],
    ]);
    const one = await call({ entity_slug: "people/one", query: "topic", limit: 1 });
    expect(one.facts.map((f: any) => f.fact)).toEqual(["strong topic"]);
    expect(one.facts_groups).toBeUndefined();
  });
  it("caps the one embedding input and makes no paid call for an empty grant", async () => {
    calls = 0;
    await call({ query: "q".repeat(10000) });
    expect(calls).toBe(1);
    expect(embedded.length).toBe(512);
    const prior = process.env.MEMRAIN_TENANT_FAIL_CLOSED;
    process.env.MEMRAIN_TENANT_FAIL_CLOSED = "1";
    try {
      const result = await call({ query: "topic" }, { authInfo: { ...auth, sourceId: undefined, allowedSources: [] }, embedQuery });
      expect(result.facts).toEqual([]);
      expect(calls).toBe(1);
    } finally {
      if (prior === undefined) delete process.env.MEMRAIN_TENANT_FAIL_CLOSED;
      else process.env.MEMRAIN_TENANT_FAIL_CLOSED = prior;
    }
  });
  it("ignores semantic focus for the public bearer even when bodies are enabled", async () => {
    const prior = process.env.MEMRAIN_PUBLIC_READ_BODIES;
    try {
      for (const flag of ["0", "1"]) {
        process.env.MEMRAIN_PUBLIC_READ_BODIES = flag;
        calls = 0;
        const opts = { isPublic: true, embedQuery };
        expect(await call({ query: "topic" }, opts)).toEqual(await call({}, opts));
        expect(calls).toBe(0);
      }
    } finally {
      if (prior === undefined) delete process.env.MEMRAIN_PUBLIC_READ_BODIES;
      else process.env.MEMRAIN_PUBLIC_READ_BODIES = prior;
    }
  });
  it("keeps plain reads unchanged and explains an unavailable embedding", async () => {
    calls = 0;
    expect(await call({ query: " " })).toEqual(await call({}));
    expect(calls).toBe(0);
    const fallback = await call({ query: "topic" }, { authInfo: auth, embedQuery: async () => { throw new Error("offline"); } });
    expect(fallback.facts).toEqual((await call({})).facts);
    expect(fallback.hint.status).toBe("embedding_unavailable");
  });
});
