/**
 * purgeDeletedPages narrowed to named slugs, with a dry run that returns the
 * plan and its hash, and a real run that refuses unless the plan still hashes
 * the same — so an operator purges exactly the set they reviewed.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { purgeDeletedPages, purgePlanHash } from "../src/core/pages-purge.ts";
import { deletePage, putPage } from "../src/core/pages.ts";
import { OperationError } from "../src/core/operation-error.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-purge-slugs-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function deletedPage(slug: string, hoursAgo = 100): Promise<void> {
  await putPage(storage, { slug, type: "note", markdown_body: `body of ${slug}` });
  await deletePage(storage, slug);
  await storage.engine().query(
    `UPDATE pages SET deleted_at = NOW() - ($2 || ' hours')::interval WHERE slug = $1`,
    [slug, String(hoursAgo)],
  );
}

async function remaining(): Promise<string[]> {
  const r = await storage.engine().query<{ slug: string }>(`SELECT slug FROM pages ORDER BY slug`);
  return r.rows.map((x) => x.slug);
}

describe("purgeDeletedPages slug filter", () => {
  it("reaps only the named slugs", async () => {
    await deletedPage("notes/a");
    await deletedPage("notes/b");
    const r = await purgeDeletedPages(storage.engine(), 72, undefined, { slugs: ["notes/a", "notes/missing"] });
    expect(r.slugs).toEqual(["notes/a"]);
    expect(await remaining()).toEqual(["notes/b"]);
  });

  it("an empty slug list reaps nothing", async () => {
    await deletedPage("notes/a");
    const r = await purgeDeletedPages(storage.engine(), 72, undefined, { slugs: [] });
    expect(r.count).toBe(0);
    expect(await remaining()).toEqual(["notes/a"]);
  });

  it("never reaps a live page or one inside the cutoff, even when named", async () => {
    await putPage(storage, { slug: "notes/live", type: "note", markdown_body: "x" });
    await deletedPage("notes/fresh", 1);
    const r = await purgeDeletedPages(storage.engine(), 72, undefined, { slugs: ["notes/live", "notes/fresh"] });
    expect(r.count).toBe(0);
    expect(await remaining()).toEqual(["notes/fresh", "notes/live"]);
  });
});

describe("purgeDeletedPages dry run and plan hash", () => {
  it("a dry run deletes nothing and returns the plan with its hash", async () => {
    await deletedPage("notes/b");
    await deletedPage("notes/a");
    const r = await purgeDeletedPages(storage.engine(), 72, undefined, { dryRun: true });
    expect(r.dry_run).toBe(true);
    expect(r.count).toBe(0);
    expect(r.planned).toEqual(["notes/a", "notes/b"]);
    expect(r.plan_hash).toMatch(/^[0-9a-f]{16}$/);
    const again = await purgeDeletedPages(storage.engine(), 72, undefined, { dryRun: true });
    expect(again.plan_hash).toBe(r.plan_hash);
    expect(await remaining()).toEqual(["notes/a", "notes/b"]);
  });

  it("purges the reviewed plan when its hash still matches", async () => {
    await deletedPage("notes/a");
    const dry = await purgeDeletedPages(storage.engine(), 72, undefined, { dryRun: true });
    const r = await purgeDeletedPages(storage.engine(), 72, undefined, { expectedPlanHash: dry.plan_hash! });
    expect(r.slugs).toEqual(["notes/a"]);
    expect(await remaining()).toEqual([]);
  });

  it("refuses with a conflict when the plan changed since the dry run", async () => {
    await deletedPage("notes/a");
    const dry = await purgeDeletedPages(storage.engine(), 72, undefined, { dryRun: true });
    await deletedPage("notes/b");
    let err: unknown;
    try {
      await purgeDeletedPages(storage.engine(), 72, undefined, { expectedPlanHash: dry.plan_hash! });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(OperationError);
    expect((err as OperationError).code).toBe("conflict");
    expect(await remaining()).toEqual(["notes/a", "notes/b"]);
  });

  it("refuses when a planned page was restored and deleted again since the dry run", async () => {
    await deletedPage("notes/a");
    const dry = await purgeDeletedPages(storage.engine(), 72, undefined, { dryRun: true });
    await deletedPage("notes/a", 200);
    await expect(
      purgeDeletedPages(storage.engine(), 72, undefined, { expectedPlanHash: dry.plan_hash! }),
    ).rejects.toBeInstanceOf(OperationError);
    expect(await remaining()).toEqual(["notes/a"]);
  });

  it("hashes slug and deletion time, in any order", () => {
    const a = { slug: "notes/a", deleted_at: "t1" };
    const b = { slug: "notes/b", deleted_at: "t2" };
    expect(purgePlanHash([a, b])).toBe(purgePlanHash([b, a]));
    expect(purgePlanHash([a])).not.toBe(purgePlanHash([{ slug: "notes/a", deleted_at: "t3" }]));
  });

  it("the per-page fallback keeps a reviewed page that was restored and deleted again", async () => {
    await deletedPage("notes/a");
    await deletedPage("notes/b");
    const dry = await purgeDeletedPages(storage.engine(), 72, undefined, { dryRun: true });
    const engine = storage.engine();
    const realQuery = engine.query.bind(engine);
    let failedFastPath = false;
    const spy = spyOn(engine, "query").mockImplementation((async (sql: string, params?: unknown[]) => {
      // A row that does not cascade blocks the set-based DELETE.
      if (!failedFastPath && sql.startsWith("DELETE FROM pages WHERE")) {
        failedFastPath = true;
        throw Object.assign(new Error("fk"), { code: "23503" });
      }
      const r = await realQuery(sql, params);
      // Between the fallback's scan and its per-page DELETE, notes/a is
      // restored and deleted again (still past the cutoff).
      if (failedFastPath && sql.startsWith("SELECT slug")) {
        await realQuery(`UPDATE pages SET deleted_at = deleted_at - interval '1 hour' WHERE slug = 'notes/a'`);
      }
      return r;
    }) as typeof engine.query);
    let r: Awaited<ReturnType<typeof purgeDeletedPages>>;
    try {
      r = await purgeDeletedPages(engine, 72, undefined, { expectedPlanHash: dry.plan_hash! });
    } finally {
      spy.mockRestore();
    }
    expect(failedFastPath).toBe(true);
    expect(r.slugs).toEqual(["notes/b"]);
    expect(await remaining()).toEqual(["notes/a"]);
  });

  it("the plan respects the source scope", async () => {
    await deletedPage("notes/a");
    const r = await purgeDeletedPages(storage.engine(), 72, ["other"], { dryRun: true });
    expect(r.planned).toEqual([]);
  });
});
