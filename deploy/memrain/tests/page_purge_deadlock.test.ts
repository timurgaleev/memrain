import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { deletePage, getPage, putPage } from "../src/core/pages.ts";
import { purgeDeletedPages } from "../src/core/pages-purge.ts";
import { storageEngines } from "./helpers/storage-engines.ts";

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) {
  describe(`purge deadlock retry (${name})`, () => {
    let db: Awaited<ReturnType<typeof open>>;
    beforeEach(async () => { db = await open(); });
    afterEach(async () => { await db.close(); });
    for (const fallback of [false, true]) {
      it(`retries a deadlock with the whole purge transaction (${fallback ? "fallback" : "fast path"})`, async () => {
        await putPage(db.storage, { slug: "notes/x", markdown_body: "keep" });
        await deletePage(db.storage, "notes/x");
        const e = db.storage.engine();
        await e.query("UPDATE pages SET deleted_at=NOW() - interval '40 days' WHERE slug='notes/x'");
        const original = e.transaction.bind(e);
        let attempts = 0;
        const transaction = spyOn(e, "transaction").mockImplementation(async fn => {
          attempts += 1;
          if (fallback && attempts === 1) throw Object.assign(new Error("test FK fallback"), { code: "23503" });
          return original(async tx => {
            const result = await fn(tx);
            if (attempts === (fallback ? 2 : 1)) throw Object.assign(new Error("test deadlock"), { code: "40P01" });
            return result;
          });
        });
        try {
          expect(await purgeDeletedPages(e)).toMatchObject({ count: 1, slugs: ["notes/x"], blocked: [] });
          expect(attempts).toBe(fallback ? 3 : 2);
        } finally { transaction.mockRestore(); }
        expect(await getPage(db.storage, "notes/x", undefined, { includeDeleted: true })).toBeNull();
      });
    }
  });
}
