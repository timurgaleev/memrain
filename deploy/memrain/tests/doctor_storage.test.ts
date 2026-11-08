import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { putPage } from "../src/core/pages.ts";
import { checkDbBackends, checkJsonbIntegrity, checkPageVersionStorage } from "../src/core/doctor-storage.ts";

for (const engine of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`storage diagnostics ${engine.name}`, () => {
  let db: Awaited<ReturnType<typeof engine.open>>;
  beforeAll(async () => {
    db = await engine.open();
    for (const slug of ["object", "array", "plain", "valid"]) await putPage(db.storage, { slug: `notes/${slug}`, markdown_body: "PRIVATE body", compiled_truth: { fine: true } });
  });
  afterAll(async () => { await db.close(); });
  it("finds encoded objects and arrays but leaves plain strings alone", async () => {
    for (const [slug, value] of [["object", '{"PRIVATE":"value"}'], ["array", '["PRIVATE"]'], ["plain", 'ordinary text']]) {
      await db.storage.engine().query("UPDATE pages SET compiled_truth = $1::text::jsonb WHERE slug = $2", [JSON.stringify(value), `notes/${slug}`]);
    }
    const result = await checkJsonbIntegrity(db.storage.engine());
    expect(result).toMatchObject({ ok: true, status: "warn" });
    expect(result.detail).toContain("pages.compiled_truth=2");
    expect(result.detail).not.toContain("PRIVATE");
    const stillString = await db.storage.engine().query<{ n: number }>("SELECT count(*)::int AS n FROM pages WHERE jsonb_typeof(compiled_truth) = 'string'");
    expect(stillString.rows[0]!.n).toBe(3);
  });
  it("shows stored version bytes and bounded slug totals, without body text", async () => {
    const result = await checkPageVersionStorage(db.storage.engine());
    expect(result.status).toBe("ok");
    expect(result.detail).toContain("4 version(s)");
    expect(result.detail).toContain("notes/object");
    expect(result.detail).not.toContain("PRIVATE");
    const versions = await db.storage.engine().query<{ n: number }>("SELECT count(*)::int AS n FROM page_versions");
    expect(versions.rows[0]!.n).toBe(4);
  });
  it("does not report its own diagnostic connection as blocked", async () => {
    expect(await checkDbBackends(db.storage.engine())).toMatchObject({ ok: true, status: "ok" });
  });
});
