import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`fact input metadata (${name})`, () => {
  let db: Awaited<ReturnType<typeof open>>;
  beforeAll(async () => { db = await open(); });
  afterAll(async () => { await db.close(); });
  const write = (args: Record<string, unknown>) => dispatchTool(db.storage, { name: "add_fact", arguments: { entity_slug: "people/example", ...args } });
  const rows = async () => (await db.storage.engine().query<{ fact: string; kind: string; notability: string; valid_from: string; claim_metric: string; claim_value: number; claim_unit: string; claim_period: string }>(
    "SELECT fact, kind, notability, valid_from::text, claim_metric, claim_value::float8 AS claim_value, claim_unit, claim_period FROM entity_facts ORDER BY id",
  )).rows;

  it("persists normalized metadata supplied on a single fact", async () => {
    const r = await write({ fact: "Rate is 44.26 cents", valid_from: "2026-01-02T00:30:00+02:00", kind: "commitment", notability: "high",
      claim_metric: "Energy Rate", claim_value: 44.26, claim_unit: "ct/kWh", claim_period: "2026" });
    expect(r.isError).toBeFalsy();
    expect((await rows())[0]).toMatchObject({ valid_from: "2026-01-01", kind: "commitment", notability: "high",
      claim_metric: "energy_rate", claim_value: 44.26, claim_unit: "ct/kWh", claim_period: "2026" });
  });

  it("inherits metadata defaults and preserves per-item overrides", async () => {
    const r = await write({ kind: "belief", valid_from: "2026-02-01", notability: "medium", claim_unit: "EUR", items: [
      { fact: "First item value 10", claim_value: 10 },
      { fact: "Second item value 20", kind: "event", notability: "low", claim_value: 20, valid_from: "2026-03-01" },
    ] });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0]!.text)).toMatchObject({ saved: 2, failed: 0 });
    expect((await rows()).slice(-2)).toMatchObject([
      { kind: "belief", notability: "medium", claim_unit: "EUR", claim_value: 10, valid_from: "2026-02-01" },
      { kind: "event", notability: "low", claim_unit: "EUR", claim_value: 20, valid_from: "2026-03-01" },
    ]);
  });

  it("rejects bad metadata before any batch item is written", async () => {
    const before = await rows();
    for (const bad of [{ valid_from: "2026-02-30" }, { kind: "unknown" }, { notability: "critical" }, { claim_value: Infinity }, { claim_unit: 5 }]) {
      for (const args of [{ fact: "Bad single", ...bad }, { items: [{ fact: "Would be first" }, { fact: "Bad last", ...bad }] }]) {
        const r = await write(args);
        expect(r.isError).toBe(true);
        expect(JSON.parse(r.content[0]!.text).error).toBe("invalid_params");
      }
    }
    expect(await rows()).toEqual(before);
  });

  it("keeps attribution and valid_until unavailable and points fact aliases to items", async () => {
    for (const extra of [{ attributed_to: "user" }, { valid_until: "2026-12-01" }]) {
      expect((await write({ fact: "Not permitted", ...extra })).isError).toBe(true);
      expect((await write({ items: [{ fact: "Not permitted", ...extra }] })).isError).toBe(true);
    }
    const alias = JSON.parse((await write({ facts: [{ fact: "Alias hint" }] })).content[0]!.text);
    expect(alias.suggestion).toContain("items");
    expect(alias.suggestion).toContain("Call shape:");
  });
});
