import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { findTypedConflicts } from "../src/core/typed-conflicts.ts";
import { putPage } from "../src/core/pages.ts";

for (const spec of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`typed conflicts ${spec.name}`, () => {
  let db: Awaited<ReturnType<typeof spec.open>>;
  beforeAll(async () => { db = await spec.open(); });
  afterAll(async () => { await db.close(); });
  beforeEach(async () => {
    await db.storage.engine().exec("TRUNCATE entity_facts CASCADE; DELETE FROM documents; DELETE FROM pages;");
  });

  async function claim(value: string, overrides: Record<string, unknown> = {}) {
    const values = {
      entity_slug: "projects/acme", fact: `Revenue ${value}`, claim_metric: "revenue",
      claim_value: value, claim_unit: "USD", claim_period: "monthly", valid_from: "2026-11-01",
      source_id: "default", visibility: "world", ...overrides,
    };
    const keys = Object.keys(values);
    return (await db.storage.engine().query<{ id: string }>(
      `INSERT INTO entity_facts (${keys.join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")}) RETURNING id::text`,
      Object.values(values),
    )).rows[0]!.id;
  }

  it("groups overlapping values with exact decimals and stable source evidence without writes", async () => {
    const first = await claim("100");
    const second = await claim("120.000000000000000000001", { valid_from: "2026-11-02" });
    const before = await db.storage.engine().query("SELECT to_jsonb(f) AS row FROM entity_facts f ORDER BY id");
    const result = await findTypedConflicts(db.storage.engine());
    expect(result).toMatchObject({ truncated: false, groups: [{
      entity_slug: "projects/acme", source_id: "default", attributed_to: null,
      metric: "revenue", unit: "usd", period: "monthly", month: "2026-11", truncated: false,
      claims: [{ id: first, value: "100" }, { id: second, value: "120.000000000000000000001" }],
    }] });
    expect(await db.storage.engine().query("SELECT to_jsonb(f) AS row FROM entity_facts f ORDER BY id")).toEqual(before);
  });

  it("compares decimal equivalence in SQL and supports negative values", async () => {
    await claim("-100");
    await claim("-100.00");
    expect((await findTypedConflicts(db.storage.engine())).groups).toEqual([]);
    await claim("-99.99999999999999999999");
    expect((await findTypedConflicts(db.storage.engine())).groups[0]!.claims.map((c) => c.value))
      .toEqual(["-100", "-100.00", "-99.99999999999999999999"]);
  });

  for (const [name, changes] of Object.entries({
    unit: { claim_unit: "EUR" }, period: { claim_period: "annual" }, speaker: { attributed_to: "assistant" },
    source: { source_id: "foreign" }, month: { valid_from: "2026-12-01" }, unknown_date: { valid_from: null },
    unknown_unit: { claim_unit: " " }, unknown_period: { claim_period: null }, dimension: { dimension: "revenue" },
    not_a_number: { claim_value: "NaN" }, infinity: { claim_value: "Infinity" },
    negative_infinity: { claim_value: "-Infinity" }, unknown_metric: { claim_metric: "!!!" },
    empty_interval: { valid_until: "2026-11-01" }, inverted_interval: { valid_until: "2026-10-01" },
  })) it(`does not fabricate conflicts across ${name}`, async () => {
    await db.storage.engine().query("INSERT INTO sources (id, kind, path_prefix) VALUES ('foreign', 'other', '/foreign/') ON CONFLICT DO NOTHING");
    await claim("100");
    await claim("120", changes);
    expect((await findTypedConflicts(db.storage.engine())).groups).toEqual([]);
  });

  it("requires overlapping half-open validity ranges in the same calendar month", async () => {
    await claim("100", { valid_until: "2026-11-03" });
    await claim("120", { valid_from: "2026-11-03" });
    expect((await findTypedConflicts(db.storage.engine())).groups).toEqual([]);
    await claim("110", { valid_from: "2026-11-02", valid_until: "2026-11-04" });
    expect((await findTypedConflicts(db.storage.engine())).groups[0]!.claims).toHaveLength(3);
  });

  it("filters hidden facts before conflict detection and group limits", async () => {
    await db.storage.engine().query("INSERT INTO sources (id, kind, path_prefix) VALUES ('foreign', 'other', '/foreign/') ON CONFLICT DO NOTHING");
    await putPage(db.storage, { slug: "notes/diary", type: "journal", allowAdHocType: true, markdown_body: "Diary." });
    await db.storage.engine().query(`INSERT INTO documents (id,source_path,source_id,frontmatter)
      VALUES ('held','page://notes/held','default','{"quarantine":{}}')`);
    const live = await claim("100", { entity_slug: "a/hidden" });
    const hidden = [
      { visibility: "private" }, { source_id: "foreign" }, { source_slug: "notes/diary" },
      { source_markdown_slug: "life/diary/note" }, { forgotten_at: new Date().toISOString() },
      { superseded_by: live }, { consolidated: true }, { source_slug: "notes/held" },
    ];
    for (const fields of hidden) await claim("120", { entity_slug: "a/hidden", ...fields });
    await claim("100", { entity_slug: "life/diary/subject" });
    await claim("120", { entity_slug: "life/diary/subject" });
    await claim("100", { entity_slug: "z/visible" });
    await claim("120", { entity_slug: "z/visible" });
    const result = await findTypedConflicts(db.storage.engine(), { sourceIds: ["default"], remote: true, limit: 1 });
    expect(result.groups.map((g) => g.entity_slug)).toEqual(["z/visible"]);
    expect(result.truncated).toBe(false);
    expect((await findTypedConflicts(db.storage.engine(), { sourceIds: [] })).groups).toEqual([]);
  });

  it("bounds participating claims and groups independently with truthful truncation", async () => {
    for (let i = 0; i < 22; i++) await claim(String(i), { entity_slug: "a/many" });
    await claim("100", { entity_slug: "z/other" });
    await claim("120", { entity_slug: "z/other" });
    const result = await findTypedConflicts(db.storage.engine(), { limit: 1 });
    expect(result.groups).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(result.groups[0]!.claims).toHaveLength(20);
    expect(result.groups[0]!.truncated).toBe(true);
    expect((await findTypedConflicts(db.storage.engine(), { entitySlug: "z/other" })).groups).toHaveLength(1);
    expect((await findTypedConflicts(db.storage.engine(), { entitySlug: "z/missing" })).groups).toEqual([]);
  });

  it("retains a divergent overlapping witness when many equivalent copies precede it", async () => {
    for (let i = 0; i < 21; i++) await claim("100");
    const witness = await claim("120");
    const group = (await findTypedConflicts(db.storage.engine())).groups[0]!;
    expect(group.claims.some((c) => c.id === witness)).toBe(true);
    expect(new Set(group.claims.map((c) => c.value)).size).toBe(2);
    expect(group.truncated).toBe(true);
    expect(group.claims).toHaveLength(20);
  });

  it("normalizes metric labels and groups calendar dates independently of the database timezone", async () => {
    await claim("100", { claim_metric: " Revenue Total ", valid_from: "2026-11-01" });
    await claim("120", { claim_metric: "revenue_total", valid_from: "2026-11-30" });
    await db.storage.engine().transaction(async (tx) => {
      await tx.exec("SET LOCAL TIME ZONE 'Pacific/Honolulu'");
      expect((await findTypedConflicts(tx)).groups).toMatchObject([{ metric: "revenue_total", month: "2026-11" }]);
    });
  });

  it("applies the default and maximum group bounds after eligibility", async () => {
    await db.storage.engine().query(`INSERT INTO entity_facts
      (entity_slug,fact,claim_metric,claim_value,claim_unit,claim_period,valid_from)
      SELECT 'projects/' || lpad(i::text,3,'0'), 'Value ' || v::text, 'revenue', v, 'USD', 'monthly', '2026-11-01'
      FROM generate_series(1,202) i CROSS JOIN generate_series(1,2) v`);
    const defaults = await findTypedConflicts(db.storage.engine());
    expect(defaults.groups).toHaveLength(20);
    expect(defaults.truncated).toBe(true);
    const maximum = await findTypedConflicts(db.storage.engine(), { limit: 201 });
    expect(maximum.groups).toHaveLength(200);
    expect(maximum.truncated).toBe(true);
  });
});
