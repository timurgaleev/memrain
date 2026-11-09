/**
 * A slug redirect dies with its target: the hard purge drops redirects that
 * point at a purged page, and the resolver only follows a redirect to a live
 * page. A redirect FROM a purged old name to a live page is the rename
 * redirect and stays. The Postgres twin covers the purge transaction on the
 * real driver. Skipped unless MEMRAIN_TEST_POSTGRES_URL points at a scratch
 * database.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { PostgresEngine } from "../src/core/engine/postgres.ts";
import { purgeDeletedPages } from "../src/core/pages-purge.ts";
import { deletePage, putPage } from "../src/core/pages.ts";
import { resolveSlugWithAlias, setSlugAlias } from "../src/core/slug-aliases.ts";

const PG_URL = process.env.MEMRAIN_TEST_POSTGRES_URL;

async function deleteAndAge(storage: Storage, slug: string): Promise<void> {
  await deletePage(storage, slug);
  await storage.engine().query(
    `UPDATE pages SET deleted_at = NOW() - interval '1000 hours' WHERE slug = $1`,
    [slug],
  );
}

async function aliasRows(storage: Storage, alias: string): Promise<number> {
  const r = await storage.engine().query(`SELECT 1 FROM slug_aliases WHERE alias_slug = $1`, [alias]);
  return r.rows.length;
}

describe("dangling slug redirects (PGLite)", () => {
  let tmp: string;
  let storage: Storage;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "memrain-alias-dangling-"));
    storage = new Storage({ dbPath: join(tmp, "db") });
    await storage.init();
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("a redirect whose target was purged no longer resolves", async () => {
    await putPage(storage, { slug: "people/b", type: "person" });
    await setSlugAlias(storage.engine(), { alias_slug: "people/a", canonical_slug: "people/b" });
    expect(await resolveSlugWithAlias(storage, "people/a")).toBe("people/b");
    await deleteAndAge(storage, "people/b");
    const r = await purgeDeletedPages(storage.engine());
    expect(r.slug_aliases_rows).toBe(1);
    expect(await aliasRows(storage, "people/a")).toBe(0);
    expect(await resolveSlugWithAlias(storage, "people/a")).toBe("people/a");
  });

  it("a redirect from a purged old name to a live page survives the purge", async () => {
    await putPage(storage, { slug: "people/old", type: "person" });
    await putPage(storage, { slug: "people/new", type: "person" });
    await setSlugAlias(storage.engine(), { alias_slug: "people/old", canonical_slug: "people/new" });
    await deleteAndAge(storage, "people/old");
    const r = await purgeDeletedPages(storage.engine());
    expect(r).toMatchObject({ slugs: ["people/old"], slug_aliases_rows: 0 });
    expect(await aliasRows(storage, "people/old")).toBe(1);
    expect(await resolveSlugWithAlias(storage, "people/old")).toBe("people/new");
  });

  it("a redirect to a merely soft-deleted target resolves to the input slug", async () => {
    await putPage(storage, { slug: "people/b", type: "person" });
    await setSlugAlias(storage.engine(), { alias_slug: "people/a", canonical_slug: "people/b" });
    await deletePage(storage, "people/b");
    expect(await resolveSlugWithAlias(storage, "people/a")).toBe("people/a");
    expect(await aliasRows(storage, "people/a")).toBe(1);
  });
});

describe.skipIf(!PG_URL)("dangling slug redirects (Postgres)", () => {
  let pg: PostgresEngine;
  let storage: Storage;
  const run = crypto.randomUUID();
  const target = `people/alias-dangling-pg-b-${run}`;
  const alias = `people/alias-dangling-pg-a-${run}`;

  beforeAll(async () => {
    pg = new PostgresEngine({ url: PG_URL! });
    storage = new Storage(pg);
    await storage.init();
  });

  afterAll(async () => {
    await pg.query(`DELETE FROM slug_aliases WHERE alias_slug = $1`, [alias]);
    await pg.query(`DELETE FROM pages WHERE slug = $1`, [target]);
    await pg.close();
  });

  it("a redirect whose target was purged no longer resolves", async () => {
    await putPage(storage, { slug: target, type: "person" });
    await setSlugAlias(pg, { alias_slug: alias, canonical_slug: target });
    expect(await resolveSlugWithAlias(storage, alias)).toBe(target);
    await deleteAndAge(storage, target);
    const r = await purgeDeletedPages(pg, undefined, undefined, { slugs: [target] });
    expect(r).toMatchObject({ slugs: [target], slug_aliases_rows: 1 });
    expect(await resolveSlugWithAlias(storage, alias)).toBe(alias);
  });
});
