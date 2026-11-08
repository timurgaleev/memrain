import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { deletePage, putPage, restorePage } from "../src/core/pages.ts";
import { storageEngines } from "./helpers/storage-engines.ts";
import type { Engine } from "../src/core/engine/interface.ts";

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) {
  describe(`page write races (${name})`, () => {
    let db: Awaited<ReturnType<typeof open>>;
    beforeEach(async () => { db = await open(); });
    afterEach(async () => { await db.close(); });
    for (const operation of ["put", "delete", "restore"] as const) {
      it(`reports a vanished row as a conflict during ${operation}`, async () => {
        await putPage(db.storage, { slug: "notes/x", markdown_body: "keep" });
        if (operation === "restore") await deletePage(db.storage, "notes/x");
        const e = db.storage.engine();
        const before = (await e.query("SELECT * FROM page_versions WHERE slug='notes/x'")).rows;
        const original = e.transaction.bind(e);
        const transaction = spyOn(e, "transaction").mockImplementation(fn => original(tx => fn(new Proxy(tx, {
          get(target, key) {
            if (key === "query") {
              const query: Engine["query"] = async (sql, params) => {
                if (/^\s*UPDATE pages\b/.test(sql)) await target.query("DELETE FROM pages WHERE slug='notes/x'");
                return target.query(sql, params);
              };
              return query;
            }
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }))));
        try {
          const write = operation === "put" ? putPage(db.storage, { slug: "notes/x", markdown_body: "new" })
            : operation === "delete" ? deletePage(db.storage, "notes/x") : restorePage(db.storage, "notes/x");
          await expect(write).rejects.toMatchObject({ code: "conflict" });
        } finally { transaction.mockRestore(); }
        expect((await e.query("SELECT * FROM page_versions WHERE slug='notes/x'")).rows).toEqual(before);
      });
    }

  });
}
