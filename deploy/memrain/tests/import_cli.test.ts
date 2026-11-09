import { afterAll, beforeAll, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Storage } from "../src/core/storage.ts";
const dir = mkdtempSync(join(tmpdir(), "import-cli-"));
const config = join(dir, "config.json");
const db = join(dir, "brain");
const input = join(dir, "export");
beforeAll(async () => {
  writeFileSync(config, JSON.stringify({ embedding: { provider: "bedrock-titan", model: "amazon.titan-embed-text-v2:0", region: "eu-west-1" }, storage: {}, database: { type: "pglite", path: db } }));
  mkdirSync(join(input, "notes"), { recursive: true });
  writeFileSync(join(input, "notes/new.md"), '---\ntitle: Imported\ntype: note\n---\n\nOriginal body\n');
  const s = new Storage({ dbPath: db }); await s.init(); await s.close();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
it("import previews by default and creates only with apply", async () => {
  const run = (args: string[]) => Bun.spawnSync([process.execPath, "src/cli.ts", "import", "--dir", input, "--source", "default", ...args], {
    cwd: join(import.meta.dir, ".."), env: { ...process.env, MEMRAIN_CONFIG_PATH: config, MEMRAIN_REQUIRE_POSTGRES: "0", MEMRAIN_FACTS_EXTRACTION: "1" }, stdout: "pipe", stderr: "pipe",
  });
  const preview = run([]);
  expect(preview.exitCode).toBe(0);
  expect(JSON.parse(new TextDecoder().decode(preview.stdout))).toMatchObject({ dry_run: true, created: 0, candidates: 1, facts_extraction: false });
  let s = new Storage({ dbPath: db }); await s.init();
  expect((await s.engine().query("SELECT slug FROM pages")).rows).toHaveLength(0); await s.close();
  const apply = run(["--apply"]);
  expect(apply.exitCode, new TextDecoder().decode(apply.stderr)).toBe(0);
  expect(JSON.parse(new TextDecoder().decode(apply.stdout))).toMatchObject({ dry_run: false, created: 1 });
  const again = run(["--apply"]);
  expect(again.exitCode).toBe(1);
  s = new Storage({ dbPath: db }); await s.init();
  expect((await s.engine().query("SELECT markdown_body FROM pages")).rows).toEqual([{ markdown_body: "Original body" }]);
  expect((await s.engine().query("SELECT id FROM entity_facts")).rows).toHaveLength(0);
  expect((await s.engine().query("SELECT slug FROM page_versions")).rows).toHaveLength(1);
  await s.close();
});
