/** /admin/api/notifications*: the owner's notification list and badge, behind an admin session. */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { createAdminAuth } from "../src/http/admin.ts";
import { handleAdminApi } from "../src/http/admin-api.ts";
import { registerSource } from "../src/core/sources.ts";
import { openNotice } from "../src/core/connectors/sync-store.ts";

const BOOT = "boot-secret";
const ACCOUNT = "55555555-5555-4555-8555-55555555555a";
let tmp: string;
let storage: Storage;
let auth: ReturnType<typeof createAdminAuth>;
let cookie: string;

const req = (path: string, init?: RequestInit) => new Request(`http://localhost:8080${path}`, init);
const call = (path: string, init?: RequestInit) =>
  handleAdminApi(req(path, init), new URL(`http://localhost:8080${path}`), { storage, requireAdmin: auth.requireAdmin });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  call(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-admin-notifications-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  auth = createAdminAuth({ bootstrapToken: BOOT });
  const login = await auth.handleAuthRoute(
    req("/admin/login", { method: "POST", body: JSON.stringify({ token: BOOT }) }),
    new URL("http://localhost:8080/admin/login"),
  );
  cookie = (login!.headers.get("Set-Cookie") ?? "").split(";")[0]!;
  const e = storage.engine();
  await registerSource(e, { id: "acme", kind: "other", pathPrefix: "acme/" });
  await e.query(
    `INSERT INTO connector_accounts (id, source_id, provider, principal_ref, account_label) VALUES ($1, 'acme', 'test', 'admin:operator', 'owner@example.test')`,
    [ACCOUNT],
  );
  await openNotice(e, ACCOUNT, "needs_reconnect", "invalid_grant for owner@example.test");
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

const count = async () => (await storage.engine().query<{ n: number }>(`SELECT count(*)::int AS n FROM notifications`)).rows[0]!.n;

describe("GET /admin/api/notifications", () => {
  it("401s without an admin session and does no work", async () => {
    expect((await call("/admin/api/notifications"))?.status).toBe(401);
    expect((await call("/admin/api/notifications/summary"))?.status).toBe(401);
    expect(await count()).toBe(0);
  });

  it("lists open notifications with a hint and no problem text", async () => {
    const res = (await call("/admin/api/notifications", { headers: { cookie } }))!;
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json() as {
      summary: { open: number; unread: number };
      webhook: { state: string };
      notifications: Array<{ kind: string; ref: string; source_id: string; link: string; hint: string }>;
    };
    expect(body.summary).toMatchObject({ open: 1, unread: 1 });
    expect(body.webhook.state).toBe("off");
    expect(body.notifications).toHaveLength(1);
    expect(body.notifications[0]).toMatchObject({ kind: "needs_reconnect", ref: ACCOUNT, source_id: "acme" });
    expect(body.notifications[0]!.hint).toContain("Connections page");
    const text = JSON.stringify(body);
    expect(text).not.toContain("invalid_grant");
    expect(text).not.toContain("owner@example.test");
  });

  it("answers the badge counts", async () => {
    const res = (await call("/admin/api/notifications/summary", { headers: { cookie } }))!;
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ open: 1, unread: 1, by_kind: { needs_reconnect: 1 } });
  });
});

describe("POST /admin/api/notifications/read", () => {
  it("refuses a cross-origin request and changes nothing", async () => {
    const res = (await post("/admin/api/notifications/read", { all: true }, { cookie, origin: "https://evil.example" }))!;
    expect(res.status).toBe(403);
    const summary = await (await call("/admin/api/notifications/summary", { headers: { cookie } }))!.json() as { unread: number };
    expect(summary.unread).toBe(1);
  });

  it("answers 400 for a malformed body", async () => {
    for (const body of [{}, { ids: "1" }, { ids: [1.5] }, { ids: [-1] }, { ids: Array.from({ length: 501 }, (_, i) => i + 1) }]) {
      expect((await post("/admin/api/notifications/read", body, { cookie }))!.status).toBe(400);
    }
  });

  it("marks one notification read, then all", async () => {
    const list = await (await call("/admin/api/notifications", { headers: { cookie } }))!.json() as { notifications: Array<{ id: number }> };
    const id = list.notifications[0]!.id;
    const one = (await post("/admin/api/notifications/read", { ids: [id] }, { cookie }))!;
    expect(one.status).toBe(200);
    expect(await one.json()).toEqual({ ok: true, marked: 1 });
    const all = (await post("/admin/api/notifications/read", { all: true }, { cookie }))!;
    expect(await all.json()).toEqual({ ok: true, marked: 0 });
    const summary = await (await call("/admin/api/notifications/summary", { headers: { cookie } }))!.json() as { unread: number };
    expect(summary.unread).toBe(0);
  });
});
