import { expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Storage } from "../src/core/storage.ts";
import { putPage, getPage } from "../src/core/pages.ts";
import { indexPageIntoSearch } from "../src/core/page-index.ts";
import { deterministicEmbed } from "./det-embed.ts";

it("all three data previews leave every public table unchanged through the actual CLI", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "memrain-data-preview-"));
  const dbPath = join(tmp, "db");
  const config = join(tmp, "config.json");
  const exported = join(tmp, "export");
  const session = join(tmp, "session.jsonl");
  mkdirSync(exported);
  writeFileSync(join(exported, "restored.md"), "---\ntitle: Restored\ntype: note\n---\n\nRestored body\n");
  writeFileSync(session, JSON.stringify({ type: "user", uuid: "u", sessionId: "preview", entrypoint: "sdk-cli", message: { content: "Check the fixture." } }));
  writeFileSync(config, JSON.stringify({ database: { type: "pglite", path: dbPath },
    embedding: { provider: "bedrock-titan", model: "amazon.titan-embed-text-v2:0", region: "eu-west-1" }, storage: {} }));
  let storage = new Storage({ dbPath });
  let opened = true;
  try {
    await storage.init();
    const slug = "transcripts/claude-code/preview-p1";
    await putPage(storage, { slug, title: "Preview", markdown_body: "A preserved fixture.",
      compiled_truth: { format: "claude-code", conversation_id: "preview" } });
    await indexPageIntoSearch(storage, (await getPage(storage, slug))!, { embedFn: async text => deterministicEmbed(text) });
    await storage.engine().exec("UPDATE documents SET source_id=NULL; UPDATE chunks SET source_id=NULL");
    await storage.engine().query("INSERT INTO entity_facts(entity_slug,fact,source_slug,attributed_to) VALUES('projects/preview','Preserved claim',$1,'user')", [slug]);
    // A pending ledger entry makes an accidental Storage.init observable even on a ready schema.
    await storage.engine().exec("DELETE FROM migrations WHERE id=146");
    const snapshot = async () => {
      const { rows } = await storage.engine().query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
      return JSON.stringify(await Promise.all(rows.map(({ tablename }) => storage.engine().query(
        `SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) AS rows FROM "${tablename.replaceAll('"', '""')}" t`))));
    };
    const before = await snapshot();
    const commands = [
      ["import", "--dir", exported, "--source", "default"],
      ["transcripts", "repair-origin", session, "--source", "default", "--json"],
      ["mirror-adopt", "--source", "default", "--limit", "2"],
    ];
    for (const args of commands) {
      await storage.close(); opened = false;
      const run = Bun.spawnSync([process.execPath, "src/cli.ts", ...args], { cwd: join(import.meta.dir, ".."),
        env: { ...process.env, MEMRAIN_CONFIG_PATH: config, MEMRAIN_REQUIRE_POSTGRES: "0" }, stdout: "pipe", stderr: "pipe" });
      expect(run.exitCode, run.stderr.toString()).toBe(0);
      const output = JSON.parse(run.stdout.toString());
      expect(output.plan_hash).toMatch(/^[a-f0-9]{64}$/);
      if (args[0] === "import") expect(output.candidates).toBe(1);
      else if (args[0] === "transcripts") expect(output.facts).toBe(1);
      else expect(output.targets).toHaveLength(2);
      storage = new Storage({ dbPath }); opened = true;
      await storage.engine().ready();
      expect(await snapshot()).toBe(before);
    }
  } finally {
    if (opened) await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}, 60000);
