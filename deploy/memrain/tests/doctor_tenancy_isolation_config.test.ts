/**
 * doctor `tenancy-isolation-config`: with more than one live non-operator
 * credential, a grantless caller reads the whole brain unless
 * MEMRAIN_TENANT_FAIL_CLOSED is on. The check warns in exactly that state.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { checkTenancyIsolationConfig } from "../src/core/doctor-tenancy.ts";

let tmp: string;
let storage: Storage;
const saved = process.env["MEMRAIN_TENANT_FAIL_CLOSED"];

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-isolation-config-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  delete process.env["MEMRAIN_TENANT_FAIL_CLOSED"];
});

afterEach(async () => {
  if (saved === undefined) delete process.env["MEMRAIN_TENANT_FAIL_CLOSED"];
  else process.env["MEMRAIN_TENANT_FAIL_CLOSED"] = saved;
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function pat(name: string, revoked = false): Promise<void> {
  await storage.raw().query(
    `INSERT INTO access_tokens (name, token_hash, scopes, revoked_at) VALUES ($1, $2, '{read}', $3)`,
    [name, `hash-${name}`, revoked ? new Date().toISOString() : null],
  );
}

async function client(id: string, deleted = false): Promise<void> {
  await storage.raw().query(
    `INSERT INTO oauth_clients (client_id, client_name, deleted_at) VALUES ($1, $1, $2)`,
    [id, deleted ? new Date().toISOString() : null],
  );
}

describe("tenancy-isolation-config", () => {
  it("is ok with a single non-operator credential", async () => {
    await pat("laptop");
    const c = await checkTenancyIsolationConfig(storage.raw());
    expect(c).toMatchObject({ name: "tenancy-isolation-config", ok: true, status: "ok" });
  });

  it("warns when two credentials share a brain without fail-closed", async () => {
    await pat("laptop");
    await client("team-bot");
    const c = await checkTenancyIsolationConfig(storage.raw());
    expect(c.status).toBe("warn");
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("MEMRAIN_TENANT_FAIL_CLOSED=1");
    expect(c.detail).toContain("2 live");
  });

  it("is ok with several credentials once fail-closed is on", async () => {
    await pat("laptop");
    await pat("phone");
    process.env["MEMRAIN_TENANT_FAIL_CLOSED"] = "1";
    const c = await checkTenancyIsolationConfig(storage.raw());
    expect(c.status).toBe("ok");
  });

  it("does not count revoked tokens or deleted clients", async () => {
    await pat("laptop");
    await pat("old", true);
    await client("gone", true);
    const c = await checkTenancyIsolationConfig(storage.raw());
    expect(c.status).toBe("ok");
  });

  it("turns a probe failure into a warn, never an ok", async () => {
    await storage.raw().query(`ALTER TABLE access_tokens RENAME TO access_tokens_moved`);
    const c = await checkTenancyIsolationConfig(storage.raw());
    expect(c.status).toBe("warn");
    await storage.raw().query(`ALTER TABLE access_tokens_moved RENAME TO access_tokens`);
  });
});
