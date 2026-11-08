import { expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { getPage, putPage } from "../src/core/pages.ts";
import { withStorage } from "../src/commands/with-storage.ts";

it("CLI requires the observed version and carries the page through a successful rename", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memrain-rename-cli-"));
  const dbPath = join(dir, "db");
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({ database: { type: "pglite", path: dbPath },
    embedding: { provider: "bedrock-titan", model: "amazon.titan-embed-text-v2:0", region: "eu-west-1" }, storage: {} }));
  const storage = new Storage({ dbPath });
  try {
    await withStorage(storage, () => putPage(storage, { slug: "notes/old", markdown_body: "CLI keeps this" }));
    const call = (...args: string[]) => Bun.spawnSync(["bun", "src/cli.ts", "rename", "notes/old", "notes/new", ...args], {
      cwd: join(import.meta.dir, ".."), env: { ...process.env, MEMRAIN_CONFIG_PATH: configPath }, stdout: "pipe", stderr: "pipe",
    });
    const missing = call();
    expect(missing.exitCode).toBe(1);
    expect(new TextDecoder().decode(missing.stderr)).toContain("--expected-version");
    const stale = call("--expected-version", "2");
    expect(stale.exitCode).toBe(1);
    const success = call("--expected-version", "1", "--source", "default");
    expect(success.exitCode).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(success.stdout))).toMatchObject({ ok: true, renamed: true });
    const reopened = new Storage({ dbPath });
    await withStorage(reopened, async () => {
      expect(await getPage(reopened, "notes/old")).toMatchObject({ slug: "notes/new", markdown_body: "CLI keeps this" });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
