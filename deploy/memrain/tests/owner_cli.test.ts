/**
 * The owner and owner-only commands, run as the operator runs them on a brain
 * whose owner member was named under 2.x: bind a new key to the owner, refuse
 * an unbound key once the brain serves several people, flag a personal mailbox
 * owner-only and dry-run the provenance backfill.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Storage } from "../src/core/storage.ts";
import { registerSource } from "../src/core/sources.ts";
import { putPage } from "../src/core/pages.ts";
import { seedMember, seedOwner } from "./helpers/seed-rows.ts";

setDefaultTimeout(60_000);

const dir = mkdtempSync(join(tmpdir(), "owner-cli-"));
const config = join(dir, "config.json");
const path = join(dir, "brain");

beforeAll(async () => {
  writeFileSync(config, JSON.stringify({ embedding: { provider: "bedrock-titan", model: "amazon.titan-embed-text-v2:0", region: "eu-west-1" }, storage: {}, database: { type: "pglite", path } }));
  const s = new Storage({ dbPath: path });
  await s.init();
  try {
    await registerSource(s.engine(), { id: "me-mail", kind: "mailbox", pathPrefix: "mail:me" });
    await putPage(s, { slug: "people/ora", type: "person", markdown_body: "Me", compiled_truth: { email: "Owner@Example.com" } });
  } finally { await s.close(); }
}, 30_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function withStorage(fn: (s: Storage) => Promise<void>): Promise<void> {
  const s = new Storage({ dbPath: path });
  await s.init();
  try { await fn(s); } finally { await s.close(); }
}

function cli(...args: string[]): { code: number; out: string; err: string } {
  const child = Bun.spawnSync([process.execPath, "src/cli.ts", ...args], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, MEMRAIN_CONFIG_PATH: config, MEMRAIN_REQUIRE_POSTGRES: "0", MEMRAIN_OPERATOR: "ops", MEMRAIN_OWNER_ENTITY: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: child.exitCode ?? -1, out: new TextDecoder().decode(child.stdout), err: new TextDecoder().decode(child.stderr) };
}

describe("owner commands", () => {
  it("a single-person install mints an unbound key", () => {
    expect(cli("auth", "create", "laptop").code).toBe(0);
  });

  it("a new key can be bound to the owner member when it is created", async () => {
    await withStorage(async (s) => {
      await seedMember(s.engine(), "ora");
      await seedOwner(s.engine(), "ora");
    });
    const minted = cli("auth", "create", "phone", "--member", "ora");
    expect(minted.code).toBe(0);
    expect(JSON.parse(minted.out).member).toBe("ora");
    await withStorage(async (s) => {
      const r = await s.engine().query<{ member_id: string | null }>(
        `SELECT member_id FROM access_tokens WHERE name = 'phone' AND revoked_at IS NULL`,
      );
      expect(r.rows[0]?.member_id).toBe("ora");
    });
  });

  it("on a shared brain an unbound key is not minted; a member or source key is", async () => {
    await withStorage(async (s) => { await seedMember(s.engine(), "bob"); });
    const refused = cli("auth", "create", "loose");
    expect(refused.code).not.toBe(0);
    expect(refused.err + refused.out).toContain("serves several people");
    // A key bound to a member other than the owner would never verify.
    expect(cli("auth", "create", "bob-laptop", "--member", "bob").code).not.toBe(0);
    expect(cli("auth", "create", "mail-reader", "--source", "me-mail").code).toBe(0);
  });

  it("flags a mailbox owner-only and dry-runs the provenance backfill", () => {
    expect(JSON.parse(cli("sources", "owner-only", "me-mail", "on").out)).toMatchObject({ source_id: "me-mail", owner_only: true });
    expect(JSON.parse(cli("sources", "owner-only", "me-mail").out).owner_only).toBe(true);
    const dry = JSON.parse(cli("sources", "provenance").out);
    expect(dry.dry_run).toBe(true);
    expect(Object.keys(dry.kinds).sort()).toEqual(["atom", "fact", "page", "take", "timeline"]);
    expect(cli("sources", "owner-only", "me-mail", "maybe").code).toBe(1);
  });
});
