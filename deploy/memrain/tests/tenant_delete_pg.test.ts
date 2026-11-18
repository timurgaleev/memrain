/**
 * Gate 4: a tenant is never deleted without a verified export taken behind a
 * database-level fence.
 *   - a purge without a good receipt under the current fence does nothing;
 *     a live export never counts;
 *   - a writer racing the delete is cut off at the fence: everything it wrote
 *     before is in the export, nothing after;
 *   - the exported PGLite brain matches the frozen database table by table;
 *   - resuming in the window voids the receipt; the window must pass first.
 * Skipped unless MEMRAIN_TEST_POSTGRES_URL points at a scratch Postgres.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgresEngine } from "../src/core/engine/postgres.ts";
import { PGliteEngine } from "../src/core/engine/pglite.ts";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { planCopy, readCatalog, verifyTables } from "../src/core/engine-copy.ts";
import { cancelDelete, currentReceipt, deleteTenant, exportTenant, purgeDeleted } from "../src/control/export.ts";
import { requireTenant, suspendTenant } from "../src/control/tenants.ts";
import { PG_URL, withDatabase } from "./helpers/control-pg.ts";
import { openControlFixture, type ControlFixture } from "./helpers/control-tenants.ts";

setDefaultTimeout(240_000);

describe.skipIf(!PG_URL)("tenant delete behind a fence", () => {
  let fx: ControlFixture;
  let out: string;
  beforeAll(async () => {
    fx = await openControlFixture(PG_URL!);
    out = mkdtempSync(join(tmpdir(), "memrain-tenant-export-"));
  });
  afterAll(async () => {
    await fx.close();
    rmSync(out, { recursive: true, force: true });
  });
  const ctx = () => ({ masterUrl: fx.masterUrl, control: fx.control });

  async function brain(id: string): Promise<Storage> {
    const s = new Storage(new PostgresEngine({ url: fx.secret(id, "postgres-url"), max: 2 }));
    await s.init();
    return s;
  }

  it("a live export copies everything but never authorises a purge", async () => {
    const id = fx.tenantId("live");
    await fx.create(id);
    const s = await brain(id);
    try {
      await putPage(s, { slug: "people/alice", markdown_body: "Alice runs the garden.", source_id: "default", title: "Alice" });
    } finally {
      await s.close();
    }
    const receipt = await exportTenant(ctx(), id, join(out, "live"));
    expect(receipt).toMatchObject({ kind: "live", fenceId: null, ok: true, pages: 1 });
    expect(existsSync(join(out, "live", "markdown", "people", "alice.md"))).toBe(true);
    await fx.control.query(`UPDATE tenants SET status = 'deleting', delete_after = now() - interval '1 day' WHERE id = $1`, [id]);
    const r = await purgeDeleted(ctx());
    expect(r.purged).toEqual([]);
    expect(r.skipped.map((x) => x.id)).toContain(id);
    const db = await fx.control.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [`tenant_${id}`]);
    expect(db.rows).toHaveLength(1);
    await fx.control.query(`UPDATE tenants SET status = 'active', delete_after = NULL WHERE id = $1`, [id]);
  });

  it("a writer racing the delete is cut off at the fence, and the export holds exactly what it wrote before", async () => {
    const id = fx.tenantId("race");
    await fx.create(id);
    const s = await brain(id);
    const acked: string[] = [];
    let stop = false;
    let refusedAfterFence = 0;
    let n = 0;
    const writer = (async () => {
      while (!stop) {
        const slug = `notes/n-${n++}`;
        try {
          await putPage(s, { slug, markdown_body: `note ${slug}`, source_id: "default", title: slug });
          acked.push(slug);
        } catch {
          refusedAfterFence++;
          await new Promise((r) => setTimeout(r, 20));
        }
      }
    })();
    while (acked.length < 5) await new Promise((r) => setTimeout(r, 20));
    const { receipt, deleteAfter } = await deleteTenant(ctx(), id, id, join(out, "race"));
    const ackedAtFence = acked.length;
    // Give the writer time to try again behind the fence.
    await new Promise((r) => setTimeout(r, 400));
    stop = true;
    await writer;
    await s.close().catch(() => undefined);

    expect(receipt).toMatchObject({ kind: "fenced", ok: true });
    expect(refusedAfterFence).toBeGreaterThan(0);
    expect(acked.length).toBe(ackedAtFence);
    expect(deleteAfter.getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    const t = await requireTenant(fx.control, id);
    expect(t.status).toBe("deleting");
    expect(await currentReceipt(fx.control, t)).toEqual({ id: receipt.id });

    const exported = readdirSync(join(out, "race", "markdown", "notes")).map((f) => `notes/${f.replace(/\.md$/, "")}`).sort();
    expect(exported).toEqual([...acked].sort());

    // The PGLite brain matches the frozen database, every table.
    const master = new PostgresEngine({ url: withDatabase(fx.masterUrl, `tenant_${id}`), max: 1 });
    const copy = new PGliteEngine({ dbPath: join(out, "race", "brain") });
    try {
      await copy.ready();
      const plan = planCopy(await readCatalog(master), await readCatalog(copy));
      expect(plan.missing).toEqual([]);
      const reports = await verifyTables(master, copy, plan);
      expect(reports.filter((r) => !r.match)).toEqual([]);
      expect(reports.find((r) => r.name === "pages")?.src).toBeGreaterThanOrEqual(5);
    } finally {
      await master.close();
      await copy.close();
    }

    // The window has to pass.
    expect((await purgeDeleted(ctx())).purged).not.toContain(id);
    const r = await purgeDeleted(ctx(), { now: new Date(Date.now() + 8 * 86_400_000) });
    expect(r.purged).toContain(id);
    const db = await fx.control.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [`tenant_${id}`]);
    expect(db.rows).toEqual([]);
    const roles = await fx.control.query(`SELECT 1 FROM pg_roles WHERE rolname LIKE $1`, [`tenant_${id}_%`]);
    expect(roles.rows).toEqual([]);
    expect((await requireTenant(fx.control, id)).status).toBe("deleted");
  });

  it("a purge and a cancelled delete racing each other: exactly one wins, and a cancelled tenant keeps its database", async () => {
    for (let round = 0; round < 3; round++) {
      const id = fx.tenantId(`racecancel${round}`);
      await fx.create(id);
      await deleteTenant(ctx(), id, id, join(out, `racecancel${round}`));
      const [purge, cancel] = await Promise.allSettled([
        purgeDeleted(ctx(), { now: new Date(Date.now() + 8 * 86_400_000) }),
        cancelDelete(ctx(), id),
      ]);
      const purged = purge.status === "fulfilled" && purge.value.purged.includes(id);
      const cancelled = cancel.status === "fulfilled";
      expect({ round, one: purged !== cancelled }).toEqual({ round, one: true });
      const db = await fx.control.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [`tenant_${id}`]);
      expect(db.rows.length).toBe(cancelled ? 1 : 0);
      expect((await requireTenant(fx.control, id)).status).toBe(cancelled ? "active" : "deleted");
    }
  });

  it("a cancel racing a new delete leaves access matching the status", async () => {
    for (let round = 0; round < 3; round++) {
      const id = fx.tenantId(`refence${round}`);
      await fx.create(id);
      await deleteTenant(ctx(), id, id, join(out, `refence${round}-a`));
      await Promise.allSettled([
        cancelDelete(ctx(), id),
        deleteTenant(ctx(), id, id, join(out, `refence${round}-b`)),
      ]);
      const t = await requireTenant(fx.control, id);
      const r = await fx.control.query<{ login: boolean; connect: boolean }>(
        `SELECT rolcanlogin AS login, has_database_privilege(rolname, $2, 'CONNECT') AS connect FROM pg_roles WHERE rolname = $1`,
        [`tenant_${id}_owner`, `tenant_${id}`],
      );
      const open = t.status === "active";
      expect({ round, status: t.status, ...r.rows[0] }).toEqual({ round, status: t.status, login: open, connect: open });
    }
  });

  it("refuses to export into a directory that already holds files", async () => {
    const id = fx.tenantId("reuse");
    await fx.create(id);
    await exportTenant(ctx(), id, join(out, "reuse"));
    await expect(exportTenant(ctx(), id, join(out, "reuse"))).rejects.toMatchObject({ code: "wrong_state" });
  });

  it("cancelling the delete of a suspended tenant leaves it suspended in its mode, even after a second fence", async () => {
    const id = fx.tenantId("heldundo");
    await fx.create(id);
    await suspendTenant(fx.control, id, "block");
    await deleteTenant(ctx(), id, id, join(out, "heldundo-a"));
    let after = await cancelDelete(ctx(), id);
    expect({ status: after.status, mode: after.mode }).toEqual({ status: "suspended", mode: "block" });
    // A fence taken while already fenced (an export that failed and is run
    // again) still remembers the state before the first one.
    await fx.control.query(`UPDATE tenants SET status = 'deleting', mode = NULL, delete_after = NULL WHERE id = $1`, [id]);
    await fx.control.query(`INSERT INTO tenant_events (tenant_id, kind, detail) VALUES ($1, 'fence', $2::jsonb)`, [id, JSON.stringify({ fence: "x", before: { status: "suspended", mode: "read-only" } })]);
    await deleteTenant(ctx(), id, id, join(out, "heldundo-b"));
    after = await cancelDelete(ctx(), id);
    expect({ status: after.status, mode: after.mode }).toEqual({ status: "suspended", mode: "read-only" });
    const r = await fx.control.query<{ login: boolean; connect: boolean }>(
      `SELECT rolcanlogin AS login, has_database_privilege(rolname, $2, 'CONNECT') AS connect FROM pg_roles WHERE rolname = $1`,
      [`tenant_${id}_owner`, `tenant_${id}`],
    );
    expect(r.rows[0]).toEqual({ login: true, connect: true });
  });

  it("resuming in the window lifts the fence and voids the receipt", async () => {
    const id = fx.tenantId("undo");
    await fx.create(id);
    await deleteTenant(ctx(), id, id, join(out, "undo"));
    const before = await requireTenant(fx.control, id);
    expect(await currentReceipt(fx.control, before)).not.toBeNull();
    const after = await cancelDelete(ctx(), id);
    expect(after.status).toBe("active");
    expect(after.fenceId).not.toBe(before.fenceId);
    expect(await currentReceipt(fx.control, after)).toBeNull();
    const s = await brain(id);
    try {
      await putPage(s, { slug: "people/bob", markdown_body: "Bob is back.", source_id: "default", title: "Bob" });
    } finally {
      await s.close();
    }
    await expect(deleteTenant(ctx(), id, "wrong", join(out, "undo2"))).rejects.toMatchObject({ code: "wrong_state" });
  });
});
