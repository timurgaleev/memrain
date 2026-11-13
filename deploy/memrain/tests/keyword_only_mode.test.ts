/**
 * Keyword-only mode (`MEMRAIN_KEYWORD_ONLY=1`) is the no-AWS local trial: a
 * page written over MCP must be stored, found by keyword search and read back
 * with no AWS variables in the environment, and not one request may reach
 * Bedrock — not the chunk embeddings, not the fenced-code symbol embeddings,
 * not the query embedding, not the intent or expansion models.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { startServer, type ServerHandle } from "../src/http/server.ts";
import type { Storage } from "../src/core/storage.ts";
import { trackedInvoke } from "../src/core/budget.ts";
import { isLlmAvailable } from "../src/core/llm/gateway.ts";
import { storageEngines } from "./helpers/storage-engines.ts";

const AWS_KEYS = ["AWS_REGION", "AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"];
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of [...AWS_KEYS, "MEMRAIN_KEYWORD_ONLY"]) saved[k] = process.env[k];
  for (const k of AWS_KEYS) delete process.env[k];
  process.env.MEMRAIN_KEYWORD_ONLY = "1";
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

let sendSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  sendSpy = spyOn(BedrockRuntimeClient.prototype, "send").mockImplementation((async () => {
    throw new Error("Bedrock must not be called in keyword-only mode");
  }) as never);
});
afterEach(() => sendSpy.mockRestore());

async function call(url: string, name: string, args: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const rpc = await res.json() as any;
  expect(rpc.error).toBeUndefined();
  expect(rpc.result.isError).not.toBe(true);
  return JSON.parse(rpc.result.content[0].text);
}

const BODY = [
  "# Lighthouse keeper notes",
  "",
  "The zanzibarquokka migration finished on Tuesday.",
  "",
  "```ts",
  "export function zanzibarRoute(a: number, b: number): number {",
  "  return a + b;",
  "}",
  "```",
].join("\n");

for (const engine of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) {
  describe(`keyword-only mode ${engine.name}`, () => {
    let storage: Storage;
    let close: () => Promise<void>;
    let server: ServerHandle;
    let url: string;

    beforeEach(async () => {
      ({ storage, close } = await engine.open());
      server = startServer({ host: "127.0.0.1", port: 0, storage });
      url = `http://127.0.0.1:${server.port}`;
    });

    afterEach(async () => {
      await server.stop();
      await close();
    });

    it("reports keyword-only on /health", async () => {
      const body = await (await fetch(`${url}/health`)).json() as Record<string, unknown>;
      expect(body.ok).toBe(true);
      expect(body.keyword_only).toBe(true);
    });

    it("writes, finds and reads a page without one Bedrock call", async () => {
      await call(url, "page_put", { slug: "notes/lighthouse", markdown_body: BODY });

      const found = await call(url, "search", { q: "zanzibarquokka" });
      expect(found.hits.map((h: { sourcePath: string }) => h.sourcePath)).toContain("page://notes/lighthouse");
      // No vector arm was attempted, so nothing degraded: keyword-only is the mode, not a failure.
      expect(found.meta.vectorEnabled).toBe(false);
      expect(found.meta.degraded).toEqual([]);

      const page = await call(url, "page_get", { slug: "notes/lighthouse" });
      expect(JSON.stringify(page)).toContain("zanzibarquokka migration");

      expect(sendSpy).not.toHaveBeenCalled();
    });
  });
}

describe("keyword-only paid-call gate", () => {
  it("refuses a paid call before it is sent", async () => {
    let sent = false;
    const refused = await trackedInvoke(
      { operation: "embedding", model: "amazon.titan-embed-text-v2:0", worstCase: { input: "x", maxOutputTokens: 0 } },
      async () => { sent = true; return 1; },
    ).then(() => null, (e: unknown) => e);
    expect(sent).toBe(false);
    expect((refused as { code?: string }).code).toBe("unsupported");
  });

  it("reports no model available even when AWS variables are present", () => {
    process.env.AWS_REGION = "eu-west-1";
    try {
      expect(isLlmAvailable()).toBe(false);
    } finally {
      delete process.env.AWS_REGION;
    }
  });
});
