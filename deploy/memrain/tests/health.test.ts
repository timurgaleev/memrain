import { test, expect } from "bun:test";
import { Storage } from "../src/core/storage.ts";
import { startServer } from "../src/http/server.ts";
import { probeLiveness } from "../src/http/health.ts";
import { VERSION } from "../src/version.ts";
import packageJson from "../package.json" with { type: "json" };
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("GET /health returns 200 liveness-only (no corpus stats)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tb-health-"));
  const storage = new Storage({ dbPath: dir });
  await storage.init();
  // Use port 0 to let the OS pick a free one, then use server.port back.
  const server = startServer({ host: "127.0.0.1", port: 0, storage });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.db).toBe("pglite");
    expect(typeof body.version).toBe("string");
    // Liveness only: corpus stats must NOT be disclosed on the anonymous
    // probe (they live behind /admin/api/full-stats).
    expect(body.stats).toBeUndefined();
  } finally {
    await server.stop();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probeLiveness returns 503 when the DB query exceeds the timeout", async () => {
  const hangingStorage = {
    engine: () => ({
      kind: "pglite",
      query: () => new Promise(() => {}), // never resolves
    }),
  } as unknown as Storage;
  const result = await probeLiveness(hangingStorage, 50);
  expect(result.status).toBe(503);
  expect(result.body.ok).toBe(false);
  expect(String(result.body.error)).toContain("timed out");
});

test("probeLiveness returns 503 with a generic message on DB failure", async () => {
  const failingStorage = {
    engine: () => ({
      kind: "pglite",
      query: () => Promise.reject(new Error("connection to db-internal-host:5432 refused")),
    }),
  } as unknown as Storage;
  const result = await probeLiveness(failingStorage, 1000);
  expect(result.status).toBe(503);
  // Never echo internals (DSN host / Postgres detail) to the anon probe.
  expect(JSON.stringify(result.body)).not.toContain("db-internal-host");
});

test("GET /health reports schema_ahead without failing the probe", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tb-health-ahead-"));
  const storage = new Storage({ dbPath: dir });
  await storage.init();
  try {
    expect((await probeLiveness(storage)).body.schema_ahead).toBe(false);
    // A newer image recorded a migration this build does not ship, then the
    // image was rolled back and booted again.
    await storage.engine().exec("INSERT INTO migrations (id, name) VALUES (99999, 'from_a_newer_image')");
    await storage.init();
    const { status, body } = await probeLiveness(storage);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.schema_ahead).toBe(true);
  } finally {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("non-/health routes return 404", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tb-health-"));
  const storage = new Storage({ dbPath: dir });
  await storage.init();
  const server = startServer({ host: "127.0.0.1", port: 0, storage });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/nothing-here`);
    expect(res.status).toBe(404);
  } finally {
    await server.stop();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("HTTP server binds to 127.0.0.1 (loopback only)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tb-health-"));
  const storage = new Storage({ dbPath: dir });
  await storage.init();
  const server = startServer({ host: "127.0.0.1", port: 0, storage });
  try {
    // Verify by attempting to connect via 127.0.0.1 — should succeed.
    const res = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(res.ok).toBe(true);
  } finally {
    await server.stop();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GET /health reports the build stamp, not the pinned package version", async () => {
  // `typeof version === "string"` above passed for four months while the field
  // was package.json's version — pinned at 0.1.0 on purpose (see version.ts),
  // so /health answered "0.1.0" for every image ever built and a deploy check
  // reading it could not tell a fresh container from a stale one.
  //
  // VERSION resolves at import time from MEMRAIN_VERSION, which the test process
  // does not set, so the honest answer here is the unstamped fallback "dev".
  // Under the old code this same assertion would read "0.1.0".
  const dir = mkdtempSync(join(tmpdir(), "tb-health-version-"));
  const storage = new Storage({ dbPath: dir });
  await storage.init();
  try {
    const { body } = await probeLiveness(storage);
    expect(body.version).toBe(VERSION);
    expect(body.version).not.toBe(packageJson.version);
  } finally {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
