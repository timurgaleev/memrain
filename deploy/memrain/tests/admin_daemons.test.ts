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
