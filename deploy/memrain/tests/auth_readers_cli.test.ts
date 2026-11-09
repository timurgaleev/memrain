import { afterAll, beforeAll, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { registerSource } from "../src/core/sources.ts";
const dir = mkdtempSync(join(tmpdir(), "readers-cli-"));
const config = join(dir, "config.json");
const path = join(dir, "brain");
beforeAll(async () => {
  writeFileSync(config, JSON.stringify({ embedding: { provider: "bedrock-titan", model: "amazon.titan-embed-text-v2:0", region: "eu-west-1" }, storage: {}, database: { type: "pglite", path } }));
  const s = new Storage({ dbPath: path }); await s.init();
  try {
    for (const id of ["a", "b"]) {
      await registerSource(s.engine(), { id, kind: "other", pathPrefix: `tenant:${id}` });
      await s.engine().query("INSERT INTO access_tokens (name, token_hash, scopes, permissions) VALUES ($1, $2, $3, $4::text::jsonb)",
        [id, createHash("sha256").update(`fixture-${id}`).digest("hex"), ["read"], JSON.stringify({ source_id: id })]);
    }
    await putPage(s, { slug: "notes/private", type: "note", source_id: "a", markdown_body: "PRIVATE-CONTENT-DO-NOT-PRINT" });
  } finally { await s.close(); }
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
it("auth who-can-read reports actual source access without reading effects or content", async () => {
  const child = Bun.spawnSync([process.execPath, "src/cli.ts", "auth", "who-can-read", "notes/private"], {
    cwd: join(import.meta.dir, ".."), env: { ...process.env, MEMRAIN_CONFIG_PATH: config, MEMRAIN_REQUIRE_POSTGRES: "0" }, stdout: "pipe", stderr: "pipe",
  });
  expect(child.exitCode).toBe(0);
  const output = new TextDecoder().decode(child.stdout);
  const report = JSON.parse(output);
  expect(report.truncated).toBe(false);
  expect(report.readers).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "pat", name: "a", verdict: "readable", rule: "page_get_allowed" }),
    expect.objectContaining({ kind: "pat", name: "b", verdict: "denied", rule: "source_scope" }),
  ]));
  expect(output).not.toContain("PRIVATE-CONTENT");
  expect(output).not.toContain("token_hash");
  const s = new Storage({ dbPath: path }); await s.init();
  try {
    expect((await s.engine().query("SELECT last_used_at FROM access_tokens")).rows).toEqual([{ last_used_at: null }, { last_used_at: null }]);
    expect((await s.engine().query("SELECT last_retrieved_at FROM pages WHERE slug = 'notes/private'")).rows[0]).toEqual({ last_retrieved_at: null });
  } finally { await s.close(); }
});
