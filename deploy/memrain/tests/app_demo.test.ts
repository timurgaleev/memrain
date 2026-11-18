/**
 * Demo memory for /app (core/demo-brain.ts): the synthetic bench corpus,
 * loaded into a source of its own that only this member reads, and removed
 * with one call down to the last row of that source in every table, facts
 * included. Loading twice is a no-op; another member's demo is untouched.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { registerSource } from "../src/core/sources.ts";
import { addMember, memberAccess, type MemberActor } from "../src/core/members.ts";
import { demoLoaded, demoSourceId, loadDemo, removeDemo } from "../src/core/demo-brain.ts";
import { deterministicEmbed } from "./det-embed.ts";

setDefaultTimeout(120_000);

const OPS: MemberActor = { actor: "ops", via: "cli" };
const embedFn = async (text: string) => deterministicEmbed(text);

let tmp: string;
let storage: Storage;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-app-demo-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  for (const id of ["alice", "bob"]) {
    await registerSource(storage.engine(), { id: `person-${id}`, kind: "other", pathPrefix: `/person-${id}` });
    await addMember(storage.engine(), id, { personalSource: `person-${id}` }, OPS);
  }
});
afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function rowsOf(source: string): Promise<Record<string, number>> {
  const e = storage.engine();
  const tables = await e.query<{ table_name: string }>(
    `SELECT c.table_name FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND c.column_name = 'source_id'`,
  );
  const out: Record<string, number> = {};
  for (const { table_name } of tables.rows) {
    const n = (await e.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table_name} WHERE source_id = $1`, [source])).rows[0]!.n;
    if (n > 0) out[table_name] = n;
  }
  const src = (await e.query(`SELECT 1 FROM sources WHERE id = $1`, [source])).rows.length;
  if (src > 0) out["sources"] = src;
  return out;
}

describe("demo memory", () => {
  it("loads the corpus into a source only this member reads", async () => {
    const r = await loadDemo(storage, "alice", { embedFn });
    expect(r.pages).toBeGreaterThan(10);
    expect(await demoLoaded(storage.engine(), "alice")).toBe(true);
    expect(await demoLoaded(storage.engine(), "bob")).toBe(false);
    const alice = await memberAccess(storage.engine(), ["alice"]);
    const bob = await memberAccess(storage.engine(), ["bob"]);
    expect(alice?.groupSources).toContain(demoSourceId("alice"));
    expect(bob?.groupSources ?? []).not.toContain(demoSourceId("alice"));
    const pages = await storage.engine().query<{ n: number }>(`SELECT count(*)::int AS n FROM pages WHERE source_id = $1`, [demoSourceId("alice")]);
    expect(pages.rows[0]!.n).toBe(r.pages);
  });

  it("loading again changes nothing", async () => {
    const before = await rowsOf(demoSourceId("alice"));
    const again = await loadDemo(storage, "alice", { embedFn });
    expect(again.already).toBe(true);
    expect(await rowsOf(demoSourceId("alice"))).toEqual(before);
  });

  it("removes every row of the demo source, facts included, and leaves another member's demo", async () => {
    await loadDemo(storage, "bob", { embedFn });
    const e = storage.engine();
    const source = demoSourceId("alice");
    // A fact extracted from a demo page, the way the cycle would write it.
    await e.query(
      `INSERT INTO entity_facts (entity_slug, fact, source_id, source_slug) SELECT 'people/odile-varga', 'leads the beacon project', $1, slug FROM pages WHERE source_id = $1 LIMIT 1`,
      [source],
    );
    expect(Object.keys(await rowsOf(source))).toContain("entity_facts");
    const removed = await removeDemo(e, "alice");
    expect(removed.removed).toBe(true);
    expect(await rowsOf(source)).toEqual({});
    expect(await demoLoaded(e, "alice")).toBe(false);
    expect((await memberAccess(e, ["alice"]))?.groupSources ?? []).not.toContain(source);
    expect(Object.keys(await rowsOf(demoSourceId("bob")))).toContain("pages");
    expect((await removeDemo(e, "alice")).removed).toBe(false);
  });

  it("never treats a source of the same name that is not this member's demo as one", async () => {
    const e = storage.engine();
    // The operator happened to name another member's personal source demo-carol.
    await registerSource(e, { id: "demo-carol", kind: "other", pathPrefix: "/demo-carol" });
    await addMember(e, "dave", { personalSource: "demo-carol" }, OPS);
    await addMember(e, "carol", {}, OPS);
    await e.query(`INSERT INTO pages (slug, type, title, markdown_body, content_hash, source_id) VALUES ('notes/dave', 'note', 'd', 'dave''s note', 'h-dave', 'demo-carol')`);
    expect(await demoLoaded(e, "carol")).toBe(false);
    expect((await removeDemo(e, "carol")).removed).toBe(false);
    await expect(loadDemo(storage, "carol", { embedFn })).rejects.toThrow(/demo/);
    expect(Object.keys(await rowsOf("demo-carol"))).toContain("pages");
    expect((await memberAccess(e, ["carol"]))?.groupSources ?? []).not.toContain("demo-carol");
  });
});
