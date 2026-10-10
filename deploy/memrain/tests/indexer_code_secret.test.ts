/**
 * Code indexing runs the secret scanner before the parse: a key committed to
 * a repository never reaches a chunk, and redacting a multi-line key block
 * keeps every later symbol on its real line. `MEMRAIN_CODE_SECRET_SCAN=0`
 * turns the scan off.
 *
 * Fixture credentials are assembled at run time so no literal credential
 * shape sits in the repository.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { indexCodeDocument } from "../src/core/indexer-code.ts";
import { _resetParsersForTests } from "../src/core/chunkers/parsers.ts";

const TOKEN = ["gh", "p_"].join("") + "A1b2C3d4".repeat(4) + "Zz9Y";
const PEM_BODY = "MIIEpAIBAAKCAQEAcodefixture";
const PEM = [`-----BEGIN ${"RSA "}PRIVATE KEY-----`, PEM_BODY, "abcdefgh", "-----END RSA PRIVATE KEY-----"].join("\n");

const SOURCE = [
  "export function key() {", // line 1
  `  return \`${PEM}\`;`, // lines 2-5
  "}",
  "",
  "export function deploy() {", // line 8
  `  return "${TOKEN}";`,
  "}",
  "",
  "export function after() {", // line 12
  "  return 2;",
  "}",
  "",
].join("\n");

let tmp: string;
let storage: Storage;
const saved = process.env.MEMRAIN_CODE_SECRET_SCAN;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-code-secret-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  if (saved === undefined) delete process.env.MEMRAIN_CODE_SECRET_SCAN;
  else process.env.MEMRAIN_CODE_SECRET_SCAN = saved;
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
  _resetParsersForTests();
});

async function chunksOf(documentId: string) {
  const r = await storage.raw().query<{ content: string; symbol_name: string | null; start_line: number; end_line: number }>(
    `SELECT content, symbol_name, start_line, end_line FROM chunks WHERE document_id = $1 ORDER BY chunk_index`,
    [documentId],
  );
  return r.rows;
}

describe("indexCodeDocument secret scan", () => {
  it("redacts keys and tokens and keeps symbol line numbers", async () => {
    const r = await indexCodeDocument(storage, { sourcePath: "src/keys.ts", text: SOURCE });
    const rows = await chunksOf(r.documentId);
    const all = rows.map((c) => c.content).join("\n");
    expect(all).not.toContain(PEM_BODY);
    expect(all).not.toContain(TOKEN);
    expect(all).toContain("[REDACTED:private-key:");
    expect(all).toContain("[REDACTED:github-token:");
    const deploy = rows.find((c) => c.symbol_name === "deploy");
    const after = rows.find((c) => c.symbol_name === "after");
    const key = rows.find((c) => c.symbol_name === "key");
    expect(key?.start_line).toBe(1);
    expect(key?.end_line).toBe(6);
    expect(deploy?.start_line).toBe(8);
    expect(deploy?.end_line).toBe(10);
    expect(after?.start_line).toBe(12);
    expect(after?.end_line).toBe(14);

    const audit = await storage.raw().query<{ summary: string; source_ref: string }>(
      `SELECT summary, source_ref FROM ingest_log WHERE source_type = 'secret-redacted'`,
    );
    expect(audit.rows.length).toBe(1);
    expect(audit.rows[0]!.source_ref).toBe("src/keys.ts");
    expect(audit.rows[0]!.summary).not.toContain(TOKEN);
  });

  it("indexes the text as it is when MEMRAIN_CODE_SECRET_SCAN=0", async () => {
    process.env.MEMRAIN_CODE_SECRET_SCAN = "0";
    const r = await indexCodeDocument(storage, { sourcePath: "src/keys.ts", text: SOURCE });
    const all = (await chunksOf(r.documentId)).map((c) => c.content).join("\n");
    expect(all).toContain(TOKEN);
  });
});
