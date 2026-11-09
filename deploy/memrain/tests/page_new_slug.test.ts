import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { deletePage, getPage, pageVersions, putPage } from "../src/core/pages.ts";
import { registerSource } from "../src/core/sources.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`new page slug (${name})`, () => {
  let db: Awaited<ReturnType<typeof open>>;
  beforeAll(async () => { db = await open(); });
  afterAll(async () => { await db.close(); });
  const write = (slug: string, extra = {}) => dispatchTool(db.storage, {
    name: "page_put", arguments: { slug, markdown_body: "New page content", ...extra },
  });

  it("refuses repeated and trailing hyphens only on new MCP pages, even with force", async () => {
    for (const slug of ["notes/new--page", "notes/new-", "notes-/new", "notes---/new"]) {
      const result = await write(slug, { force: true });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0]!.text).error).toBe("invalid_params");
      expect(await getPage(db.storage, slug)).toBeNull();
      expect(await pageVersions(db.storage, slug)).toEqual([]);
    }
    const valid = await write("notes/a-new-page");
    expect(valid.isError).toBeFalsy();
    expect((await getPage(db.storage, "notes/a-new-page"))!.markdown_body).toBe("New page content");
  });

  it("preserves internal creation and updates/restoration of existing legacy slugs", async () => {
    const slug = "notes/legacy--page-";
    await putPage(db.storage, { slug, markdown_body: "Internal original" });
    expect((await write(slug, { expected_version: 1 })).isError).toBeFalsy();
    await deletePage(db.storage, slug);
    const deletedVersion = Number((await pageVersions(db.storage, slug))[0]!.version_n);
    expect((await write(slug, { expected_version: deletedVersion })).isError).toBeFalsy();
    expect((await getPage(db.storage, slug))!.markdown_body).toBe("New page content");
  });

  it("keeps ownership refusal ahead of the spelling check", async () => {
    await registerSource(db.storage.engine(), { id: "slug-other", kind: "vault", pathPrefix: "/slug-other" });
    await putPage(db.storage, { slug: "notes/foreign--page", markdown_body: "Original", source_id: "slug-other" });
    const result = await dispatchTool(db.storage, { name: "page_put", arguments: {
      slug: "notes/foreign--page", markdown_body: "Overwrite", force: true,
    } }, { authInfo: { token: "test", clientId: "test", scopes: ["read", "write"], sourceId: "default", allowedSources: ["default"], isPublic: false } });
    expect(JSON.parse(result.content[0]!.text).error).toBe("permission_denied");
    expect((await getPage(db.storage, "notes/foreign--page"))!.markdown_body).toBe("Original");
  });
});
