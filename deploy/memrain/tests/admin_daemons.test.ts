/** GET /admin/api/daemons: the daemon report behind an admin session. */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { createAdminAuth } from "../src/http/admin.ts";
import { handleAdminApi } from "../src/http/admin-api.ts";
import { pauseDaemon } from "../src/core/daemons/controls.ts";

const BOOT = "boot-secret";
let tmp: string;
let storage: Storage;
let auth: ReturnType<typeof createAdminAuth>;
let cookie: string;

const req = (path: string, init?: RequestInit) => new Request(`http://localhost:8080${path}`, init);
const call = (init?: RequestInit) =>
  handleAdminApi(req("/admin/api/daemons", init), new URL("http://localhost:8080/admin/api/daemons"), {
    storage,
    requireAdmin: auth.requireAdmin,
  });

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-admin-daemons-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  auth = createAdminAuth({ bootstrapToken: BOOT });
  const login = await auth.handleAuthRoute(
    req("/admin/login", { method: "POST", body: JSON.stringify({ token: BOOT }) }),
    new URL("http://localhost:8080/admin/login"),
  );
  cookie = (login!.headers.get("Set-Cookie") ?? "").split(";")[0]!;
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("GET /admin/api/daemons", () => {
  it("401s without an admin session", async () => {
    expect((await call())?.status).toBe(401);
  });

  it("returns the daemon report", async () => {
    await pauseDaemon(storage.engine(), { daemon: "cycle", by: "cli", reason: "disk" });
    const res = (await call({ headers: { cookie } }))!;
    expect(res.status).toBe(200);
    const body = await res.json() as { daemons: Array<{ name: string; paused: unknown }> };
    expect(body.daemons.find(d => d.name === "cycle")?.paused).toMatchObject({ reason: "disk" });
  });
});

describe("POST /admin/api/daemons/control", () => {
  const control = (body: unknown, headers: Record<string, string> = {}) =>
    handleAdminApi(
      req("/admin/api/daemons/control", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }),
      new URL("http://localhost:8080/admin/api/daemons/control"),
      { storage, requireAdmin: auth.requireAdmin },
    );
  const enabled = async () => (await storage.engine().query<{ enabled: boolean | null }>(
    `SELECT enabled FROM daemon_controls WHERE daemon = 'connector_sync' AND source_id = 'acme'`)).rows[0]?.enabled ?? null;

  it("401s without an admin session and changes nothing", async () => {
    expect((await control({ action: "enable", daemon: "connector_sync", source_id: "acme" }))?.status).toBe(401);
    expect(await enabled()).toBeNull();
  });

  it("refuses a cross-origin request", async () => {
    const res = await control({ action: "enable", daemon: "connector_sync", source_id: "acme" }, { cookie, origin: "https://evil.example" });
    expect(res?.status).toBe(403);
    expect(await enabled()).toBeNull();
  });

  it("enables and disables a daemon for one source", async () => {
    const on = (await control({ action: "enable", daemon: "connector_sync", source_id: "acme" }, { cookie }))!;
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ ok: true, action: "enable", daemon: "connector_sync", source_id: "acme" });
    expect(await enabled()).toBe(true);
    expect((await control({ action: "disable", daemon: "connector_sync", source_id: "acme" }, { cookie }))!.status).toBe(200);
    expect(await enabled()).toBe(false);
  });

  it("answers 400 for an unknown daemon or action", async () => {
    const bad = (await control({ action: "enable", daemon: "nope" }, { cookie }))!;
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain("unknown daemon");
    expect((await control({ action: "explode", daemon: "connector_sync" }, { cookie }))!.status).toBe(400);
  });
});
