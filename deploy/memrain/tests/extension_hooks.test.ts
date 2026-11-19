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
  type HoldOutcome,
} from "../src/core/extension.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import { OperationError } from "../src/core/operation-error.ts";
import { Queue } from "../src/core/jobs/queue.ts";
import { Worker } from "../src/core/jobs/worker.ts";
import { registerHandler, _resetHandlersForTesting } from "../src/core/jobs/handlers.ts";
import { trackedInvoke } from "../src/core/budget.ts";

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

const HAIKU = { operation: "probe", model: "eu.anthropic.claude-haiku-5-5", worstCase: { input: "x", maxOutputTokens: 10 } };

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

  it("a held paid call settles done with its cost, and unknown when it may have billed unreported", async () => {
    const settled: HoldOutcome[] = [];
    registerExtension({
      name: "t",
      holdSpend: async (_call, worstUsd) => ({ id: "h1", usd: worstUsd ?? 0 }),
      settleSpend: async (_call, _hold, result) => void settled.push(result),
    });
    await trackedInvoke(HAIKU, async (meter) => { meter.report({ inputTokens: 1, outputTokens: 1 }); return "ok"; });
    const timeout = Object.assign(new Error("socket hang up"), { name: "TimeoutError" });
    await expect(trackedInvoke(HAIKU, async () => { throw timeout; })).rejects.toThrow();
    expect(settled[0]?.outcome).toBe("done");
    expect(settled[0]?.outcome === "done" && settled[0].actualUsd).toBeGreaterThan(0);
    expect(settled[1]?.outcome).toBe("unknown");
  });

  it("a refusal from the spend hook is a daily-cap refusal and nothing is sent", async () => {
    registerExtension({ name: "t", holdSpend: async (_c, _w, r) => r.refuse("over the cap", "Wait.") });
    let sent = 0;
    await expect(trackedInvoke(HAIKU, async () => { sent++; return "x"; })).rejects.toThrow(/daily_cap: 'probe' was not sent: over the cap/);
    expect(sent).toBe(0);
  });
});
