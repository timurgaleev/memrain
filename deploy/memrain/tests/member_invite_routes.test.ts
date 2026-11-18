/**
 * Inviting a member to /app from the admin API and the CLI, and the CLI's
 * offboarding switch. The link carries its token in the fragment; a member
 * without a personal source is refused with member_not_ready.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Storage } from "../src/core/storage.ts";
import { registerSource } from "../src/core/sources.ts";
import { addMember } from "../src/core/members.ts";
import { handleAdminApi, type AdminApiDeps } from "../src/http/admin-api.ts";
import { openMemberInvite } from "../src/core/member-invites.ts";

setDefaultTimeout(60_000);

const ORIGIN = "https://acme.example.test";
const dir = mkdtempSync(join(tmpdir(), "member-invite-"));
const config = join(dir, "config.json");
const path = join(dir, "brain");
let storage: Storage;

beforeAll(async () => {
  writeFileSync(config, JSON.stringify({ embedding: { provider: "bedrock-titan", model: "amazon.titan-embed-text-v2:0", region: "eu-west-1" }, storage: {}, database: { type: "pglite", path } }));
  storage = new Storage({ dbPath: path });
  await storage.init();
  const e = storage.engine();
  await registerSource(e, { id: "person-alice", kind: "other", pathPrefix: "/person-alice" });
  await addMember(e, "alice", { personalSource: "person-alice" }, { actor: "ops", via: "cli" });
  await addMember(e, "bob", {}, { actor: "ops", via: "cli" });
}, 30_000);
afterAll(async () => {
  await storage.close();
  rmSync(dir, { recursive: true, force: true });
});

const deps = (): AdminApiDeps => ({ storage, publicUrl: ORIGIN, requireAdmin: () => true, sessionCooldown: () => null });
const post = (p: string, body: unknown = {}) =>
  new Request(`${ORIGIN}${p}`, { method: "POST", headers: { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify(body) });

describe("POST /admin/api/members/:id/invite", () => {
  it("returns a one-time link with the token in the fragment", async () => {
    const res = (await handleAdminApi(post("/admin/api/members/alice/invite", { ttl_hours: 24 }), new URL(`${ORIGIN}/admin/api/members/alice/invite`), deps()))!;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; expires_at: string };
    expect(body.url.startsWith(`${ORIGIN}/app/invite#`)).toBe(true);
    const token = body.url.slice(body.url.indexOf("#") + 1);
    expect(await openMemberInvite(storage.engine(), token, "pre")).toMatchObject({ ok: true, memberId: "alice" });
  });

  it("refuses a member with no personal source", async () => {
    const res = (await handleAdminApi(post("/admin/api/members/bob/invite"), new URL(`${ORIGIN}/admin/api/members/bob/invite`), deps()))!;
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("member_not_ready");
  });
});

describe("memrain member invite / remove --erase-personal-source", () => {
  function cli(...args: string[]): { code: number; out: string; err: string } {
    const child = Bun.spawnSync([process.execPath, "src/cli.ts", ...args], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, MEMRAIN_CONFIG_PATH: config, MEMRAIN_REQUIRE_POSTGRES: "0", MEMRAIN_OPERATOR: "ops", MEMRAIN_PUBLIC_URL: ORIGIN },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: child.exitCode ?? -1, out: new TextDecoder().decode(child.stdout), err: new TextDecoder().decode(child.stderr) };
  }

  it("prints the link and a dry-run erasure plan", async () => {
    await storage.close();
    try {
      const inv = cli("member", "invite", "alice", "--ttl", "48h");
      expect(inv.code).toBe(0);
      expect(JSON.parse(inv.out).url.startsWith(`${ORIGIN}/app/invite#`)).toBe(true);
      expect(cli("member", "invite", "alice", "--ttl", "soon").code).not.toBe(0);
      const plan = cli("member", "remove", "alice", "--erase-personal-source");
      expect(plan.code).toBe(0);
      expect(JSON.parse(plan.out)).toMatchObject({ applied: false, source_id: "person-alice" });
      expect(cli("member", "remove", "alice", "--erase-personal-source", "--apply").code).not.toBe(0);
    } finally {
      storage = new Storage({ dbPath: path });
      await storage.init();
    }
  });
});
