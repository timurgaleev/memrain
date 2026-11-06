/**
 * `init --postgres` never rewrites a config.json that already says postgres.
 * Every container start runs it, and the operator's config (including keys
 * init does not know) must survive byte for byte, whichever directory name
 * reaches it. The one write on an existing file stays the pglite→postgres
 * switch, which replaces `database` and nothing else.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runInit } from "../src/commands/init.ts";

const TEMPLATES_DIR = resolve(import.meta.dir, "..", "templates");

const EXISTING = {
  database: { type: "postgres" },
  embedding: { provider: "bedrock-titan", model: "amazon.titan-embed-text-v2:0", region: "eu-west-1" },
  storage: {},
  auth: { selfIssued: { enabled: true } },
  operator_note: { kept: ["unknown", "keys"] },
};

let home: string;
let savedOverride: string | undefined;

/** A config dir as a live install has it: config.json plus every seeded template. */
function install(dir: string, body: object): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const f of fs.readdirSync(TEMPLATES_DIR).filter((n) => n.endsWith(".md.template"))) {
    fs.writeFileSync(join(dir, f.replace(".md.template", ".md")), "seeded\n");
  }
  const p = join(dir, "config.json");
  fs.writeFileSync(p, JSON.stringify(body, null, 4));
  fs.chmodSync(p, 0o640);
  return p;
}

function fingerprint(p: string) {
  const st = fs.statSync(p);
  return {
    sha256: createHash("sha256").update(fs.readFileSync(p)).digest("hex"),
    mode: st.mode,
    uid: st.uid,
    gid: st.gid,
    ino: st.ino,
    mtimeMs: st.mtimeMs,
  };
}

async function initPostgres(): Promise<string> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  try {
    await runInit({ pglite: false, postgres: true, home });
  } finally {
    console.log = orig;
  }
  return lines.join("\n");
}

beforeEach(() => {
  home = fs.mkdtempSync(join(tmpdir(), "memrain-init-norewrite-"));
  savedOverride = process.env.MEMRAIN_CONFIG_PATH;
  delete process.env.MEMRAIN_CONFIG_PATH;
});

afterEach(() => {
  if (savedOverride === undefined) delete process.env.MEMRAIN_CONFIG_PATH;
  else process.env.MEMRAIN_CONFIG_PATH = savedOverride;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("init --postgres on an existing postgres config", () => {
  const cases: [string, () => string][] = [
    ["reached via ~/.memrain", () => install(join(home, ".memrain"), EXISTING)],
    ["reached via ~/.memex", () => install(join(home, ".memex"), EXISTING)],
    [
      "reached via two names for one directory",
      () => {
        const p = install(join(home, ".memex"), EXISTING);
        fs.symlinkSync(join(home, ".memex"), join(home, ".memrain"));
        return p;
      },
    ],
  ];

  for (const [label, setup] of cases) {
    it(`leaves it untouched when ${label}`, async () => {
      const cfg = setup();
      const dir = dirname(cfg);
      const before = fingerprint(cfg);
      const listing = fs.readdirSync(dir).sort();
      const writes = spyOn(fs, "writeFileSync");
      try {
        const out = await initPostgres();
        expect(out).toContain("already initialized");
        expect(writes).not.toHaveBeenCalled();
      } finally {
        writes.mockRestore();
      }
      expect(fingerprint(cfg)).toEqual(before);
      expect(fs.readdirSync(dir).sort()).toEqual(listing);
    });
  }
});

describe("init --postgres on an existing pglite config", () => {
  it("switches database to postgres and keeps every other key", async () => {
    const legacy = { ...EXISTING, database: { type: "pglite", path: "/data/brain.pglite" } };
    const cfg = install(join(home, ".memex"), legacy);
    const writes = spyOn(fs, "writeFileSync");
    try {
      await initPostgres();
      expect(writes).toHaveBeenCalledTimes(1);
    } finally {
      writes.mockRestore();
    }
    expect(JSON.parse(fs.readFileSync(cfg, "utf8"))).toEqual({ ...legacy, database: { type: "postgres" } });
  });
});
