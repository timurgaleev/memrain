/**
 * The tenant gates sit on the real entry points: the HTTP server before any
 * routing, MCP dispatch before any tool runs, and the job worker before a
 * claim. Hosting mode is switched on per test with a stub policy source.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { startServer } from "../src/http/server.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import { Queue } from "../src/core/jobs/queue.ts";
import { Worker } from "../src/core/jobs/worker.ts";
import { registerHandler, _resetHandlersForTesting } from "../src/core/jobs/handlers.ts";
import { HOSTING_ENV, setTenantPolicySource, type TenantPolicy } from "../src/control/contract.ts";

const ENV_NAMES = Object.values(HOSTING_ENV);
const saved = new Map<string, string | undefined>();
let dir: string;
let storage: Storage;
let reads = 0;

const readOnly: TenantPolicy = { status: "suspended", mode: "read-only", limits: {}, llmOff: false };
const blocked: TenantPolicy = { status: "suspended", mode: "block", limits: {}, llmOff: false };

function hostWith(policy: TenantPolicy): void {
  process.env["MEMRAIN_TENANT_ID"] = "acme";
  process.env["MEMRAIN_CONTROL_URL"] = "control-url-from-secret-file";
  setTenantPolicySource(async () => { reads++; return policy; });
}

beforeAll(async () => {
  for (const n of ENV_NAMES) saved.set(n, process.env[n]);
  dir = mkdtempSync(join(tmpdir(), "memrain-hosting-wiring-"));
  storage = new Storage({ dbPath: dir });
  await storage.init();
}, 30_000);

afterAll(async () => {
  await storage.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  reads = 0;
  for (const n of ENV_NAMES) delete process.env[n];
});

afterEach(() => {
  setTenantPolicySource(null);
  for (const [n, v] of saved) {
    if (v === undefined) delete process.env[n];
    else process.env[n] = v;
  }
});

describe("HTTP server", () => {
  it("a blocked tenant answers 403 tenant_suspended before routing, and /health still serves", async () => {
    hostWith(blocked);
    const server = startServer({ host: "127.0.0.1", port: 0, storage, internalToken: "tenant-internal-token" });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const mcp = await fetch(`${base}/mcp`, { method: "POST", body: "{}" });
      expect(mcp.status).toBe(403);
      expect(await mcp.json()).toEqual({ ok: false, error: "tenant_suspended" });
      expect((await fetch(`${base}/nowhere`)).status).toBe(403);
      expect((await fetch(`${base}/mcp`, { method: "OPTIONS", headers: { Origin: "https://claude.ai" } })).status).toBe(403);
      expect((await fetch(`${base}/health`)).status).toBe(200);
    } finally {
      await server.stop();
    }
  });
});

describe("HTTP server, read-only", () => {
  it("a credential-issuing GET is refused while the tenant is read-only", async () => {
    hostWith(readOnly);
    const server = startServer({ host: "127.0.0.1", port: 0, storage, internalToken: "tenant-internal-token" });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/admin/auth/one-time-nonce`, { redirect: "manual" });
      expect(res.status).toBe(403);
    } finally {
      await server.stop();
    }
  });
});

describe("MCP dispatch", () => {
  it("read-only refuses a write operation with tenant_suspended and runs a read", async () => {
    hostWith(readOnly);
    const put = await dispatchTool(storage, { name: "page_put", arguments: { slug: "notes/x", markdown_body: "hello" } });
    expect(put.isError).toBe(true);
    expect(JSON.parse(put.content[0]!.text).error).toBe("tenant_suspended");
    const list = await dispatchTool(storage, { name: "page_list", arguments: {} });
    expect(list.isError ?? false).toBe(false);
  });
});

describe("job worker", () => {
  beforeEach(() => _resetHandlersForTesting());

  it("a held tenant claims nothing, in drainOnce and in the polling loop", async () => {
    let ran = 0;
    registerHandler("hosting-wiring-probe", async () => { ran++; return {}; });
    const queue = new Queue(storage.engine());
    const job = await queue.enqueue({ kind: "hosting-wiring-probe" });
    hostWith(blocked);
    const worker = new Worker(queue);
    expect(await worker.drainOnce()).toBe(0);
    worker.start();
    const deadline = Date.now() + 5_000;
    while (reads < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    await worker.stop();
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(ran).toBe(0);
    expect((await queue.get(job.id))?.status).toBe("pending");
  });
});
