import { expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Storage } from "../src/core/storage.ts";
import { forgetFact } from "../src/core/facts-recall.ts";

it("actual erase preview prints only a plan and leaves every public table unchanged", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "memrain-erasure-cli-"));
  const dbPath = join(tmp, "db"); const config = join(tmp, "config.json");
  writeFileSync(config, JSON.stringify({ database: { type: "pglite", path: dbPath }, embedding: { provider: "bedrock-titan", model: "amazon.titan-embed-text-v2:0", region: "eu-west-1" }, storage: {} }));
  let storage = new Storage({ dbPath }); let opened = true;
  try {
    await storage.init();
    const id = (await storage.engine().query<{ id: number }>("INSERT INTO entity_facts(entity_slug,fact,source_id) VALUES('people/preview','Private selected preview claim 6273','default') RETURNING id")).rows[0]!.id;
    await forgetFact(storage, id, { reason: "Private preview reason" });
    await storage.engine().exec("DELETE FROM migrations WHERE id=146");
    const snapshot = async () => {
      const tables = (await storage.engine().query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
      return JSON.stringify(await Promise.all(tables.map(({ tablename }) => storage.engine().query(`SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) AS rows FROM "${tablename.replaceAll('"', '""')}" t`))));
    };
    const before = await snapshot();
    await storage.close(); opened = false;
    const run = Bun.spawnSync([process.execPath, "src/cli.ts", "erase", "forgotten", "--source", "default", "--fact-ids", String(id)], {
      cwd: join(import.meta.dir, ".."), env: { ...process.env, MEMRAIN_CONFIG_PATH: config, MEMRAIN_REQUIRE_POSTGRES: "0" }, stdout: "pipe", stderr: "pipe" });
    expect(run.exitCode, run.stderr.toString()).toBe(0);
    const output = JSON.parse(run.stdout.toString());
    expect(output).toMatchObject({ ok: true, dry_run: true, fact_ids: [id], blockers: [], cost_usd: 0 });
    expect(output.plan_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(run.stdout.toString()).not.toContain("Private");
    storage = new Storage({ dbPath }); opened = true; await storage.engine().ready();
    expect(await snapshot()).toBe(before);
  } finally { if (opened) await storage.close(); rmSync(tmp, { recursive: true, force: true }); }
}, 30000);
