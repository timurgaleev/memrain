import { test, expect, mock } from "bun:test";
import { embedText, resolveEmbedDimensions } from "../src/core/embedding.ts";
import type { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";

function mockBedrockClient(returnVector: number[]): BedrockRuntimeClient {
  // Minimal mock that returns the configured vector wrapped in the Titan response shape.
  return {
    send: mock(async () => ({
      body: new TextEncoder().encode(JSON.stringify({ embedding: returnVector })),
    })),
  } as unknown as BedrockRuntimeClient;
}

test("embedText returns a 1024-dim vector from Titan", async () => {
  const fakeVec = new Array(1024).fill(0).map((_, i) => i / 1024);
  const client = mockBedrockClient(fakeVec);
  const result = await embedText("hello world", { client });
  expect(result.length).toBe(1024);
  expect(result[0]).toBe(0);
  expect(result[1023]).toBeCloseTo(1023 / 1024);
});

test("embedText hands the billed input tokens to onUsage", async () => {
  const client = {
    send: mock(async () => ({
      body: new TextEncoder().encode(JSON.stringify({ embedding: Array.from({ length: 1024 }).fill(0), inputTextTokenCount: 7 })),
    })),
  } as unknown as BedrockRuntimeClient;
  const seen: number[] = [];
  await embedText("hello world", { client, onUsage: (u) => seen.push(u.inputTokens) });
  expect(seen).toEqual([7]);
});

test("embedText throws on empty input", async () => {
  const client = mockBedrockClient(new Array(1024).fill(0));
  await expect(embedText("", { client })).rejects.toThrow();
  await expect(embedText("   ", { client })).rejects.toThrow();
});

test("embedText throws when response embedding has wrong dimension", async () => {
  const client = mockBedrockClient(new Array(512).fill(0));  // wrong dim
  await expect(embedText("hello", { client })).rejects.toThrow(/1024/);
});

test("embedText accepts modelId override", async () => {
  const fakeVec = new Array(1024).fill(0);
  const client = mockBedrockClient(fakeVec);
  // Should not throw with a custom modelId
  const result = await embedText("hello", { client, modelId: "custom.model.v1" });
  expect(result.length).toBe(1024);
});

test("resolveEmbedDimensions defaults to 1024 when unset/blank", () => {
  expect(resolveEmbedDimensions(undefined)).toBe(1024);
  expect(resolveEmbedDimensions("")).toBe(1024);
  expect(resolveEmbedDimensions("   ")).toBe(1024);
});

test("resolveEmbedDimensions accepts the stored column width (1024)", () => {
  expect(resolveEmbedDimensions("1024")).toBe(1024);
});

test("resolveEmbedDimensions rejects a width that won't fit the vector(1024) column", () => {
  // 256/512 are valid Titan outputs but don't fit the fixed column, so they
  // must fail at resolution — not on the first DB insert.
  expect(() => resolveEmbedDimensions("512")).toThrow(/vector\(1024\)/);
  expect(() => resolveEmbedDimensions("256")).toThrow(/migration/);
});

test("resolveEmbedDimensions accepts any positive width for a non-default model", () => {
  // The stored-column gate only binds the default model; a future embedder
  // (passed explicitly) owns its own coordinated schema swap.
  expect(resolveEmbedDimensions("1536", "some.future.embedder:0")).toBe(1536);
});

test("resolveEmbedDimensions fails loud on a bad value", () => {
  expect(() => resolveEmbedDimensions("0")).toThrow(/positive integer/);
  expect(() => resolveEmbedDimensions("-1")).toThrow(/positive integer/);
  expect(() => resolveEmbedDimensions("1.5")).toThrow(/positive integer/);
  expect(() => resolveEmbedDimensions("abc")).toThrow(/positive integer/);
});
