import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { putPage, renamePage } from "../src/core/pages.ts";
import { getRawData, putRawData } from "../src/core/raw-data.ts";
import { storageEngines } from "./helpers/storage-engines.ts";

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) {
  describe(`rename raw data (${name})`, () => {
    let db: Awaited<ReturnType<typeof open>>;
    beforeEach(async () => { db = await open(); });
    afterEach(async () => { await db.close(); });
    it("carries raw payloads to the new name", async () => {
      await putPage(db.storage, { slug: "notes/a", markdown_body: "A" });
      await putRawData(db.storage, "notes/a", "importer", { value: "keep" });
      expect((await renamePage(db.storage, "notes/a", "notes/b")).moved?.raw_data).toBe(1);
      expect((await getRawData(db.storage, "notes/b"))[0]?.data).toEqual({ value: "keep" });
      expect(await getRawData(db.storage, "notes/a")).toEqual([]);
    });

    for (const newer of ["notes/a", "notes/b"]) {
      it(`keeps the newer payload from ${newer} on a legacy orphan collision`, async () => {
        await putPage(db.storage, { slug: "notes/a", markdown_body: "A" });
        const e = db.storage.engine();
        for (const slug of ["notes/a", "notes/b"]) {
          await e.query("INSERT INTO raw_data (slug, source, data, created_at) VALUES ($1, 'importer', $2::text::jsonb, $3::timestamptz)",
            [slug, JSON.stringify({ value: slug }), slug === newer ? "2026-02-01" : "2026-01-01"]);
        }
        const result = await renamePage(db.storage, "notes/a", "notes/b");
        expect(result.moved?.raw_data_replaced).toBe(1);
        expect((await getRawData(db.storage, "notes/b")).map(r => r.data)).toEqual([{ value: newer }]);
        expect((await e.query("SELECT slug FROM raw_data")).rows).toEqual([{ slug: "notes/b" }]);
      });
    }
  });
}
