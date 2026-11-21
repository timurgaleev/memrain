/**
 * Fact slots: a fact about a person may carry one slot (location, employer,
 * role). A later value of the same slot ends an earlier one at read time, in
 * every fact reader, from the facts that reader may see. Nothing is stored:
 * the retired row keeps its NULL valid_until.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { addFact, entityRecall, listFacts } from "../src/core/facts.ts";
import { deriveSlotEnds, normalizeSlot, type SlotRow } from "../src/core/fact-slots.ts";
import { matchQueryFacts } from "../src/core/facts-query-match.ts";
import { putPage } from "../src/core/pages.ts";
import { getBrainHotMemoryMeta, invalidateHotMemoryMeta } from "../src/core/hot-memory-meta.ts";
import { buildContextPack } from "../src/core/context/context-pack.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";

const ALICE = "people/alice-example";

describe("normalizeSlot", () => {
  it("keeps a valid slot with aliases normalized and the value trimmed", () => {
    expect(normalizeSlot("Company", "  Acme Example ", ALICE)).toEqual({ dimension: "employer", value: "Acme Example" });
    expect(normalizeSlot("location", "Springfield", ALICE)).toEqual({ dimension: "location", value: "Springfield" });
    expect(normalizeSlot("job title", "head of design", ALICE)).toEqual({ dimension: "role", value: "head of design" });
  });

  it("keeps an 80-character value and drops an 81-character one", () => {
    expect(normalizeSlot("role", "y".repeat(80), ALICE)).toEqual({ dimension: "role", value: "y".repeat(80) });
    expect(normalizeSlot("role", "x".repeat(81), ALICE)).toBeNull();
  });

  it("drops a dimension outside the vocabulary, a blank or non-string value, and a slot with no entity", () => {
    expect(normalizeSlot("hobby", "chess", ALICE)).toBeNull();
    expect(normalizeSlot("location", "   ", ALICE)).toBeNull();
    expect(normalizeSlot("role", 7, ALICE)).toBeNull();
    expect(normalizeSlot(undefined, "Acme Example", ALICE)).toBeNull();
    expect(normalizeSlot("employer", "Acme Example", null)).toBeNull();
  });
});

describe("deriveSlotEnds", () => {
  const row = (id: number, value: string, from: string, page: string | null, fact = `fact ${id}`): SlotRow => ({
    id, source_id: "default", entity_slug: ALICE, dimension: "employer", value_hash: value, valid_from: from, source_markdown_slug: page, fact,
  });

  it("a value from the same page ends the stint before it", () => {
    const ends = deriveSlotEnds([row(1, "acme", "2024-01-01", "notes/a"), row(2, "beta", "2025-06-01", "notes/a")]);
    expect(ends.get(1)).toEqual({ at: new Date("2025-06-01"), by: 2 });
    expect(ends.has(2)).toBe(false);
  });

  it("across pages only a fact that states the change ends the earlier value", () => {
    expect(deriveSlotEnds([row(1, "acme", "2024-01-01", "notes/a"), row(2, "beta", "2025-06-01", "notes/b", "Alice works at Beta")]).size).toBe(0);
    expect(deriveSlotEnds([row(1, "acme", "2024-01-01", "notes/a"), row(2, "beta", "2025-06-01", "notes/b", "Alice joined Beta")]).get(1)?.by).toBe(2);
  });

  it("a restatement continues the stint and every row of it ends together", () => {
    const ends = deriveSlotEnds([row(1, "acme", "2024-01-01", "notes/a"), row(2, "acme", "2024-05-01", "notes/c"),
      row(3, "beta", "2025-06-01", "notes/b", "Alice moved to Beta")]);
    expect(ends.get(1)?.by).toBe(3);
    expect(ends.get(2)?.by).toBe(3);
  });

  it("a value dated no later than the stint ends nothing, and slots of other entities stay apart", () => {
    expect(deriveSlotEnds([row(1, "acme", "2024-01-01", "notes/a"), row(2, "beta", "2024-01-01", "notes/a")]).size).toBe(0);
    expect(deriveSlotEnds([row(1, "acme", "2024-01-01", "notes/a"), { ...row(2, "beta", "2025-06-01", "notes/a"), entity_slug: "people/bob" }]).size).toBe(0);
  });
});

for (const engine of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`fact slots ${engine.name}`, () => {
  let db: Awaited<ReturnType<typeof engine.open>>;
  const ids = {} as Record<"acme" | "beta" | "paris" | "berlin" | "tea", number>;
  const add = async (key: keyof typeof ids, fact: string, slot: { dimension: string; value: string } | null, valid_from: string, extra: Record<string, unknown> = {}) => {
    ids[key] = (await addFact(db.storage, { entity_slug: ALICE, fact, valid_from, source_slug: `notes/${key}`, ...(slot ? { slot } : {}), ...extra })).id!;
  };
  const facts = (rows: Array<{ fact: string }>) => rows.map((f) => f.fact).sort();

  beforeAll(async () => {
    db = await engine.open();
    await putPage(db.storage, { slug: ALICE, type: "person", title: "Alice Example" });
    await add("acme", "Alice Example works at Acme Example", { dimension: "employer", value: "Acme Example" }, "2024-01-01", { visibility: "world" });
    await add("beta", "Alice Example joined Beta Example", { dimension: "employer", value: "Beta Example" }, "2025-06-01", { visibility: "world" });
    await add("paris", "Alice Example lives in Paris", { dimension: "location", value: "Paris" }, "2024-01-01", { visibility: "world" });
    await add("berlin", "Alice Example moved to Berlin", { dimension: "location", value: "Berlin" }, "2025-03-01", { visibility: "private" });
    await add("tea", "Alice Example likes green tea", null, "2024-02-01", { visibility: "world" });
  });
  afterAll(async () => { await db.close(); });

  it("entity_facts drops a slot value a later one ended, and keeps everything else", async () => {
    expect(facts(await listFacts(db.storage, ALICE, { decay: false }))).toEqual([
      "Alice Example joined Beta Example", "Alice Example likes green tea", "Alice Example moved to Berlin",
    ]);
  });

  it("nothing is stored: the ended row keeps a NULL valid_until", async () => {
    const r = await db.storage.engine().query<{ valid_until: string | null }>("SELECT valid_until::text FROM entity_facts WHERE id = $1", [ids.acme]);
    expect(r.rows[0]!.valid_until).toBeNull();
  });

  it("include_ended shows the ended value with its end and what ended it", async () => {
    const rows = await listFacts(db.storage, ALICE, { decay: false, includeEnded: true });
    const acme = rows.find((f) => f.id === ids.acme)!;
    expect(acme.valid_until).toBe("2025-06-01");
    expect(acme.slot).toMatchObject({ dimension: "employer", value: "Acme Example", ended_by: ids.beta, ended_at: "2025-06-01" });
    expect(typeof acme.slot!.said_at).toBe("string");
    expect(rows.find((f) => f.id === ids.beta)!.slot).toMatchObject({ dimension: "employer", value: "Beta Example" });
    expect(rows.find((f) => f.id === ids.beta)!.slot!.ended_by).toBeUndefined();
    expect(rows.find((f) => f.id === ids.tea)!.slot).toBeUndefined();
  });

  it("a fact the reader cannot see never ends one it can", async () => {
    expect(facts(await listFacts(db.storage, ALICE, { decay: false, visibility: ["world"] }))).toEqual([
      "Alice Example joined Beta Example", "Alice Example likes green tea", "Alice Example lives in Paris",
    ]);
  });

  it("a limited read still fills its limit after dropping ended values", async () => {
    const rows = await listFacts(db.storage, ALICE, { decay: false, limit: 3, order: "recency" });
    expect(rows).toHaveLength(3);
    expect(rows.map((f) => f.id)).not.toContain(ids.acme);
    expect(rows.map((f) => f.id)).not.toContain(ids.paris);
  });

  it("entity_recall and the search fact block read the current value only", async () => {
    expect(facts((await entityRecall(db.storage, ALICE, { decay: false })).facts)).not.toContain("Alice Example works at Acme Example");
    const matched = await matchQueryFacts(db.storage.engine(), "Alice Example works Acme Example joined Beta Example");
    expect(matched.map((f) => f.fact_id)).toContain(ids.beta);
    expect(matched.map((f) => f.fact_id)).not.toContain(ids.acme);
  });

  it("hot memory and context_pack read the current value only", async () => {
    const prior = process.env["MEMRAIN_HOT_MEMORY_META"];
    process.env["MEMRAIN_HOT_MEMORY_META"] = "1";
    try {
      invalidateHotMemoryMeta();
      const meta = await getBrainHotMemoryMeta(db.storage) as { brain_hot_memory: { facts: Array<{ id: number }> } };
      const hot = meta.brain_hot_memory.facts.map((f) => f.id);
      expect(hot).toContain(ids.beta);
      expect(hot).not.toContain(ids.acme);
    } finally {
      if (prior === undefined) delete process.env["MEMRAIN_HOT_MEMORY_META"];
      else process.env["MEMRAIN_HOT_MEMORY_META"] = prior;
      invalidateHotMemoryMeta();
    }
    const pack = JSON.stringify(await buildContextPack(db.storage, { slugs: [ALICE], decay: false }));
    expect(pack).toContain("joined Beta Example");
    expect(pack).not.toContain("works at Acme Example");
  });

  it("known_as_of reads what the brain knew then, with slots ended as of then", async () => {
    const e = db.storage.engine();
    await e.query("UPDATE entity_facts SET first_written_at = '2025-01-01T00:00:00Z' WHERE id = ANY($1::bigint[])", [[ids.acme, ids.paris, ids.tea]]);
    await e.query("UPDATE entity_facts SET first_written_at = '2025-07-01T00:00:00Z' WHERE id = ANY($1::bigint[])", [[ids.beta, ids.berlin]]);
    expect(facts(await listFacts(db.storage, ALICE, { knownAsOf: "2025-02-01T00:00:00Z" }))).toEqual([
      "Alice Example likes green tea", "Alice Example lives in Paris", "Alice Example works at Acme Example",
    ]);
    expect(facts(await listFacts(db.storage, ALICE, { knownAsOf: "2025-08-01T00:00:00Z" }))).toEqual([
      "Alice Example joined Beta Example", "Alice Example likes green tea", "Alice Example moved to Berlin",
    ]);
    // A fact replaced after T was still known at T; one replaced before was not.
    await e.query("UPDATE entity_facts SET forgotten_at = '2025-03-01T00:00:00Z', forgotten_cause = 'supersede' WHERE id = $1", [ids.tea]);
    expect(facts(await listFacts(db.storage, ALICE, { knownAsOf: "2025-02-01T00:00:00Z" }))).toContain("Alice Example likes green tea");
    expect(facts(await listFacts(db.storage, ALICE, { knownAsOf: "2025-04-01T00:00:00Z" }))).not.toContain("Alice Example likes green tea");
    // A forgotten or purged fact never comes back, however early T is.
    for (const cause of ["forget", "purge"]) {
      await e.query("UPDATE entity_facts SET forgotten_cause = $2 WHERE id = $1", [ids.tea, cause]);
      expect(facts(await listFacts(db.storage, ALICE, { knownAsOf: "2025-02-01T00:00:00Z" }))).not.toContain("Alice Example likes green tea");
    }
    await e.query("UPDATE entity_facts SET forgotten_at = NULL, forgotten_cause = NULL WHERE id = $1", [ids.tea]);
    // A replaced copy of a claim later withdrawn, or of a purged page, stays erased too.
    const copy = (await addFact(db.storage, { entity_slug: ALICE, fact: "Alice Example keeps bees", source_slug: "notes/bees" })).id!;
    await e.query("UPDATE entity_facts SET first_written_at = '2025-01-01T00:00:00Z', forgotten_at = '2025-03-01T00:00:00Z', forgotten_cause = 'supersede' WHERE id = $1", [copy]);
    expect(facts(await listFacts(db.storage, ALICE, { knownAsOf: "2025-02-01T00:00:00Z" }))).toContain("Alice Example keeps bees");
    await e.query("INSERT INTO fact_purge_receipts (purge_id, page_slug, source_id, fact_ids) VALUES (gen_random_uuid(), 'notes/bees', 'default', ARRAY[]::bigint[])");
    expect(facts(await listFacts(db.storage, ALICE, { knownAsOf: "2025-02-01T00:00:00Z" }))).not.toContain("Alice Example keeps bees");
    const owl = (await addFact(db.storage, { entity_slug: ALICE, fact: "Alice Example owns an owl" })).id!;
    await e.query("UPDATE entity_facts SET first_written_at = '2025-01-01T00:00:00Z', forgotten_at = '2025-03-01T00:00:00Z', forgotten_cause = 'supersede' WHERE id = $1", [owl]);
    expect(facts(await listFacts(db.storage, ALICE, { knownAsOf: "2025-02-01T00:00:00Z" }))).toContain("Alice Example owns an owl");
    await e.query("INSERT INTO fact_withdrawals (source_id, visibility, entity_slug, claim_key) VALUES ('default', 'private', $1, memrain_fact_claim_key('Alice Example owns an owl'))", [ALICE]);
    expect(facts(await listFacts(db.storage, ALICE, { knownAsOf: "2025-02-01T00:00:00Z" }))).not.toContain("Alice Example owns an owl");
  });

  it("entity_facts takes include_ended and known_as_of, under the caller's visibility", async () => {
    const call = async (args: Record<string, unknown>, opts: Parameters<typeof dispatchTool>[2]) => {
      const r = await dispatchTool(db.storage, { name: "entity_facts", arguments: { entity_slug: ALICE, ...args } }, opts);
      return { isError: r.isError === true, body: JSON.parse(r.content[0]!.text) };
    };
    const texts = (r: { body: { facts: Array<{ fact: string }> } }) => r.body.facts.map((f) => f.fact).sort();
    const ended = await call({ include_ended: true }, {});
    expect(texts(ended)).toContain("Alice Example works at Acme Example");
    const tenant = { authInfo: { token: "t", clientId: "laptop", scopes: ["read"], isPublic: false } };
    expect(texts(await call({ known_as_of: "2025-08-01T00:00:00Z" }, tenant))).toEqual([
      "Alice Example joined Beta Example", "Alice Example likes green tea", "Alice Example lives in Paris",
    ]);
    expect((await call({ known_as_of: "not a date" }, {})).isError).toBe(true);
  });

  it("a restatement keeps when the claim was first written", async () => {
    const first = await addFact(db.storage, { entity_slug: "people/bob-example", fact: "Bob Example plays chess" });
    const e = db.storage.engine();
    await e.query("UPDATE entity_facts SET first_written_at = NULL, written_at = '2024-01-01T00:00:00Z' WHERE id = $1", [first.id]);
    await addFact(db.storage, { entity_slug: "people/bob-example", fact: "Bob Example plays chess" });
    const r = await e.query<{ first: string; written: string }>(
      "SELECT first_written_at::date::text AS first, written_at::date::text AS written FROM entity_facts WHERE id = $1", [first.id]);
    expect(r.rows[0]!.first).toBe("2024-01-01");
    expect(r.rows[0]!.written).not.toBe("2024-01-01");
  });
});
