import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import { putPage } from "../src/core/pages.ts";
import { registerSource } from "../src/core/sources.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";

const auth: AuthInfo = { token: "test", clientId: "test", scopes: ["read", "write"],
  sourceId: "held-a", allowedSources: ["held-a"], isPublic: false };
const junk = "Checking your browser before accessing example.com. Cloudflare Ray ID: 8badf00d";
for (const engine of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(engine.name, () => {
  let db: Awaited<ReturnType<typeof engine.open>>;
  const call = async (name: string, args: Record<string, unknown>, remote = true) => {
    const r = await dispatchTool(db.storage, { name, arguments: args }, remote ? { authInfo: auth } : {});
    expect(r.isError).toBeFalsy();
    return JSON.parse(r.content[0]!.text);
  };
  beforeAll(async () => {
    db = await engine.open();
    for (const id of ["held-a", "held-b"]) await registerSource(db.storage.engine(), { id, kind: "vault", pathPrefix: `/${id}` });
    for (const slug of ["notes/held-one", "notes/held-two"]) {
      await call("page_put", { slug, type: "note", markdown_body: junk, compiled_truth: { secret: "held truth" } });
    }
    await call("page_append", { slug: "notes/held-one", content: "Second revision." });
    await putPage(db.storage, { slug: "notes/foreign", type: "note", markdown_body: "foreign secret", source_id: "held-b" });
    await putPage(db.storage, { slug: "notes/clean", type: "note", markdown_body: "normal content", source_id: "held-a" });
  });
  afterAll(async () => { await db.close(); });

  it("lists held metadata using a single batch lookup and preserves clean content", async () => {
    const query = spyOn(db.storage.engine(), "query");
    try {
      const r = await call("page_list", {});
      expect(r.pages.map((p: any) => p.slug).sort()).toEqual(["notes/clean", "notes/held-one", "notes/held-two"]);
      for (const page of r.pages.filter((p: any) => p.slug.includes("held"))) {
        expect(page.notice).toBe("page_quarantined");
        expect(page.quarantined.reason).toBe("junk_pattern");
        expect(page.markdown_body).toBeUndefined();
        expect(page.compiled_truth).toBeUndefined();
      }
      expect(r.pages.find((p: any) => p.slug === "notes/clean").markdown_body).toBe("normal content");
      expect(query.mock.calls.filter(([sql]) => sql.includes("FROM documents") && sql.includes("frontmatter"))).toHaveLength(1);
    } finally { query.mockRestore(); }
  });

  it("withholds every revision snapshot and leaves version metadata", async () => {
    const r = await call("page_versions", { slug: "notes/held-one", include_body: true });
    expect(r.versions).toHaveLength(2);
    for (const v of r.versions) {
      expect(v.notice).toBe("page_quarantined");
      expect(v.quarantined.reason).toBe("junk_pattern");
      expect(v.body_snapshot).toBeUndefined();
      expect(v.compiled_truth_snapshot).toBeUndefined();
      expect(Number(v.version_n)).toBeGreaterThan(0);
    }
    expect((await call("page_versions", { slug: "notes/foreign", include_body: true })).versions).toEqual([]);
  });

  it("withholds recalled page content without leaking foreign pages", async () => {
    const r = await call("entity_recall", { slug: "notes/held-one" });
    expect(r.page.notice).toBe("page_quarantined");
    expect(r.page.quarantined.reason).toBe("junk_pattern");
    expect(r.page.markdown_body).toBeUndefined();
    expect(r.page.compiled_truth).toBeUndefined();
    expect(r.identity).toBeUndefined();
    expect((await call("entity_recall", { slug: "notes/foreign" })).page).toBeNull();
  });

  it("does not borrow another source's verdict for an ambiguous mirror path", async () => {
    await putPage(db.storage, { slug: "held-a/notes/held-one", type: "note", markdown_body: "default content", source_id: "default" });
    const r = await call("page_get", { slug: "held-a/notes/held-one" }, false);
    expect(r.page.markdown_body).toBe("default content");
    expect(r.quarantined).toBeUndefined();
  });

  it("lets operators inspect held content and its verdict on all surfaces", async () => {
    const list = await call("page_list", {}, false);
    const page = list.pages.find((p: any) => p.slug === "notes/held-one");
    expect(page.markdown_body).toContain(junk);
    expect(page.quarantined.reason).toBe("junk_pattern");
    expect(page.notice).toBeUndefined();
    const versions = (await call("page_versions", { slug: page.slug, include_body: true }, false)).versions;
    expect(versions[0].body_snapshot).toContain(junk);
    expect(versions[0].quarantined.reason).toBe("junk_pattern");
    const recall = await call("entity_recall", { slug: page.slug }, false);
    expect(recall.page.markdown_body).toContain(junk);
    expect(recall.page.quarantined.reason).toBe("junk_pattern");
  });
});
