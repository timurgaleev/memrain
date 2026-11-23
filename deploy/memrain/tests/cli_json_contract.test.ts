/**
 * `--json` contract over the real entrypoint: for each guarded command, `JSON.parse(stdout)` yields exactly one object — on success, on a
 * usage error and on a refused flag — while human-readable output stays on
 * stderr. A script or an agent can therefore branch on stdout alone.
 *
 * These spawn `bun src/cli.ts`, because what is under test is the whole
 * process's stdout: a stray console.log anywhere on the path breaks the
 * contract and nothing in-process can see it. Runs on PGLite always and on
 * Postgres when MEMRAIN_TEST_POSTGRES_URL is set.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSON_GUARDED_COMMANDS } from "../src/cli-args.ts";
import { pgTestEngine, pgTestEnv } from "./helpers/pg-test-engine.ts";

const root = join(import.meta.dir, "..");
const pgUrl = process.env.MEMRAIN_TEST_POSTGRES_URL;

interface Run { code: number; out: string; err: string }

function parseOne(r: Run): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(r.out);
  } catch {
    throw new Error(`stdout is not one JSON document (exit ${r.code}):\n${r.out}\n--- stderr:\n${r.err}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`stdout is JSON but not an object: ${r.out}`);
  }
  return value as Record<string, unknown>;
}

/** Commands and the key that proves their OWN data came back, not the text fallback. */
const SUCCESS_CASES: { argv: string[]; key: string; engineFree?: boolean }[] = [
  { argv: ["status", "--json"], key: "stats" },
  { argv: ["doctor", "--json"], key: "checks" },
  { argv: ["sources", "list", "--json"], key: "rows" },
  { argv: ["secrets", "audit", "--json"], key: "hits_total" },
  { argv: ["export", "--dir", "@EXPORT@", "--json"], key: "pages" },
  { argv: ["engine", "status", "--json"], key: "engine" },
  { argv: ["version", "--json"], key: "version", engineFree: true },
];

describe("the guarded command set", () => {
  it("is the commands the contract below covers", () => {
    const covered = new Set(SUCCESS_CASES.map((c) => c.argv[0]!));
    expect([...JSON_GUARDED_COMMANDS].sort()).toEqual([...covered].sort());
  });
});

const engines: { name: string; setup: (dir: string) => Promise<{ env: Record<string, string>; config: object; close: () => Promise<void> }> }[] = [
  {
    name: "PGLite",
    setup: async (dir) => ({
      env: {},
      config: { type: "pglite", path: join(dir, "brain") },
      close: async () => {},
    }),
  },
  ...(pgUrl ? [{
    name: "Postgres",
    setup: async () => {
      const name = `json_contract_${process.pid}_${Math.floor(Math.random() * 1e9)}`;
      const admin = pgTestEngine({ url: pgUrl, max: 1 });
      try {
        await admin.exec(`CREATE DATABASE ${name}`);
      } finally {
        await admin.close();
      }
      const url = new URL(pgUrl);
      url.pathname = `/${name}`;
      return {
        env: pgTestEnv(url.toString()),
        config: { type: "postgres" },
        close: async () => {
          const cleanup = pgTestEngine({ url: pgUrl, max: 1 });
          try {
            await cleanup.exec(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
          } finally {
            await cleanup.close();
          }
        },
      };
    },
  }] : []),
];

for (const engine of engines) {
  describe(`--json contract (${engine.name})`, () => {
    const dir = mkdtempSync(join(tmpdir(), "memrain-json-contract-"));
    const configPath = join(dir, "config.json");
    let env: Record<string, string> = {};
    let close: () => Promise<void> = async () => {};

    beforeAll(async () => {
      const setup = await engine.setup(dir);
      env = setup.env;
      close = setup.close;
      writeFileSync(configPath, JSON.stringify({
        database: setup.config,
        embedding: { provider: "bedrock-titan", model: "amazon.titan-embed-text-v2:0", region: "eu-west-1" },
        storage: {},
      }));
    });
    afterAll(async () => {
      await close();
      rmSync(dir, { recursive: true, force: true });
    });

    function cli(argv: string[]): Run {
      const p = Bun.spawnSync(["bun", "src/cli.ts", ...argv.map((a) => a.replace("@EXPORT@", join(dir, "export")))], {
        cwd: root,
        env: {
          ...process.env,
          MEMRAIN_CONFIG_PATH: configPath,
          MEMRAIN_REQUIRE_POSTGRES: "0",
          MEMRAIN_NO_DB_CONFIG: "1",
          // Never reach a real Bedrock endpoint: the vector arm degrades instead.
          AWS_ACCESS_KEY_ID: "test",
          AWS_SECRET_ACCESS_KEY: "test",
          AWS_EC2_METADATA_DISABLED: "true",
          ...env,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      return { code: p.exitCode, out: new TextDecoder().decode(p.stdout), err: new TextDecoder().decode(p.stderr) };
    }

    for (const c of SUCCESS_CASES) {
      if (engine.name !== "PGLite" && c.engineFree) continue;
      it(`${c.argv.slice(0, 2).join(" ")} prints one object with its own data`, () => {
        const doc = parseOne(cli(c.argv));
        expect(doc).toHaveProperty(c.key);
        expect(doc.data).toBeUndefined();
      }, 60_000);
    }

    it("a usage error becomes an error object, not empty stdout", () => {
      const r = cli(["sources", "bogus", "--json"]);
      expect(r.code).not.toBe(0);
      const doc = parseOne(r);
      expect(doc.ok).toBe(false);
      expect(doc.exit_code).toBe(r.code);
      expect(typeof (doc.error as { message: string }).message).toBe("string");
    }, 60_000);

    it("a refused flag becomes an error object too", () => {
      const r = cli(["status", "--json", "--bogus"]);
      expect(r.code).toBe(1);
      const doc = parseOne(r);
      expect(doc.ok).toBe(false);
      expect((doc.error as { message: string }).message).toContain("--bogus");
    }, 60_000);
  });
}

describe("--json --help", () => {
  it("wraps the manual as text instead of printing prose", () => {
    const p = Bun.spawnSync(["bun", "src/cli.ts", "version", "--json", "--help"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode).toBe(0);
    const doc = parseOne({ code: p.exitCode, out: new TextDecoder().decode(p.stdout), err: "" });
    expect(doc.ok).toBe(true);
    expect((doc.data as { text: string }).text).toContain("Usage: memrain <command>");
  });
});

describe("human output is unchanged without --json", () => {
  it("version still prints its one line", () => {
    const p = Bun.spawnSync(["bun", "src/cli.ts", "version"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    expect(new TextDecoder().decode(p.stdout)).toMatch(/^memrain \S+\n$/);
  });

  it("a command outside the guarded set still refuses --json", () => {
    const p = Bun.spawnSync(["bun", "src/cli.ts", "reindex", "--json"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode).toBe(1);
    expect(new TextDecoder().decode(p.stdout)).toBe("");
    expect(new TextDecoder().decode(p.stderr)).toContain("unknown flag '--json'");
  });
});
