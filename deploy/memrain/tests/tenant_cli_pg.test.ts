/**
 * `memrain tenant …` end to end against a scratch control database: the
 * commands the deploy loop relies on (migrate-control, list --json, migrate,
 * smoke-record) and the operator's switches (suspend, resume, limits, cap,
 * usage). No secret reaches stdout. Skipped unless MEMRAIN_TEST_POSTGRES_URL
 * points at a scratch Postgres.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgresEngine } from "../src/core/engine/postgres.ts";
import { runTenant } from "../src/commands/tenant.ts";
import { PG_URL, createScratchControl, dropTenantArtifacts, runSuffix, type ScratchControl } from "./helpers/control-pg.ts";

setDefaultTimeout(180_000);

describe.skipIf(!PG_URL)("memrain tenant", () => {
  let control: ScratchControl;
  let dir: string;
  let env: NodeJS.ProcessEnv;
  const id = `cli-${runSuffix()}`;

  async function run(...args: string[]): Promise<{ code: number; out: string; err: string }> {
    const out: string[] = [];
    const err: string[] = [];
    const log = console.log;
    const error = console.error;
    console.log = (...a: unknown[]) => out.push(a.join(" "));
    console.error = (...a: unknown[]) => err.push(a.join(" "));
    try {
      const code = await runTenant(args, env);
      return { code, out: out.join("\n"), err: err.join("\n") };
    } finally {
      console.log = log;
      console.error = error;
    }
  }

  beforeAll(async () => {
    control = await createScratchControl(PG_URL!);
    dir = mkdtempSync(join(tmpdir(), "memrain-tenant-cli-"));
    env = { MEMRAIN_CONTROL_ADMIN_URL: control.url };
  });
  afterAll(async () => {
    await control.drop();
    await dropTenantArtifacts(PG_URL!, id);
    rmSync(dir, { recursive: true, force: true });
  });

  it("migrates the control database and lists nothing yet", async () => {
    expect((await run("migrate-control")).code).toBe(0);
    expect(JSON.parse((await run("migrate-control")).out).applied).toEqual([]);
    expect(JSON.parse((await run("list", "--json")).out)).toEqual({ ok: true, tenants: [] });
  });

  it("refuses to create without a host, and creates one waiting for member invites", async () => {
    await expect(run("create", id)).rejects.toThrow(/--host is required/);
    await expect(run("create", id, "--host", `${id}.example.test`, "--secrets-dir", join(dir, "secrets"))).rejects.toThrow(/--invite-out/);
    const r = await run("create", id, "--host", `${id}.example.test`, "--secrets-dir", join(dir, "secrets"), "--invite-out", join(dir, "invite"));
    expect(r.code).toBe(0);
    const body = JSON.parse(r.out);
    expect(body).toMatchObject({ ok: true, tenant: id, status: "provisioning", pending: "invite" });
    const secret = readFileSync(join(dir, "secrets", id, "postgres-url"), "utf8").trim();
    const password = decodeURIComponent(new URL(secret).password);
    expect(r.out).not.toContain(password);
    expect(r.err).not.toContain(password);
    expect(JSON.parse((await run("list", "--json")).out).tenants).toEqual([
      { id, status: "provisioning", mode: null, hostname: `${id}.example.test` },
    ]);
  });

  it("migrates one tenant as its owner role, applying nothing new", async () => {
    const r = await run("migrate", id);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ ok: true, tenant: id, applied: [] });
  });

  it("suspends, resumes and sets limits", async () => {
    const e = new PostgresEngine({ url: control.url, max: 1 });
    try {
      await e.query(`UPDATE tenants SET status = 'active' WHERE id = $1`, [id]);
    } finally {
      await e.close();
    }
    expect(JSON.parse((await run("suspend", id, "--mode", "read-only")).out))
      .toMatchObject({ status: "suspended", mode: "read-only", jobs_still_running: [] });
    expect(JSON.parse((await run("list", "--json", "--status", "suspended")).out).tenants.map((t: { id: string }) => t.id)).toEqual([id]);
    expect(JSON.parse((await run("resume", id)).out)).toMatchObject({ status: "active" });
    expect(JSON.parse((await run("limits", id, "--set", "max-pages=10,max-usd-per-day=none")).out).limits)
      .toEqual({ maxMembers: 1, maxPages: 10 });
    const bad = await run("limits", id, "--set", "max-pages=ten");
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("invalid_limits");
  });

  it("records a smoke stamp and sets the hosting cap", async () => {
    const r = await run("smoke-record", id, "--boot-id", "0a1b2c3d-4e5f-4061-8293-a4b5c6d7e8f9", "--image-stamp", "v1.23.0", "--started-at", new Date().toISOString());
    expect(r.code).toBe(0);
    expect(JSON.parse((await run("cap", "--usd", "12.5", "--llm-off")).out)).toEqual({ ok: true, cap_usd: 12.5, llm_off: true });
    expect(JSON.parse((await run("cap", "--llm-on")).out)).toEqual({ ok: true, cap_usd: 12.5, llm_off: false });
    expect(JSON.parse((await run("spend", "--days", "3")).out)).toMatchObject({ ok: true, days: [], tenants: [] });
  });

  it("writes usage events, and a second run for the same day replaces them", async () => {
    const file = join(dir, "usage.jsonl");
    const date = new Date().toISOString().slice(0, 10);
    const first = JSON.parse((await run("usage", id, "--date", date, "--out", file)).out);
    expect(first.events.map((e: { metric: string }) => e.metric)).toEqual(["seats", "pages", "llm_usd", "storage_bytes"]);
    expect(first.events[0]).toEqual({ tenant: id, date, metric: "seats", value: 1 });
    await run("usage", id, "--date", date, "--out", file);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(4);
  });
});
