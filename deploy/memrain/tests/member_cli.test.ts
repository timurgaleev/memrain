/**
 * The `member` and `group` commands, run as the operator runs them
 * (`bun run src/cli.ts …`, which is what the container ships), in the order
 * docs/TEAM-SETUP.md walks through.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Storage } from "../src/core/storage.ts";
import { registerSource } from "../src/core/sources.ts";

// Each step boots the CLI and its brain in a fresh process.
setDefaultTimeout(60_000);

const dir = mkdtempSync(join(tmpdir(), "member-cli-"));
const config = join(dir, "config.json");
const path = join(dir, "brain");

beforeAll(async () => {
  writeFileSync(config, JSON.stringify({ embedding: { provider: "bedrock-titan", model: "amazon.titan-embed-text-v2:0", region: "eu-west-1" }, storage: {}, database: { type: "pglite", path } }));
  const s = new Storage({ dbPath: path });
  await s.init();
  try {
    for (const id of ["alice", "sales"]) await registerSource(s.engine(), { id, kind: "other", pathPrefix: `tenant:${id}` });
  } finally { await s.close(); }
}, 30_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function cli(...args: string[]): { code: number; out: string; err: string } {
  const child = Bun.spawnSync([process.execPath, "src/cli.ts", ...args], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, MEMRAIN_CONFIG_PATH: config, MEMRAIN_REQUIRE_POSTGRES: "0", MEMRAIN_OPERATOR: "ops" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: child.exitCode ?? -1, out: new TextDecoder().decode(child.stdout), err: new TextDecoder().decode(child.stderr) };
}

describe("member and group commands", () => {
  it("add a member, give them a key, put them in a group that reads a shared source", () => {
    expect(cli("member", "add", "alice", "--name", "Alice", "--email", "alice@example.com").code).toBe(0);
    const minted = cli("auth", "create", "alice-laptop", "--source", "alice", "--profile", "writer");
    expect(minted.code).toBe(0);
    expect(JSON.parse(minted.out)).toMatchObject({ profile: "writer", scopes: ["read", "write"] });
    expect(cli("member", "bind", "alice", "--token", "alice-laptop").code).toBe(0);
    expect(cli("group", "add", "sales-team", "--name", "Sales").code).toBe(0);
    expect(cli("group", "grant-source", "sales-team", "sales").code).toBe(0);
    expect(cli("group", "add-member", "sales-team", "alice").code).toBe(0);

    const shown = JSON.parse(cli("member", "show", "alice").out);
    expect(shown.member).toMatchObject({ id: "alice", status: "enabled", groups: ["sales-team"] });
    expect(shown.credentials).toEqual([{ kind: "token", id: "alice-laptop" }]);
    expect(shown.audit[0]).toMatchObject({ actor: "ops", via: "cli" });
    expect(JSON.parse(cli("group", "show", "sales-team").out).group).toMatchObject({ sources: ["sales"], members: ["alice"] });
  });

  it("refuses the owner's source without the override, and says why", () => {
    const r = cli("group", "grant-source", "sales-team", "default");
    expect(r.code).toBe(1);
    expect(r.err).toContain("--allow-owner-source");
    expect(cli("group", "grant-source", "sales-team", "default", "--allow-owner-source").code).toBe(0);
    expect(cli("group", "revoke-source", "sales-team", "default").code).toBe(0);
  });

  it("disables a member and refuses a binding that names two credentials", () => {
    const disabled = cli("member", "disable", "alice");
    expect(disabled.code).toBe(0);
    expect(JSON.parse(disabled.out).member.status).toBe("disabled");
    const both = cli("member", "unbind", "--token", "alice-laptop", "--client", "x");
    expect(both.code).toBe(1);
    expect(both.err).toContain("exactly one credential");
    expect(cli("member", "frobnicate").code).toBe(1);
  });
});

describe("auth register-client --profile", () => {
  it("leaves no live client behind when recording the profile fails", async () => {
    // A brain whose oauth_clients lost tool_surface makes the profile write
    // fail after the client row exists; the operator never sees its secret.
    const own = mkdtempSync(join(tmpdir(), "member-cli-profile-"));
    const ownConfig = join(own, "config.json");
    const ownPath = join(own, "brain");
    try {
      writeFileSync(ownConfig, JSON.stringify({ embedding: { provider: "bedrock-titan", model: "amazon.titan-embed-text-v2:0", region: "eu-west-1" }, storage: {}, database: { type: "pglite", path: ownPath } }));
      const s = new Storage({ dbPath: ownPath });
      await s.init();
      try {
        await s.raw().query("ALTER TABLE oauth_clients DROP COLUMN tool_surface");
      } finally { await s.close(); }

      const child = Bun.spawnSync([process.execPath, "src/cli.ts", "auth", "register-client", "half-made", "--profile", "reader"], {
        cwd: join(import.meta.dir, ".."),
        env: { ...process.env, MEMRAIN_CONFIG_PATH: ownConfig, MEMRAIN_REQUIRE_POSTGRES: "0", MEMRAIN_OPERATOR: "ops" },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(child.exitCode).toBe(1);
      expect(new TextDecoder().decode(child.stdout)).not.toContain("client_secret");

      const after = new Storage({ dbPath: ownPath });
      await after.init();
      try {
        const live = await after.raw().query(`SELECT client_id FROM oauth_clients WHERE client_name = 'half-made' AND deleted_at IS NULL`);
        expect(live.rows).toEqual([]);
      } finally { await after.close(); }
    } finally { rmSync(own, { recursive: true, force: true }); }
  });
});
