/**
 * P5-C7: the spend report's chat slice — calls booked on the `chat` wallet
 * path, by day, model and spender, and nothing else.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { logSpend } from "../src/core/budget.ts";
import { spendReport } from "../src/core/spend-report.ts";
import { appendChatMessage, createChatThread } from "../src/core/chat/store.ts";

let tmp: string;
let storage: Storage;
beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-spend-chat-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

const HAIKU = "eu.anthropic.claude-haiku-5-5";
const SONNET = "eu.anthropic.claude-sonnet-5-5";

describe("spend report chat slice", () => {
  it("sums only chat calls and matches the cost the chat messages show", async () => {
    const e = storage.engine();
    const owner = { key: "operator", sourceId: "default", spendId: "memrain_chat_operator" };
    const thread = await createChatThread(e, owner, "q");
    const answers = [{ usd: 0.0031, model: HAIKU }, { usd: 0.0125, model: SONNET }];
    for (const a of answers) {
      await logSpend(e, { clientId: owner.spendId, operation: "chat", costUsd: a.usd, model: a.model, role: "chat", outcome: "ok", usage: { inputTokens: 1000, outputTokens: 100 } });
      await appendChatMessage(e, thread, { role: "assistant", content: "a", status: "ok", costUsd: a.usd, model: a.model });
    }
    await logSpend(e, { clientId: owner.spendId, operation: "chat", costUsd: 0, model: HAIKU, role: "chat", outcome: "refused" });
    await logSpend(e, { operation: "think", costUsd: 1.5, model: SONNET, outcome: "ok" });
    await logSpend(e, { operation: "facts", costUsd: 0.4, model: HAIKU, role: "facts-extract", phase: "extract", outcome: "ok" });

    const r = await spendReport(e, { days: 7 });
    const shown = (await e.query<{ usd: number }>(`SELECT COALESCE(SUM(cost_usd), 0)::float8 AS usd FROM chat_messages`)).rows[0]!.usd;
    expect(r.chat.total_usd).toBeCloseTo(shown, 9);
    expect(r.chat.calls).toBe(2);
    expect(r.chat.by_model.map(g => g.key)).toEqual([SONNET, HAIKU]);
    expect(r.chat.by_client).toEqual([expect.objectContaining({ key: owner.spendId, calls: 2 })]);
    expect(r.chat.by_day).toHaveLength(1);
    expect(r.chat.by_day[0]!.key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.total_usd).toBeCloseTo(0.0031 + 0.0125 + 1.5 + 0.4, 9);
  });
});
