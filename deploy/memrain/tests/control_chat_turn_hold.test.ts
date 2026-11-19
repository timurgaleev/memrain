/**
 * One chat turn counts once against the brain's day. The turn holds its answer
 * cap before any model call; the calls inside it run under that hold, so the
 * brain-wide sum while the turn runs is the turn's cap, never the cap plus the
 * calls' own holds, and afterwards it is what the calls actually cost.
 */
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { indexPageIntoSearch } from "../src/core/page-index.ts";
import { brainDaySpendUsd, costUsd, setSpendLedgerEngine, trackedInvoke } from "../src/core/budget.ts";
import type { SonnetFn } from "../src/core/llm/sonnet.ts";
import { deterministicEmbedQuery } from "./det-embed.ts";
import { operatorOwner, runChatTurn } from "../src/core/chat/chat-service.ts";

setDefaultTimeout(60_000);

const MODEL = "eu.anthropic.claude-haiku-5-5";
const ANSWER_CAP = 0.02;
const USAGE = { inputTokens: 900, outputTokens: 120 };

let tmp: string;
let storage: Storage;
let savedCap: string | undefined;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-chat-hold-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  savedCap = process.env["MEMRAIN_DAILY_BUDGET_USD"];
  setSpendLedgerEngine(storage.engine());
});

afterEach(async () => {
  setSpendLedgerEngine(null);
  if (savedCap === undefined) delete process.env["MEMRAIN_DAILY_BUDGET_USD"];
  else process.env["MEMRAIN_DAILY_BUDGET_USD"] = savedCap;
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

const answer = JSON.stringify({
  answer: "The garden plan is to plant tomatoes [page://notes/garden].",
  citations: [{ ref: "page://notes/garden", kind: "page" }],
  gaps: [],
});

describe("chat turn against the brain's daily cap", () => {
  it("counts the turn once: a brain cap just above one answer still lets the answer through", async () => {
    const body = "The garden plan is to plant tomatoes in May.";
    await putPage(storage, { slug: "notes/garden", markdown_body: body, source_id: "default", title: "notes/garden" });
    await indexPageIntoSearch(storage, { slug: "notes/garden", markdown_body: body, source_id: "default", title: "notes/garden" },
      { embedFn: deterministicEmbedQuery });

    // Room for exactly one answer and a little more, never for the answer's
    // hold plus the call's own hold on top of it.
    const brainCap = ANSWER_CAP + 0.001;
    process.env["MEMRAIN_DAILY_BUDGET_USD"] = String(brainCap);
    const seenDuringCall: number[] = [];
    const booked: SonnetFn = (input) => trackedInvoke(
      { operation: "chat", model: MODEL, worstCase: { input: input.system + input.user, maxOutputTokens: input.maxTokens } },
      async (meter) => {
        seenDuringCall.push(await brainDaySpendUsd(storage.engine()));
        meter.report(USAGE);
        return { text: answer, modelId: MODEL, usage: USAGE };
      },
    );

    const result = await runChatTurn({
      storage,
      owner: operatorOwner(),
      env: { MEMRAIN_CHAT: "1", MEMRAIN_DAILY_BUDGET_USD: String(brainCap), MEMRAIN_CHAT_ANSWER_MAX_USD: String(ANSWER_CAP) },
      sonnetFn: booked,
      embedFn: null,
      embedQuery: deterministicEmbedQuery,
    }, { message: "what is the garden plan?" }, () => {});

    expect(result.status).toBe("ok");
    expect(seenDuringCall).toHaveLength(1);
    expect(seenDuringCall[0]!).toBeLessThanOrEqual(ANSWER_CAP + 1e-9);
    expect(await brainDaySpendUsd(storage.engine())).toBeCloseTo(costUsd(MODEL, USAGE), 9);
  });
});
