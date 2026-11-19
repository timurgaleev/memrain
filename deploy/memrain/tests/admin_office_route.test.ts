/**
 * GET /admin/api/office: the names the live Office page seeds itself with.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { createAdminAuth } from "../src/http/admin.ts";
import { handleAdminApi } from "../src/http/admin-api.ts";
import { _resetOfficeRuntimeForTesting, noteCycleRun, noteOfficeRuntime, type OfficeSnapshot } from "../src/http/admin-office.ts";
import { _resetDaemonsForTesting, registerDaemon } from "../src/core/daemons/registry.ts";
import { pauseDaemon, resumeDaemon, setDaemonEnabled } from "../src/core/daemons/controls.ts";
import { NOTIFICATIONS_JOB_KIND } from "../src/core/notifications/daemon.ts";
import { _resetHandlersForTesting, registerHandler } from "../src/core/jobs/handlers.ts";

const BOOT = "boot-secret";
let tmp: string;
let storage: Storage;
let auth: ReturnType<typeof createAdminAuth>;
let cookie: string;
const savedDaemons = process.env.MEMRAIN_DAEMONS;
const savedBrainCap = process.env.MEMRAIN_DAILY_BUDGET_USD;
const noop = async () => ({});

function registerProbe(paid = false): void {
  registerDaemon({
    name: "probe",
    kind: "daemon_probe",
    schedule: { cron: "0 7 * * *" },
    lane: "short",
    paid,
    defaultEnabled: true,
  });
}

async function snapshot(): Promise<OfficeSnapshot> {
  const res = await call("/admin/api/office", { cookie });
  expect(res?.status).toBe(200);
  return (await res!.json()) as OfficeSnapshot;
}
const worker = (b: OfficeSnapshot, name: string) => b.workers.find((w) => w.name === name);

function call(path: string, headers: Record<string, string> = {}): Promise<Response | null> {
  return handleAdminApi(new Request(`http://localhost:8080${path}`, { headers }), new URL(`http://localhost:8080${path}`), {
    storage,
    requireAdmin: auth.requireAdmin,
  });
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-office-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  auth = createAdminAuth({ bootstrapToken: BOOT });
  const login = await auth.handleAuthRoute(
    new Request("http://localhost:8080/admin/login", { method: "POST", body: JSON.stringify({ token: BOOT }) }),
    new URL("http://localhost:8080/admin/login"),
  );
  cookie = (login!.headers.get("Set-Cookie") ?? "").split(";")[0]!;
});

afterEach(async () => {
  if (savedDaemons === undefined) delete process.env.MEMRAIN_DAEMONS;
  else process.env.MEMRAIN_DAEMONS = savedDaemons;
  if (savedBrainCap === undefined) delete process.env.MEMRAIN_DAILY_BUDGET_USD;
  else process.env.MEMRAIN_DAILY_BUDGET_USD = savedBrainCap;
  _resetHandlersForTesting();
  _resetOfficeRuntimeForTesting();
  _resetDaemonsForTesting();
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("GET /admin/api/office", () => {
  it("401s without an admin session", async () => {
    expect((await call("/admin/api/office"))?.status).toBe(401);
  });

  it("lists workers and clients, marking the daemon with a running job", async () => {
    const e = storage.engine();
    await e.query(
      `INSERT INTO jobs (id, kind, status, payload, last_error)
       VALUES ('daemon:connector_sync:acme:w1', 'connector_sync', 'running', '{"secret":"PAYLOAD-X"}', 'ERR-X')`,
    );
    await e.query(`INSERT INTO oauth_clients (client_id, client_name) VALUES ('cid-1', 'Claude Code')`);
    await e.query(`INSERT INTO oauth_clients (client_id, client_name, deleted_at) VALUES ('cid-gone', 'Old', NOW())`);
    await e.query(
      `INSERT INTO access_tokens (name, token_hash, last_used_at) VALUES ('laptop', 'HASH-LIVE', '2026-01-02T03:04:05Z')`,
    );
    await e.query(
      `INSERT INTO access_tokens (name, token_hash, revoked_at) VALUES ('stolen', 'HASH-REVOKED', NOW())`,
    );

    const res = await call("/admin/api/office", { cookie });
    expect(res?.status).toBe(200);
    const text = await res!.text();
    const body = JSON.parse(text) as OfficeSnapshot;

    const sync = body.workers.find((w) => w.name === "connector_sync");
    expect(sync?.running).toBe(true);
    expect(body.workers.find((w) => w.name === "notifications")?.running).toBe(false);
    expect(body.workers.find((w) => w.name === "worker")).toEqual({ name: "worker", enabled: false, running: false });

    expect(body.clients.map((c) => c.id).sort()).toEqual(["cid-1", "laptop", "public"]);
    expect(body.clients.find((c) => c.id === "laptop")?.display_name).toBe("laptop");
    expect(body.clients.find((c) => c.id === "laptop")?.last_seen).toContain("2026-01-02");
    expect(body.clients.find((c) => c.id === "public")).toEqual({ id: "public", display_name: "Shared key", last_seen: null });

    for (const leak of ["token_hash", "HASH-LIVE", "payload", "PAYLOAD-X", "last_error", "ERR-X", "stolen"]) {
      expect(text).not.toContain(leak);
    }
  });

  it("reports effective availability, not the configured switch", async () => {
    process.env.MEMRAIN_DAEMONS = "1";
    noteOfficeRuntime({ jobsWorker: true, cycleLoop: true });
    registerHandler(NOTIFICATIONS_JOB_KIND, noop);
    for (const daemon of ["notifications"]) {
      await setDaemonEnabled(storage.engine(), { daemon, enabled: true, by: "cli" });
    }
    let b = await snapshot();
    expect(worker(b, "notifications")?.enabled).toBe(true);
    expect(worker(b, "worker")?.enabled).toBe(true);
    expect(worker(b, "cycle")?.enabled).toBe(true);

    await pauseDaemon(storage.engine(), { daemon: "notifications", by: "cli" });
    b = await snapshot();
    expect(worker(b, "notifications")?.enabled).toBe(false);
    await resumeDaemon(storage.engine(), { daemon: "notifications", by: "cli" });
    expect(worker(await snapshot(), "notifications")?.enabled).toBe(true);

    process.env.MEMRAIN_DAEMONS = "0";
    expect(worker(await snapshot(), "notifications")?.enabled).toBe(false);
  });

  it("keeps worker and cycle off until serve notes what it started", async () => {
    let b = await snapshot();
    expect(worker(b, "worker")?.enabled).toBe(false);
    expect(worker(b, "cycle")?.enabled).toBe(false);

    noteOfficeRuntime({ jobsWorker: true, cycleLoop: false });
    b = await snapshot();
    expect(worker(b, "worker")?.enabled).toBe(true);
    expect(worker(b, "cycle")?.enabled).toBe(false);
  });

  it("shows a cycle in progress as running", async () => {
    noteOfficeRuntime({ jobsWorker: true, cycleLoop: true });
    expect(worker(await snapshot(), "cycle")?.running).toBe(false);
    noteCycleRun("start");
    expect(worker(await snapshot(), "cycle")?.running).toBe(true);
    noteCycleRun("end");
    expect(worker(await snapshot(), "cycle")?.running).toBe(false);
  });

  it("dates an OAuth app by its newest token and leaves an app without tokens undated", async () => {
    const e = storage.engine();
    await e.query(`INSERT INTO oauth_clients (client_id, client_name) VALUES ('cid-live', 'Live app'), ('cid-idle', 'Idle app')`);
    await e.query(
      `INSERT INTO oauth_tokens (token_hash, token_type, client_id, created_at)
       VALUES ('TOKEN-OLD', 'refresh', 'cid-live', NOW() - INTERVAL '3 days'),
              ('TOKEN-NEW', 'access', 'cid-live', NOW())`,
    );
    const res = await call("/admin/api/office", { cookie });
    const text = await res!.text();
    const b = JSON.parse(text) as OfficeSnapshot;
    const live = b.clients.find((c) => c.id === "cid-live")!;
    expect(live.last_seen).not.toBeNull();
    expect(Math.abs(Date.now() - Date.parse(live.last_seen!))).toBeLessThan(60_000);
    expect(b.clients.find((c) => c.id === "cid-idle")?.last_seen).toBeNull();
    expect(b.clients.find((c) => c.id === "public")?.last_seen).toBeNull();
    for (const leak of ["token_hash", "TOKEN-OLD", "TOKEN-NEW"]) expect(text).not.toContain(leak);
  });

  it("lists each client id once, OAuth and the shared key winning over a same-named PAT", async () => {
    const e = storage.engine();
    await e.query(`INSERT INTO oauth_clients (client_id, client_name) VALUES ('shared-name', 'Real client')`);
    await e.query(`INSERT INTO access_tokens (name, token_hash) VALUES ('shared-name', 'h-a'), ('public', 'h-b')`);
    const b = await snapshot();
    expect(b.clients.filter((c) => c.id === "shared-name")).toEqual([
      { id: "shared-name", display_name: "Real client", last_seen: null },
    ]);
    expect(b.clients.filter((c) => c.id === "public")).toEqual([
      { id: "public", display_name: "Shared key", last_seen: null },
    ]);
  });

  it("resolves a daemon per target, like the scheduler", async () => {
    process.env.MEMRAIN_DAEMONS = "1";
    noteOfficeRuntime({ jobsWorker: true, cycleLoop: false });
    registerHandler("daemon_probe", noop);
    registerDaemon({
      name: "probe",
      kind: "daemon_probe",
      schedule: { cron: "0 7 * * *" },
      lane: "short",
      paid: false,
      defaultEnabled: true,
      targets: async () => [{ sourceId: "a" }, { sourceId: "b" }],
    });
    const e = storage.engine();
    expect(worker(await snapshot(), "probe")?.enabled).toBe(true);

    await setDaemonEnabled(e, { daemon: "probe", sourceId: "a", enabled: false, by: "cli" });
    await pauseDaemon(e, { daemon: "probe", sourceId: "b", by: "cli" });
    expect(worker(await snapshot(), "probe")?.enabled).toBe(false);

    await setDaemonEnabled(e, { daemon: "probe", sourceId: "b", enabled: true, by: "cli" });
    await e.query("UPDATE daemon_controls SET paused = false WHERE daemon = 'probe' AND source_id = 'b'");
    expect(worker(await snapshot(), "probe")?.enabled).toBe(true);
  });

  it("treats the cycle as open unless paused, whatever its enabled switch says", async () => {
    noteOfficeRuntime({ jobsWorker: true, cycleLoop: true });
    const e = storage.engine();
    await setDaemonEnabled(e, { daemon: "cycle", enabled: false, by: "cli" });
    expect(worker(await snapshot(), "cycle")?.enabled).toBe(true);
    await pauseDaemon(e, { daemon: "cycle", by: "cli" });
    expect(worker(await snapshot(), "cycle")?.enabled).toBe(false);
  });

  it("keeps a scheduled daemon off while this process runs no job worker", async () => {
    process.env.MEMRAIN_DAEMONS = "1";
    registerProbe();
    registerHandler("daemon_probe", noop);
    expect(worker(await snapshot(), "probe")?.enabled).toBe(false);
    noteOfficeRuntime({ jobsWorker: true, cycleLoop: false });
    expect(worker(await snapshot(), "probe")?.enabled).toBe(true);
  });

  it("keeps a daemon off when this process has no handler for its kind", async () => {
    process.env.MEMRAIN_DAEMONS = "1";
    noteOfficeRuntime({ jobsWorker: true, cycleLoop: false });
    registerProbe();
    expect(worker(await snapshot(), "probe")?.enabled).toBe(false);
    registerHandler("daemon_probe", noop);
    expect(worker(await snapshot(), "probe")?.enabled).toBe(true);
  });

  it("keeps a paid daemon off without a brain-wide daily cap", async () => {
    process.env.MEMRAIN_DAEMONS = "1";
    delete process.env.MEMRAIN_DAILY_BUDGET_USD;
    noteOfficeRuntime({ jobsWorker: true, cycleLoop: false });
    registerProbe(true);
    registerHandler("daemon_probe", noop);
    expect(worker(await snapshot(), "probe")?.enabled).toBe(false);
    process.env.MEMRAIN_DAILY_BUDGET_USD = "5";
    expect(worker(await snapshot(), "probe")?.enabled).toBe(true);
  });

  it("caps display names and strips control characters", async () => {
    const long = `bell\u0007${"n".repeat(500)}`;
    const e = storage.engine();
    await e.query(`INSERT INTO access_tokens (name, token_hash) VALUES ($1, 'h-long')`, [long]);
    await e.query(`INSERT INTO oauth_clients (client_id, client_name) VALUES ('cid-long', $1)`, [`tab\t${"o".repeat(500)}\u007F`]);
    const b = await snapshot();
    const pat = b.clients.find((c) => c.id === long)!;
    expect(pat.display_name.length).toBeLessThanOrEqual(80);
    expect(pat.display_name.startsWith("bell")).toBe(true);
    const app = b.clients.find((c) => c.id === "cid-long")!;
    expect(app.display_name.length).toBeLessThanOrEqual(80);
    // eslint-disable-next-line no-control-regex
    for (const c of [pat, app]) expect(c.display_name).not.toMatch(/[\u0000-\u001F\u007F]/);
  });
});
