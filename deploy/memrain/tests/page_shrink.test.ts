import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { getPage, pageVersions, putPage } from "../src/core/pages.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import { storageEngines } from "./helpers/storage-engines.ts";

setDefaultTimeout(60000);
const policy = process.env.MEMRAIN_REQUIRE_WRITE_PRECONDITION;

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) {
  describe(`large page replacement (${name})`, () => {
    let db: Awaited<ReturnType<typeof open>>;
    beforeEach(async () => { db = await open(); });
    afterEach(async () => {
      if (policy === undefined) delete process.env.MEMRAIN_REQUIRE_WRITE_PRECONDITION;
      else process.env.MEMRAIN_REQUIRE_WRITE_PRECONDITION = policy;
      await db.close();
    });

    it("refuses a truncated replacement without changing body, hash or history", async () => {
      const body = "A long authored paragraph.\n".repeat(1500);
      await putPage(db.storage, { slug: "notes/large", markdown_body: body });
      const before = await getPage(db.storage, "notes/large");
      const versions = await pageVersions(db.storage, "notes/large");
      await expect(putPage(db.storage, {
        slug: "notes/large", markdown_body: "just a fragment", expectedVersion: 1, preconditionPolicy: "warn",
      })).rejects.toMatchObject({ code: "page_shrink_refused" });
      expect(await getPage(db.storage, "notes/large")).toEqual(before);
      expect(await pageVersions(db.storage, "notes/large")).toEqual(versions);
    });

    it("uses UTF-8 bytes for the threshold and replacement ratio", async () => {
      await putPage(db.storage, { slug: "notes/unicode", markdown_body: "界".repeat(12000) });
      await expect(putPage(db.storage, {
        slug: "notes/unicode", markdown_body: "x".repeat(17000), preconditionPolicy: "warn",
      })).rejects.toMatchObject({ code: "page_shrink_refused" });
    });

    it("allows exactly 32 KiB stored and exactly half of a larger body", async () => {
      for (const [slug, oldBytes, newBytes] of [["notes/threshold", 32768, 1], ["notes/half", 40000, 20000]] as const) {
        await putPage(db.storage, { slug, markdown_body: "x".repeat(oldBytes) });
        await putPage(db.storage, { slug, markdown_body: "y".repeat(newBytes), preconditionPolicy: "warn" });
        expect((await getPage(db.storage, slug))!.markdown_body).toHaveLength(newBytes);
      }
    });

    it("preserves internal replacement and metadata-only update behavior", async () => {
      await putPage(db.storage, { slug: "notes/internal", markdown_body: "x".repeat(40000) });
      await putPage(db.storage, { slug: "notes/internal", title: "New title", preconditionPolicy: "warn" });
      expect((await getPage(db.storage, "notes/internal"))!.markdown_body).toHaveLength(40000);
      await putPage(db.storage, { slug: "notes/internal", markdown_body: "short internal projection" });
      expect((await getPage(db.storage, "notes/internal"))!.markdown_body).toBe("short internal projection");
    });

    it("returns byte counts through MCP and accepts an explicit shrink override", async () => {
      process.env.MEMRAIN_REQUIRE_WRITE_PRECONDITION = "warn";
      await putPage(db.storage, { slug: "notes/mcp", markdown_body: "x".repeat(40000) });
      const args = { slug: "notes/mcp", markdown_body: "short", expected_version: 1 };
      const refused = await dispatchTool(db.storage, { name: "page_put", arguments: args });
      expect(refused.isError).toBe(true);
      expect(JSON.parse(refused.content[0]!.text)).toMatchObject({
        error: "page_shrink_refused", stored_bytes: 40000, content_bytes: 5,
      });
      const accepted = await dispatchTool(db.storage, {
        name: "page_put", arguments: { ...args, allow_shrink: true },
      });
      expect(accepted.isError).toBeFalsy();
      expect((await getPage(db.storage, "notes/mcp"))!.markdown_body).toBe("short");
    });
  });
}
