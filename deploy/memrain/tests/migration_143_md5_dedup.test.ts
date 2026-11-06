/**
 * Migration 143 — the manual timeline and chunk-fact dedup keys hash the text,
 * so an event or fact longer than a btree entry allows (2704 bytes) can be
 * stored and still dedups. Up, down (refused while a long row exists) and up
 * again, on PGLite and, when MEMRAIN_TEST_POSTGRES_URL is set, on a scratch
 * Postgres database of its own.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { PGliteEngine } from "../src/core/engine/pglite.ts";
import { PostgresEngine } from "../src/core/engine/postgres.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import { addFact } from "../src/core/facts.ts";
import { putPage } from "../src/core/pages.ts";
import { addTimelineEvent } from "../src/core/timeline.ts";
import { discoverMigrations, revertMigration, runMigrations } from "../src/core/migrate.ts";
import { migrationsThrough } from "./helpers/migration-120.ts";

const PG_URL = process.env.MEMRAIN_TEST_POSTGRES_URL;

interface Opened {
  storage: Storage;
  close: () => Promise<void>;
}

async function openPglite(): Promise<Opened> {
  const tmp = mkdtempSync(join(tmpdir(), "memrain-mig143-"));
  const storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  return {
    storage,
    close: async () => {
      await storage.close();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

async function openPostgres(baseUrl: string): Promise<Opened> {
  const name = `mig143_${process.pid}_${Math.floor(Math.random() * 1e9)}`;
  const admin = new PostgresEngine({ url: baseUrl, max: 1 });
  await admin.exec(`CREATE DATABASE ${name}`);
  await admin.close();
  const u = new URL(baseUrl);
  u.pathname = `/${name}`;
  const storage = new Storage(new PostgresEngine({ url: u.toString(), max: 2 }));
  await storage.init();
  return {
    storage,
    close: async () => {
      await storage.close();
      const a = new PostgresEngine({ url: baseUrl, max: 1 });
      try {
        await a.exec(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await a.close();
      }
    },
  };
}

const ENGINES: Array<{ name: string; open: () => Promise<Opened> }> = [
  { name: "PGLite", open: openPglite },
  ...(PG_URL ? [{ name: "Postgres", open: () => openPostgres(PG_URL) }] : []),
];

// Incompressible, so the index cannot fit the text by compressing it.
const longAscii = (bytes = 3000) => randomBytes(bytes).toString("base64");
const longCyr = () =>
  Array.from({ length: 3000 }, () => String.fromCharCode(0x430 + Math.floor(Math.random() * 32))).join("");

const MD5_INDEXES = ["entity_facts_dedup_speaker_md5_idx", "timeline_events_manual_dedup_md5_idx"];
const OLD_INDEXES = ["entity_facts_dedup_speaker_idx", "timeline_events_manual_dedup_idx"];

for (const { name, open } of ENGINES) {
  describe(`migration 143 (${name})`, () => {
    let db: Opened;
    beforeEach(async () => {
      db = await open();
      await putPage(db.storage, { slug: "notes/x", type: "note", markdown_body: "x" });
    });
    afterEach(async () => {
      await db.close();
    });

    async function dedupIndexes(): Promise<string[]> {
      const r = await db.storage.engine().query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
          WHERE indexname = ANY($1::text[]) ORDER BY indexname`,
        [[...MD5_INDEXES, ...OLD_INDEXES]],
      );
      return r.rows.map((x) => x.indexname);
    }

    it("stores a 4000-char manual event and dedups the repeat", async () => {
      const event = longAscii();
      const input = { slug: "notes/x", occurred_at: "2026-01-01", event };
      const a = await addTimelineEvent(db.storage, input);
      const b = await addTimelineEvent(db.storage, input);
      expect(a.inserted).toBe(true);
      expect(b.inserted).toBe(false);
    });

    it("stores a 3000-char Cyrillic event", async () => {
      const event = longCyr();
      const a = await addTimelineEvent(db.storage, { slug: "notes/x", occurred_at: "2026-01-01", event });
      expect(a.inserted).toBe(true);
      const r = await db.storage.engine().query<{ event: string }>(
        `SELECT event FROM timeline_events WHERE id = $1`,
        [a.id],
      );
      expect(r.rows[0]?.event).toBe(event);
    });

    it("two distinct 5000-char events both insert", async () => {
      const a = await addTimelineEvent(db.storage, { slug: "notes/x", occurred_at: "2026-01-01", event: longAscii(3750) });
      const b = await addTimelineEvent(db.storage, { slug: "notes/x", occurred_at: "2026-01-01", event: longAscii(3750) });
      expect(a.inserted).toBe(true);
      expect(b.inserted).toBe(true);
    });

    it("stores a 4000-char chunk fact and dedups the repeat", async () => {
      const input = { entity_slug: "people/a", fact: longAscii(), source_chunk_id: "c1" };
      const a = await addFact(db.storage, input);
      const b = await addFact(db.storage, input);
      expect(a.inserted).toBe(true);
      expect(b.inserted).toBe(false);
    });

    it("reverts and re-applies; the down changes nothing while a long row exists", async () => {
      const e = db.storage.engine();
      expect(await dedupIndexes()).toEqual(MD5_INDEXES);
      const later = discoverMigrations().map((m) => m.id).filter((id) => id > 143).sort((a, b) => b - a);
      for (const id of later) await revertMigration(e, id);

      await e.query(
        `INSERT INTO timeline_events (slug, occurred_at, event) VALUES ('notes/x', '2026-01-01', $1)`,
        [longAscii()],
      );
      await expect(revertMigration(e, 143)).rejects.toThrow(/index row/);
      expect(await dedupIndexes()).toEqual(MD5_INDEXES);
      await e.query(`DELETE FROM timeline_events`);

      await e.query(
        `INSERT INTO entity_facts (entity_slug, fact, source_chunk_id) VALUES ('people/a', $1, 'c1')`,
        [longAscii()],
      );
      await expect(revertMigration(e, 143)).rejects.toThrow(/index row/);
      expect(await dedupIndexes()).toEqual(MD5_INDEXES);
      await e.query(`DELETE FROM entity_facts`);

      await revertMigration(e, 143);
      expect(await dedupIndexes()).toEqual(OLD_INDEXES);
      const again = await runMigrations(e);
      expect(again.applied.map((m) => m.id)).toEqual([143, ...later.reverse()]);
      expect(await dedupIndexes()).toEqual(MD5_INDEXES);
    });

    it("the down refuses rather than keep a stray index under an old name", async () => {
      const e = db.storage.engine();
      const later = discoverMigrations().map((m) => m.id).filter((id) => id > 143).sort((a, b) => b - a);
      for (const id of later) await revertMigration(e, id);
      await e.query(`CREATE INDEX timeline_events_manual_dedup_idx ON timeline_events (slug)`);

      await expect(revertMigration(e, 143)).rejects.toThrow(/already exists/);
      expect(await dedupIndexes()).toEqual([...MD5_INDEXES, "timeline_events_manual_dedup_idx"].sort());
      const top = await e.query<{ id: number }>(`SELECT max(id) AS id FROM migrations`);
      expect(Number(top.rows[0]?.id)).toBe(143);
    });
  });
}

/** A bare engine migrated through 142 only, the schema the down must restore. */
async function openAt142(kind: "PGLite" | "Postgres"): Promise<{ engine: Engine; close: () => Promise<void> }> {
  let engine: Engine;
  let close: () => Promise<void>;
  if (kind === "PGLite") {
    const tmp = mkdtempSync(join(tmpdir(), "memrain-mig143-142-"));
    // The sharded runner's template is migrated through the head.
    const template = process.env.MEMRAIN_TEST_PGLITE_TEMPLATE;
    delete process.env.MEMRAIN_TEST_PGLITE_TEMPLATE;
    const pglite = new PGliteEngine({ dbPath: join(tmp, "db") });
    try {
      await pglite.ready();
    } finally {
      if (template !== undefined) process.env.MEMRAIN_TEST_PGLITE_TEMPLATE = template;
    }
    engine = pglite;
    close = async () => {
      await pglite.close();
      rmSync(tmp, { recursive: true, force: true });
    };
  } else {
    const name = `mig143_142_${process.pid}_${Math.floor(Math.random() * 1e9)}`;
    const admin = new PostgresEngine({ url: PG_URL!, max: 1 });
    await admin.exec(`CREATE DATABASE ${name}`);
    await admin.close();
    const u = new URL(PG_URL!);
    u.pathname = `/${name}`;
    const pg = new PostgresEngine({ url: u.toString(), max: 2 });
    engine = pg;
    close = async () => {
      await pg.close();
      const a = new PostgresEngine({ url: PG_URL!, max: 1 });
      try {
        await a.exec(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await a.close();
      }
    };
  }
  const through = migrationsThrough(142);
  try {
    await runMigrations(engine, through.dir);
  } finally {
    through.cleanup();
  }
  return { engine, close };
}

async function indexDefs(e: Engine, names: string[]): Promise<Record<string, string>> {
  const r = await e.query<{ indexname: string; indexdef: string }>(
    `SELECT indexname, indexdef FROM pg_indexes WHERE indexname = ANY($1::text[])`,
    [names],
  );
  return Object.fromEntries(r.rows.map((x) => [x.indexname, x.indexdef]));
}

// The ON CONFLICT targets the writers used before 143.
const OLD_TIMELINE_INSERT = `INSERT INTO timeline_events (slug, occurred_at, event, source_label)
  VALUES ('notes/x', '2026-01-01', 'Met Bob', 'manual')
  ON CONFLICT (slug, occurred_at, event, source_label, source_id)
    WHERE source_chunk_id IS NULL
    DO NOTHING
  RETURNING id`;
const OLD_FACT_INSERT = `INSERT INTO entity_facts (entity_slug, fact, source_chunk_id)
  VALUES ('people/a', 'Plays chess', 'c1')
  ON CONFLICT (entity_slug, fact, source_chunk_id, (COALESCE(attributed_to, '')))
    WHERE source_chunk_id IS NOT NULL
    DO NOTHING
  RETURNING id`;

for (const kind of ["PGLite", ...(PG_URL ? ["Postgres" as const] : [])] as const) {
  describe(`migration 143 down restores the 142 schema (${kind})`, () => {
    it("rebuilds the old indexes with their exact definitions; the old writers work again", async () => {
      const { engine: e, close } = await openAt142(kind);
      try {
        const before = await indexDefs(e, OLD_INDEXES);
        expect(Object.keys(before).sort()).toEqual(OLD_INDEXES);
        await e.query(
          `INSERT INTO pages (slug, type, title, content_hash, markdown_body) VALUES ('notes/x', 'note', 'X', 'h', 'x')`,
        );

        await runMigrations(e);
        const later = discoverMigrations().map((m) => m.id).filter((id) => id > 143).sort((a, b) => b - a);
        for (const id of later) await revertMigration(e, id);
        await revertMigration(e, 143);

        expect(await indexDefs(e, [...OLD_INDEXES, ...MD5_INDEXES])).toEqual(before);
        for (const sql of [OLD_TIMELINE_INSERT, OLD_FACT_INSERT]) {
          expect((await e.query(sql)).rows).toHaveLength(1);
          expect((await e.query(sql)).rows).toHaveLength(0);
        }
      } finally {
        await close();
      }
    });
  });
}
