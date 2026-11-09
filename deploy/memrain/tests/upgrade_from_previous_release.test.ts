/**
 * Data a brain on the previous release holds survives every migration since:
 * a database migrated through PREVIOUS_RELEASE.lastMigration is seeded with
 * plain SQL (the current writers may target indexes the old schema lacks), read
 * through the old columns, migrated to the head, and read with current APIs. PGLite
 * always; Postgres on a scratch database of its own when
 * MEMRAIN_TEST_POSTGRES_URL is set.
 */
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGliteEngine } from "../src/core/engine/pglite.ts";
import { PostgresEngine } from "../src/core/engine/postgres.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import { Storage } from "../src/core/storage.ts";
import { discoverMigrations, runMigrations } from "../src/core/migrate.ts";
import { getPage, pageVersions } from "../src/core/pages.ts";
import { listFacts } from "../src/core/facts.ts";
import { getLinks } from "../src/core/links-read.ts";
import { getEntityTimeline } from "../src/core/timeline.ts";
import { getTags } from "../src/core/tags.ts";
import { getRuntimeConfig } from "../src/core/runtime-config.ts";
import { OAuthProvider } from "../src/core/oauth-provider.ts";
import { migrationsThrough } from "./helpers/migration-120.ts";
import { PREVIOUS_RELEASE } from "./helpers/previous-release.ts";

const PG_URL = process.env.MEMRAIN_TEST_POSTGRES_URL;

interface Opened {
  engine: Engine;
  close: () => Promise<void>;
}

async function migrateToPrevious(e: Engine, lastMigration: number): Promise<void> {
  const through = migrationsThrough(lastMigration);
  try {
    await runMigrations(e, through.dir);
  } finally {
    through.cleanup();
  }
}

