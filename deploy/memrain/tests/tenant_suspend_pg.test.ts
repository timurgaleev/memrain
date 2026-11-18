/**
 * Gate 3 (and the A6 isolation stamp): a hosted tenant's container held by
 * the control plane, over real HTTP and a real control login.
 *   - Until the isolation smoke is stamped after the container started, only
 *     /health answers; a stamp from before a restart does not count.
 *   - `block`: every route class but health answers 403 tenant_suspended.
 *   - `read-only`: write and auth routes answer 403; /mcp serves every
 *     read-only operation of the registry and refuses every other one with
 *     tenant_suspended.
 *   - Queued jobs are not claimed, and a running job is handed back.
 *   - Suspend and resume leave every table's rows and content as they were.
 * Skipped unless MEMRAIN_TEST_POSTGRES_URL points at a scratch Postgres.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { randomUUID } from "node:crypto";
import { PostgresEngine } from "../src/core/engine/postgres.ts";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { startServer, type ServerHandle } from "../src/http/server.ts";
import { Queue } from "../src/core/jobs/queue.ts";
import { Worker } from "../src/core/jobs/worker.ts";
import { _resetHandlersForTesting, registerHandler } from "../src/core/jobs/handlers.ts";
import { hashTable, planCopy, readCatalog } from "../src/core/engine-copy.ts";
import { HOSTING_ENV, setTenantPolicySource } from "../src/control/contract.ts";
import { controlPolicySource, resetControlClient, type TenantSelf } from "../src/control/policy.ts";
import { resumeTenant, suspendTenant } from "../src/control/tenants.ts";
import { recordSmoke } from "../src/control/usage.ts";
import { ROUTE_CLASSES } from "../src/core/tenant-guard.ts";
import { OPERATIONS, operationAnnotations } from "../src/mcp/operations.ts";
import { PG_URL, withDatabase } from "./helpers/control-pg.ts";
import { openControlFixture, type ControlFixture } from "./helpers/control-tenants.ts";

setDefaultTimeout(300_000);

const BOOT = randomUUID();
const IMAGE = "test-image-stamp";

describe.skipIf(!PG_URL)("a held tenant over HTTP", () => {
  let fx: ControlFixture;
  let id: string;
  let storage: Storage;
  let ctl: PostgresEngine;
  let server: ServerHandle;
  let base: string;
  let startedAt = new Date(Date.now() - 60_000);
  const saved = new Map<string, string | undefined>();

  function installSource(): void {
    setTenantPolicySource(controlPolicySource({
      readSelf: async () => (await ctl.query<{ s: TenantSelf | null }>(`SELECT tenant_self() AS s`)).rows[0]?.s ?? null,
      identity: () => ({ startedAt, bootId: BOOT, imageStamp: IMAGE }),
      ttlMs: 0,
    }));
  }

  beforeAll(async () => {
    fx = await openControlFixture(PG_URL!);
    id = fx.tenantId("held");
    await fx.create(id);
    for (const k of Object.values(HOSTING_ENV)) saved.set(k, process.env[k]);
    process.env["MEMRAIN_TENANT_ID"] = id;
    process.env["MEMRAIN_CONTROL_URL"] = "set-by-the-test-source";
    ctl = new PostgresEngine({ url: fx.secret(id, "control-url"), max: 2 });
    installSource();
    storage = new Storage(new PostgresEngine({ url: fx.secret(id, "postgres-url"), max: 4 }));
    await storage.init();
    await putPage(storage, { slug: "notes/kept", markdown_body: "This page must survive the hold.", source_id: "default", title: "Kept" });
    server = startServer({ host: "127.0.0.1", port: 0, storage });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    await server.stop();
    await storage.close();
    await ctl.close();
    setTenantPolicySource(null);
    resetControlClient();
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await fx.close();
  });

  const mcp = (method: string, params: Record<string, unknown> = {}) => fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

  function samplePath(path: string, prefix?: true): string {
    return prefix ? `${path.endsWith("/") ? path : `${path}/`}probe` : path;
  }

  it("A6: until the smoke is stamped after this container started, only /health answers", async () => {
    expect((await fetch(`${base}/health`)).status).toBe(200);
    const before = await mcp("tools/list");
    expect(before.status).toBe(503);
    expect(await before.json()).toEqual({ ok: false, error: "isolation_unverified" });

    await recordSmoke(fx.control, id, { startedAt, bootId: BOOT, imageStamp: IMAGE });
    expect((await mcp("tools/list")).status).toBe(200);

    // A restart after the stamp: the old stamp no longer counts.
    startedAt = new Date(Date.now() + 1_000);
    installSource();
    expect((await mcp("tools/list")).status).toBe(503);
    startedAt = new Date(Date.now() - 60_000);
    installSource();
    expect((await mcp("tools/list")).status).toBe(200);
  });

  it("suspend and resume leave every table as it was", async () => {
    const master = new PostgresEngine({ url: withDatabase(fx.masterUrl, `tenant_${id}`), max: 1 });
    try {
      const cat = await readCatalog(master);
      const plan = planCopy(cat, cat);
      const snap = async () => Promise.all(plan.tables.map(async (t) => ({ t: t.name, ...(await hashTable(master, t)) })));
      const before = await snap();
      await suspendTenant(fx.control, id, "block");
      await suspendTenant(fx.control, id, "read-only");
      await resumeTenant(fx.control, id);
      expect(await snap()).toEqual(before);
    } finally {
      await master.close();
    }
  });

  it("block: every route class but health answers 403 tenant_suspended", async () => {
    await suspendTenant(fx.control, id, "block");
    try {
      for (const e of ROUTE_CLASSES) {
        const method = e.methods[0]!;
        const res = await fetch(`${base}${samplePath(e.path, e.prefix)}`, { method, ...(method === "POST" ? { body: "{}" } : {}) });
        const want = e.cls === "health" ? 200 : 403;
        if (e.cls === "health" && e.prefix) {
          expect({ path: e.path, refused: res.status === 403 }).toEqual({ path: e.path, refused: false });
        } else {
          expect({ path: e.path, method, status: res.status }).toEqual({ path: e.path, method, status: want });
        }
      }
      const unknown = await fetch(`${base}/no-such-route`, { method: "POST" });
      expect(unknown.status).toBe(403);
    } finally {
      await resumeTenant(fx.control, id);
    }
  });

  it("read-only: changes are refused on every route and every write operation; reads answer", async () => {
    await suspendTenant(fx.control, id, "read-only");
    try {
      for (const e of ROUTE_CLASSES.filter((x) => x.cls === "write" || x.cls === "auth")) {
        const method = e.methods.find((m) => m !== "OPTIONS")!;
        const res = await fetch(`${base}${samplePath(e.path, e.prefix)}`, { method, ...(method === "POST" ? { body: "{}" } : {}) });
        expect({ path: e.path, status: res.status }).toEqual({ path: e.path, status: 403 });
      }
      expect((await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } })).status).toBe(200);
      expect((await mcp("tools/list")).status).toBe(200);
      const wrong: string[] = [];
      for (const op of OPERATIONS) {
        const res = await mcp("tools/call", { name: op.name, arguments: {} });
        const text = await res.text();
        const suspended = text.includes("tenant_suspended");
        if (suspended === operationAnnotations(op).readOnlyHint) wrong.push(`${op.name}: suspended=${suspended}`);
      }
      expect(wrong).toEqual([]);
      const page = await mcp("tools/call", { name: "page_get", arguments: { slug: "notes/kept" } });
      expect(await page.text()).toContain("This page must survive the hold.");
    } finally {
      await resumeTenant(fx.control, id);
    }
  });

  it("a held tenant claims no queued job and hands back the one that is running", async () => {
    _resetHandlersForTesting();
    const queue = new Queue(storage.engine());
    let entered!: () => void;
    const running = new Promise<void>((r) => { entered = r; });
    registerHandler("hold-probe", async (_payload, ctx) => {
      entered();
      await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
      throw ctx.signal.reason;
    });
    const worker = new Worker(queue, { intervalMs: 20, lockSeconds: 1, engine: storage.engine(), workerLockId: `held-${id}`, logger: () => {} });
    await queue.enqueue({ kind: "hold-probe", id: `run-${id}`, maxRetries: 3 });
    worker.start();
    await running;
    await suspendTenant(fx.control, id, "read-only");
    try {
      const deadline = Date.now() + 10_000;
      let status = "running";
      while (status === "running" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        status = (await storage.engine().query<{ status: string }>(`SELECT status FROM jobs WHERE id = $1`, [`run-${id}`])).rows[0]!.status;
      }
      expect(status).toBe("pending");
      await queue.enqueue({ kind: "hold-probe", id: `queued-${id}`, maxRetries: 3 });
      expect(await worker.drainOnce()).toBe(0);
    } finally {
      await worker.stop();
      await resumeTenant(fx.control, id);
      _resetHandlersForTesting();
    }
  });
});
