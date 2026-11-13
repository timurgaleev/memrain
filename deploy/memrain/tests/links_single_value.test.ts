import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { putPage } from "../src/core/pages.ts";
import { addLink, graphQuery } from "../src/core/links.ts";
import { checkSingleValueLinkOverlaps } from "../src/core/doctor-ops.ts";

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`single-value links (${name})`, () => {
  let db: Awaited<ReturnType<typeof open>>;
  beforeAll(async () => { db = await open(); });
  afterAll(async () => { await db.close(); });

  let n = 0;
  async function person(): Promise<string> {
    const slug = `people/p${++n}`;
    await putPage(db.storage, { slug, markdown_body: "Person page." });
    return slug;
  }
  const works = (source_slug: string, target_slug: string, valid_from?: string, valid_until?: string) =>
    addLink(db.storage, {
      source_slug, target_slug, type: "works_at",
      ...(valid_from ? { valid_from } : {}), ...(valid_until ? { valid_until } : {}),
    });
  async function intervals(slug: string, type = "works_at") {
    return (await db.storage.engine().query<{ target_slug: string; valid_from: string | null; valid_until: string | null }>(
      `SELECT target_slug, valid_from::text AS valid_from, valid_until::text AS valid_until
         FROM links WHERE source_slug = $1 AND type = $2 AND link_source = 'manual' ORDER BY valid_from NULLS FIRST, target_slug`,
      [slug, type],
    )).rows;
  }
  function overlapping(rows: Awaited<ReturnType<typeof intervals>>): boolean {
    const lo = (v: string | null) => v ?? "0000-01-01";
    const hi = (v: string | null) => v ?? "9999-12-31";
    return rows.some((a, i) => rows.slice(i + 1).some((b) => lo(a.valid_from) < hi(b.valid_until) && lo(b.valid_from) < hi(a.valid_until)));
  }
  async function refusal(p: Promise<unknown>): Promise<string | undefined> {
    return p.then(() => undefined, (e: { code?: string }) => e.code);
  }

  it("closes the active value at the next start date and keeps it for historical reads", async () => {
    const p = await person();
    await works(p, "orgs/acme", "2020-01-01");
    await works(p, "orgs/globex", "2023-06-01");
    expect(await intervals(p)).toEqual([
      { target_slug: "orgs/acme", valid_from: "2020-01-01", valid_until: "2023-06-01" },
      { target_slug: "orgs/globex", valid_from: "2023-06-01", valid_until: null },
    ]);
    const then = await graphQuery(db.storage, { source_slug: p, type: "works_at", status: "active", asOf: "2021-01-01" });
    expect(then.map((r) => r.target_slug)).toEqual(["orgs/acme"]);
  });

  it("closes an undated active value too", async () => {
    const p = await person();
    await works(p, "orgs/acme");
    await works(p, "orgs/globex", "2023-06-01");
    expect((await intervals(p))[0]).toEqual({ target_slug: "orgs/acme", valid_from: null, valid_until: "2023-06-01" });
  });

  it("leaves multi-value types open", async () => {
    const p = await person();
    for (const [target, from] of [["people/a", "2020-01-01"], ["people/b", "2023-01-01"]] as const) {
      await addLink(db.storage, { source_slug: p, target_slug: target, type: "knows", valid_from: from });
    }
    expect((await intervals(p, "knows")).map((r) => r.valid_until)).toEqual([null, null]);
  });

  it("refuses an equal start date for a different target", async () => {
    const p = await person();
    await works(p, "orgs/acme", "2020-01-01");
    expect(await refusal(works(p, "orgs/globex", "2020-01-01"))).toBe("link_interval_conflict");
    expect(await intervals(p)).toEqual([{ target_slug: "orgs/acme", valid_from: "2020-01-01", valid_until: null }]);
  });

  it("refuses a value that overlaps an expired interval", async () => {
    const p = await person();
    await works(p, "orgs/acme", "2020-01-01", "2022-01-01");
    expect(await refusal(works(p, "orgs/globex", "2021-01-01"))).toBe("link_interval_conflict");
    await works(p, "orgs/initech", "2022-01-01", "2023-01-01");
    expect(await refusal(works(p, "orgs/globex", "2021-06-01", "2022-06-01"))).toBe("link_interval_conflict");
    expect((await intervals(p)).map((r) => r.target_slug)).toEqual(["orgs/acme", "orgs/initech"]);
  });

  it("fills a gap retroactively, ending at the next recorded start", async () => {
    const p = await person();
    await works(p, "orgs/acme", "2020-01-01", "2021-01-01");
    await works(p, "orgs/initech", "2023-01-01");
    await works(p, "orgs/globex", "2021-06-01");
    await works(p, "orgs/hooli", "2019-01-01");
    expect(await intervals(p)).toEqual([
      { target_slug: "orgs/hooli", valid_from: "2019-01-01", valid_until: "2020-01-01" },
      { target_slug: "orgs/acme", valid_from: "2020-01-01", valid_until: "2021-01-01" },
      { target_slug: "orgs/globex", valid_from: "2021-06-01", valid_until: "2023-01-01" },
      { target_slug: "orgs/initech", valid_from: "2023-01-01", valid_until: null },
    ]);
  });

  it("keeps re-adding the same target idempotent", async () => {
    const p = await person();
    await works(p, "orgs/acme", "2020-01-01");
    await works(p, "orgs/globex", "2023-01-01");
    await works(p, "orgs/acme", "2020-01-01");
    expect(overlapping(await intervals(p))).toBe(false);
  });

  it("ignores rows written by derived writers", async () => {
    const p = await person();
    await db.storage.engine().query(
      `INSERT INTO links (source_slug, target_slug, type, link_source, valid_from) VALUES ($1, 'orgs/derived', 'works_at', 'frontmatter', '2020-01-01')`,
      [p],
    );
    await works(p, "orgs/acme", "2021-01-01");
    const derived = await db.storage.engine().query<{ valid_until: string | null }>(
      `SELECT valid_until::text AS valid_until FROM links WHERE source_slug = $1 AND link_source = 'frontmatter'`, [p]);
    expect(derived.rows).toEqual([{ valid_until: null }]);
  });

  it("serializes concurrent writers so no overlap is stored", async () => {
    const p = await person();
    await works(p, "orgs/acme", "2020-01-01");
    const outcomes = await Promise.all([
      refusal(works(p, "orgs/globex", "2023-01-01")),
      refusal(works(p, "orgs/initech", "2024-01-01")),
    ]);
    expect(outcomes).toEqual([undefined, undefined]);
    expect(overlapping(await intervals(p))).toBe(false);
    expect((await intervals(p)).filter((r) => r.valid_until === null)).toHaveLength(1);
  });

  it("lets exactly one of two same-day writers win", async () => {
    const p = await person();
    const outcomes = await Promise.all([
      refusal(works(p, "orgs/globex", "2023-01-01")),
      refusal(works(p, "orgs/initech", "2023-01-01")),
    ]);
    expect(outcomes.filter((o) => o === undefined)).toHaveLength(1);
    expect(outcomes.filter((o) => o !== undefined)).toEqual(["link_interval_conflict"]);
    expect(await intervals(p)).toHaveLength(1);
  });

  it("reports legacy overlaps without changing them", async () => {
    const p = await person();
    await db.storage.engine().query(
      `INSERT INTO links (source_slug, target_slug, type, link_source, valid_from)
       VALUES ($1, 'orgs/old-a', 'works_at', 'manual', '2018-01-01'), ($1, 'orgs/old-b', 'works_at', 'manual', '2019-01-01')`,
      [p],
    );
    const before = await intervals(p);
    const report = await checkSingleValueLinkOverlaps(db.storage.engine());
    expect(report.status).toBe("warn");
    expect(report.detail).toContain(p);
    expect(await intervals(p)).toEqual(before);
  });
});
