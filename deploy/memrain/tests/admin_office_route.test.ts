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
import type { OfficeSnapshot } from "../src/http/admin-office.ts";

const BOOT = "boot-secret";
let tmp: string;
let storage: Storage;
let auth: ReturnType<typeof createAdminAuth>;
let cookie: string;

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
    expect(body.workers.find((w) => w.name === "worker")).toEqual({ name: "worker", enabled: true, running: false });

    expect(body.clients.map((c) => c.id).sort()).toEqual(["cid-1", "laptop", "public"]);
    expect(body.clients.find((c) => c.id === "laptop")?.display_name).toBe("laptop");
    expect(body.clients.find((c) => c.id === "laptop")?.last_seen).toContain("2026-01-02");
    expect(body.clients.find((c) => c.id === "public")).toEqual({ id: "public", display_name: "Shared key", last_seen: null });

    for (const leak of ["token_hash", "HASH-LIVE", "payload", "PAYLOAD-X", "last_error", "ERR-X", "stolen"]) {
      expect(text).not.toContain(leak);
    }
  });
});
