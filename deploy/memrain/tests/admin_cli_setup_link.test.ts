/**
 * `memrain admin setup-link`: mints a hashed, audited link, prints the token on
 * stdout only, validates --ttl, and on a PGLite brain held by a running server
 * exits 2 pointing at the bootstrap API.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { sha256Hex } from "../src/core/admin-passkey-store.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
let dir: string;
let dbPath: string;
let cfgPath: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "memrain-cli-setup-link-"));
  mkdirSync(join(dir, "cfg"));
  dbPath = join(dir, "cfg", "brain.pglite");
  cfgPath = join(dir, "cfg", "config.json");
  writeFileSync(cfgPath, JSON.stringify({
    database: { type: "pglite", path: dbPath },
    embedding: { provider: "bedrock-titan", model: "amazon.titan-embed-text-v2:0", region: "eu-west-1" },
    storage: {},
  }));
  const s = new Storage({ dbPath });
  await s.init();
  await s.close();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run(args: string[], publicUrl: string | null = "https://brain.example.com/") {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("MEMRAIN_") && !k.startsWith("MEMEX_")) env[k] = v;
  env.MEMRAIN_CONFIG_PATH = cfgPath;
  if (publicUrl !== null) env.MEMRAIN_PUBLIC_URL = publicUrl;
  const p = Bun.spawnSync(["bun", CLI, "admin", "setup-link", ...args], { env });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

async function withDb<T>(fn: (s: Storage) => Promise<T>): Promise<T> {
  const s = new Storage({ dbPath });
  await s.init();
  try {
    return await fn(s);
  } finally {
    await s.close();
  }
}

describe("memrain admin setup-link", () => {
  it("--json prints the link on stdout only, and stores the hash with a via=cli audit row", async () => {
    const r = run(["--json"]);
    expect(r.code).toBe(0);
    const { url, expires_at } = JSON.parse(r.out) as { url: string; expires_at: string };
    expect(url).toMatch(/^https:\/\/brain\.example\.com\/admin\/#enroll\/[\w-]{43}$/);
    const token = url.split("#enroll/")[1]!;
    expect(r.err).not.toContain(token);
    expect(Date.parse(expires_at) - Date.now()).toBeGreaterThan(23.9 * 3_600_000);
    expect(Date.parse(expires_at) - Date.now()).toBeLessThanOrEqual(24 * 3_600_000);
    await withDb(async (s) => {
      const row = await s.engine().query<{ nonce_hash: string; created_via: string }>(
        `SELECT nonce_hash, created_via FROM admin_setup_links WHERE used_at IS NULL AND revoked_at IS NULL`,
      );
      expect(row.rows).toEqual([{ nonce_hash: sha256Hex(token), created_via: "cli" }]);
      const ev = await s.engine().query<{ via: string }>(`SELECT via FROM admin_auth_events WHERE event = 'setup_link.issued'`);
      expect(ev.rows.map((x) => x.via)).toContain("cli");
      const dump = JSON.stringify((await s.engine().query(`SELECT * FROM admin_setup_links`)).rows)
        + JSON.stringify((await s.engine().query(`SELECT * FROM admin_auth_events`)).rows);
      expect(dump).not.toContain(token);
    });
  });

  it("without MEMRAIN_PUBLIC_URL prints a host-less link and warns on stderr without the token", () => {
    const r = run(["--ttl", "72"], null);
    expect(r.code).toBe(0);
    const [line, exp] = r.out.trim().split("\n");
    expect(line).toMatch(/^\/admin\/#enroll\/[\w-]{43}$/);
    expect(exp).toMatch(/^expires \d{4}-/);
    expect(r.err).toContain("MEMRAIN_PUBLIC_URL is unset");
    expect(r.err).not.toContain(line!.split("#enroll/")[1]!);
  });

  it("rejects --ttl 0, 73 and non-numbers, unknown flags and --dry-run", () => {
    for (const args of [["--ttl", "0"], ["--ttl", "73"], ["--ttl", "1.5"], ["--bogus"], ["--dry-run"]]) {
      const r = run(args);
      expect({ args, code: r.code }).toEqual({ args, code: 1 });
      expect(r.out).not.toContain("#enroll/");
    }
  });

  it("on a PGLite brain the running server holds, exits 2 with the bootstrap-API hint", async () => {
    const held = new Storage({ dbPath });
    await held.init();
    try {
      const r = run(["--json"]);
      expect(r.code).toBe(2);
      expect(r.err).toContain("/admin/api/setup-links");
      expect(r.out).toBe("");
    } finally {
      await held.close();
    }
  });
});
