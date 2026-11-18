/**
 * `tenant create` on a real Postgres: idempotent, resumable after a failed
 * step, never reuses a deleted id, refuses a hostile id, and leaves a tenant
 * whose roles reach only its own database. Skipped unless
 * MEMRAIN_TEST_POSTGRES_URL points at a scratch Postgres (superuser).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { statSync } from "node:fs";
import { join } from "node:path";
import { PostgresEngine } from "../src/core/engine/postgres.ts";
import { createTenant } from "../src/control/provision.ts";
import { MemberInviteError } from "../src/core/member-invites.ts";
import { getTenant, tenantEvents } from "../src/control/tenants.ts";
import { PG_URL } from "./helpers/control-pg.ts";
import { openControlFixture, type ControlFixture } from "./helpers/control-tenants.ts";

setDefaultTimeout(120_000);

describe.skipIf(!PG_URL)("tenant create on Postgres", () => {
  let fx: ControlFixture;
  beforeAll(async () => {
    fx = await openControlFixture(PG_URL!);
  });
  afterAll(async () => {
    await fx.close();
  });

  it("creates an active tenant with a connector, an owner and private secrets", async () => {
    const id = fx.tenantId("acme");
    const r = await fx.create(id);
    expect(r.status).toBe("active");
    expect(r.pending).toBeNull();
    expect(r.invite?.url).toStartWith(`https://${id}.example.test/app/invite#`);
    expect(r.connectorClientId).toStartWith("memrain_cl_");
    const row = await getTenant(fx.control, id);
    expect(row).toMatchObject({ status: "active", dbName: `tenant_${id}`, ownerMember: "owner" });

    for (const name of ["postgres-url", "control-url", "internal-token"] as const) {
      const st = statSync(join(fx.secretsDir, id, name));
      expect(st.mode & 0o777).toBe(0o600);
    }
    expect(statSync(join(fx.secretsDir, id)).mode & 0o777).toBe(0o700);

    const brain = new PostgresEngine({ url: fx.secret(id, "postgres-url"), max: 1 });
    try {
      const client = await brain.query<{ tenant_mode: string; token_endpoint_auth_method: string; redirect_uris: string[] }>(
        `SELECT tenant_mode, token_endpoint_auth_method, redirect_uris FROM oauth_clients WHERE client_id = $1`,
        [r.connectorClientId],
      );
      expect(client.rows[0]).toMatchObject({ tenant_mode: "enrollment", token_endpoint_auth_method: "none" });
      const member = await brain.query<{ personal_source_id: string }>(`SELECT personal_source_id FROM members WHERE id = 'owner'`);
      expect(member.rows[0]?.personal_source_id).toBe("person-owner");
    } finally {
      await brain.close();
    }
  });

  it("running create again for an active tenant changes nothing and makes no duplicate", async () => {
    const id = fx.tenantId("twice");
    const first = await fx.create(id);
    const again = await fx.create(id);
    expect(again).toMatchObject({ status: "active", alreadyActive: true, ran: [] });
    expect(again.connectorClientId).toBe(first.connectorClientId);
    const brain = new PostgresEngine({ url: fx.secret(id, "postgres-url"), max: 1 });
    try {
      const n = await brain.query<{ n: number }>(`SELECT count(*)::int AS n FROM oauth_clients`);
      expect(n.rows[0]!.n).toBe(1);
    } finally {
      await brain.close();
    }
  });

  it("a failure at the migrations step leaves provisioning; --resume finishes it", async () => {
    const id = fx.tenantId("halfway");
    const failing = { ...fx.ctx, beforeStep: (s: string) => { if (s === "migrations") throw new Error("injected failure"); } };
    await expect(createTenant(failing, { id, hostname: `${id}.example.test` })).rejects.toThrow("injected failure");
    expect((await getTenant(fx.control, id))?.status).toBe("provisioning");
    await expect(fx.create(id)).rejects.toMatchObject({ code: "exists" });
    const done = await fx.create(id, { resume: true });
    expect(done.status).toBe("active");
    expect(done.ran).toContain("migrations");
    const kinds = (await tenantEvents(fx.control, id)).map((e) => e.kind);
    expect(kinds.filter((k) => k === "provision:row")).toHaveLength(1);
    expect(kinds.slice(-2)).toEqual(["active", "provision:postcheck"]);
  });

  it("without member invites the tenant waits in provisioning", async () => {
    const id = fx.tenantId("noinvite");
    const unavailable = async (): Promise<never> => { throw new MemberInviteError("not_implemented", "member invites are not available"); };
    const r = await createTenant({ ...fx.ctx, mintInvite: unavailable }, { id, hostname: `${id}.example.test` });
    expect(r).toMatchObject({ status: "provisioning", pending: "invite", invite: null });
  });

  it("with member invites the tenant goes active and hands out the owner's invite link", async () => {
    const id = fx.tenantId("invited");
    const r = await createTenant({ ...fx.ctx, mintInvite: undefined }, { id, hostname: `${id}.example.test` });
    expect(r).toMatchObject({ status: "active", pending: null });
    expect(r.invite?.url).toStartWith(`https://${id}.example.test/app/invite#`);
  });

  it("a deleted id is never reused, and a hostile id never reaches SQL", async () => {
    const id = fx.tenantId("gone");
    await fx.create(id);
    await fx.control.query(`UPDATE tenants SET status = 'deleted' WHERE id = $1`, [id]);
    await expect(fx.create(id)).rejects.toMatchObject({ code: "retired" });
    await expect(createTenant(fx.ctx, { id: "a; drop", hostname: "x.example.test" })).rejects.toMatchObject({ code: "invalid_id" });
    await expect(createTenant(fx.ctx, { id: "Bad", hostname: "x.example.test" })).rejects.toMatchObject({ code: "invalid_id" });
  });

  it("one tenant's owner role cannot connect to another tenant's database", async () => {
    const a = fx.tenantId("iso-a");
    const b = fx.tenantId("iso-b");
    await fx.create(a);
    await fx.create(b);
    const aUrl = new URL(fx.secret(a, "postgres-url"));
    aUrl.pathname = `/tenant_${b}`;
    const probe = new PostgresEngine({ url: aUrl.toString(), max: 1 });
    try {
      await expect(probe.query("SELECT 1")).rejects.toThrow(/permission denied|not have CONNECT/i);
    } finally {
      await probe.close();
    }
  });
});
