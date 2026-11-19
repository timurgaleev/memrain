/**
 * No extension registered: the plain server. Every hook answers as if it were
 * not there, the ingress switches stay out of the database's reach, the
 * extension's routes do not exist, and the public guard answers as before.
 * The deploy.sh half lives in tests/deploy-trace.test.sh.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { startServer, type ServerHandle } from "../src/http/server.ts";
import { extension } from "../src/core/extension.ts";
import { applyRuntimeEnvOverlay, isEnvOnlyKey, setRuntimeConfig } from "../src/core/runtime-config.ts";
import { putRuntimeConfigRow } from "./helpers/runtime-config-row.ts";
import { trackedInvoke } from "../src/core/budget.ts";

const INGRESS_KEYS = ["MEMRAIN_PUBLIC_AUTH", "MEMRAIN_REQUIRE_MEMBER"];
const saved = new Map<string, string | undefined>();
let dir: string;
let storage: Storage;

beforeAll(async () => {
  for (const k of INGRESS_KEYS) {
    for (const name of [k, k.replace(/^MEMRAIN_/, "MEMEX_")]) {
      saved.set(name, process.env[name]);
      delete process.env[name];
    }
  }
  dir = mkdtempSync(join(tmpdir(), "memrain-no-extension-"));
  storage = new Storage({ dbPath: dir });
  await storage.init();
}, 30_000);

afterAll(async () => {
  await storage.close();
  rmSync(dir, { recursive: true, force: true });
  for (const [name, v] of saved) {
    if (v === undefined) delete process.env[name];
    else process.env[name] = v;
  }
});

describe("no extension", () => {
  it("every hook is a no-op", async () => {
    const ext = extension();
    expect(ext.name).toBe("none");
    expect(await ext.admitRequest(new Request("http://h/ingest", { method: "POST" }), new URL("http://h/ingest"))).toBeNull();
    await ext.admitOperation("page_put", () => storage.engine(), {});
    expect(await ext.paused()).toBe(false);
    expect(await ext.holdSpend({ operation: "x", model: "m" }, 1, { refuse: async () => { throw new Error("no"); }, unavailable: async () => { throw new Error("no"); } })).toBeNull();
    expect(ext.withholdErrors(true)).toBe(false);
    expect(ext.bedrockClientConfig()).toEqual({});
  });

  it("the ingress switches are environment-only", async () => {
    for (const k of INGRESS_KEYS) expect(isEnvOnlyKey(k)).toBe(true);
    const e = storage.engine();
    for (const k of INGRESS_KEYS) {
      await putRuntimeConfigRow(e, k.replace(/^MEMRAIN_/, "MEMEX_"), "1");
      await setRuntimeConfig(e, k, k === "MEMRAIN_PUBLIC_AUTH" ? "oauth" : "1");
    }
    const orig = console.error;
    console.error = () => {};
    try {
      await applyRuntimeEnvOverlay(e);
    } finally {
      console.error = orig;
    }
    for (const k of INGRESS_KEYS) {
      expect(process.env[k]).toBeUndefined();
      expect(process.env[k.replace(/^MEMRAIN_/, "MEMEX_")]).toBeUndefined();
    }
  });

  it("a paid call takes no external hold", async () => {
    const out = await trackedInvoke(
      { operation: "probe", model: "eu.anthropic.claude-haiku-5-5", worstCase: { input: "x", maxOutputTokens: 10 } },
      async (meter) => { meter.report({ inputTokens: 1, outputTokens: 1 }); return "sent"; },
    );
    expect(out).toBe("sent");
  });
});

describe("no extension: HTTP surface", () => {
  let server: ServerHandle;
  let base: string;

  beforeAll(() => {
    server = startServer({ host: "127.0.0.1", port: 0, storage, publicBearerToken: "pub-bearer-for-test" });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    await server.stop();
  });

  it("the extension's routes do not exist", async () => {
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

  it("with sharing and feedback off, a public /s/ link or rating needs the bearer as before", async () => {
    expect(process.env["MEMRAIN_CHAT_SHARE"]).toBeUndefined();
    expect(process.env["MEMRAIN_FEEDBACK"]).toBeUndefined();
    const pub = { "Cf-Connecting-Ip": "203.0.113.7" };
    expect((await fetch(`${base}/s/${"a".repeat(43)}`, { headers: pub })).status).toBe(401);
    expect((await fetch(`${base}/s/${"a".repeat(43)}`, { method: "POST", headers: pub, body: "password=x" })).status).toBe(401);
  });

  it("/health answers", async () => {
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });
});

describe("no extension, no public bearer", () => {
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
