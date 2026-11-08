import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { getPage, pageVersions, putPage } from "../src/core/pages.ts";
import { registerSource } from "../src/core/sources.ts";
import { dispatchTool, type DispatchOptions } from "../src/mcp/dispatch.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";

const auth: AuthInfo = { token: "test", clientId: "test", scopes: ["read", "write"],
  sourceId: "version-a", allowedSources: ["version-a"], isPublic: false };
for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`historical page read (${name})`, () => {
  let db: Awaited<ReturnType<typeof open>>;
  const read = (args: Record<string, unknown>, opts: DispatchOptions = {}) =>
    dispatchTool(db.storage, { name: "page_get", arguments: args }, opts);
  beforeAll(async () => {
    db = await open();
    for (const id of ["version-a", "version-b"]) await registerSource(db.storage.engine(), { id, kind: "vault", pathPrefix: `/${id}` });
    for (const body of ["Old content", "Current content"]) await putPage(db.storage, {
      slug: "notes/history", source_id: "version-a", title: "Current title", markdown_body: body, compiled_truth: { summary: body },
    });
    await putPage(db.storage, { slug: "notes/large-history", source_id: "version-a", markdown_body: "# Old heading\n" + "Large original body.\n".repeat(16000) });
    await putPage(db.storage, { slug: "notes/large-history", source_id: "version-a", markdown_body: "Small current body." });
    await putPage(db.storage, { slug: "notes/held-history", source_id: "version-a", markdown_body: "# Private old heading\nOld held content" });
    const held = await dispatchTool(db.storage, { name: "page_put", arguments: {
      slug: "notes/held-history", markdown_body: "Checking your browser before accessing example.com. Cloudflare Ray ID: 8badf00d",
    } }, { authInfo: auth });
    expect(held.isError).toBeFalsy();
    await putPage(db.storage, { slug: "life/diary/history", source_id: "version-a", markdown_body: "Diary content" });
  });
  afterAll(async () => { await db.close(); });

  it("returns the requested snapshot and distinguishes it from the current version", async () => {
    const result = await read({ slug: "notes/history", version: 1 }, { authInfo: auth });
    expect(result.isError).toBeFalsy();
    const r = JSON.parse(result.content[0]!.text);
    const old = (await pageVersions(db.storage, "notes/history"))[1]!;
    expect(r).toMatchObject({ version: 1, current_version: 2, written_at: old.written_at,
      page: { markdown_body: "Old content", compiled_truth: { summary: "Old content" }, content_hash: old.hash_new, title: "Current title" } });
    expect((await getPage(db.storage, "notes/history"))!.markdown_body).toBe("Current content");
  });

  it("reports a missing version only after the caller can read the page", async () => {
    const missing = await read({ slug: "notes/history", version: 99 }, { authInfo: auth });
    expect(missing.isError).toBe(true);
    expect(JSON.parse(missing.content[0]!.text).error).toBe("version_not_found");
    const foreign = await read({ slug: "notes/history", version: 99 }, {
      authInfo: { ...auth, sourceId: "version-b", allowedSources: ["version-b"] },
    });
    expect(JSON.parse(foreign.content[0]!.text).error).toBe("not_found");
    const diary = await read({ slug: "life/diary/history", version: 1 }, { authInfo: auth });
    expect(JSON.parse(diary.content[0]!.text).error).toBe("not_found");
  });

  it("withholds historical bodies and headings under current quarantine and public redaction", async () => {
    const held = await read({ slug: "notes/held-history", version: 1, max_bytes: 10 }, { authInfo: auth });
    expect(held.isError).toBeFalsy();
    const r = JSON.parse(held.content[0]!.text);
    expect(r.notice).toBe("page_quarantined");
    expect(r.headings).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain("Private old heading");
    expect(r.page.markdown_body).toBeUndefined();
    const publicRead = await read({ slug: "notes/history", version: 1 }, { isPublic: true });
    expect(publicRead.isError).toBeFalsy();
    const publicPage = JSON.parse(publicRead.content[0]!.text);
    expect(publicPage.page.markdown_body).toBeUndefined();
    expect(publicPage.page.body_window).toBeUndefined();
    expect(publicPage.headings).toBeUndefined();
  });

  it("windows a large historical body while retaining the current stored page", async () => {
    const result = await read({ slug: "notes/large-history", version: 1 });
    expect(result.isError).toBeFalsy();
    const r = JSON.parse(result.content[0]!.text);
    expect(r.partial).toBe(true);
    expect("markdown_body" in r.page).toBe(false);
    expect(r.page.body_window.startsWith("# Old heading\n")).toBe(true);
    expect(Buffer.byteLength(r.page.body_window)).toBeLessThanOrEqual(262144);
    expect((await getPage(db.storage, "notes/large-history"))!.markdown_body).toBe("Small current body.");
  });
});
