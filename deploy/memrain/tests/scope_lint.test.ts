/**
 * scripts/scope-lint.ts is the static half of the isolation gate: an unscoped
 * read of a `source_id` table or a pooler-unsafe statement must fail `make audit`.
 * These tests pin what it detects, that its table list matches the real catalog
 * on both engines, and that the tree sits exactly at the committed baseline.
 */
import { describe, expect, it, setDefaultTimeout } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  countUnscoped,
  extractLiterals,
  findPoolerUnsafe,
  findUnscopedReads,
  sourceScopedTables,
} from "../../../scripts/scope-lint.ts";
import { storageEngines } from "./helpers/storage-engines.ts";

setDefaultTimeout(60000);

const TABLES = new Set(["pages", "entity_facts"]);

describe("scope-lint detection", () => {
  it("flags an unscoped read of a source_id table", () => {
    const src = "await engine.query(`SELECT slug FROM pages WHERE type = $1`, [t]);";
    expect(findUnscopedReads("x.ts", src, TABLES)).toEqual([{ file: "x.ts", line: 1 }]);
  });

  it("flags a JOIN onto a source_id table", () => {
    const src = "const q = `SELECT l.id FROM links_other l JOIN entity_facts f ON f.id = l.fact_id`;";
    expect(findUnscopedReads("x.ts", src, TABLES)).toHaveLength(1);
  });

  it("accepts a read that applies a source predicate or a scope helper", () => {
    const direct = "q(`SELECT slug FROM pages WHERE source_id = ANY($1::text[])`);";
    const helper = "q(`SELECT slug FROM pages WHERE deleted_at IS NULL${andSourceScope(\"source_id\", scope, params)}`);";
    expect(findUnscopedReads("x.ts", direct, TABLES)).toEqual([]);
    expect(findUnscopedReads("x.ts", helper, TABLES)).toEqual([]);
  });

  it("honours a marker with a reason on the three lines above", () => {
    const marked = "// scope: operator-only doctor runs as the operator\nq(`SELECT count(*) FROM pages`);";
    const bare = "// scope: operator-only\nq(`SELECT count(*) FROM pages`);";
    const far = "// scope: operator-only reason\n\n\n\nq(`SELECT count(*) FROM pages`);";
    expect(findUnscopedReads("x.ts", marked, TABLES)).toEqual([]);
    expect(findUnscopedReads("x.ts", bare, TABLES)).toHaveLength(1);
    expect(findUnscopedReads("x.ts", far, TABLES)).toHaveLength(1);
  });

  it("ignores writes, other tables and commented-out SQL", () => {
    const src = [
      "q(`UPDATE pages SET title = $1 WHERE slug = $2`);",
      "q(`SELECT 1 FROM jobs`);",
      "// q(`SELECT slug FROM pages`);",
      "/* q(`SELECT slug FROM pages`); */",
    ].join("\n");
    expect(findUnscopedReads("x.ts", src, TABLES)).toEqual([]);
  });

  it("reads template expressions and nested templates without losing line numbers", () => {
    const src = "const a = 1;\nq(`SELECT ${cols(`x`)}\n FROM pages`);\nconst s = 'FROM pages';";
    const lits = extractLiterals(src);
    expect(lits.find(l => l.text.includes("FROM pages") && l.text.includes("SELECT"))?.line).toBe(2);
    expect(findUnscopedReads("x.ts", src, TABLES)).toEqual([{ file: "x.ts", line: 2 }]);
  });
});

describe("scope-lint pooler safety", () => {
  it("flags session-level constructs", () => {
    for (const sql of [
      "q(`SELECT pg_advisory_lock(42)`)",
      "q(`SELECT pg_try_advisory_lock(1, 2)`)",
      "q(`SELECT pg_advisory_unlock(42)`)",
      "q(`SELECT pg_advisory_lock_shared(42)`)",
      "q(`LISTEN jobs_ready`)",
      "q(`UNLISTEN *`)",
      "q(`SET SESSION statement_timeout = 0`)",
      "q(`SET statement_timeout = 0`)",
      "q(`SET search_path TO evil`)",
      "q(`SELECT set_config('app.x', $1, false)`)",
    ]) {
      expect({ sql, hits: findPoolerUnsafe("x.ts", sql).length }).toEqual({ sql, hits: 1 });
    }
  });

  it("allows transaction-scoped forms", () => {
    for (const sql of [
      "q(`SELECT pg_advisory_xact_lock(42)`)",
      "q(`SELECT pg_try_advisory_xact_lock(42)`)",
      "q(`SET LOCAL statement_timeout = '5s'`)",
      "q(`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`)",
      "q(`SELECT set_config(name, value, true) FROM s`)",
      "q(`UPDATE pages SET title = $1`)",
      "hint(\"Set MEMRAIN_PUBLIC_URL to the external origin\")",
    ]) {
      expect({ sql, hits: findPoolerUnsafe("x.ts", sql).length }).toEqual({ sql, hits: 0 });
    }
  });
});

describe("scope-lint against the tree", () => {
  for (const engine of storageEngines(process.env["MEMRAIN_TEST_POSTGRES_URL"])) {
    it(`parses the same source_id tables the ${engine.name} catalog has`, async () => {
      const { storage, close } = await engine.open();
      try {
        const { rows } = await storage.engine().query<{ table_name: string }>(
          `SELECT c.table_name FROM information_schema.columns c
             JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
            WHERE c.table_schema = 'public' AND c.column_name = 'source_id' AND t.table_type = 'BASE TABLE'`,
        );
        expect([...sourceScopedTables()].sort()).toEqual(rows.map(r => r.table_name).sort());
      } finally {
        await close();
      }
    });
  }

  it("matches the committed baseline exactly and finds no pooler-unsafe statement", () => {
    const baseline = JSON.parse(readFileSync(join(import.meta.dir, "../../../scripts/scope-lint.baseline.json"), "utf8"));
    expect(countUnscoped(sourceScopedTables())).toEqual(baseline);
  });
});