async function openPglite(lastMigration: number): Promise<Opened> {
  const tmp = mkdtempSync(join(tmpdir(), "upgrade-prev-"));
  // The sharded runner's template is migrated through the head; this database
  // must stop at the previous release.
  const template = process.env.MEMRAIN_TEST_PGLITE_TEMPLATE;
  delete process.env.MEMRAIN_TEST_PGLITE_TEMPLATE;
  const engine = new PGliteEngine({ dbPath: join(tmp, "db") });
  try {
    await engine.ready();
  } finally {
    if (template !== undefined) process.env.MEMRAIN_TEST_PGLITE_TEMPLATE = template;
  }
  await migrateToPrevious(engine, lastMigration);
  return {
    engine,
    close: async () => {
      await engine.close();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

async function openPostgres(baseUrl: string, lastMigration: number): Promise<Opened> {
  const name = `upgrade_prev_${process.pid}_${Math.floor(Math.random() * 1e9)}`;
  const admin = new PostgresEngine({ url: baseUrl, max: 1 });
  await admin.exec(`CREATE DATABASE ${name}`);
  await admin.close();
  const u = new URL(baseUrl);
  u.pathname = `/${name}`;
  const engine = new PostgresEngine({ url: u.toString(), max: 2 });
  await engine.ready();
  await migrateToPrevious(engine, lastMigration);
  return {
    engine,
    close: async () => {
      await engine.close();
      const a = new PostgresEngine({ url: baseUrl, max: 1 });
      try {
        await a.exec(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await a.close();
      }
    },
  };
}

const ENGINES: Array<{ name: string; open: (lastMigration: number) => Promise<Opened> }> = [
  { name: "PGLite", open: openPglite },
  ...(PG_URL ? [{ name: "Postgres", open: (lastMigration: number) => openPostgres(PG_URL, lastMigration) }] : []),
];

const PAT = "memrain_pat_upgrade_fixture";
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

async function seed(e: Engine): Promise<void> {
  await e.exec(`
    INSERT INTO pages (slug, type, title, content_hash, markdown_body, updated_at) VALUES
      ('people/alice', 'person', 'Alice', 'h2', E'# Alice\\n\\nSecond body.', '2026-01-02 00:00:00+00'),
      ('notes/meeting', 'note', 'Meeting', 'h3', '# Meeting', '2026-01-02 00:00:00+00');
    INSERT INTO page_versions (slug, version_n, hash_prev, hash_new, body_snapshot, compiled_truth_snapshot,
                               written_by, written_at) VALUES
      ('people/alice', 1, NULL, 'h1', E'# Alice\\n\\nFirst body.', '{}', 'seed', '2026-01-01 00:00:00+00'),
      ('people/alice', 2, 'h1', 'h2', E'# Alice\\n\\nSecond body.', '{}', 'seed', '2026-01-02 00:00:00+00');
    INSERT INTO entity_facts (entity_slug, fact, source_chunk_id, attributed_to, written_by, written_at) VALUES
      ('people/alice', 'Lives in Paris', 'c1', 'user', 'seed', '2026-01-01 00:00:00+00'),
      ('people/alice', 'Plays chess', NULL, NULL, 'seed', '2026-01-01 00:00:00+00');
    INSERT INTO links (source_slug, target_slug, type, written_at)
      VALUES ('notes/meeting', 'people/alice', 'mentions', '2026-01-01 00:00:00+00');
    INSERT INTO timeline_events (slug, occurred_at, event, source_label, written_at)
      VALUES ('people/alice', '2026-01-01 10:00:00+00', 'Met Bob', 'manual', '2026-01-01 00:00:00+00');
    INSERT INTO tags (slug, tag, created_at) VALUES ('people/alice', 'friend', '2026-01-01 00:00:00+00');
    INSERT INTO runtime_config (key, value, updated_at) VALUES ('MEMRAIN_UPGRADE_PROBE', '42', '2026-01-01 00:00:00+00');
    INSERT INTO access_tokens (name, token_hash) VALUES ('upgrade-pat', '${sha256(PAT)}');
  `);
}

async function read(e: Engine, legacyVersions = false) {
  const storage = new Storage(e);
  const auth = await new OAuthProvider({ engine: e }).verifyAccessToken(PAT);
  const versions = legacyVersions
    ? (await e.query<Awaited<ReturnType<typeof pageVersions>>[number]>(
      `SELECT slug, source_id, version_n, hash_prev, hash_new, body_snapshot, compiled_truth_snapshot,
              written_by, NULL::text AS change_reason, written_at::text AS written_at
         FROM page_versions WHERE slug = $1 ORDER BY version_n DESC LIMIT 20`, ["people/alice"],
    )).rows
    : await pageVersions(storage, "people/alice");
  return {
    page: (await getPage(storage, "people/alice"))?.markdown_body,
    versions,
    facts: (await listFacts(storage, "people/alice"))
      .map((f) => [f.fact, f.source_chunk_id, f.attributed_to])
      .sort(),
    links: await getLinks(storage, "people/alice"),
    timeline: (await getEntityTimeline(storage, "people/alice")).map((t) => [t.occurred_at, t.event, t.source_label]),
    tags: await getTags(storage, "people/alice"),
    config: await getRuntimeConfig(e, "MEMRAIN_UPGRADE_PROBE"),
    pat: { clientId: auth.clientId, scopes: auth.scopes },
  };
}

// Keep the pre-reason schema covered after the release pointer advances.
const BASELINES = [...new Map([
  { tag: "v1.14.0", lastMigration: 146 }, PREVIOUS_RELEASE,
].map(release => [release.lastMigration, release])).values()];

for (const baseline of BASELINES) for (const { name, open } of ENGINES) {
  describe(`upgrade from ${baseline.tag} (${name})`, () => {
    it("keeps every seeded row readable through the migrations since", async () => {
      const db = await open(baseline.lastMigration);
      try {
        await seed(db.engine);
        const before = await read(db.engine, baseline.lastMigration < 147);
        expect(before.page).toContain("Second body.");
        expect(before.versions.map((v) => v.version_n)).toEqual([2, 1]);
        expect(before.facts).toEqual([["Lives in Paris", "c1", "user"], ["Plays chess", null, null]]);
        expect(JSON.stringify(before.links)).toContain("notes/meeting");
        expect(before.timeline.map((t) => t[1])).toEqual(["Met Bob"]);
        expect(before.tags).toEqual(["friend"]);
        expect(before.config).toBe("42");
        expect(before.pat.clientId).toBe("upgrade-pat");

        const pending = discoverMigrations()
          .map((m) => m.id)
          .filter((id) => id > baseline.lastMigration);
        const result = await runMigrations(db.engine);
        expect(result.applied.map((m) => m.id)).toEqual(pending);

        expect(await read(db.engine)).toEqual(before);
      } finally {
        await db.close();
      }
    });
  });
}

it("the previous release is not ahead of the shipped migrations", () => {
  expect(PREVIOUS_RELEASE.lastMigration).toBeLessThanOrEqual(Math.max(...discoverMigrations().map((m) => m.id)));
});
