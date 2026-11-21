/**
 * Entity anchor list (entity-anchor.ts): an opt-in list that, for a
 * current-state query naming one entity, reads the entity page and the pages
 * linking to it, newest first, under the caller's read fences. PGLite, no
 * Bedrock (deterministic embeddings for the mirrors).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { addLink } from "../src/core/links.ts";
import { putPage } from "../src/core/pages.ts";
import { mirrorPage } from "../src/core/page-index.ts";
import { asksForCurrentState, ENTITY_ANCHOR_MAX, entityAnchorChunkIds, namedEntity } from "../src/core/search/entity-anchor.ts";
import { rankingSignature } from "../src/core/search/query-cache.ts";
import { deterministicEmbed } from "./det-embed.ts";
import type { Engine } from "../src/core/engine/interface.ts";

let tmp: string;
let storage: Storage;
const saved = process.env["MEMRAIN_ENTITY_ANCHOR"];

async function page(slug: string, type: string, title: string, body: string): Promise<void> {
  await putPage(storage, { slug, type, title, markdown_body: body, allowAdHocType: true });
  await mirrorPage(storage, { slug, title, markdown_body: body }, { remote: false, embedFn: async (t) => deterministicEmbed(t) });
}

async function slugsOf(ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const r = await storage.engine().query<{ id: string; source_path: string }>(
    `SELECT c.id, d.source_path FROM chunks c JOIN documents d ON d.id = c.document_id WHERE c.id = ANY($1::text[])`, [ids]);
  const byId = new Map(r.rows.map(row => [row.id, row.source_path.replace("page://", "")]));
  return ids.map(id => byId.get(id) ?? "?");
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-anchor-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  await page("companies/acme", "company", "Acme", "Acme builds rockets.");
  await page("companies/acme-labs", "company", "Acme Labs", "The research arm.");
  await page("people/bob", "person", "Bob", "Bob is an engineer.");
  await page("notes/old", "note", "Old note", "Spring update on the rocket.");
  await page("notes/new", "note", "New note", "Autumn update on the launch.");
  await page("life/diary/entry", "diary", "Diary", "Private thoughts about the company.");
  for (const s of ["notes/old", "notes/new", "life/diary/entry"]) {
    await addLink(storage, { source_slug: s, target_slug: "companies/acme", type: "mentions" });
  }
  await storage.engine().query(`UPDATE pages SET updated_at = now() - interval '30 days' WHERE slug = 'notes/old'`);
  await storage.engine().query(`UPDATE pages SET updated_at = now() - interval '1 day' WHERE slug = 'notes/new'`);
  await storage.engine().query(`UPDATE pages SET updated_at = now() - interval '60 days' WHERE slug = 'life/diary/entry'`);
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
  if (saved === undefined) delete process.env["MEMRAIN_ENTITY_ANCHOR"];
  else process.env["MEMRAIN_ENTITY_ANCHOR"] = saved;
});

const on = () => { process.env["MEMRAIN_ENTITY_ANCHOR"] = "1"; };
const off = () => { delete process.env["MEMRAIN_ENTITY_ANCHOR"]; };

describe("entity anchor", () => {
  it("is off by default and keeps the cache signature unchanged then", async () => {
    off();
    const sigOff = rankingSignature();
    expect(await entityAnchorChunkIds(storage.engine(), "what is acme doing now")).toEqual([]);
    on();
    expect(rankingSignature()).not.toBe(sigOff);
    expect(rankingSignature().startsWith(sigOff)).toBe(true);
    off();
  });

  it("reads the entity page, then linking pages newest first", async () => {
    on();
    try {
      const ids = await entityAnchorChunkIds(storage.engine(), "what is acme doing now?");
      expect(await slugsOf(ids)).toEqual(["companies/acme", "notes/new", "notes/old", "life/diary/entry"]);
    } finally {
      off();
    }
  });

  it("needs a current-state cue and exactly one named entity", async () => {
    on();
    try {
      expect(asksForCurrentState("what is acme building")).toBe(false);
      expect(await entityAnchorChunkIds(storage.engine(), "what is acme building")).toEqual([]);
      expect(await namedEntity(storage.engine(), "is bob at acme now")).toBeNull();
      expect(await namedEntity(storage.engine(), "what is acme labs doing now")).toBe("companies/acme-labs");
    } finally {
      off();
    }
  });

  it("a remote caller never gets a diary page; an empty scope reads nothing", async () => {
    on();
    try {
      const remote = await entityAnchorChunkIds(storage.engine(), "what is acme doing now", { remote: true });
      expect(await slugsOf(remote)).toEqual(["companies/acme", "notes/new", "notes/old"]);
      expect(await entityAnchorChunkIds(storage.engine(), "what is acme doing now", { sourceIds: [] })).toEqual([]);
    } finally {
      off();
    }
  });

  it("caps the linking pages in SQL, not after reading them all", async () => {
    on();
    await page("companies/hubco", "company", "Hubco", "A hub.");
    for (let i = 0; i < ENTITY_ANCHOR_MAX + 5; i++) {
      await page(`notes/hub-${i}`, "note", `Hub note ${i}`, `Hub note body ${i}.`);
      await addLink(storage, { source_slug: `notes/hub-${i}`, target_slug: "companies/hubco", type: "mentions" });
    }
    let maxRows = 0;
    const engine = new Proxy(storage.engine(), {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv);
        if (prop !== "query" || typeof v !== "function") return v;
        return async (...args: unknown[]) => {
          const r = await (v as (...a: unknown[]) => Promise<{ rows: unknown[] }>).apply(target, args);
          maxRows = Math.max(maxRows, r.rows.length);
          return r;
        };
      },
    }) as Engine;
    try {
      const ids = await entityAnchorChunkIds(engine, "what is hubco doing now");
      expect(ids).toHaveLength(ENTITY_ANCHOR_MAX + 1);
      expect(maxRows).toBeLessThanOrEqual(ENTITY_ANCHOR_MAX);
    } finally {
      off();
    }
  });

  it("skips a soft-deleted linking page", async () => {
    on();
    await storage.engine().query(`UPDATE pages SET deleted_at = now() WHERE slug = 'notes/new'`);
    try {
      const ids = await entityAnchorChunkIds(storage.engine(), "what is acme doing now");
      expect(await slugsOf(ids)).not.toContain("notes/new");
    } finally {
      await storage.engine().query(`UPDATE pages SET deleted_at = NULL WHERE slug = 'notes/new'`);
      off();
    }
  });
});
