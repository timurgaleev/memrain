import { expect, it } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { indexCodeDocument } from "../src/core/indexer-code.ts";

it("rechunk dry-run leaves the code corpus byte-identical at the CLI boundary", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "memrain-rechunk-cli-"));
  const db = join(tmp, "db");
  const file = join(tmp, "sample.ts");
  const config = join(tmp, "config.json");
  const text = "export function sample(): number { return 42; }\n";
  writeFileSync(file, text);
  writeFileSync(config, JSON.stringify({ database: { type: "pglite", path: db },
    embedding: { provider: "bedrock-titan", model: "amazon.titan-embed-text-v2:0", region: "eu-west-1" }, storage: {} }));
  let storage = new Storage({ dbPath: db });
  let open = true;
  try {
    await storage.init();
    await indexCodeDocument(storage, { sourcePath: file, text });
    await storage.engine().exec("UPDATE documents SET chunker_version = 0");
    const snapshot = async () => {
      const { rows } = await storage.engine().query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename");
      return JSON.stringify(await Promise.all(rows.map(({ tablename }) =>
        storage.engine().query(`SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) AS rows FROM "${tablename.replaceAll('"', '""')}" t`))));
    };
    const before = await snapshot();
    await storage.close();
    open = false;
    const run = Bun.spawnSync([process.execPath, "src/cli.ts", "reindex", "--source", "code", "--paths", tmp,
      "--rechunk-stale", "--dry-run", "--limit", "1"], {
      cwd: join(import.meta.dir, ".."), env: { ...process.env, MEMRAIN_CONFIG_PATH: config, MEMRAIN_REQUIRE_POSTGRES: "0" },
      stdout: "pipe", stderr: "pipe",
    });
    expect(run.exitCode, run.stderr.toString()).toBe(0);
    storage = new Storage({ dbPath: db });
    open = true;
    await storage.init();
    expect(await snapshot()).toBe(before);
    const output = JSON.parse(run.stdout.toString());
    expect(output.plan_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(output.selected).toBe(1);
    expect(output.cost_upper_bound_usd).toBe(0);
    await storage.close(); open = false;
    const apply = Bun.spawnSync([process.execPath, "src/cli.ts", "reindex", "--source", "code", "--paths", tmp,
      "--rechunk-stale", "--plan-hash", output.plan_hash, "--limit", "1", "--max-cost-usd", "0"], {
      cwd: join(import.meta.dir, ".."), env: { ...process.env, MEMRAIN_CONFIG_PATH: config, MEMRAIN_REQUIRE_POSTGRES: "0" },
      stdout: "pipe", stderr: "pipe",
    });
    expect(apply.exitCode, apply.stderr.toString()).toBe(0);
    expect(JSON.parse(apply.stdout.toString())).toMatchObject({ ok: true, dry_run: false, status: "complete", embedding_calls: 0 });
  } finally {
    if (open) await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}, 60000);
