/**
 * Context-pack cards list the pages that link to the entity and are dated
 * after its own page, newest first: hidden and fenced referrers never show,
 * vault notes count for the operator only, a redacted pack shows dates only,
 * and a tight budget trims these before any fact.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage, deletePage } from "../src/core/pages.ts";
import { addLink } from "../src/core/links.ts";
import { addFact } from "../src/core/facts.ts";
import { entityId } from "../src/core/entities.ts";
import { buildContextPack } from "../src/core/context/context-pack.ts";

let tmp: string;
let storage: Storage;
const ENTITY = "people/zoe";

async function at(slug: string, iso: string): Promise<void> {
  await storage.engine().query(`UPDATE pages SET updated_at = $2::timestamptz WHERE slug = $1`, [slug, iso]);
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-pack-newer-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  await putPage(storage, { slug: ENTITY, type: "person", title: "Zoe", markdown_body: "Zoe runs ops." });
  for (let j = 0; j < 5; j++) {
    await addFact(storage, { entity_slug: ENTITY, fact: `zoe fact ${j}`, confidence: 0.9 });
  }
  const referrers: Array<[string, string]> = [
    ["notes/older", "2026-01-01T00:00:00Z"],
    ["notes/r1", "2026-03-01T00:00:00Z"],
    ["notes/r2", "2026-04-01T00:00:00Z"],
    ["notes/gone", "2026-05-01T00:00:00Z"],
    ["life/diary/2026-06-01", "2026-06-01T00:00:00Z"],
  ];
  for (const [slug] of referrers) {
    await putPage(storage, { slug, title: `Title of ${slug} ${"y".repeat(120)}`, markdown_body: "[[Zoe]]" });
    await addLink(storage, { source_slug: slug, target_slug: ENTITY, type: "wikilink" });
  }
  await deletePage(storage, "notes/gone");
  for (const [slug, iso] of referrers) await at(slug, iso);
  await at(ENTITY, "2026-02-01T00:00:00Z");
  // A vault note that links [[Zoe]]: it carries the link as an entity mention.
  const zoe = entityId("wikilink", "zoe");
  await storage.engine().exec(`
    INSERT INTO documents (id, source_path, title, effective_date) VALUES
      ('v1', '/vault/journal/2026-07-01.md', 'Journal July', '2026-07-01T00:00:00Z'),
      ('v0', '/vault/journal/2025-12-01.md', 'Journal December', '2025-12-01T00:00:00Z');
    INSERT INTO chunks (id, document_id, chunk_index, content) VALUES
      ('v1c0', 'v1', 0, 'talked to [[Zoe]]'),
      ('v0c0', 'v0', 0, 'talked to [[Zoe]] long ago');
    INSERT INTO entities (id, type, name) VALUES ('${zoe}', 'wikilink', 'zoe') ON CONFLICT DO NOTHING;
    INSERT INTO entity_mentions (chunk_id, entity_id, surface_form) VALUES
      ('v1c0', '${zoe}', 'Zoe'), ('v0c0', '${zoe}', 'Zoe');
  `);
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.MEMRAIN_CONTEXT_NEWER_MENTIONS;
});

describe("context_pack newer mentions", () => {
  it("lists live referrers dated after the entity page, newest first, vault notes included", async () => {
    const p = await buildContextPack(storage, { slugs: [ENTITY], tokenBudget: 8000 });
    expect(p.cards[0]!.newer?.map((n) => n.slug)).toEqual([
      "/vault/journal/2026-07-01.md",
      "life/diary/2026-06-01",
      "notes/r2",
      "notes/r1",
    ]);
    expect(p.cards[0]!.newer?.[2]).toMatchObject({ date: "2026-04-01T00:00:00Z", title: expect.stringContaining("notes/r2") });
  });

  it("a remote caller sees page referrers through its fence, and no vault notes", async () => {
    const p = await buildContextPack(storage, { slugs: [ENTITY], tokenBudget: 8000, remote: true });
    expect(p.cards[0]!.newer?.map((n) => n.slug)).toEqual(["notes/r2", "notes/r1"]);
  });

  it("a redacted pack carries the dates only", async () => {
    const p = await buildContextPack(storage, { slugs: [ENTITY], tokenBudget: 8000, redact: true, remote: true });
    expect(p.cards[0]!.newer).toEqual([{ date: "2026-04-01T00:00:00Z" }, { date: "2026-03-01T00:00:00Z" }]);
  });

  it("is off with MEMRAIN_CONTEXT_NEWER_MENTIONS=0", async () => {
    process.env.MEMRAIN_CONTEXT_NEWER_MENTIONS = "0";
    const p = await buildContextPack(storage, { slugs: [ENTITY], tokenBudget: 8000 });
    expect(p.cards[0]!.newer).toBeUndefined();
  });

  it("a tight budget drops newer mentions before any fact", async () => {
    const full = await buildContextPack(storage, { slugs: [ENTITY], tokenBudget: 8000 });
    const card = full.cards[0]!;
    const { newer: _n, ...bare } = card;
    const need = Math.ceil(JSON.stringify(bare).length / 4) + 30;
    const p = await buildContextPack(storage, { slugs: [ENTITY], tokenBudget: Math.max(200, need), factsLimit: 1 });
    const fitted = p.cards[0]!;
    expect(fitted.facts.length).toBe(5);
    expect((fitted.newer ?? []).length).toBeLessThan(4);
    expect((fitted.newer ?? []).length + p.budget.card_newer_dropped).toBe(4);
  });
});
