import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { putPage } from "../src/core/pages.ts";
import { registerSource } from "../src/core/sources.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";

const auth: AuthInfo = { token: "test", clientId: "cursor", scopes: ["read"],
  sourceId: "cursor-a", allowedSources: ["cursor-a"], isPublic: false };

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`page listing cursor (${name})`, () => {
  let db: Awaited<ReturnType<typeof open>>;
  beforeAll(async () => {
    db = await open();
    for (const id of ["cursor-a", "cursor-b"]) await registerSource(db.storage.engine(), { id, kind: "vault", pathPrefix: `/${id}` });
    for (const slug of ["projects/x/a", "projects/x/b", "projects/x/c", "projects/xy/a", "projects/x/z-diary", "projects/x/z-journal", "life/diary/cursor", "projects/x/foreign"]) {
      await putPage(db.storage, { slug, source_id: slug.endsWith("foreign") ? "cursor-b" : "cursor-a",
        type: slug.endsWith("z-diary") ? "diary" : slug.endsWith("z-journal") ? "journal" : "note", markdown_body: slug });
    }
    await db.storage.engine().exec(`
      UPDATE pages SET created_at = '2026-01-01 00:00:00.123456+00', updated_at = '2026-01-01 00:00:00.123456+00';
      UPDATE pages SET updated_at = '2026-01-01 00:00:00.123457+00', created_at = '2026-01-01 00:00:00.123457+00' WHERE slug = 'projects/x/c';
      UPDATE pages SET updated_at = '2026-02-01+00' WHERE type IN ('diary', 'journal') OR slug LIKE 'life/diary/%';
    `);
    await db.storage.engine().query("UPDATE pages SET type = $1 WHERE slug = $2", [" \tJournal\u00a0", "projects/x/z-journal"]);
  });
  afterAll(async () => { await db.close(); });
  const raw = (args: Record<string, unknown>, caller = auth) => dispatchTool(db.storage, {
    name: "page_list", arguments: { include_body: false, ...args },
  }, { authInfo: caller });
  const read = async (args: Record<string, unknown>) => {
    const r = await raw(args);
    expect(r.isError).toBeFalsy();
    return JSON.parse(r.content[0]!.text);
  };

  it("paginates every sort with tied timestamps and preserves microseconds", async () => {
    for (const sort of ["updated_desc", "updated_asc", "created_desc", "slug"]) {
      const found: string[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 3; i++) {
        const r = await read({ slug_prefix: "projects/x/", sort, limit: 1, ...(cursor ? { cursor } : {}) });
        expect(r.pages).toHaveLength(1);
        found.push(r.pages[0].slug);
        expect(r.complete).toBe(i === 2);
        if (i === 2) expect(r.next_cursor).toBeNull();
        else expect(typeof r.next_cursor).toBe("string");
        cursor = r.next_cursor;
      }
      expect(found).toEqual((sort === "updated_desc" || sort === "created_desc" ? ["c", "a", "b"] : ["a", "b", "c"]).map(s => `projects/x/${s}`));
    }
  });

  it("excludes private rows before fetching the visible limit and reports empty completion", async () => {
    const r = await read({ limit: 4 });
    expect(r.pages.map((p: { slug: string }) => p.slug)).toEqual(["projects/x/c", "projects/x/a", "projects/x/b", "projects/xy/a"]);
    expect(r.complete).toBe(true);
    expect(r.next_cursor).toBeNull();
    const empty = await read({ slug_prefix: "absent/", limit: 1 });
    expect(empty).toMatchObject({ pages: [], complete: true, next_cursor: null });
  });

  it("binds cursors to filters and caller sources while permitting a different limit", async () => {
    const first = await read({ slug_prefix: "projects/x/", limit: 1 });
    const cursor = first.next_cursor;
    for (const changed of [{ slug_prefix: "projects/" }, { sort: "slug" }, { type: "person" }, { tag: "work" }, { since: "2025-01-01" }, { include_deleted: true }]) {
      const r = await raw({ slug_prefix: "projects/x/", cursor, ...changed });
      expect(JSON.parse(r.content[0]!.text).error).toBe("invalid_params");
    }
    const foreign = await raw({ slug_prefix: "projects/x/", cursor }, { ...auth, sourceId: "cursor-b", allowedSources: ["cursor-b"] });
    expect(JSON.parse(foreign.content[0]!.text).error).toBe("invalid_params");
    const rest = await read({ slug_prefix: "projects/x/", cursor, limit: 100 });
    expect(rest.pages.map((p: { slug: string }) => p.slug)).toEqual(["projects/x/a", "projects/x/b"]);
    expect(rest.complete).toBe(true);
  });

  it("rejects malformed cursors and path prefixes without treating metacharacters as wildcards", async () => {
    const first = await read({ limit: 1 });
    expect(typeof first.next_cursor).toBe("string");
    for (const cursor of ["!", "x".repeat(4097), Buffer.from("{}").toString("base64url"), first.next_cursor.slice(0, -5)]) {
      const r = await raw({ cursor });
      expect(JSON.parse(r.content[0]!.text).error).toBe("invalid_params");
    }
    for (const slug_prefix of ["projects/%", "projects/_", "projects/../", "/projects", "projects\\", "projects/*", "x".repeat(257)]) {
      const r = await raw({ slug_prefix });
      expect(JSON.parse(r.content[0]!.text).error).toBe("invalid_params");
    }
    const alias = await raw({ prefix: "projects/x/" });
    expect(alias.isError).toBe(true);
    expect(JSON.parse(alias.content[0]!.text).suggestion).toContain("slug_prefix");
  });
});
