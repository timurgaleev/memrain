/**
 * The hosting-wide spend cap in the control database, with real concurrent
 * transactions from three tenants' control logins:
 *   - spent + reserved never passes the cap, for the install or for a tenant;
 *   - an actual above its reservation is booked in full, the overrun is
 *     exactly the sum of (actual - hold), and paid calls go off for everyone;
 *   - a reservation past its TTL turns into spend, never into free room.
 * Skipped unless MEMRAIN_TEST_POSTGRES_URL points at a scratch Postgres.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { PostgresEngine } from "../src/core/engine/postgres.ts";
import { controlSpendBackend, type HostingSpendBackend } from "../src/control/hosting-spend.ts";
import { setTenantLimits } from "../src/control/tenants.ts";
import { PG_URL } from "./helpers/control-pg.ts";
import { openControlFixture, type ControlFixture } from "./helpers/control-tenants.ts";

setDefaultTimeout(180_000);

describe.skipIf(!PG_URL)("hosting spend cap on Postgres", () => {
  let fx: ControlFixture;
  const ids: string[] = [];
  const logins: PostgresEngine[] = [];
  const backends: HostingSpendBackend[] = [];

  beforeAll(async () => {
    fx = await openControlFixture(PG_URL!);
    for (const base of ["spend-a", "spend-b", "spend-c"]) {
      const id = fx.tenantId(base);
      ids.push(id);
      await fx.create(id);
      await setTenantLimits(fx.control, id, { maxUsdPerDay: null });
      const e = new PostgresEngine({ url: fx.secret(id, "control-url"), max: 8 });
      logins.push(e);
      backends.push(controlSpendBackend(e));
    }
  });
  afterAll(async () => {
    for (const e of logins) await e.close();
    await fx.close();
  });
  beforeEach(async () => {
    await fx.control.query(`DELETE FROM hosting_spend_reservations`);
    await fx.control.query(`DELETE FROM tenant_spend_windows`);
    await fx.control.query(`DELETE FROM hosting_spend_windows`);
    await fx.control.query(`UPDATE hosting_settings SET cap_usd = 1, llm_off = false`);
  });

  async function window(): Promise<{ spent: number; reserved: number; llm_off: boolean }> {
    const r = await fx.control.query<{ spent: string; reserved: string; llm_off: boolean }>(
      `SELECT spent_usd AS spent, reserved_usd AS reserved, llm_off FROM hosting_spend_windows`,
    );
    const w = r.rows[0]!;
    return { spent: Number(w.spent), reserved: Number(w.reserved), llm_off: w.llm_off };
  }

  it("fifty parallel reservations from three tenants never pass the hosting cap", async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => backends[i % 3]!.reserve(0.07, 600)),
    );
    const granted = results.filter((r) => r.ok).length;
    // 1.00 / 0.07: exactly 14 fit.
    expect(granted).toBe(14);
    const w = await window();
    expect(w.spent + w.reserved).toBeLessThanOrEqual(1);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === "hosting_cap")).toBe(true);
  });

  it("a tenant's own daily cap holds under the same race", async () => {
    await setTenantLimits(fx.control, ids[0]!, { maxUsdPerDay: 0.2 });
    try {
      const results = await Promise.all(Array.from({ length: 20 }, () => backends[0]!.reserve(0.03, 600)));
      expect(results.filter((r) => r.ok)).toHaveLength(6);
      expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === "tenant_cap")).toBe(true);
      // Another tenant still has the install's room.
      expect((await backends[1]!.reserve(0.03, 600)).ok).toBe(true);
    } finally {
      await setTenantLimits(fx.control, ids[0]!, { maxUsdPerDay: null });
    }
  });

  it("an overrun is booked in full, equals the sum of actual minus hold, and turns paid calls off", async () => {
    const holds = await Promise.all([backends[0]!.reserve(0.1, 600), backends[1]!.reserve(0.1, 600), backends[2]!.reserve(0.1, 600)]);
    const actuals = [0.05, 0.13, 0.12];
    let overruns = 0;
    for (let i = 0; i < 3; i++) {
      const h = holds[i]!;
      if (!h.ok) throw new Error("reserve refused");
      const s = await backends[i]!.settle(h.id, actuals[i]!);
      if (s.overrun) overruns++;
    }
    expect(overruns).toBe(2);
    const w = await window();
    expect(w.reserved).toBe(0);
    expect(w.spent).toBeCloseTo(0.3, 9);
    expect(w.spent - (0.05 + 0.1 + 0.1)).toBeCloseTo((0.13 - 0.1) + (0.12 - 0.1), 9);
    expect(w.llm_off).toBe(true);
    expect(await backends[0]!.reserve(0.01, 600)).toEqual({ ok: false, reason: "llm_off" });
    const self = await logins[1]!.query<{ s: { llm_off: boolean } }>(`SELECT tenant_self() AS s`);
    expect(self.rows[0]!.s.llm_off).toBe(true);
  });

  it("a reservation abandoned past its TTL becomes spend, not free room", async () => {
    const h = await backends[0]!.reserve(0.4, 600);
    if (!h.ok) throw new Error("reserve refused");
    await fx.control.query(`UPDATE hosting_spend_reservations SET expires_at = now() - interval '1 second' WHERE id = $1`, [h.id]);
    // Another tenant cannot sweep it, but it still counts as reserved.
    expect((await backends[1]!.reserve(0.7, 600)).ok).toBe(false);
    expect(await window()).toMatchObject({ spent: 0, reserved: 0.4 });
    // Its own tenant's next reservation sweeps it into spend.
    expect((await backends[0]!.reserve(0.7, 600)).ok).toBe(false);
    const w = await window();
    expect(w).toMatchObject({ spent: 0.4, reserved: 0 });
    const r = await fx.control.query<{ outcome: string }>(`SELECT outcome FROM hosting_spend_reservations WHERE id = $1`, [h.id]);
    expect(r.rows[0]!.outcome).toBe("expired");
    // A late settle of an expired reservation changes nothing.
    expect(await backends[0]!.settle(h.id, 0)).toMatchObject({ ok: false, reason: "not_open" });
  });

  it("a settle arriving after the TTL never frees the hold, and a late actual above it is still booked", async () => {
    const lapse = (id: string) => fx.control.query(
      `UPDATE hosting_spend_reservations SET expires_at = now() - interval '1 second' WHERE id = $1`, [id]);
    // Not yet swept: a $0 settle past the TTL books the whole hold.
    const a = await backends[0]!.reserve(0.2, 600);
    if (!a.ok) throw new Error("reserve refused");
    await lapse(a.id);
    expect(await backends[0]!.settle(a.id, 0)).toMatchObject({ ok: true, overrun: false });
    expect(await window()).toMatchObject({ spent: 0.2, reserved: 0, llm_off: false });
    // Swept first, then the call reports more than it held: the rest is booked once.
    const b = await backends[0]!.reserve(0.1, 600);
    if (!b.ok) throw new Error("reserve refused");
    await lapse(b.id);
    await fx.control.query(`SELECT hosting_expire()`);
    expect(await backends[0]!.settle(b.id, 0.15)).toMatchObject({ ok: true, overrun: true });
    expect(await backends[0]!.settle(b.id, 0.15)).toMatchObject({ ok: false, reason: "not_open" });
    const w = await window();
    expect(w.spent).toBeCloseTo(0.35, 9);
    expect(w.llm_off).toBe(true);
  });

  it("one tenant's reservation sweeps only its own expired rows", async () => {
    const other = await backends[1]!.reserve(0.1, 600);
    if (!other.ok) throw new Error("reserve refused");
    await fx.control.query(`UPDATE hosting_spend_reservations SET expires_at = now() - interval '1 second' WHERE id = $1`, [other.id]);
    expect((await backends[0]!.reserve(0.01, 600)).ok).toBe(true);
    const r = await fx.control.query<{ settled: boolean }>(
      `SELECT settled_at IS NOT NULL AS settled FROM hosting_spend_reservations WHERE id = $1`, [other.id]);
    expect(r.rows[0]!.settled).toBe(false);
  });

  it("a tenant cannot settle another tenant's reservation, and a suspended tenant reserves nothing", async () => {
    const h = await backends[0]!.reserve(0.1, 600);
    if (!h.ok) throw new Error("reserve refused");
    expect(await backends[1]!.settle(h.id, 0)).toMatchObject({ ok: false, reason: "not_open" });
    await fx.control.query(`UPDATE tenants SET status = 'suspended', mode = 'read-only' WHERE id = $1`, [ids[2]]);
    try {
      expect(await backends[2]!.reserve(0.01, 600)).toEqual({ ok: false, reason: "tenant_inactive" });
    } finally {
      await fx.control.query(`UPDATE tenants SET status = 'active', mode = NULL WHERE id = $1`, [ids[2]]);
    }
  });

  it("the operator's switch refuses every reservation", async () => {
    await fx.control.query(`UPDATE hosting_settings SET llm_off = true`);
    expect(await backends[0]!.reserve(0.01, 600)).toEqual({ ok: false, reason: "llm_off" });
  });
});
