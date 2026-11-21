/**
 * embed-stale re-reads a document's file through the MARKDOWN indexer. A code
 * document with an old vector must never be picked: re-read that way, it would
 * come back as prose, its symbols and `kind: code` gone.
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { registerSource } from "../src/core/sources.ts";
import { embedStalePhase } from "../src/core/cycle/embed-stale.ts";

const ZERO_VEC = JSON.stringify(Array.from({ length: 1024 }).fill(0));

let tmp: string;
let root: string;
let storage: Storage;
let saved: string | undefined;

beforeEach(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "memrain-stale-code-")));
  root = join(tmp, "vault");
  mkdirSync(root, { recursive: true });
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  saved = process.env.MEMRAIN_VAULT_PATHS;
  process.env.MEMRAIN_VAULT_PATHS = root;
});

afterEach(async () => {
  if (saved === undefined) delete process.env.MEMRAIN_VAULT_PATHS;
  else process.env.MEMRAIN_VAULT_PATHS = saved;
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** A locally indexed document whose only vector is 90 days old. */
async function oldDoc(sourcePath: string, frontmatter: Record<string, unknown>) {
  const id = `doc_${createHash("sha256").update(sourcePath).digest("hex").slice(0, 16)}`;
  const e = storage.engine();
  await e.query(
    `INSERT INTO documents (id, source_id, source_path, title, frontmatter, last_indexed_mtime)
     VALUES ($1, NULL, $2, NULL, $3::jsonb, 1)`,
    [id, sourcePath, JSON.stringify(frontmatter)],
  );
  await e.query(`INSERT INTO chunks (id, document_id, chunk_index, content) VALUES ($1, $2, 0, 'placeholder')`, [`${id}c0`, id]);
  await e.query(
    `INSERT INTO embeddings (chunk_id, vector, model, created_at) VALUES ($1, $2::vector, 'test', NOW() - interval '90 days')`,
    [`${id}c0`, ZERO_VEC],
  );
  return id;
}

describe("embed-stale phase and code documents", () => {
  // Value: protects=a code document keeps its symbols and kind when its vectors age;
  // fails_when=findStale stops excluding kind=code; why_new=code chunks only now carry vectors,
  // so they only now reach this phase; seam=none
  it("leaves a code document with an old vector alone while refreshing a note", async () => {
    await registerSource(storage.engine(), { id: "local", kind: "vault", pathPrefix: root });
    // Both files carry embed_skip so a markdown re-index never reaches Titan.
    const codePath = join(root, "tool.ts");
    writeFileSync(codePath, "---\nembed_skip: true\n---\n\nexport function tool() { return 1; }\n");
    const notePath = join(root, "note.md");
    writeFileSync(notePath, "---\nembed_skip: true\n---\n\n# refreshed note\n");
    const codeId = await oldDoc(codePath, { kind: "code", language: "typescript" });
    await oldDoc(notePath, {});

    const r = await embedStalePhase(storage.engine(), { staleDays: 30 });
    expect(r.errors).toEqual([]);
    expect(r.reembedded).toBe(1);

    const { rows } = await storage.engine().query<{ kind: string | null; content: string }>(
      `SELECT d.frontmatter->>'kind' AS kind, c.content FROM documents d JOIN chunks c ON c.document_id = d.id WHERE d.id = $1`,
      [codeId],
    );
    expect(rows).toEqual([{ kind: "code", content: "placeholder" }]);
  });
});
