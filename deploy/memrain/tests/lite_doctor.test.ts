/**
 * The doctor on a brain an earlier build filled: `memrain doctor` and the
 * `run_doctor` tool both pass, report the pre-Lite feature rows as one
 * informational line, and name no subsystem this build no longer has.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor } from "../src/commands/doctor.ts";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import { restoreExitCode } from "./helpers/exit-code.ts";

/**
 * Words naming a subsystem this build dropped; none may appear in a report.
 * "connector key" is the secret store's key (MEMRAIN_CONNECTOR_KEK), not a connector.
 */
const RETIRED = /\b(jobs?|queue|worker|daemons?|cycle|connectors?(?! key)|chronicle|synthesis|takes?|calibration|skillpack|skills|eval|contradiction|notifications?|chat|remediat\w*|code[- ]graph|grammars?|contextual)\b/i;

const tmp = mkdtempSync(join(tmpdir(), "memrain-lite-doctor-"));
const cfgDir = join(tmp, "cfg");
const dbPath = join(cfgDir, "brain.pglite");
const cfgPath = join(cfgDir, "config.json");
const savedVault = process.env.MEMRAIN_VAULT_PATH;

async function seed(): Promise<void> {
  const storage = new Storage({ dbPath });
  await storage.init();
  try {
    await putPage(storage, { slug: "people/alice", type: "person", title: "Alice", markdown_body: "Alice keeps the archive." });
    await storage.engine().exec(`
      INSERT INTO entity_facts (entity_slug, fact, source_id, written_by) VALUES ('people/alice', 'Lives in Lisbon', 'default', 'seed');
      INSERT INTO timeline_events (slug, occurred_at, event, source_label, source_id)
        VALUES ('people/alice', '2026-01-01 10:00:00+00', 'Joined', 'manual', 'default');
      INSERT INTO synth_takes (take_key, source_ref, source_hash, prompt_version, claim_text, model_id)
        VALUES ('t1', 'people/alice', 'h', 'v1', 'A take', 'm');
      INSERT INTO jobs (id, kind, payload) VALUES ('job-1', 'page_mirror', '{}'::jsonb);
    `);
  } finally {
    await storage.close();
  }
}

beforeAll(async () => {
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(cfgPath, JSON.stringify({
    database: { type: "pglite", path: dbPath },
    embedding: { provider: "bedrock-titan", model: "amazon.titan-embed-text-v2:0", region: "eu-west-1" },
    storage: {},
  }));
  delete process.env.MEMRAIN_VAULT_PATH;
  await seed();
});

afterAll(() => {
  if (savedVault !== undefined) process.env.MEMRAIN_VAULT_PATH = savedVault;
  rmSync(tmp, { recursive: true, force: true });
});

interface Check { name: string; ok: boolean; status: string; detail?: string }

describe("doctor on a pre-Lite brain", () => {
  // Value: protects=an upgraded brain reads healthy and the report speaks only of what this
  // build runs; fails_when=a check probes a dropped subsystem or fails on its leftover rows;
  // why_new=the doctor was rewritten for the cut; seam=none
  it("memrain doctor exits 0 and mentions no retired subsystem", async () => {
    const captured: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };
    const prevExit = process.exitCode;
    process.exitCode = 0;
    let exitCode: number | undefined;
    try {
      await runDoctor({ configPath: cfgPath });
      exitCode = process.exitCode;
    } finally {
      console.log = origLog;
      restoreExitCode(prevExit);
    }
    const report = JSON.parse(captured.join("\n")) as { ok: boolean; checks: Check[] };
    expect(exitCode ?? 0).toBe(0);
    expect(report.ok).toBe(true);
    const text = JSON.stringify(report.checks);
    expect(text.match(RETIRED)).toBeNull();
    const unused = report.checks.find((c) => c.name === "unused-feature-data")!;
    expect(unused.status).toBe("ok");
    expect(unused.detail).toBe("pre-Lite feature data present, unused by Lite: 4 rows (kept as is)");
  });

  // Value: protects=the MCP doctor agrees with the CLI one; fails_when=run_doctor still
  // probes a dropped subsystem; why_new=same; seam=none
  it("run_doctor passes and mentions no retired subsystem", async () => {
    const storage = new Storage({ dbPath });
    await storage.init();
    try {
      const r = await dispatchTool(storage, { name: "run_doctor", arguments: {} });
      expect(r.isError).toBeUndefined();
      const report = JSON.parse(r.content[0]!.text) as { ok: boolean; checks: Check[] };
      expect(report.ok).toBe(true);
      expect(JSON.stringify(report.checks).match(RETIRED)).toBeNull();
      expect(report.checks.some((c) => c.detail?.startsWith("pre-Lite feature data present, unused by Lite: 4 rows"))).toBe(true);
    } finally {
      await storage.close();
    }
  });
});
