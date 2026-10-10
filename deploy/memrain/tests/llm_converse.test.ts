/**
 * The multi-turn Converse primitive: the request carries the conversation and
 * a toolConfig, the call is booked in the spend ledger under the caller's
 * operation, the stop reason reaches the caller untouched, and a conversation
 * with an unanswered toolUse is repaired before it is sent.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BedrockRuntimeClient, Message } from "@aws-sdk/client-bedrock-runtime";
import { Storage } from "../src/core/storage.ts";
import { setSpendLedgerEngine } from "../src/core/budget.ts";
import {
  converseTurn,
  repairToolPairing,
  UNANSWERED_TOOL_RESULT,
} from "../src/core/llm/converse.ts";

const HAIKU = "eu.anthropic.claude-haiku-4-5-20251001-v1:0";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-converse-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  setSpendLedgerEngine(storage.engine());
});

afterEach(async () => {
  setSpendLedgerEngine(null);
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

function fakeClient(resp: Record<string, unknown>): {
  client: BedrockRuntimeClient;
  sent: Array<Record<string, unknown>>;
} {
  const sent: Array<Record<string, unknown>> = [];
  const client = {
    send: mock(async (cmd: { input: Record<string, unknown> }) => {
      sent.push(cmd.input);
      return resp;
    }),
  } as unknown as BedrockRuntimeClient;
  return { client, sent };
}

const TOOLS = [
  {
    name: "search",
    description: "search the brain",
    inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
  },
];

describe("converseTurn", () => {
  it("sends the conversation with a toolConfig and returns the assistant message", async () => {
    const assistant: Message = {
      role: "assistant",
      content: [{ toolUse: { toolUseId: "t1", name: "search", input: { q: "memex" } } }],
    };
    const { client, sent } = fakeClient({
      output: { message: assistant },
      stopReason: "tool_use",
      usage: { inputTokens: 1000, outputTokens: 50 },
    });
    const r = await converseTurn({
      system: "be brief",
      messages: [{ role: "user", content: [{ text: "hi" }] }],
      tools: TOOLS,
      maxTokens: 256,
      operation: "agent",
      modelId: HAIKU,
      client,
    });
    expect(sent).toHaveLength(1);
    const req = sent[0]!;
    expect(req.modelId).toBe(HAIKU);
    expect(req.system).toEqual([{ text: "be brief" }]);
    expect(req.toolConfig).toEqual({
      tools: [{ toolSpec: { name: "search", description: "search the brain", inputSchema: { json: TOOLS[0]!.inputSchema } } }],
    });
    expect((req.inferenceConfig as { maxTokens: number }).maxTokens).toBe(256);
    expect(r.message).toEqual(assistant);
    expect(r.stopReason).toBe("tool_use");
    expect(r.usage).toEqual({ inputTokens: 1000, outputTokens: 50 });
    expect(r.modelId).toBe(HAIKU);
  });

  it("books the call in the spend ledger under the caller's operation", async () => {
    const { client } = fakeClient({
      output: { message: { role: "assistant", content: [{ text: "done" }] } },
      stopReason: "end_turn",
      usage: { inputTokens: 1_000_000, outputTokens: 200_000 },
    });
    await converseTurn({
      system: "s",
      messages: [{ role: "user", content: [{ text: "hi" }] }],
      tools: TOOLS,
      maxTokens: 64,
      operation: "agent",
      modelId: HAIKU,
      client,
    });
    const rows = await storage.engine().query<{ operation: string; spend_cents: number; model: string }>(
      `SELECT operation, spend_cents::float8 AS spend_cents, model FROM mcp_spend_log`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.operation).toBe("agent");
    expect(rows.rows[0]!.model).toBe(HAIKU);
    // 1M input @ $1 + 200k output @ $5 = $2.00.
    expect(rows.rows[0]!.spend_cents).toBeCloseTo(200, 6);
  });

  it("hands the caller's abort signal to the SDK", async () => {
    const opts: unknown[] = [];
    const client = {
      send: mock(async (_cmd: unknown, o: unknown) => {
        opts.push(o);
        return {
          output: { message: { role: "assistant", content: [{ text: "x" }] } },
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }),
    } as unknown as BedrockRuntimeClient;
    const ctl = new AbortController();
    await converseTurn({
      system: "s",
      messages: [{ role: "user", content: [{ text: "hi" }] }],
      tools: [],
      maxTokens: 16,
      operation: "agent",
      modelId: HAIKU,
      client,
      signal: ctl.signal,
    });
    expect((opts[0] as { abortSignal?: AbortSignal }).abortSignal).toBe(ctl.signal);
  });

  it("passes every stop reason through unchanged", async () => {
    for (const reason of ["max_tokens", "guardrail_intervened", "content_filtered", "end_turn"]) {
      const { client } = fakeClient({
        output: { message: { role: "assistant", content: [{ text: "x" }] } },
        stopReason: reason,
        usage: { inputTokens: 1, outputTokens: 1 },
      });
      const r = await converseTurn({
        system: "s",
        messages: [{ role: "user", content: [{ text: "hi" }] }],
        tools: [],
        maxTokens: 16,
        operation: "agent",
        modelId: HAIKU,
        client,
      });
      expect(r.stopReason).toBe(reason);
    }
  });

  it("repairs an unanswered toolUse before sending", async () => {
    const { client, sent } = fakeClient({
      output: { message: { role: "assistant", content: [{ text: "ok" }] } },
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    await converseTurn({
      system: "s",
      messages: [
        { role: "user", content: [{ text: "hi" }] },
        { role: "assistant", content: [{ toolUse: { toolUseId: "orphan", name: "search", input: {} } }] },
      ],
      tools: TOOLS,
      maxTokens: 16,
      operation: "agent",
      modelId: HAIKU,
      client,
    });
    const msgs = sent[0]!.messages as Message[];
    expect(msgs).toHaveLength(3);
    expect(msgs[2]!.content![0]!.toolResult!.toolUseId).toBe("orphan");
  });
});

describe("repairToolPairing", () => {
  const use = (id: string) => ({ toolUse: { toolUseId: id, name: "search", input: {} } });
  const result = (id: string) => ({
    toolResult: { toolUseId: id, content: [{ text: "r" }], status: "success" as const },
  });

  it("adds a synthetic error result for a trailing toolUse", () => {
    const out = repairToolPairing([
      { role: "user", content: [{ text: "q" }] },
      { role: "assistant", content: [use("a"), use("b")] },
    ]);
    expect(out).toHaveLength(3);
    const blocks = out[2]!.content!;
    expect(blocks.map((b) => b.toolResult!.toolUseId)).toEqual(["a", "b"]);
    expect(blocks[0]!.toolResult!.status).toBe("error");
    expect(blocks[0]!.toolResult!.content![0]!.text).toBe(UNANSWERED_TOOL_RESULT);
  });

  it("fills only the missing ids of a partial answer, without mutating the input", () => {
    const partial: Message = { role: "user", content: [result("a")] };
    const input: Message[] = [
      { role: "user", content: [{ text: "q" }] },
      { role: "assistant", content: [use("a"), use("b")] },
      partial,
    ];
    const out = repairToolPairing(input);
    expect(out).toHaveLength(3);
    expect(out[2]!.content!.map((b) => b.toolResult!.toolUseId).sort()).toEqual(["a", "b"]);
    expect(partial.content).toHaveLength(1);
  });

  it("inserts a result turn between two assistant turns", () => {
    const out = repairToolPairing([
      { role: "user", content: [{ text: "q" }] },
      { role: "assistant", content: [use("a")] },
      { role: "assistant", content: [{ text: "later" }] },
    ]);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("leaves a well-paired conversation as it is", () => {
    const input: Message[] = [
      { role: "user", content: [{ text: "q" }] },
      { role: "assistant", content: [use("a")] },
      { role: "user", content: [result("a")] },
      { role: "assistant", content: [{ text: "done" }] },
    ];
    expect(repairToolPairing(input)).toEqual(input);
  });
});
