import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { capHitSnippets } from "../src/core/search/snippet-cap.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import { putPage } from "../src/core/pages.ts";
import { registerSource } from "../src/core/sources.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";

const auth: AuthInfo = { token: "test", clientId: "test", scopes: ["read"], sourceId: "pointer-a", allowedSources: ["pointer-a", "default"], isPublic: false };
let db: Awaited<ReturnType<ReturnType<typeof storageEngines>[number]["open"]>>;
beforeAll(async () => {
  db = await storageEngines(undefined)[0]!.open();
  await registerSource(db.storage.engine(), { id: "pointer-a", kind: "vault", pathPrefix: "/pointer-a" });
  await registerSource(db.storage.engine(), { id: "pointer-b", kind: "vault", pathPrefix: "/pointer-b" });
  for (const [slug, source_id] of [["pointer-a/notes/default", "default"], ["notes/tenant", "pointer-a"], ["notes/foreign", "pointer-b"]]) {
    await putPage(db.storage, { slug: slug!, source_id, type: "note", markdown_body: `Full content ${slug}` });
  }
});
afterAll(async () => { await db.close(); });

describe("source-qualified page pointers", () => {
  for (const [source_id, slug, path] of [
    ["default", "pointer-a/notes/default", "page://pointer-a/notes/default"],
    ["pointer-a", "notes/tenant", "page://pointer-a/notes/tenant"],
    ["pointer-a", "notes/tenant", "page-truth://pointer-a/notes/tenant"],
  ]) it(`round-trips ${path} using the hit's owning source`, async () => {
    const hit = capHitSnippets([{ content: "long content for this page", sourcePath: path!, source_id }], 4, auth.allowedSources)[0]!;
    const args = JSON.parse(hit.full!.slice("page_get ".length));
    expect(args).toEqual({ slug, source_id });
    const r = await dispatchTool(db.storage, { name: "page_get", arguments: args }, { authInfo: auth });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0]!.text).page.markdown_body).toBe(`Full content ${slug}`);
  });

  it("never expands a tenant's grant through an explicit source, even with fuzzy lookup", async () => {
    for (const fuzzy of [false, true]) {
      const r = await dispatchTool(db.storage, { name: "page_get", arguments: { slug: "notes/foreign", source_id: "pointer-b", fuzzy } }, { authInfo: auth });
      expect(r.isError).toBe(true);
      expect(JSON.parse(r.content[0]!.text).error).toBe("not_found");
    }
  });

  it("an operator's explicit source cannot resolve a page owned by a different source", async () => {
    const r = await dispatchTool(db.storage, { name: "page_get", arguments: { slug: "notes/tenant", source_id: "default" } });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0]!.text).error).toBe("not_found");
  });
});
