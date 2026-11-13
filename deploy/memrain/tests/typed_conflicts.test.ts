import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { contestedWith, findTypedConflicts } from "../src/core/typed-conflicts.ts";
import { putPage } from "../src/core/pages.ts";
import { entityRecall } from "../src/core/facts.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";

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

  it("marks each live claim with the conflicting claims it overlaps", async () => {
    const a = await claim("100");
    const b = await claim("120", { valid_from: "2026-11-02" });
    const same = await claim("100.0", { valid_from: "2026-11-03" });
    const peers = await contestedWith(db.storage.engine(), [a, b, same].map(Number));
    expect(peers.get(Number(a))).toEqual([Number(b)]);
    expect(peers.get(Number(b))).toEqual([Number(a), Number(same)]);
    expect(peers.get(Number(same))).toEqual([Number(b)]);
  });

  it("leaves out expired, hidden and differently scoped claims", async () => {
    await db.storage.engine().query("INSERT INTO sources (id, kind, path_prefix) VALUES ('foreign', 'other', '/foreign/') ON CONFLICT DO NOTHING");
    const live = await claim("100", { valid_from: "2026-11-10" });
    await claim("120", { valid_until: "2026-11-05" });
    await claim("130", { visibility: "private" });
    await claim("140", { source_id: "foreign" });
    await claim("150", { forgotten_at: new Date().toISOString() });
    await claim("160", { source_slug: "life/diary/2026-11-01" });
    const remote = await contestedWith(db.storage.engine(), [Number(live)], { sourceIds: ["default"], remote: true });
    expect(remote.get(Number(live))).toBeUndefined();
    const operator = await contestedWith(db.storage.engine(), [Number(live)]);
    expect(operator.get(Number(live))).toHaveLength(2);
    expect(await contestedWith(db.storage.engine(), [Number(live)], { sourceIds: [] })).toEqual(new Map());
  });

  it("caps the peers at five, smallest ids first", async () => {
    const first = await claim("0");
    const others: number[] = [];
    for (let i = 1; i <= 7; i++) others.push(Number(await claim(String(i))));
    expect((await contestedWith(db.storage.engine(), [Number(first)])).get(Number(first))).toEqual(others.slice(0, 5));
  });

  it("carries the peers on entity_recall facts and nowhere else", async () => {
    const a = await claim("100");
    const b = await claim("120");
    await db.storage.engine().query(
      `INSERT INTO entity_facts (entity_slug, fact, source_id, visibility) VALUES ('projects/acme', 'Acme is in Berlin', 'default', 'world')`,
    );
    const r = await entityRecall(db.storage, "projects/acme", { decay: false });
    const byId = new Map(r.facts.map((f) => [String(f.id), f]));
    expect(byId.get(a)!.contested_with).toEqual([Number(b)]);
    expect(byId.get(b)!.contested_with).toEqual([Number(a)]);
    expect(r.facts.find((f) => f.fact === "Acme is in Berlin")!.contested_with).toBeUndefined();
  });

  it("names only world-visible peers to a tenant calling entity_recall", async () => {
    const a = await claim("100");
    const b = await claim("120");
    await claim("130", { visibility: "private" });
    const res = await dispatchTool(db.storage, { name: "entity_recall", arguments: { slug: "projects/acme" } }, {
      authInfo: { token: "tok", clientId: "client", scopes: ["read"], sourceId: "default", allowedSources: ["default"], isPublic: false },
    });
    const facts = JSON.parse(res.content[0]!.text).facts as { id: number; contested_with?: number[] }[];
    expect(facts.find((f) => String(f.id) === a)!.contested_with).toEqual([Number(b)]);
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
