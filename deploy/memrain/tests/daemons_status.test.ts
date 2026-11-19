/**
 * Daemon status and controls as the operator sees them: the core report, the
 * `memrain daemons` CLI, and the operator-only MCP tools.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { OperationError } from "../src/core/operation-error.ts";
import { controlDaemon, daemonsStatus } from "../src/core/daemons/status.ts";
import { _resetDaemonsForTesting, registerDaemon } from "../src/core/daemons/registry.ts";
import { tryAcquireDbLock } from "../src/core/db-lock.ts";
import { DAEMON_LOCK_ID } from "../src/core/daemons/scheduler.ts";
import { runDaemons } from "../src/commands/daemons.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";

let dir: string;
let storage: Storage;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "memrain-daemons-status-"));
  storage = new Storage({ dbPath: join(dir, "db") });
  await storage.init();
});

afterEach(async () => {
  _resetDaemonsForTesting();
  await storage.engine().exec(`DELETE FROM daemon_controls; DELETE FROM cycle_locks`);
});

afterAll(async () => {
  await storage.close();
  rmSync(dir, { recursive: true, force: true });
});

async function captured(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    return { code: await fn(), out: lines.join("\n") };
  } finally {
    console.log = log;
  }
}

const tenant: AuthInfo = { token: "t", clientId: "c", scopes: ["read"], sourceId: "acme", allowedSources: ["acme"], isPublic: false };

describe("daemonsStatus / controlDaemon", () => {
  it("reports every registered daemon with its schedule, pause and run status", async () => {
    registerDaemon({ name: "probe", kind: "daemon_probe", schedule: { cron: "0 7 * * *", timezone: "Europe/Berlin" }, lane: "short", paid: false, defaultEnabled: false });
    await controlDaemon(storage.engine(), { action: "pause", daemon: "cycle", reason: "disk work" }, "cli");
    const s = await daemonsStatus(storage.engine(), {}, new Date("2026-11-15T05:00:00Z"));
    expect(s.paused_all).toBeNull();
    expect(s.scheduler.leader).toBeNull();
    const cycle = s.daemons.find(d => d.name === "cycle")!;
    expect(cycle.schedule).toBe("external");
    expect(cycle.paused).toMatchObject({ by: "cli", reason: "disk work" });
    const probe = s.daemons.find(d => d.name === "probe")!;
    expect(probe.enabled).toBe(false);
    expect(probe.next_window).toBe("2026-11-15T07:00@Europe/Berlin");
  });

  it("shows a global pause and the leader's tick age", async () => {
    await controlDaemon(storage.engine(), { action: "pause", daemon: "all" }, "cli");
    const lock = (await tryAcquireDbLock(storage.engine(), DAEMON_LOCK_ID, 5))!;
    try {
      const s = await daemonsStatus(storage.engine());
      expect(s.paused_all).toMatchObject({ by: "cli" });
      expect(s.scheduler.leader?.live).toBe(true);
      expect(s.scheduler.leader?.tick_age_s).toBeGreaterThanOrEqual(0);
    } finally { await lock.release(); }
  });

  it("a malformed zone override does not break the report", async () => {
    registerDaemon({ name: "probe", kind: "daemon_probe", schedule: { cron: "0 7 * * *" }, lane: "short", paid: false, defaultEnabled: true });
    await storage.engine().query(`INSERT INTO daemon_controls (daemon, source_id, timezone) VALUES ('probe', '*', 'Mars/Olympus')`);
    const s = await daemonsStatus(storage.engine());
    expect(s.daemons.find(d => d.name === "probe")!.next_window).toBeNull();
  });

  it("enables and disables a daemon for every source or one source, and audits each change", async () => {
    const e = storage.engine();
    const auditTo = mkdtempSync(join(tmpdir(), "memrain-daemons-audit-"));
    const prev = process.env.MEMRAIN_AUDIT_DIR;
    process.env.MEMRAIN_AUDIT_DIR = auditTo;
    try {
      registerDaemon({ name: "probe", kind: "daemon_probe", schedule: { cron: "0 7 * * *" }, lane: "short", paid: false, defaultEnabled: false });
      expect(await controlDaemon(e, { action: "enable", daemon: "probe" }, "cli")).toEqual({ ok: true, action: "enable", daemon: "probe", source_id: "*" });
      expect((await daemonsStatus(e)).daemons.find(d => d.name === "probe")!.enabled).toBe(true);
      await controlDaemon(e, { action: "disable", daemon: "probe", source_id: "acme" }, "admin");
      const probe = (await daemonsStatus(e)).daemons.find(d => d.name === "probe")!;
      expect(probe.enabled).toBe(true);
      expect(probe.sources).toEqual([expect.objectContaining({ source_id: "acme", enabled: false })]);
      const rows = (await e.query<{ source_id: string; enabled: boolean }>(
        `SELECT source_id, enabled FROM daemon_controls WHERE daemon = 'probe' ORDER BY source_id`)).rows;
      expect(rows).toEqual([{ source_id: "*", enabled: true }, { source_id: "acme", enabled: false }]);
      const audit = readdirSync(auditTo).map(f => readFileSync(join(auditTo, f), "utf8")).join("");
      const records = audit.trim().split("\n").map(l => JSON.parse(l) as Record<string, unknown>);
      expect(records).toEqual([
        expect.objectContaining({ kind: "daemon_control", action: "enable", daemon: "probe", source_id: "*", by: "cli" }),
        expect.objectContaining({ kind: "daemon_control", action: "disable", daemon: "probe", source_id: "acme", by: "admin" }),
      ]);
    } finally {
      if (prev === undefined) delete process.env.MEMRAIN_AUDIT_DIR;
      else process.env.MEMRAIN_AUDIT_DIR = prev;
      rmSync(auditTo, { recursive: true, force: true });
    }
  });

  it("refuses to enable or disable every daemon at once", async () => {
    await expect(controlDaemon(storage.engine(), { action: "enable", daemon: "all" }, "cli")).rejects.toThrow("named daemon");
  });

  it("refuses an unknown daemon, a bad source id and an unknown action", async () => {
    const e = storage.engine();
    await expect(controlDaemon(e, { action: "pause", daemon: "nope" }, "cli")).rejects.toBeInstanceOf(OperationError);
    await expect(controlDaemon(e, { action: "pause", daemon: "cycle", source_id: "a b" }, "cli")).rejects.toThrow("source_id");
    await expect(controlDaemon(e, { action: "explode", daemon: "cycle" }, "cli")).rejects.toThrow("action");
  });
});

describe("memrain daemons", () => {
  it("status --json prints one JSON object", async () => {
    const { code, out } = await captured(() => runDaemons({ sub: "status", json: true, storage }));
    expect(code).toBe(0);
    expect(JSON.parse(out).daemons.map((d: { name: string }) => d.name)).toContain("cycle");
  });

  it("pause and resume change what status reports", async () => {
    expect((await captured(() => runDaemons({ sub: "pause", name: "cycle", reason: "x", storage }))).code).toBe(0);
    expect((await daemonsStatus(storage.engine())).daemons.find(d => d.name === "cycle")!.paused).not.toBeNull();
    expect((await captured(() => runDaemons({ sub: "resume", name: "cycle", storage }))).code).toBe(0);
    expect((await daemonsStatus(storage.engine())).daemons.find(d => d.name === "cycle")!.paused).toBeNull();
  });

  it("enable and disable set the daemon's switch for a source", async () => {
    const { code, out } = await captured(() => runDaemons({ sub: "enable", name: "connector_sync", sourceId: "acme", json: true, storage }));
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ ok: true, action: "enable", daemon: "connector_sync", source_id: "acme" });
    const row = async () => (await storage.engine().query<{ enabled: boolean | null }>(
      `SELECT enabled FROM daemon_controls WHERE daemon = 'connector_sync' AND source_id = 'acme'`)).rows[0]?.enabled;
    expect(await row()).toBe(true);
    expect((await captured(() => runDaemons({ sub: "disable", name: "connector_sync", sourceId: "acme", storage }))).code).toBe(0);
    expect(await row()).toBe(false);
  });

  it("an unknown subcommand or daemon exits 1", async () => {
    const err = console.error;
    console.error = () => {};
    try {
      expect(await runDaemons({ sub: "bogus", storage })).toBe(1);
      expect(await runDaemons({ sub: "pause", name: "nope", storage })).toBe(1);
    } finally { console.error = err; }
  });
});

describe("MCP daemons_status", () => {
  it("answers the operator", async () => {
    const res = await dispatchTool(storage, { name: "daemons_status", arguments: {} }, {});
    expect(res.isError).toBeFalsy();
    expect(JSON.stringify(res)).toContain("cycle");
  });

  it("is operator-only", async () => {
    const res = await dispatchTool(storage, { name: "daemons_status", arguments: {} }, { authInfo: tenant, isPublic: false });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res)).toContain("operator-only");
  });
});
