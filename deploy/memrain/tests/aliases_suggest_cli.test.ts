import { afterAll, beforeAll, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Storage } from "../src/core/storage.ts";
import { putPage, getPage } from "../src/core/pages.ts";
import { registerSource } from "../src/core/sources.ts";

const dir = mkdtempSync(join(tmpdir(), "memrain-aliases-cli-"));
const config = join(dir, "config.json");
const path = join(dir, "brain");
beforeAll(async () => {
  writeFileSync(config, JSON.stringify({ embedding: { provider: "bedrock-titan", model: "amazon.titan-embed-text-v2:0", region: "eu-west-1" }, storage: {}, database: { type: "pglite", path } }));
  const storage = new Storage({ dbPath: path });
  await storage.init();
  try {
    await registerSource(storage.engine(), { id: "other", kind: "other", pathPrefix: "/other" });
    await putPage(storage, { slug: "people/alex", type: "person", title: "Александр Петров", markdown_body: "Александр Петров, он же Саша Петров.\n<!-- Александр Петров aka Hidden Name. -->\nSomeone Else aka Wrong Alias." });
    await putPage(storage, { slug: "people/robert", type: "person", title: "Robert Smith", markdown_body: 'Robert Smith aka "Bob Smith".', compiled_truth: { aliases: ["Bob Smith"] } });
    await putPage(storage, { slug: "people/foreign", type: "person", title: "Jane Smith", markdown_body: "Jane Smith aka Jane Other.", source_id: "other" });
  } finally { await storage.close(); }
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
it("suggests only explicit undeclared aliases for the page subject, without writing", async () => {
  const p = Bun.spawnSync(["bun", "src/cli.ts", "aliases", "suggest", "--source", "default", "--json"], { cwd: join(import.meta.dir, ".."), env: { ...process.env, MEMRAIN_CONFIG_PATH: config, MEMRAIN_REQUIRE_POSTGRES: "0" }, stdout: "pipe", stderr: "pipe" });
  expect(p.exitCode).toBe(0);
  expect(JSON.parse(new TextDecoder().decode(p.stdout))).toMatchObject({ candidates: [{ slug: "people/alex", source_id: "default", alias: "Саша Петров" }], truncated: false });
  const storage = new Storage({ dbPath: path });
  await storage.init();
  try { expect((await getPage(storage, "people/alex"))!.compiled_truth).toEqual({}); }
  finally { await storage.close(); }
});
