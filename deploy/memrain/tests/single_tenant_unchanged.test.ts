/**
 * "One tenant, hosting flags off": the personal brain behaves exactly as it
 * did before hosting existed. The tenant policy is a constant that consults
 * nothing, a stored runtime_config row cannot switch hosting on, the hosting
 * routes do not exist, and the public guard answers as before. Each hosting
 * lane adds its own row here; the deploy.sh half lives in
 * tests/deploy-single-tenant-trace.test.sh.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { startServer, type ServerHandle } from "../src/http/server.ts";
import {
  HOSTING_ENV,
  SINGLE_TENANT_POLICY,
  hostingMode,
  setTenantPolicySource,
  tenantPolicy,
} from "../src/control/contract.ts";
import { admitJob, admitRequest, assertTenantAllows, tenantPaused } from "../src/core/tenant-guard.ts";
import {
  ENV_ONLY_KEYS,
  NEVER_STORED_KEYS,
  applyRuntimeEnvOverlay,
  setRuntimeConfig,
} from "../src/core/runtime-config.ts";
import { putRuntimeConfigRow } from "./helpers/runtime-config-row.ts";

const HOSTING_KEYS = Object.values(HOSTING_ENV);
const saved = new Map<string, string | undefined>();
let dir: string;
let storage: Storage;

beforeAll(async () => {
  for (const k of HOSTING_KEYS) {
    for (const name of [k, k.replace(/^MEMRAIN_/, "MEMEX_")]) {
      saved.set(name, process.env[name]);
      delete process.env[name];
    }
  }
  dir = mkdtempSync(join(tmpdir(), "memrain-single-tenant-"));
  storage = new Storage({ dbPath: dir });
  await storage.init();
}, 30_000);

afterAll(async () => {
  setTenantPolicySource(null);
  await storage.close();
  rmSync(dir, { recursive: true, force: true });
  for (const [name, v] of saved) {
    if (v === undefined) delete process.env[name];
    else process.env[name] = v;
  }
});

describe("single tenant, hosting flags off", () => {
  it("the tenant policy is the constant and no gate consults a policy source", async () => {
    let reads = 0;
    setTenantPolicySource(async () => {
      reads++;
      return { status: "suspended", mode: "block", limits: {}, llmOff: true };
    });
    try {
      expect(await tenantPolicy()).toBe(SINGLE_TENANT_POLICY);
      expect(await admitRequest(new Request("http://h/ingest", { method: "POST" }))).toBeNull();
      await assertTenantAllows("page_put");
      expect(await admitJob()).toBe(true);
      expect(await tenantPaused()).toBe(false);
      expect(reads).toBe(0);
    } finally {
      setTenantPolicySource(null);
    }
  });

  it("every hosting variable is environment-only; the control URL is never stored", async () => {
    for (const k of HOSTING_KEYS) expect(ENV_ONLY_KEYS.has(k)).toBe(true);
    expect(NEVER_STORED_KEYS.has("MEMRAIN_CONTROL_URL")).toBe(true);
    await expect(setRuntimeConfig(storage.engine(), "MEMRAIN_CONTROL_URL", "x")).rejects.toThrow(/environment only/);
  });

  it("stored rows under either prefix cannot switch hosting on", async () => {
    const e = storage.engine();
    for (const k of HOSTING_KEYS) {
      await putRuntimeConfigRow(e, k.replace(/^MEMRAIN_/, "MEMEX_"), "1");
      if (k !== "MEMRAIN_CONTROL_URL") await setRuntimeConfig(e, k, k === "MEMRAIN_TENANT_ID" ? "acme" : "1");
    }
    const orig = console.error;
    console.error = () => {};
    try {
      await applyRuntimeEnvOverlay(e);
    } finally {
      console.error = orig;
    }
    for (const k of HOSTING_KEYS) {
      expect(process.env[k]).toBeUndefined();
      expect(process.env[k.replace(/^MEMRAIN_/, "MEMEX_")]).toBeUndefined();
    }
    expect(hostingMode()).toBeNull();
  });
});

describe("single tenant HTTP surface", () => {
  let server: ServerHandle;
  let base: string;

  beforeAll(() => {
    server = startServer({ host: "127.0.0.1", port: 0, storage, publicBearerToken: "pub-bearer-for-test" });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    await server.stop();
  });

  it("the hosting routes do not exist", async () => {
    for (const path of ["/app", "/app/login", "/app/invite", "/app/api/chat", "/s/abc"]) {
      const res = await fetch(`${base}${path}`);
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
    }
  });

  it("a public /mcp call without a credential gets the same 401 as before", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Cf-Connecting-Ip": "203.0.113.7", "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("resource_metadata");
  });

  it("/health answers", async () => {
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });
});

describe("single tenant without a public bearer", () => {
  it("a public /mcp call gets the same 503 as before", async () => {
    const s = startServer({ host: "127.0.0.1", port: 0, storage });
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}/mcp`, {
        method: "POST",
        headers: { "Cf-Connecting-Ip": "203.0.113.7", "Content-Type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(503);
    } finally {
      await s.stop();
    }
  });
});
