/**
 * The extension registry: one registration, a refusal to start when a wrapped
 * build's environment meets a plain build, and each hook family consulted at
 * its real call site.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { startServer } from "../src/http/server.ts";
import {
  _resetExtensionForTests,
  assertExtensionPresent,
  registerExtension,
} from "../src/core/extension.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import { OperationError } from "../src/core/operation-error.ts";
import { Queue } from "../src/core/jobs/queue.ts";
import { Worker } from "../src/core/jobs/worker.ts";
import { registerHandler, _resetHandlersForTesting } from "../src/core/jobs/handlers.ts";

let dir: string;
let storage: Storage;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "memrain-ext-hooks-"));
  storage = new Storage({ dbPath: dir });
  await storage.init();
}, 30_000);

afterAll(async () => {
  _resetExtensionForTests();
  await storage.close();
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => _resetExtensionForTests());

describe("registration", () => {
  it("refuses a second registration", () => {
    registerExtension({ name: "a" });
    expect(() => registerExtension({ name: "b" })).toThrow(/already registered/);
  });

  it("a wrapped build's environment without its extension refuses to start", () => {
    expect(() => assertExtensionPresent({ MEMRAIN_TENANT_ID: "acme" })).toThrow(/refusing to start/);
    expect(() => assertExtensionPresent({ MEMRAIN_CONTROL_URL: "postgres://x" })).toThrow(/refusing to start/);
    expect(() => assertExtensionPresent({ MEMRAIN_TENANT_ID: "  " })).not.toThrow();
    expect(() => assertExtensionPresent({})).not.toThrow();
    registerExtension({ name: "wrapped" });
    expect(() => assertExtensionPresent({ MEMRAIN_TENANT_ID: "acme" })).toThrow(/does not supply startupCheck, admitRequest/);
  });

  it("a wrapped build must supply every gate itself; an undefined one does not count", () => {
    const gates = {
      startupCheck: () => {},
      admitRequest: async () => null,
      admitOperation: async () => {},
      paused: async () => false,
      holdSpend: async () => null,
      settleSpend: async () => {},
    };
    registerExtension({ name: "partial", ...gates, paused: undefined });
    expect(() => assertExtensionPresent({ MEMRAIN_TENANT_ID: "acme" })).toThrow(/does not supply paused/);
    _resetExtensionForTests();
    registerExtension({ name: "full", ...gates });
    expect(() => assertExtensionPresent({ MEMRAIN_TENANT_ID: "acme" })).not.toThrow();
  });

  it("the stored config can set neither marker, and never stores the control URL", async () => {
    const { isEnvOnlyKey, isNeverStoredKey } = await import("../src/core/runtime-config.ts");
    expect(isEnvOnlyKey("MEMRAIN_TENANT_ID")).toBe(true);
    expect(isEnvOnlyKey("MEMRAIN_CONTROL_URL")).toBe(true);
    expect(isNeverStoredKey("MEMRAIN_CONTROL_URL")).toBe(true);
  });
});

describe("hooks at their call sites", () => {
  it("admitRequest answers before routing", async () => {
    registerExtension({ name: "t", admitRequest: async () => Response.json({ held: true }, { status: 403 }) });
    const s = startServer({ host: "127.0.0.1", port: 0, storage });
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}/ingest`, { method: "POST" });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ held: true });
    } finally {
      await s.stop();
    }
  });

  it("admitOperation refuses an MCP operation in dispatch", async () => {
    const seen: string[] = [];
    registerExtension({
      name: "t",
      admitOperation: async (name) => {
        seen.push(name);
        throw new OperationError("tenant_suspended", `'${name}' is refused`, "Ask the operator.");
      },
    });
    const r = await dispatchTool(storage, { name: "page_put", arguments: { slug: "notes/x", markdown_body: "x" } });
    expect(seen).toEqual(["page_put"]);
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain("tenant_suspended");
  });

  it("paused holds the worker before it claims", async () => {
    _resetHandlersForTesting();
    let ran = 0;
    registerHandler("ext-probe", async () => { ran++; return {}; });
    const queue = new Queue(storage.engine());
    await queue.enqueue({ kind: "ext-probe" });
    registerExtension({ name: "t", paused: async () => true });
    expect(await new Worker(queue).drainOnce()).toBe(0);
    expect(ran).toBe(0);
    _resetExtensionForTests();
    expect(await new Worker(queue).drainOnce()).toBe(1);
    expect(ran).toBe(1);
    _resetHandlersForTesting();
  });
});
