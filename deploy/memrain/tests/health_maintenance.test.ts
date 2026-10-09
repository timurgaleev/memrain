/**
 * /health in maintenance mode: the only addition is `maintenance: true`, and
 * only while maintenance is on. With it off the body is byte-identical to the
 * plain liveness body, key order included. No switch detail or count leaks.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { startServer, type ServerHandle } from "../src/http/server.ts";
import { probeLiveness } from "../src/http/health.ts";
import { VERSION } from "../src/version.ts";

let dir: string;
let storage: Storage;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "memrain-health-maint-"));
  storage = new Storage({ dbPath: dir });
  await storage.init();
});

afterAll(async () => {
  await storage.close();
  rmSync(dir, { recursive: true, force: true });
});

async function healthText(maintenance?: boolean): Promise<{ status: number; text: string }> {
  const opts: Parameters<typeof startServer>[0] = { host: "127.0.0.1", port: 0, storage };
  if (maintenance !== undefined) opts.maintenance = maintenance;
  const server: ServerHandle = startServer(opts);
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/health`);
    return { status: res.status, text: await res.text() };
  } finally {
    await server.stop();
  }
}

describe("/health maintenance flag", () => {
  const plain = JSON.stringify({ ok: true, db: "pglite", version: VERSION, schema_ahead: false });

  it("maintenance off (default): the body is exactly {ok, db, version, schema_ahead}", async () => {
    const r = await healthText();
    expect(r.status).toBe(200);
    expect(r.text).toBe(plain);
  });

  it("maintenance explicitly off: still byte-identical", async () => {
    expect((await healthText(false)).text).toBe(plain);
  });

  it("maintenance on: the only addition is maintenance:true", async () => {
    const r = await healthText(true);
    expect(r.status).toBe(200);
    expect(r.text).toBe(
      JSON.stringify({ ok: true, db: "pglite", version: VERSION, schema_ahead: false, maintenance: true }),
    );
    expect(r.text).not.toMatch(/code_sweep|jobs_worker|cycle|jobs_|lock/);
  });

  it("a failing probe keeps the flag while maintenance is on, and only then", async () => {
    const failing = {
      engine: () => ({ kind: "pglite", query: () => Promise.reject(new Error("down")) }),
    } as unknown as Storage;
    const on = await probeLiveness(failing, 1000, true);
    expect(on.status).toBe(503);
    expect(on.body.maintenance).toBe(true);
    const off = await probeLiveness(failing, 1000);
    expect("maintenance" in off.body).toBe(false);
  });
});
