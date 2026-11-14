/**
 * The paid paths that predate the wallet, moved under it without changing
 * what they may spend.
 *
 * Locks: facts extraction (on write and on demand), the conversation-facts
 * backfill, the contextual-LLM tier and deep synthesis each make their model
 * calls inside a wallet path of their own name; an enclosing path keeps the
 * spend's name (a backfill's extraction books to the backfill); those paths add
 * no cap of their own and do not wait for MEMRAIN_DAILY_BUDGET_USD, so their
 * existing run caps are the only ones that bind until an operator opts into a
 * per-path day cap.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { currentWalletPath, paidPathWallet, runAsPath, runInWallet } from "../src/core/budget.ts";
import { extractFactsForPage, extractFactsOnDemand } from "../src/core/facts-extract.ts";
import { conversationFactsBackfillPhase } from "../src/core/cycle/conversation-facts-backfill.ts";
import { DEFAULT_BUDGET_USD as CONTEXTUAL_DEFAULT_USD, defaultContextualLlmBudget, generateChunkContext } from "../src/core/search/contextual-llm.ts";
import { runDeepSynthPhase } from "../src/core/synthesis/deep-synth.ts";
import type { SonnetFn } from "../src/core/llm/sonnet.ts";
import type { LlmFn } from "../src/core/llm/haiku.ts";

const ENV = ["MEMRAIN_DAILY_BUDGET_USD", "MEMRAIN_SPEND_PATH_FACTS_EXTRACT_MAX_USD_PER_DAY", "MEMRAIN_FACTS_EXTRACTION"] as const;

let tmp: string;
let storage: Storage;
beforeEach(async () => {
  for (const k of ENV) delete process.env[k];
  tmp = mkdtempSync(join(tmpdir(), "memrain-wallet-paths-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  for (const k of ENV) delete process.env[k];
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** A fake Sonnet that records the wallet path each call was made under. */
function recordingSonnet(seen: (string | null)[]): SonnetFn {
  return async () => {
    seen.push(currentWalletPath()?.role ?? null);
    return { text: "[]", modelId: "eu.anthropic.claude-sonnet-4-5-v1:0", usage: { inputTokens: 10, outputTokens: 2 } };
  };
}

const BODY = "Alice told Bob on Monday that the migration to the new billing system is planned for March, with Carol owning it.";

describe("existing paid paths under the wallet", () => {
  it("name a path that adds no cap and does not wait for a brain cap", () => {
    expect(paidPathWallet("facts-extract", {})).toEqual({ role: "facts-extract" });
    expect(paidPathWallet("facts-extract", { MEMRAIN_SPEND_PATH_FACTS_EXTRACT_MAX_USD_PER_DAY: "0.5" }))
      .toEqual({ role: "facts-extract", dayCapUsd: 0.5 });
    expect(defaultContextualLlmBudget(undefined)).toBe(CONTEXTUAL_DEFAULT_USD);
  });

  it("an enclosing path keeps the spend's name", async () => {
    const roles: (string | null)[] = [];
    await runInWallet({ role: "outer" }, () => runAsPath("inner", async () => { roles.push(currentWalletPath()?.role ?? null); }));
    await runAsPath("alone", async () => { roles.push(currentWalletPath()?.role ?? null); });
    expect(roles).toEqual(["outer", "alone"]);
  });

  it("facts extraction on write and on demand run as facts-extract", async () => {
    const onWrite: (string | null)[] = [];
    await putPage(storage, { slug: "notes/a", type: "note", title: "a", markdown_body: BODY });
    await extractFactsForPage(storage, { slug: "notes/a", type: "note", body: BODY, sonnetFn: recordingSonnet(onWrite) });
    const onDemand: (string | null)[] = [];
    await extractFactsOnDemand(BODY, { sonnetFn: recordingSonnet(onDemand) });
    expect(onWrite.length).toBeGreaterThan(0);
    expect(onDemand.length).toBeGreaterThan(0);
    expect(new Set([...onWrite, ...onDemand])).toEqual(new Set(["facts-extract"]));
  });

  it("the conversation-facts backfill books its extraction to itself", async () => {
    await putPage(storage, { slug: "notes/conv", type: "note", title: "c", markdown_body: BODY });
    const seen: (string | null)[] = [];
    const r = await conversationFactsBackfillPhase(storage, { sonnetFn: recordingSonnet(seen) });
    expect(r.pagesProcessed).toBe(1);
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set(["conversation-facts-backfill"]));
  });

  it("the contextual-LLM tier runs as contextual-llm", async () => {
    const seen: (string | null)[] = [];
    const llmFn: LlmFn = async () => {
      seen.push(currentWalletPath()?.role ?? null);
      return { text: "context", usage: { inputTokens: 10, outputTokens: 2 } } as Awaited<ReturnType<LlmFn>>;
    };
    expect(await generateChunkContext("doc text here", "chunk text", { llmFn })).toBe("context");
    expect(seen).toEqual(["contextual-llm"]);
  });

  it("deep synthesis runs as deep-synth", async () => {
    const seen: (string | null)[] = [];
    await runDeepSynthPhase(storage, {
      questions: ["what is planned?"],
      sonnetFn: recordingSonnet(seen),
      pagesFn: async () => [{ sourcePath: "notes/a.md", content: BODY } as never],
    });
    expect(new Set(seen)).toEqual(new Set(["deep-synth"]));
  });
});
