import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { putPage, getPage } from "../src/core/pages.ts";
import { renderFactsFence } from "../src/core/facts-fence.ts";
import { reconcileFactsForPage } from "../src/core/facts-reconcile.ts";
import { forgetFact } from "../src/core/facts-recall.ts";

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`exact superseded fence (${name})`, () => {
  let db: Awaited<ReturnType<typeof open>>;
  beforeAll(async () => { db = await open(); });
  afterAll(async () => { await db.close(); });
  const body = (claim: string, rowNum = 1) => `## Facts\n\n${renderFactsFence([{ rowNum, claim, confidence: 1, active: true }])}\n`;
  const rows = (slug: string) => db.storage.engine().query<Record<string, unknown> & { id: number }>("SELECT * FROM entity_facts WHERE source_markdown_slug=$1 ORDER BY id", [slug]);
  async function write(slug: string, claim: string, row = 1) {
    const p = await putPage(db.storage, { slug, markdown_body: body(claim, row) });
    return reconcileFactsForPage(db.storage, slug, p.content_hash, "default");
  }
  async function retire(slug: string, claim: string) {
    await write(slug, claim);
    const id = (await rows(slug)).rows[0]!.id;
    await forgetFact(db.storage, Number(id), { cause: "supersede", reason: "Superseded fixture" });
    return id;
  }
  it("keeps an identical row retired and reports its row without changing the page or history", async () => {
    const slug = "notes/retired";
    await retire(slug, "Revenue 100 in 2026");
    const before = (await rows(slug)).rows;
    const page = await getPage(db.storage, slug);
    const result = await write(slug, "Revenue 100 in 2026");
    expect(result).toMatchObject({ added: 0, removed: 0, superseded_rows: [1] });
    expect((await rows(slug)).rows).toEqual(before);
    expect(await getPage(db.storage, slug)).toEqual(page);
    expect(await write(slug, "Revenue 100 in 2026")).toMatchObject({ added: 0, removed: 0, superseded_rows: [1] });
  });
  it("permits a corrected number on the same row and the old claim on another row", async () => {
    const slug = "notes/corrected";
    await retire(slug, "Revenue 100 in 2026");
    expect((await write(slug, "Revenue 200 in 2026")).added).toBe(1);
    expect((await write(slug, "Revenue 100 in 2026", 2)).added).toBe(1);
  });
  it("removes an old resurrected live projection while preserving the supersession tombstone", async () => {
    const slug = "notes/resurrected";
    const id = await retire(slug, "Old exact claim");
    await db.storage.engine().query(`INSERT INTO entity_facts(entity_slug,fact,confidence,source_id,source_markdown_slug,row_num)
      VALUES($1,'Old exact claim',1,'default',$1,1)`, [slug]);
    expect(await write(slug, "Old exact claim")).toMatchObject({ removed: 1, added: 0, superseded_rows: [1] });
    expect((await rows(slug)).rows.map(r => r.id)).toEqual([id]);
  });
  it("ignores NULL-row supersession and refuses a stale page hash", async () => {
    const slug = "notes/legacy";
    const id = await retire(slug, "Legacy claim");
    await db.storage.engine().query("UPDATE entity_facts SET row_num=NULL WHERE id=$1", [id]);
    expect((await write(slug, "Legacy claim")).added).toBe(1);
    const p = await putPage(db.storage, { slug, markdown_body: body("Later claim") });
    const before = (await rows(slug)).rows;
    expect(await reconcileFactsForPage(db.storage, slug, "stale", "default")).toEqual({ added: 0, removed: 0 });
    expect((await rows(slug)).rows).toEqual(before);
    expect(p.changed).toBe(true);
  });
  it("does not let another source's tombstone suppress an owned row", async () => {
    const slug = "notes/foreign-tombstone";
    await db.storage.engine().query("INSERT INTO sources(id,kind,path_prefix) VALUES('foreign-tombstone','other','foreign-tombstone:fixture')");
    await db.storage.engine().query(`INSERT INTO entity_facts(entity_slug,fact,confidence,source_id,source_markdown_slug,row_num,forgotten_at,forgotten_cause)
      VALUES($1,'Exact owned claim',1,'foreign-tombstone',$1,1,NOW(),'supersede')`, [slug]);
    const before = (await rows(slug)).rows;
    expect((await write(slug, "Exact owned claim")).added).toBe(1);
    expect((await rows(slug)).rows.filter(r => r.source_id === "foreign-tombstone")).toEqual(before);
  });
});
