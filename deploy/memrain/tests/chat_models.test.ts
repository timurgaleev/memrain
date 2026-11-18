/**
 * P5-C3: which models chat offers and what an answer may cost before it is
 * sent. Only priced models are offered; the per-answer ceiling never rises
 * above the hard cap; the estimate is an upper bound on what a turn costs.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { indexPageIntoSearch } from "../src/core/page-index.ts";
import { chatConfig, estimateAnswerUsd, modelLabel } from "../src/core/chat/config.ts";
import { operatorOwner, runChatTurn } from "../src/core/chat/chat-service.ts";
import type { SonnetFn } from "../src/core/llm/sonnet.ts";
import { deterministicEmbedQuery } from "./det-embed.ts";

setDefaultTimeout(120_000);

const HAIKU = "eu.anthropic.claude-haiku-5-5";
const SONNET = "eu.anthropic.claude-sonnet-5-5";

describe("chat models", () => {
  it("offers the configured priced models in order, the first as default", () => {
    const cfg = chatConfig({ MEMRAIN_CHAT: "1", MEMRAIN_DAILY_BUDGET_USD: "5", MEMRAIN_CHAT_MODELS: `${SONNET}, vendor.unpriced-v1 ,${HAIKU}` });
    expect(cfg.models.map(m => m.id)).toEqual([SONNET, HAIKU]);
    expect(cfg.defaultModel).toBe(SONNET);
    expect(cfg.models[1]).toMatchObject({ label: "Claude Haiku 5.5", input_usd_per_m: 0.11, output_usd_per_m: 0.55 });
  });

  it("defaults to one cheap model and stays off without the switch or a brain cap", () => {
    expect(chatConfig({}).models.map(m => m.id)).toEqual([HAIKU]);
    expect(chatConfig({}).enabled).toBe(false);
    expect(chatConfig({ MEMRAIN_CHAT: "1" })).toMatchObject({ enabled: false });
    expect(chatConfig({ MEMRAIN_CHAT: "1" }).disabledReason).toContain("MEMRAIN_DAILY_BUDGET_USD");
    expect(chatConfig({ MEMRAIN_CHAT: "1", MEMRAIN_DAILY_BUDGET_USD: "5" }).enabled).toBe(true);
    expect(chatConfig({ MEMRAIN_CHAT: "1", MEMRAIN_DAILY_BUDGET_USD: "5", MEMRAIN_CHAT_MODELS: "vendor.unpriced-v1" }).enabled).toBe(false);
  });

  it("caps the answer ceiling at the hard cap", () => {
    expect(chatConfig({}).answerCapUsd).toBe(0.02);
    expect(chatConfig({ MEMRAIN_CHAT_ANSWER_MAX_USD: "5" }).answerCapUsd).toBe(0.5);
    expect(chatConfig({ MEMRAIN_CHAT_ANSWER_MAX_USD: "5", MEMRAIN_CHAT_ANSWER_MAX_USD_CAP: "0.1" }).answerCapUsd).toBe(0.1);
    expect(chatConfig({ MEMRAIN_CHAT_ANSWER_MAX_USD: "-1" }).answerCapUsd).toBe(0.02);
  });

  it("labels model ids for people", () => {
    expect(modelLabel("eu.anthropic.claude-sonnet-5-5")).toBe("Claude Sonnet 5.5");
    expect(modelLabel("amazon.nova-lite-v1:0")).toBe("Nova Lite V1:0");
  });
});

describe("pre-send estimate", () => {
  let tmp: string;
  let storage: Storage;
  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "memrain-chat-est-"));
    storage = new Storage({ dbPath: join(tmp, "db") });
    await storage.init();
    for (let i = 0; i < 10; i++) {
      const body = `Garden note ${i}: the tomatoes go in the north bed. ${"Soil and water notes. ".repeat(40)}`;
      await putPage(storage, { slug: `notes/garden-${i}`, markdown_body: body, title: `Garden ${i}` });
      await indexPageIntoSearch(storage, { slug: `notes/garden-${i}`, markdown_body: body, title: `Garden ${i}` }, { embedFn: deterministicEmbedQuery });
    }
  });
  afterAll(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("is never below what a turn actually costs (20 random usages within the call's bounds)", async () => {
    const estimate = estimateAnswerUsd(HAIKU)!;
    let seed = 7;
    const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    for (let i = 0; i < 20; i++) {
      const model: SonnetFn = async (input) => {
        const bytes = Buffer.byteLength(input.system + input.user, "utf8");
        // Every other turn bills the most the call could: one token per byte, the whole output cap.
        const usage = i % 2 === 0
          ? { inputTokens: bytes, outputTokens: input.maxTokens }
          : { inputTokens: Math.floor(rand() * bytes), outputTokens: Math.floor(rand() * input.maxTokens) };
        const text = input.system.includes("standalone question")
          ? "Where do the tomatoes go?"
          : JSON.stringify({ answer: "North bed [page://notes/garden-1].", citations: [{ ref: "page://notes/garden-1", kind: "page" }], gaps: [] });
        return { text, modelId: HAIKU, usage };
      };
      const ctx = { storage, owner: { ...operatorOwner(), key: `est-${i}` }, sonnetFn: model, embedFn: null, embedQuery: deterministicEmbedQuery,
        env: { MEMRAIN_CHAT: "1", MEMRAIN_DAILY_BUDGET_USD: "50", MEMRAIN_CHAT_USER_DAY_USD: "50" } as NodeJS.ProcessEnv };
      const first = await runChatTurn(ctx, { message: "where do the tomatoes go in the garden?" }, () => {});
      const second = await runChatTurn(ctx, { message: "and the soil?", threadId: first.thread_id }, () => {});
      for (const r of [first, second]) {
        expect(r.cost_usd).not.toBeNull();
        expect(r.cost_usd!).toBeLessThanOrEqual(estimate);
      }
    }
  });
});
