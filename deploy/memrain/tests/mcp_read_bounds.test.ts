import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { putPage } from "../src/core/pages.ts";
import { registerSource } from "../src/core/sources.ts";
import { dispatchTool, type DispatchOptions } from "../src/mcp/dispatch.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";

const auth: AuthInfo = { token: "test", clientId: "test", scopes: ["read"],
  sourceId: "bounds-a", allowedSources: ["bounds-a"], isPublic: false };

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`bounded reads (${name})`, () => {
  let db: Awaited<ReturnType<typeof open>>;
  const call = async (tool: string, args: Record<string, unknown>, opts: DispatchOptions = {}) => {
    const r = await dispatchTool(db.storage, { name: tool, arguments: args }, opts);
    expect(r.isError).toBeFalsy();
    return JSON.parse(r.content[0]!.text);
  };
  beforeAll(async () => {
    db = await open();
    for (const id of ["bounds-a", "bounds-b"]) await registerSource(db.storage.engine(), { id, kind: "vault", pathPrefix: `/${id}` });
    for (const body of ["First version", "Second version"]) await putPage(db.storage, {
      slug: "notes/versions", source_id: "bounds-a", markdown_body: body, compiled_truth: { summary: body },
    });
    await db.storage.engine().exec(`
      INSERT INTO documents (id, source_path, source_id) VALUES
        ('bounds-visible', '/shared.md', 'bounds-a'), ('bounds-foreign', '/shared.md', 'bounds-b');
      INSERT INTO chunks (id, document_id, chunk_index, content)
        SELECT 'bounds-chunk-' || n, 'bounds-visible', n, 'Visible chunk ' || n FROM generate_series(0, 200) n;
      INSERT INTO chunks (id, document_id, chunk_index, content) VALUES ('bounds-private', 'bounds-foreign', 0, 'Foreign content');
    `);
  });
  afterAll(async () => { await db.close(); });

  it("defaults version history to metadata without selecting snapshots", async () => {
    const query = spyOn(db.storage.engine(), "query");
    try {
      const r = await call("page_versions", { slug: "notes/versions" });
      expect(r.versions).toHaveLength(2);
      expect(r.versions.map((v: any) => Number(v.version_n))).toEqual([2, 1]);
      expect(r.versions.every((v: any) => !("body_snapshot" in v) && !("compiled_truth_snapshot" in v))).toBe(true);
      const sql = query.mock.calls.find(([sql]) => /FROM page_versions\b/.test(sql))?.[0];
      expect(sql).toBeDefined();
      expect(sql).not.toContain("body_snapshot");
      expect(sql).not.toContain("compiled_truth_snapshot");
    } finally { query.mockRestore(); }
  });

  it("returns explicit version bodies only inside the existing read grant", async () => {
    const r = await call("page_versions", { slug: "notes/versions", include_body: true }, { authInfo: auth });
    expect(r.versions[0]).toMatchObject({ body_snapshot: "Second version", compiled_truth_snapshot: { summary: "Second version" } });
    const foreign = await call("page_versions", { slug: "notes/versions", include_body: true }, {
      authInfo: { ...auth, sourceId: "bounds-b", allowedSources: ["bounds-b"] },
    });
    expect(foreign.versions).toEqual([]);
    const redacted = await call("page_versions", { slug: "notes/versions", include_body: true }, { isPublic: true });
    expect(JSON.stringify(redacted)).not.toContain("Second version");
  });

  it("keeps listing bodies by default but can omit them in the database read", async () => {
    expect((await call("page_list", {})).pages[0].markdown_body).toBe("Second version");
    const query = spyOn(db.storage.engine(), "query");
    try {
      const r = await call("page_list", { include_body: false });
      expect(r.pages).toHaveLength(1);
      expect(r.pages[0].slug).toBe("notes/versions");
      expect("markdown_body" in r.pages[0]).toBe(false);
      expect("compiled_truth" in r.pages[0]).toBe(false);
      const sql = query.mock.calls.find(([sql]) => /FROM pages\b/.test(sql))?.[0];
      expect(sql).not.toContain("markdown_body");
      expect(sql).not.toContain("compiled_truth");
    } finally { query.mockRestore(); }
  });

  it("bounds chunks after source filtering and returns the exact next page", async () => {
    const r = await call("get_chunks", { source_path: "/shared.md" }, { authInfo: auth });
    expect(r.chunks).toHaveLength(200);
    expect(r.truncated).toBe(true);
    expect(r.chunks.map((c: any) => c.chunkIndex)).toEqual(Array.from({ length: 200 }, (_, i) => i));
    const last = await call("get_chunks", { source_path: "/shared.md", from_index: 200, limit: 20 }, { authInfo: auth });
    expect(last.chunks).toEqual([{ chunkId: "bounds-chunk-200", chunkIndex: 200, content: "Visible chunk 200", symbolName: null }]);
    expect(last.truncated).toBe(false);
    const small = await call("get_chunks", { source_path: "/shared.md", from_index: 1, limit: 2 }, { authInfo: auth });
    expect(small.chunks.map((c: any) => c.chunkIndex)).toEqual([1, 2]);
    expect(small.truncated).toBe(true);
  });

  it("does not skip tied chunk indices across sources when an operator pages", async () => {
    const first = await call("get_chunks", { source_path: "/shared.md", limit: 1 });
    const second = await call("get_chunks", { source_path: "/shared.md", limit: 1, from_index: 1 });
    expect(first.chunks[0].chunkId).toBe("bounds-chunk-0");
    expect(second.chunks[0].chunkId).toBe("bounds-private");
    expect(first.truncated).toBe(true);
    expect(second.truncated).toBe(true);
  });
});
