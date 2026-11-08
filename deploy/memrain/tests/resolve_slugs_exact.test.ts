import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { putPage } from "../src/core/pages.ts";
import { registerSource } from "../src/core/sources.ts";
import { addLink } from "../src/core/links.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`exact slug resolution (${name})`, () => {
  let db: Awaited<ReturnType<typeof open>>;
  const authInfo = { token: "test", clientId: "test", scopes: ["read"], sourceId: "default", allowedSources: ["default"], isPublic: false };
  beforeAll(async () => {
    db = await open();
    await registerSource(db.storage.engine(), { id: "resolve-other", kind: "vault", pathPrefix: "/resolve-other" });
    await putPage(db.storage, { slug: "people/alice", title: "Alice Example", compiled_truth: { aliases: ["A. Example"], email: "alice@example.invalid" } });
    await putPage(db.storage, { slug: "teams/alice", title: "Alice Team" });
    await putPage(db.storage, { slug: "notes/reference" });
    await putPage(db.storage, { slug: "notes/private", type: "journal", title: "Alice", compiled_truth: { aliases: ["Secret Name"] } });
    await putPage(db.storage, { slug: "foreign/alice", title: "Alice Example", source_id: "resolve-other" });
    for (const type of ["knows", "related_to"]) await addLink(db.storage, { source_slug: "notes/reference", target_slug: "people/alice", type });
    await addLink(db.storage, { source_slug: "notes/private", target_slug: "people/alice", type: "related_to" });
    await addLink(db.storage, { source_slug: "foreign/alice", target_slug: "people/alice", type: "related_to", source_id: "resolve-other" });
  });
  afterAll(async () => { await db.close(); });
  const resolve = async (query: string, args: Record<string, unknown> = {}, isPublic = false) => {
    const result = await dispatchTool(db.storage, { name: "resolve_slugs", arguments: { query, exact: true, ...args } }, { authInfo, isPublic });
    expect(result.isError).toBeFalsy();
    return JSON.parse(result.content[0]!.text);
  };

  it("matches exact title, alias and email but never a typo or partial name", async () => {
    for (const query of ["Alice Example", "a. example", "ALICE@example.invalid", "people/alice"]) {
      const result = await resolve(query);
      expect(result.ambiguous).toBe(false);
      expect(result.hits).toEqual([{ slug: "people/alice", title: "Alice Example", score: 1, referenced_by_count: 1 }]);
    }
    expect((await resolve("alce example")).hits).toEqual([]);
    expect((await resolve("alice ex")).hits).toEqual([]);
  });

  it("reports basename ambiguity even at limit one without counting hidden candidates", async () => {
    const result = await resolve("alice", { limit: 1 });
    expect(result.ambiguous).toBe(true);
    expect(result.hits).toHaveLength(1);
    expect((await resolve("Secret Name")).hits).toEqual([]);
    expect((await resolve("Alice Example")).ambiguous).toBe(false);
  });

  it("does not confirm body-only email fields on redacted public reads", async () => {
    expect((await resolve("alice@example.invalid", {}, true)).hits).toEqual([]);
  });

  it("adds source-scoped distinct referring-page counts to fuzzy results too", async () => {
    const result = await resolve("alce example", { exact: false });
    expect(result.hits[0]).toMatchObject({ slug: "people/alice", referenced_by_count: 1 });
    expect(result.hits.some((h: { slug: string }) => h.slug.startsWith("foreign/") || h.slug === "notes/private")).toBe(false);
  });
});
