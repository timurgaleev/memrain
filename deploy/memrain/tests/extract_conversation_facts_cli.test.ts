/**
 * `memrain extract-conversation-facts` reads a turn the model declines in two
 * halves, keeps the facts of every other turn, stops cleanly at its budget,
 * and stores a claim its speaker asked to keep quiet private.
 *
 * Value: protects=one refused turn does not cost the transcript's other facts, the halves retry is bounded by the
 * run's budget, and a keep-quiet request narrows the claim; fails_when=a refusal is dropped silently again, the
 * halves retry ignores the cap, or the CLI writes kept-quiet claims at the batch visibility;
 * why_new=the CLI had neither behaviour (the page path did); seam=runExtractConversationFacts with a faked model;
 * no_claim=the live Bedrock stop reasons are covered by the extractor's own tests, not here.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { runExtractConversationFacts } from "../src/commands/extract-conversation-facts.ts";
import type { SonnetCallResult, SonnetFn } from "../src/core/llm/sonnet.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-convcli-"));
  storage = new Storage({ dbPath: join(tmp, "brain.pglite") });
  await storage.init();
  await putPage(storage, { slug: "people/alice", type: "person" });
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

const MODEL = "eu.anthropic.claude-sonnet-4-6";
const QUIET = "Alice reviewed the budget for turn three. ".repeat(8).trim();
const TOUCHY = "SENSITIVE PASSAGE the model will not read. ".repeat(8).trim();

const turn = (n: number, text: string) => `**Alice** (2024-03-1${n} 9:00 AM): ${text}`;
const FIVE = [
  turn(1, "Turn one: Alice moved to Lisbon."),
  turn(2, "Turn two: Alice started at Acme."),
  `${turn(3, QUIET)}\n${TOUCHY}`,
  turn(4, "Turn four: Alice adopted a cat."),
  turn(5, "Turn five: Alice runs on Sundays."),
].join("\n");

const refusal: SonnetCallResult = { text: "", modelId: MODEL, usage: { inputTokens: 10_000, outputTokens: 0 }, stopReason: "content_filtered" };

/** Refuses any prompt holding the touchy passage; otherwise echoes the turn back as one fact about Alice. */
function filtering(): { fn: SonnetFn; users: string[] } {
  const users: string[] = [];
  const fn: SonnetFn = async (input) => {
    users.push(input.user);
    if (input.user.includes("SENSITIVE PASSAGE")) return refusal;
    const body = input.user.match(/<turn>\n([\s\S]*?)\n<\/turn>/)?.[1] ?? "";
    const label = body.match(/Turn \w+|turn three/)?.[0] ?? "unknown";
    return {
      text: JSON.stringify({ facts: [{ fact: `Alice said ${label}.`, kind: "fact", entity: "people/alice", confidence: 0.9, notability: "high" }] }),
      modelId: MODEL,
      usage: { inputTokens: 10_000, outputTokens: 0 },
    };
  };
  return { fn, users };
}

async function factTexts(): Promise<string[]> {
  const r = await storage.engine().query<{ fact: string }>("SELECT fact FROM entity_facts ORDER BY fact");
  return r.rows.map((row) => row.fact);
}

describe("extract-conversation-facts declined turns", () => {
  it("keeps the other turns' facts and retries the declined turn once as halves", async () => {
    const { fn, users } = filtering();
    const report = await runExtractConversationFacts(storage, { text: FIVE, sonnetFn: fn, modelId: MODEL, maxBudgetUsd: 5 });
    // Five turns, plus the two halves of turn three.
    expect(users).toHaveLength(7);
    expect(report.declinedWindows).toBe(1);
    expect(report.budgetExhausted).toBe(false);
    expect(await factTexts()).toEqual([
      "Alice said Turn five.",
      "Alice said Turn four.",
      "Alice said Turn one.",
      "Alice said Turn two.",
      "Alice said turn three.",
    ]);
    // Each half carries the speaker label, so the keep-quiet reading still knows who spoke.
    expect(users.slice(3, 5).every((u) => u.includes("<turn>\nAlice: "))).toBe(true);
  });

  it("a budget that runs out during the halves retry stops the run and keeps the facts before it", async () => {
    const { fn, users } = filtering();
    // Each call costs $0.03 and a worst case $0.072: after three calls (turns one, two and three whole) the halves do not fit.
    const report = await runExtractConversationFacts(storage, { text: FIVE, sonnetFn: fn, modelId: MODEL, maxBudgetUsd: 0.15 });
    expect(users).toHaveLength(3);
    expect(report.budgetExhausted).toBe(true);
    expect(report.declinedWindows).toBe(1);
    expect(await factTexts()).toEqual(["Alice said Turn one.", "Alice said Turn two."]);
  });

  it("stores a claim the speaker asked to keep secret as kept quiet", async () => {
    const fn: SonnetFn = async () => ({
      text: JSON.stringify({ facts: [{ fact: "Alice is joining Beta Example.", kind: "fact", entity: "people/alice", confidence: 0.9, notability: "high" }] }),
      modelId: MODEL,
      usage: { inputTokens: 100, outputTokens: 20 },
    });
    const said = await runExtractConversationFacts(storage, {
      text: "**user** (2024-03-15 9:00 AM): Please keep this secret: Alice is joining Beta Example.",
      sonnetFn: fn, modelId: MODEL, maxBudgetUsd: 1,
    });
    expect(said.keptQuiet).toBe(1);
    const echoed = await runExtractConversationFacts(storage, {
      text: "**assistant** (2024-03-15 9:01 AM): Understood, keep this secret: Alice is joining Beta Example.",
      sonnetFn: fn, modelId: MODEL, maxBudgetUsd: 1,
    });
    expect(echoed.keptQuiet).toBe(0);
  });
});
