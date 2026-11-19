/**
 * `migrate-engine` copy + verify: every catalog table survives a two-hop
 * round trip with equal counts and content hashes, triggers stay off while
 * copying, and a re-run converges instead of duplicating.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { addLink } from "../src/core/links.ts";
import { addFact } from "../src/core/facts.ts";
import { forgetFact } from "../src/core/facts-recall.ts";
import { addTimelineEvent } from "../src/core/timeline.ts";
import { addTag } from "../src/core/tags.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import {
  copyEngine,
  planCopy,
  readCatalog,
  topoOrder,
  type Catalog,
  type TableInfo,
} from "../src/core/engine-copy.ts";
import { resolveEndpoints, runMigrateEngine } from "../src/commands/migrate-engine.ts";

let tmp: string;
let src: Storage;
let mid: Storage;
let end: Storage;
let liveFactId: number;
let forgottenFactId: number;

async function open(name: string): Promise<Storage> {
  const s = new Storage({ dbPath: join(tmp, name) });
  await s.init();
  return s;
}

async function seed(s: Storage): Promise<void> {
  const e = s.engine();
  await e.query(
    "INSERT INTO sources (id, kind, path_prefix, description) VALUES ('team-b', 'other', '/team-b', 'second tenant')",
  );
  await e.query("UPDATE sources SET description = 'operator brain' WHERE id = 'default'");

  await putPage(s, { slug: "people/alice", type: "person", title: "Alice", markdown_body: "# Alice\n\nv1" });
  await putPage(s, { slug: "people/alice", type: "person", title: "Alice", markdown_body: "# Alice\n\nv2 [[people/bob]]" });
  await putPage(s, { slug: "people/bob", type: "person", title: "Bob", markdown_body: "# Bob" });
  await putPage(s, { slug: "notes/b", type: "note", markdown_body: "tenant B", source_id: "team-b" });
  await addLink(s, { source_slug: "people/alice", target_slug: "people/bob", type: "knows" });
  await addTimelineEvent(s, { slug: "people/alice", occurred_at: "2026-03-04T05:06:07.891Z", event: "joined" });
  await addTag(s, "people/alice", "team");

  const live = await addFact(s, { entity_slug: "people/alice", fact: "Works remotely" });
  liveFactId = Number(live.id);
  const doomed = await addFact(s, { entity_slug: "people/alice", fact: "Lives in the old town" });
  forgottenFactId = Number(doomed.id);
  await forgetFact(s, forgottenFactId, { reason: "moved" });
  // A live copy of a withdrawn claim, as a pre-withdrawal re-assertion left it.
  // The insert trigger would flip it on any normal insert, so bypass it here.
  await e.transaction(async (tx) => {
    await tx.query("SET LOCAL session_replication_role = replica");
    await tx.query(
      `INSERT INTO entity_facts (entity_slug, fact, source_id, visibility, written_by)
       SELECT entity_slug, fact, source_id, visibility, written_by FROM entity_facts WHERE id = $1`,
      [forgottenFactId],
    );
  });

  await e.query(
    `INSERT INTO documents (id, source_path, title, frontmatter)
     VALUES ('doc-obj', '/x/obj.md', 'Obj', '{"a":{"b":[1,2,{"c":"d"}]},"n":null}'::jsonb),
            ('doc-str', '/x/str.md', NULL, '"just a string"'::jsonb)`,
  );
  await e.query(
    `INSERT INTO chunks (id, document_id, chunk_index, content, parent_symbol_path)
     VALUES ('chunk-1', 'doc-obj', 0, 'alpha beta gamma', ARRAY['Outer', 'in ner', NULL]::text[])`,
  );
  const vec = Array.from({ length: 1024 }, (_, i) => ((i * 7919) % 1000) / 997 - 0.5);
  await e.query(
    "INSERT INTO embeddings (chunk_id, vector, model) VALUES ('chunk-1', $1::vector, 'titan-v2')",
    [`[${vec.join(",")}]`],
  );
  // Identity-always table: explicit ids need OVERRIDING SYSTEM VALUE on copy.
  await e.query(
    `INSERT INTO raw_data (slug, source, data)
     VALUES ('people/alice', 'crm', '{"k":1}'::jsonb), ('people/bob', 'crm', '[]'::jsonb)`,
  );
  await e.query(
    `INSERT INTO oauth_clients (client_id, client_name, token_endpoint_auth_method, client_secret_hash)
     VALUES ('pub-1', 'Public', 'none', NULL)`,
  );
}

async function catalogCount(s: Storage): Promise<number> {
  return (await readCatalog(s.engine())).size;
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-engine-copy-"));
  src = await open("src");
  mid = await open("mid");
  end = await open("end");
  await seed(src);
});

afterAll(async () => {
  await src.close();
  await mid.close();
  await end.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("readCatalog / planCopy", () => {
  it("sees the tables the old hardcoded plan skipped, and marks chunks.ts generated", async () => {
    const cat = await readCatalog(src.engine());
    for (const t of [
      "pages", "page_versions", "entity_facts", "fact_withdrawals", "links",
      "timeline_events", "tags", "oauth_clients", "oauth_tokens", "sources",
    ]) {
      expect(cat.has(t)).toBe(true);
    }
    const ts = cat.get("chunks")!.columns.find((c) => c.name === "ts")!;
    expect(ts.generated).toBe(true);
    // tags has no primary key; its NOT NULL unique key stands in.
    expect(cat.get("tags")!.key).toEqual(["slug", "tag", "source_id"]);
  });

  it("orders FK parents first, breaking ties by name", () => {
    const edges = new Map([["c", ["b"]], ["b", ["a"]], ["a", []], ["z", []], ["y", []]]);
    expect(topoOrder(["c", "z", "b", "a", "y"], edges)).toEqual(["a", "b", "c", "y", "z"]);
    // A cycle and a self-reference do not stall the order.
    const cyc = new Map([["p", ["q", "p"]], ["q", ["p"]], ["m", []]]);
    expect(topoOrder(["q", "p", "m"], cyc)).toEqual(["m", "p", "q"]);
  });

  it("puts sources before pages before page_versions and links on the real schema", async () => {
    const cat = await readCatalog(src.engine());
    const order = planCopy(cat, cat).tables.map((t) => t.name);
    const at = (n: string) => order.indexOf(n);
    expect(at("sources")).toBeLessThan(at("pages"));
    expect(at("pages")).toBeLessThan(at("page_versions"));
    expect(at("pages")).toBeLessThan(at("links"));
  });

  it("copies the column intersection and reports what the destination lacks", () => {
    const table = (cols: string[], extra: Partial<TableInfo> = {}): TableInfo => ({
      name: "t",
      columns: cols.map((name) => ({
        name,
        type: "text",
        generated: name === "g",
        identityAlways: false,
        hasSequence: false,
      })),
      key: ["id"],
      references: [],
      ...extra,
    });
    const s: Catalog = new Map([["t", table(["id", "a", "b", "g"])], ["only_src", table(["id"])]]);
    const d: Catalog = new Map([["t", table(["id", "a", "g"])]]);
    const plan = planCopy(s, d);
    expect(plan.tables.map((t) => t.name)).toEqual(["t"]);
    expect(plan.tables[0]!.columns.map((c) => c.name)).toEqual(["id", "a"]);
    expect(plan.tables[0]!.sourceOnlyColumns).toEqual(["b"]);
    expect(plan.missing).toEqual([{ name: "only_src", side: "destination" }]);
    expect(planCopy(s, d, ["t"]).missing).toEqual([]);
    expect(() => planCopy(s, d, ["nope"])).toThrow(/unknown table/);
  });
});

describe("copyEngine round trip", () => {
  it("an interrupted copy (a subset first) converges on the full run", async () => {
    // Withdrawals land before the facts they match: a live insert would be
    // flipped by trigger 112 if triggers ran during the copy.
    const partial = await copyEngine(src.engine(), mid.engine(), {
      tables: ["fact_withdrawals", "sources"],
    });
    expect(partial.ok).toBe(true);
    expect(partial.tables.map((t) => t.name).sort()).toEqual(["fact_withdrawals", "sources"]);

    const full = await copyEngine(src.engine(), mid.engine(), { batchSize: 2 });
    expect(full.failures).toEqual([]);
    expect(full.ok).toBe(true);
  });

  it("keeps every table's count and hash across src -> mid -> end", async () => {
    const hop2 = await copyEngine(mid.engine(), end.engine());
    expect(hop2.ok).toBe(true);
    const total = await catalogCount(src);
    expect(hop2.tables.length).toBe(total);

    const direct = await copyEngine(src.engine(), end.engine(), { verifyOnly: true });
    expect(direct.ok).toBe(true);
    expect(direct.verifyOnly).toBe(true);
    expect(direct.tables.length).toBe(total);
    for (const t of direct.tables) {
      expect({ name: t.name, match: t.match }).toEqual({ name: t.name, match: true });
    }
    const byName = new Map(direct.tables.map((t) => [t.name, t]));
    for (const t of ["pages", "page_versions", "links", "entity_facts", "fact_withdrawals", "tags",
      "timeline_events", "embeddings", "chunks", "oauth_clients", "sources"]) {
      expect(byName.get(t)!.src).toBeGreaterThan(0);
    }
  });

  it("preserves fact tombstones and does not flip the live copy of a withdrawn claim", async () => {
    const q = `SELECT id::text AS id, forgotten_at::text AS f, forgotten_cause AS c
                 FROM entity_facts ORDER BY id`;
    const a = (await src.engine().query(q)).rows;
    const b = (await end.engine().query(q)).rows;
    expect(b).toEqual(a);
    const live = (await end.engine().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM entity_facts
        WHERE fact = 'Lives in the old town' AND forgotten_at IS NULL`,
    )).rows[0]!.n;
    expect(live).toBe(1);
    const tomb = (await end.engine().query<{ c: string }>(
      "SELECT forgotten_cause AS c FROM entity_facts WHERE id = $1",
      [forgottenFactId],
    )).rows[0]!;
    expect(tomb.c).toBe("forget");
  });

  it("round-trips jsonb, vectors, arrays, tsvector and timestamps exactly", async () => {
    const q = `SELECT d.frontmatter::text AS fm, c.parent_symbol_path::text AS psp,
                      c.search_vector::text AS sv, c.ts::text AS ts, e.vector::text AS v
                 FROM documents d LEFT JOIN chunks c ON c.document_id = d.id
                 LEFT JOIN embeddings e ON e.chunk_id = c.id ORDER BY d.id`;
    const a = (await src.engine().query(q)).rows;
    const b = (await end.engine().query(q)).rows;
    expect(b).toEqual(a);
    const scalar = (await end.engine().query<{ t: string }>(
      "SELECT jsonb_typeof(frontmatter) AS t FROM documents WHERE id = 'doc-str'",
    )).rows[0]!;
    expect(scalar.t).toBe("string");
    const tq = "SELECT occurred_at::text AS o FROM timeline_events ORDER BY 1";
    expect((await end.engine().query(tq)).rows).toEqual((await src.engine().query(tq)).rows);
  });

  it("makes the destination's seeded default source equal to the source's", async () => {
    const row = (await end.engine().query<{ d: string }>(
      "SELECT description AS d FROM sources WHERE id = 'default'",
    )).rows[0]!;
    expect(row.d).toBe("operator brain");
  });

  it("is idempotent on a re-run", async () => {
    const again = await copyEngine(mid.engine(), end.engine());
    expect(again.ok).toBe(true);
    const tagCount = again.tables.find((t) => t.name === "tags")!;
    expect(tagCount.dst).toBe(tagCount.src);
  });

  it("advances sequences so a new insert on the destination does not collide", async () => {
    const r = await addFact(end, { entity_slug: "people/bob", fact: "Plays chess" });
    expect(Number(r.id)).toBeGreaterThan(liveFactId);
    const raw = await end.engine().query<{ id: string }>(
      "INSERT INTO raw_data (slug, source, data) VALUES ('people/bob', 'test', '{}'::jsonb) RETURNING id::text AS id",
    );
    expect(Number(raw.rows[0]!.id)).toBeGreaterThan(2);
    // Undo so the later mutation test isolates exactly one table.
    await end.engine().query("DELETE FROM entity_facts WHERE fact = 'Plays chess'");
    await end.engine().query("DELETE FROM raw_data WHERE source = 'test'");
  });

  it("reports exactly the mutated table as a mismatch and fails the run", async () => {
    await end.engine().query("UPDATE pages SET title = 'Alicia' WHERE slug = 'people/alice'");
    const r = await copyEngine(src.engine(), end.engine(), { verifyOnly: true });
    expect(r.ok).toBe(false);
    expect(r.tables.filter((t) => !t.match).map((t) => t.name)).toEqual(["pages"]);
    const pages = r.tables.find((t) => t.name === "pages")!;
    expect(pages.src).toBe(pages.dst);
    expect(r.failures.map((f) => f.table)).toEqual(["pages"]);
  });
});

describe("source fidelity", () => {
  it("reads the source through one read-only repeatable-read transaction", async () => {
    const s = await open("snap-src");
    const d = await open("snap-dst");
    try {
      await putPage(s, { slug: "notes/snap", type: "note", markdown_body: "snap" });
      const real = s.engine();
      let transactions = 0;
      const statements: string[] = [];
      const counted: Engine = {
        kind: real.kind,
        ready: () => real.ready(),
        query: <U>(sql: string, params?: unknown[]) => real.query<U>(sql, params),
        exec: (sql: string) => real.exec(sql),
        close: async () => {},
        transaction: <U>(fn: (tx: Engine) => Promise<U>) => {
          transactions++;
          return real.transaction((tx) => fn({
            kind: tx.kind,
            ready: () => tx.ready(),
            exec: (sql: string) => tx.exec(sql),
            close: () => tx.close(),
            transaction: (inner) => tx.transaction(inner),
            query: <V>(sql: string, params?: unknown[]) => {
              statements.push(sql);
              return tx.query<V>(sql, params);
            },
          }));
        },
      };
      const r = await copyEngine(counted, d.engine(), { batchSize: 1 });
      expect(r.ok).toBe(true);
      expect(transactions).toBe(1);
      expect(statements[0]).toBe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
      expect(statements.length).toBeGreaterThan(10);
    } finally {
      await s.close();
      await d.close();
    }
  });

  it("does not reissue an id the source handed out and then deleted", async () => {
    const s = await open("seq-src");
    const d = await open("seq-dst");
    try {
      const ids = (await s.engine().query<{ id: string }>(
        `INSERT INTO raw_data (slug, source, data)
         VALUES ('a', 'crm', '{}'::jsonb), ('b', 'crm', '{}'::jsonb), ('c', 'crm', '{}'::jsonb)
         RETURNING id::text AS id`,
      )).rows.map((r) => Number(r.id));
      const top = Math.max(...ids);
      await s.engine().query("DELETE FROM raw_data WHERE id = $1", [top]);

      const r = await copyEngine(s.engine(), d.engine(), { tables: ["raw_data"] });
      expect(r.ok).toBe(true);
      const next = await d.engine().query<{ id: string }>(
        "INSERT INTO raw_data (slug, source, data) VALUES ('d', 'crm', '{}'::jsonb) RETURNING id::text AS id",
      );
      expect(Number(next.rows[0]!.id)).toBeGreaterThan(top);
    } finally {
      await s.close();
      await d.close();
    }
  });

  it("does not wind the destination's sequence back below ids it already handed out", async () => {
    const s = await open("seqback-src");
    const d = await open("seqback-dst");
    try {
      await s.engine().query(
        `INSERT INTO raw_data (slug, source, data)
         VALUES ('a', 'crm', '{}'::jsonb), ('b', 'crm', '{}'::jsonb)`,
      );
      // The destination handed out four ids and then purged every row — its
      // sequence is ahead of anything the copy can see in the table.
      const purged = (await d.engine().query<{ id: string }>(
        `INSERT INTO raw_data (slug, source, data)
         VALUES ('p1', 'crm', '{}'::jsonb), ('p2', 'crm', '{}'::jsonb),
                ('p3', 'crm', '{}'::jsonb), ('p4', 'crm', '{}'::jsonb)
         RETURNING id::text AS id`,
      )).rows.map((r) => Number(r.id));
      await d.engine().query("DELETE FROM raw_data");
      const top = Math.max(...purged);

      const r = await copyEngine(s.engine(), d.engine(), { tables: ["raw_data"] });
      expect(r.ok).toBe(true);
      const next = await d.engine().query<{ id: string }>(
        "INSERT INTO raw_data (slug, source, data) VALUES ('e', 'crm', '{}'::jsonb) RETURNING id::text AS id",
      );
      expect(Number(next.rows[0]!.id)).toBeGreaterThan(top);
    } finally {
      await s.close();
      await d.close();
    }
  });

  it("copies a column the source computes and the destination stores plainly", async () => {
    const s = await open("gen-src");
    const d = await open("gen-dst");
    try {
      await putPage(s, { slug: "notes/g", type: "note", markdown_body: "g" });
      await addTag(s, "notes/g", "kept");
      await s.engine().query(
        "ALTER TABLE tags ADD COLUMN label text GENERATED ALWAYS AS (slug || ':' || tag) STORED",
      );
      await d.engine().query("ALTER TABLE tags ADD COLUMN label text");

      const r = await copyEngine(s.engine(), d.engine(), { tables: ["tags"] });
      expect(r.ok).toBe(true);
      expect(r.tables[0]!.sourceOnlyColumns).toBeUndefined();
      const labels = async (st: Storage) =>
        (await st.engine().query<{ label: string | null }>("SELECT label FROM tags ORDER BY tag")).rows;
      expect(await labels(d)).toEqual(await labels(s));
      expect(await labels(d)).toEqual([{ label: "notes/g:kept" }]);
    } finally {
      await s.close();
      await d.close();
    }
  });

  it("fails a dry run on a table the destination lacks, but not on a count difference", async () => {
    const s = await open("dry-src");
    const d = await open("dry-dst");
    try {
      await putPage(s, { slug: "notes/d", type: "note", markdown_body: "d" });
      const lagging = await copyEngine(s.engine(), d.engine(), { tables: ["pages"], dryRun: true });
      expect(lagging.ok).toBe(true);
      expect(lagging.tables[0]!.match).toBe(false);

      await d.engine().query("ALTER TABLE tags RENAME TO tags_hidden");
      const missing = await copyEngine(s.engine(), d.engine(), { tables: ["tags"], dryRun: true });
      expect(missing.ok).toBe(false);
      expect(missing.missing).toEqual([{ name: "tags", side: "destination" }]);
    } finally {
      await s.close();
      await d.close();
    }
  });

  it("fails on a source column the destination lacks unless dropping is allowed", async () => {
    const s = await open("drop-src");
    const d = await open("drop-dst");
    try {
      await putPage(s, { slug: "notes/t", type: "note", markdown_body: "t" });
      await addTag(s, "notes/t", "kept");
      await s.engine().query("ALTER TABLE tags ADD COLUMN note text");
      await s.engine().query("UPDATE tags SET note = 'lost on copy'");

      const strict = await copyEngine(s.engine(), d.engine(), { tables: ["tags"] });
      expect(strict.ok).toBe(false);
      expect(strict.failures).toEqual([
        { table: "tags", error: "source-only columns not copied: note" },
      ]);
      expect(strict.tables[0]!.sourceOnlyColumns).toEqual(["note"]);

      const lax = await copyEngine(s.engine(), d.engine(), {
        tables: ["tags"],
        allowDroppedColumns: true,
      });
      expect(lax.ok).toBe(true);

      const preview = await copyEngine(s.engine(), d.engine(), { tables: ["tags"], dryRun: true });
      expect(preview.ok).toBe(false);
      expect(preview.failures).toEqual(strict.failures);
    } finally {
      await s.close();
      await d.close();
    }
  });
});

describe("runMigrateEngine", () => {
  it("copies pglite -> pglite by path and returns a failing summary on mismatch", async () => {
    const a = join(tmp, "cli-a");
    const b = join(tmp, "cli-b");
    const sa = await open("cli-a");
    await putPage(sa, { slug: "notes/x", type: "note", markdown_body: "x" });
    await sa.close();

    const ok = await runMigrateEngine({ from: "pglite", to: "pglite", pgliteDbPath: a, toPgliteDbPath: b });
    expect(ok.ok).toBe(true);

    const sb = await open("cli-b");
    await sb.engine().query("DELETE FROM tags");
    await sb.engine().query("UPDATE pages SET title = 'changed' WHERE slug = 'notes/x'");
    await sb.close();
    const bad = await runMigrateEngine({
      from: "pglite", to: "pglite", pgliteDbPath: a, toPgliteDbPath: b, verifyOnly: true,
    });
    expect(bad.ok).toBe(false);
    // Four PGLite instances, each running every migration: past the amd64
    // gate's 5s per-test budget on a cold runner.
  }, 30000);

  it("refuses a source whose schema is behind the binary, in every mode", async () => {
    const a = join(tmp, "behind-a");
    const b = join(tmp, "behind-b");
    const sa = await open("behind-a");
    await sa.engine().query("DELETE FROM migrations WHERE id = (SELECT MAX(id) FROM migrations)");
    await sa.close();
    for (const mode of [{}, { dryRun: true }, { verifyOnly: true }]) {
      const run = runMigrateEngine({ from: "pglite", to: "pglite", pgliteDbPath: a, toPgliteDbPath: b, ...mode });
      await expect(run).rejects.toThrow(/source schema is behind this binary .*apply-migrations/);
    }
  }, 30000);

  it("refuses the same database as source and destination", () => {
    expect(() => resolveEndpoints({ from: "pglite", to: "pglite", pgliteDbPath: "/tmp/x", toPgliteDbPath: "/tmp/../tmp/x" }))
      .toThrow(/same database/);
    expect(() => resolveEndpoints({ from: "pglite", to: "pglite", pgliteDbPath: "/tmp/x" }))
      .toThrow(/--to-pglite-path required/);
    expect(() => resolveEndpoints({ from: "postgres", to: "postgres" }, { MEMRAIN_POSTGRES_URL: "postgres://h/db" }))
      .toThrow(/must differ/);
    const ep = resolveEndpoints({ from: "postgres", to: "pglite", pgliteDbPath: "/tmp/y" }, { MEMRAIN_POSTGRES_URL: "postgres://h/db" });
    expect(ep.dst).toEqual({ kind: "pglite", path: "/tmp/y" });
  });

  it("copies a pooled tenant over its direct URL, never through the pooler", () => {
    const pooled = { MEMRAIN_POSTGRES_URL: "postgres://u:p@pgbouncer-t1:6432/db", MEMRAIN_PG_POOLER: "pgbouncer" };
    const direct = "postgres://u:p@rds/db";
    expect(resolveEndpoints({ from: "pglite", to: "postgres", pgliteDbPath: "/tmp/y" }, { ...pooled, MEMRAIN_POSTGRES_DIRECT_URL: direct }).dst)
      .toEqual({ kind: "postgres", url: direct });
    expect(resolveEndpoints({ from: "postgres", to: "pglite", pgliteDbPath: "/tmp/y" }, { ...pooled, MEMRAIN_POSTGRES_DIRECT_URL: direct }).src)
      .toEqual({ kind: "postgres", url: direct });
    expect(() => resolveEndpoints({ from: "pglite", to: "postgres", pgliteDbPath: "/tmp/y" }, pooled))
      .toThrow(/MEMRAIN_POSTGRES_DIRECT_URL/);
    expect(resolveEndpoints({ from: "pglite", to: "postgres", pgliteDbPath: "/tmp/y", postgresUrl: direct }, pooled).dst)
      .toEqual({ kind: "postgres", url: direct });
  });
});
