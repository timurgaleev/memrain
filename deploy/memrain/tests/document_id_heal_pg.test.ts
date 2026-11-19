/**
 * The document-id fold and the drift check on a real Postgres: the row locks,
 * the COALESCE'd insert owner and sha256/convert_to all have to hold there too.
 * Skipped unless MEMRAIN_TEST_POSTGRES_URL points at a scratch database.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PostgresEngine } from "../src/core/engine/postgres.ts";
import { pgTestEngine } from "./helpers/pg-test-engine.ts";
import { Storage } from "../src/core/storage.ts";
import { registerSource } from "../src/core/sources.ts";
import { indexFile } from "../src/core/indexer.ts";
import { checkDocumentIdDrift } from "../src/core/doctor-tenancy.ts";

const URL_ = process.env.MEMRAIN_TEST_POSTGRES_URL;
const idFor = (p: string) => `doc_${createHash("sha256").update(p).digest("hex").slice(0, 16)}`;

describe.skipIf(!URL_)("document id fold on Postgres", () => {
  let pg: PostgresEngine;
  let storage: Storage;
  let tmp: string;
  let savedVault: string | undefined;

  beforeAll(async () => {
    pg = pgTestEngine({ url: URL_! });
    storage = new Storage(pg);
    await storage.init();
    await registerSource(pg, { id: "timur", kind: "other", pathPrefix: "tenant:timur" }).catch(() => {});
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "memrain-id-heal-pg-")));
    mkdirSync(join(tmp, "memory"), { recursive: true });
    savedVault = process.env.MEMRAIN_VAULT_PATHS;
    process.env.MEMRAIN_VAULT_PATHS = join(tmp, "memory");
  });

  afterAll(async () => {
    if (savedVault === undefined) delete process.env.MEMRAIN_VAULT_PATHS;
    else process.env.MEMRAIN_VAULT_PATHS = savedVault;
    rmSync(tmp, { recursive: true, force: true });
    await pg.close();
  });

  it("adopts a NULL-owned twin under the legacy owner and the drift check sees it go", async () => {
    const path = join(tmp, "memory", `n-${randomBytes(4).toString("hex")}.md`);
    writeFileSync(path, "---\nembed_skip: true\n---\n\n# pg note\n");
    const legacy = idFor(`${path}.legacy`);
    const canonical = idFor(path);
    await pg.query(
      `INSERT INTO documents (id, source_id, source_path, frontmatter, last_indexed_mtime) VALUES
         ($1, 'timur', $3, '{}'::jsonb, 1),
         ($2, NULL,    $3, '{}'::jsonb, 1)`,
      [legacy, canonical, path],
    );
    await pg.query(
      `INSERT INTO chunks (id, document_id, chunk_index, content, source_id) VALUES ($1, $2, 0, 'old', 'timur')`,
      [`${legacy}_c0`, legacy],
    );
    await pg.query(
      `INSERT INTO entity_facts (entity_slug, fact, source_chunk_id, source_id)
       VALUES ('people/pg-heal', $2, $1, 'timur')`,
      [`${legacy}_c0`, `fact ${legacy}`],
    );
    const drift = await checkDocumentIdDrift(pg);
    expect(drift.status).toBe("warn");

    await indexFile(storage, path);

    const rows = await pg.query<{ id: string; source_id: string | null }>(
      "SELECT id, source_id FROM documents WHERE source_path = $1",
      [path],
    );
    expect(rows.rows).toEqual([{ id: canonical, source_id: "timur" }]);
    const fact = await pg.query<{ source_chunk_id: string }>(
      "SELECT source_chunk_id FROM entity_facts WHERE fact = $1",
      [`fact ${legacy}`],
    );
    expect(fact.rows[0]!.source_chunk_id).toBe(`${canonical}_c0`);
    const left = await pg.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM documents
        WHERE source_path = $1
          AND id <> 'doc_' || left(encode(sha256(convert_to(source_path, 'UTF8')), 'hex'), 16)`,
      [path],
    );
    expect(left.rows[0]!.n).toBe(0);
  });

  it("carries lifecycle state and synthesis provenance onto the new id", async () => {
    const path = join(tmp, "memory", `s-${randomBytes(4).toString("hex")}.md`);
    writeFileSync(path, "---\nembed_skip: true\n---\n\n# pg synth\n");
    const legacy = idFor(`${path}.legacy`);
    const canonical = idFor(path);
    const tag = randomBytes(4).toString("hex");
    await pg.query(
      `INSERT INTO documents (id, source_id, source_path, frontmatter, last_indexed_mtime, deleted_at, archived, archived_at)
       VALUES ($1, 'timur', $2, '{}'::jsonb, 1, '2026-09-01T00:00:00Z', true, '2026-09-02T00:00:00Z')`,
      [legacy, path],
    );
    await pg.query(
      `INSERT INTO synth_atoms (atom_key, source_ref, source_kind, source_hash, title, body, model_id)
       VALUES ($2, $1, 'document', 'h', 't', 'b', 'm')`,
      [legacy, `ak-${tag}`],
    );
    await pg.query(
      `INSERT INTO synth_takes (take_key, source_ref, source_hash, prompt_version, claim_text, model_id)
       VALUES ($2, $1, 'h', 'v1', 'c', 'm')`,
      [legacy, `tk-${tag}`],
    );

    await indexFile(storage, path);

    const doc = await pg.query<{ id: string; deleted: boolean; archived: boolean; at: boolean }>(
      `SELECT id, deleted_at = '2026-09-01T00:00:00Z' AS deleted, archived,
              archived_at = '2026-09-02T00:00:00Z' AS at
         FROM documents WHERE source_path = $1`,
      [path],
    );
    expect(doc.rows).toEqual([{ id: canonical, deleted: true, archived: true, at: true }]);
    const atom = await pg.query<{ source_ref: string }>("SELECT source_ref FROM synth_atoms WHERE atom_key = $1", [`ak-${tag}`]);
    const take = await pg.query<{ source_ref: string }>("SELECT source_ref FROM synth_takes WHERE take_key = $1", [`tk-${tag}`]);
    expect(atom.rows[0]!.source_ref).toBe(canonical);
    expect(take.rows[0]!.source_ref).toBe(canonical);
  });
});
