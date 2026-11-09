import { describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { putPage, getPageExact } from "../src/core/pages.ts";
import { checkMixedScriptTargets } from "../src/core/mixed-script-targets.ts";

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`mixed-script diagnostic (${name})`, () => {
  it("reports exact old/new ambiguity without changing stored identities or versions", async () => {
    const db = await open();
    try {
      for (const slug of ["people/smith", "people/алиса-smith"]) await putPage(db.storage, { slug, title: "Алиса Smith", markdown_body: "Retained note." });
      const e = db.storage.engine();
      const before = (await e.query("SELECT * FROM page_versions ORDER BY slug,version_n")).rows;
      const report = await checkMixedScriptTargets(e);
      expect(report.candidates).toEqual([{ source_id: "default", old_key: "people/smith", new_key: "people/алиса-smith", old_resolves: true, new_resolves: true, ambiguous: true }]);
      expect((await getPageExact(db.storage, "people/smith"))!.slug).toBe("people/smith");
      expect((await e.query("SELECT * FROM page_versions ORDER BY slug,version_n")).rows).toEqual(before);
    } finally { await db.close(); }
  });
});
