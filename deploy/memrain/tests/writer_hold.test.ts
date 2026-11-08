import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { deletePage, getPage, putPage } from "../src/core/pages.ts";
import { storageEngines } from "./helpers/storage-engines.ts";

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) {
  describe(`internal writer hold (${name})`, () => {
    let db: Awaited<ReturnType<typeof open>>;
    beforeEach(async () => { db = await open(); });
    afterEach(async () => { await db.close(); });
    const input = {
      slug: "concepts/x", markdown_body: "robot", written_by: "synthesize-concepts",
      onlyOverwriteWriter: "synthesize-concepts",
    };

    it("creates and updates its own page", async () => {
      expect((await putPage(db.storage, input)).created).toBe(true);
      const r = await putPage(db.storage, { ...input, markdown_body: "new robot" });
      expect(r.changed).toBe(true);
      expect((await getPage(db.storage, input.slug))?.markdown_body).toBe("new robot");
    });

    for (const author of ["operator", undefined]) {
      it(`holds an edit by ${author ?? "a legacy null writer"} without adding a version`, async () => {
        await putPage(db.storage, input);
        const edit = await putPage(db.storage, { slug: input.slug, markdown_body: "human", written_by: author });
        const r = await putPage(db.storage, input);
        expect(r).toMatchObject({ held: "authored_edit", changed: false, created: false, version_n: edit.version_n });
        expect((await getPage(db.storage, input.slug))?.markdown_body).toBe("human");
        const versions = await db.storage.engine().query("SELECT version_n FROM page_versions WHERE slug=$1", [input.slug]);
        expect(versions.rows).toHaveLength(2);
      });
    }

    it("holds a page deleted by the operator", async () => {
      await putPage(db.storage, input);
      await deletePage(db.storage, input.slug, "operator");
      expect(await putPage(db.storage, input)).toMatchObject({ held: "authored_edit", changed: false });
      expect(await getPage(db.storage, input.slug)).toBeNull();
    });

    it("still enforces tenant ownership and explicit version preconditions", async () => {
      await putPage(db.storage, input);
      await expect(putPage(db.storage, { ...input, source_id: "other" })).rejects.toMatchObject({ code: "permission_denied" });
      await expect(putPage(db.storage, { ...input, expectedVersion: 0 })).rejects.toMatchObject({ code: "version_conflict" });
    });
  });
}
