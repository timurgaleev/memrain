/**
 * The agent loop against a real ledger (PGLite) with scripted Converse turns
 * and a counting dispatcher: a normal run, a resume after the process died
 * mid-tool (completed tools are not re-run, a foreign pending row is skipped),
 * the per-job budget seeded from jobs.cost_usd, terminal stop reasons and the
 * turn cap, and a lost claim stopping the loop. Plus the payload and timeout
 * rules of the `subagent` handler.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContentBlock, Message } from "@aws-sdk/client-bedrock-runtime";
import { Storage } from "../src/core/storage.ts";
import { Queue } from "../src/core/jobs/queue.ts";
import type { JobRow } from "../src/core/jobs/types.ts";
import type { ConverseFn, ConverseTurnInput } from "../src/core/llm/converse.ts";
import type { ToolCallRequest, ToolCallResult } from "../src/mcp/dispatch.ts";
import { AgentClaimLost, INTERRUPTED_TOOL_RESULT, runAgent } from "../src/core/agent/runner.ts";
import { listMessages, listToolExecutions } from "../src/core/subagent_ledger.ts";
import {
  AGENT_JOB_TIMEOUT_MS,
  SUBAGENT_JOB_KIND,
  makeSubagentHandler,
  parseSubagentPayload,
} from "../src/core/agent/handler.ts";

const HAIKU = "eu.anthropic.claude-haiku-4-5-20251001-v1:0";

let tmp: string;
let storage: Storage;
let queue: Queue;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-agent-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  queue = new Queue(storage.engine());
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function claimNew(): Promise<JobRow> {
  await queue.enqueue({ kind: SUBAGENT_JOB_KIND, payload: { task: "t" }, maxRetries: 0 });
  return (await queue.claim({ kinds: [SUBAGENT_JOB_KIND] }))!;
}

/** What the stall sweep does to a job whose process died: requeue, then a new claim. */
async function reclaim(job: JobRow): Promise<JobRow> {
  await storage.engine().query(
    `UPDATE jobs SET status = 'pending', lock_until = NULL, started_at = NULL WHERE id = $1`,
    [job.id],
  );
  return (await queue.claim({ kinds: [SUBAGENT_JOB_KIND] }))!;
}

interface ScriptedTurn {
  content: Message["content"];
  stopReason: string;
  usage?: { inputTokens: number; outputTokens: number };
}

function script(turns: ScriptedTurn[]): { fn: ConverseFn; calls: ConverseTurnInput[] } {
  const calls: ConverseTurnInput[] = [];
  const fn: ConverseFn = async (input) => {
    calls.push(input);
    const t = turns[calls.length - 1];
    if (!t) throw new Error(`unscripted converse call #${calls.length}`);
    return {
      message: { role: "assistant", content: t.content },
      stopReason: t.stopReason,
      usage: t.usage ?? { inputTokens: 1000, outputTokens: 100 },
      modelId: HAIKU,
    };
  };
  return { fn, calls };
}

function counter(
  respond: (req: ToolCallRequest) => Promise<ToolCallResult> = async (req) => ({
    content: [{ type: "text", text: `result of ${req.name}` }],
  }),
): { calls: ToolCallRequest[]; fn: (s: Storage, req: ToolCallRequest) => Promise<ToolCallResult> } {
  const calls: ToolCallRequest[] = [];
  return {
    calls,
    fn: async (_s, req) => {
      calls.push(req);
      return respond(req);
    },
  };
}

const use = (
  id: string,
  name = "search",
  input: Record<string, unknown> = { q: "memex" },
): ContentBlock => ({ toolUse: { toolUseId: id, name, input: input as never } });

function ctxFor(job: JobRow) {
  return {
    recordUsage: (u: Parameters<Queue["recordUsage"]>[2]) => queue.recordUsage(job.id, job.claimGeneration, u),
    updateProgress: (p: Record<string, unknown>) => queue.updateProgress(job.id, job.claimGeneration, p),
  };
}

async function jobCost(id: string): Promise<number> {
  return (await queue.get(id))!.costUsd;
}

describe("runAgent", () => {
  it("runs tool turns to an end_turn answer and records every turn", async () => {
    const job = await claimNew();
    const s = script([
      { content: [{ text: "looking" }, use("t1")], stopReason: "tool_use" },
      { content: [{ text: "memex is a brain [[memex]]" }], stopReason: "end_turn" },
    ]);
    const d = counter();
    const r = await runAgent({
      storage, job, task: "what is memex?", maxUsd: 0.25, modelId: HAIKU,
      converse: s.fn, dispatch: d.fn, ...ctxFor(job),
    });
    expect(r.stop_reason).toBe("end_turn");
    expect(r.final_text).toBe("memex is a brain [[memex]]");
    expect(r.turns).toBe(2);
    expect(d.calls).toEqual([{ name: "search", arguments: { q: "memex" } }]);

    const msgs = await listMessages(storage, job.id);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "tool_result", "assistant"]);
    const execs = await listToolExecutions(storage, job.id);
    expect(execs).toHaveLength(1);
    expect(execs[0]!.status).toBe("succeeded");
    expect(execs[0]!.tool_use_id).toBe("t1");
    expect(execs[0]!.run_generation).toBe(job.claimGeneration);

    // The second call saw the tool's answer paired with its toolUse.
    const second = s.calls[1]!.messages;
    expect(second[2]!.content![0]!.toolResult!.content![0]!.text).toBe("result of search");
    expect(s.calls[1]!.operation).toBe("agent");
    // Every call's cost reached the job row.
    expect(r.cost_usd).toBeGreaterThan(0);
    expect(await jobCost(job.id)).toBeCloseTo(r.cost_usd, 9);
  });

  it("replays reasoning blocks byte for byte, redacted bytes included", async () => {
    const job = await claimNew();
    const redacted = new Uint8Array([0, 1, 254, 255]);
    const s = script([
      {
        content: [
          { reasoningContent: { reasoningText: { text: "plan", signature: "sig" } } },
          { reasoningContent: { redactedContent: redacted } },
          use("t1"),
        ],
        stopReason: "tool_use",
      },
      { content: [{ text: "done" }], stopReason: "end_turn" },
    ]);
    await runAgent({
      storage, job, task: "t", maxUsd: 0.25, modelId: HAIKU,
      converse: s.fn, dispatch: counter().fn, ...ctxFor(job),
    });
    const replayed = s.calls[1]!.messages[1]!.content!;
    expect(replayed[0]!.reasoningContent!.reasoningText).toEqual({ text: "plan", signature: "sig" });
    const bytes = replayed[1]!.reasoningContent!.redactedContent;
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect([...bytes!]).toEqual([...redacted]);
  });

  it("resumes after a kill mid-tool without re-running the finished tool", async () => {
    const first = await claimNew();
    const hang = new Promise<ToolCallResult>(() => {});
    const d1 = counter(async (req) =>
      req.name === "page_get" ? hang : { content: [{ type: "text", text: "found it" }] },
    );
    const s1 = script([
      { content: [use("done-1"), use("killed-1", "page_get", { slug: "a" })], stopReason: "tool_use" },
    ]);
    // The first attempt hangs inside its second tool: the process "dies" there.
    void runAgent({
      storage, job: first, task: "t", maxUsd: 0.25, modelId: HAIKU,
      converse: s1.fn, dispatch: d1.fn, ...ctxFor(first),
    });
    for (let i = 0; i < 200 && d1.calls.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    expect(d1.calls.map((c) => c.name)).toEqual(["search", "page_get"]);

    const second = await reclaim(first);
    expect(second.claimGeneration).toBeGreaterThan(first.claimGeneration);
    const d2 = counter();
    const s2 = script([{ content: [{ text: "partial answer" }], stopReason: "end_turn" }]);
    const r = await runAgent({
      storage, job: second, task: "t", maxUsd: 0.25, modelId: HAIKU,
      converse: s2.fn, dispatch: d2.fn, ...ctxFor(second),
    });
    expect(r.stop_reason).toBe("end_turn");
    // Nothing was dispatched again: the finished call was answered from its
    // row, the interrupted one was skipped.
    expect(d2.calls).toHaveLength(0);
    const execs = await listToolExecutions(storage, first.id);
    expect(execs.filter((e) => e.tool_use_id === "done-1")).toHaveLength(1);
    expect(execs.find((e) => e.tool_use_id === "done-1")!.status).toBe("succeeded");
    const killed = execs.filter((e) => e.tool_use_id === "killed-1");
    expect(killed).toHaveLength(1);
    expect(killed[0]!.status).toBe("skipped");
    expect(killed[0]!.run_generation).toBe(first.claimGeneration);

    const results = s2.calls[0]!.messages[2]!.content!.map((b) => b.toolResult!);
    expect(results.find((t) => t.toolUseId === "done-1")!.content![0]!.text).toBe("found it");
    const k = results.find((t) => t.toolUseId === "killed-1")!;
    expect(k.status).toBe("error");
    expect(k.content![0]!.text).toBe(INTERRUPTED_TOOL_RESULT);
    // The resumed attempt did not call the model for the turn it already had.
    expect(s2.calls).toHaveLength(1);
  });

  it("skips a pending row from another generation and never dispatches its input", async () => {
    const job = await claimNew();
    const s = script([
      { content: [use("forged", "page_get", { slug: "from-model" })], stopReason: "tool_use" },
      { content: [{ text: "ok" }], stopReason: "end_turn" },
    ]);
    // A pending row for the same toolUse, planted under another generation
    // with different input, before this attempt reaches it.
    const d = counter();
    const planting: ConverseFn = async (input) => {
      const out = await s.fn(input);
      if (s.calls.length === 1) {
        await storage.engine().query(
          `INSERT INTO subagent_tool_executions
             (job_id, turn_num, tool_name, input, status, tool_use_id, run_generation)
           VALUES ($1, 1, 'page_get', '{"slug":"planted"}'::jsonb, 'pending', 'forged', $2)`,
          [job.id, job.claimGeneration + 5],
        );
      }
      return out;
    };
    const r = await runAgent({
      storage, job, task: "t", maxUsd: 0.25, modelId: HAIKU,
      converse: planting, dispatch: d.fn, ...ctxFor(job),
    });
    expect(r.stop_reason).toBe("end_turn");
    expect(d.calls).toHaveLength(0);
    const execs = await listToolExecutions(storage, job.id);
    expect(execs).toHaveLength(1);
    expect(execs[0]!.status).toBe("skipped");
  });

  it("starts the budget from jobs.cost_usd and stops before a call that would not fit", async () => {
    const job = await claimNew();
    await queue.recordUsage(job.id, job.claimGeneration, { costUsd: 0.2499 });
    const seeded = (await queue.get(job.id))!;
    const s = script([{ content: [{ text: "never" }], stopReason: "end_turn" }]);
    const r = await runAgent({
      storage, job: seeded, task: "t", maxUsd: 0.25, modelId: HAIKU,
      converse: s.fn, dispatch: counter().fn, ...ctxFor(seeded),
    });
    expect(r.stop_reason).toBe("budget_exhausted");
    expect(s.calls).toHaveLength(0);
    expect(r.cost_usd).toBeCloseTo(0.2499, 9);
  });

  it("ends on BudgetExhausted after a call that overran, with its cost on the job", async () => {
    const job = await claimNew();
    const s = script([
      // 60k output tokens on Haiku = $0.30, far over what was reserved.
      { content: [use("t1")], stopReason: "tool_use", usage: { inputTokens: 1000, outputTokens: 60_000 } },
    ]);
    const d = counter();
    const r = await runAgent({
      storage, job, task: "t", maxUsd: 0.25, modelId: HAIKU,
      converse: s.fn, dispatch: d.fn, ...ctxFor(job),
    });
    expect(r.stop_reason).toBe("budget_exhausted");
    // The turn is recorded, its tools are not run.
    expect(d.calls).toHaveLength(0);
    expect(await jobCost(job.id)).toBeCloseTo(r.cost_usd, 9);
    expect(r.cost_usd).toBeGreaterThan(0.25);
  });

  for (const reason of ["max_tokens", "guardrail_intervened", "content_filtered"]) {
    it(`ends terminally on ${reason} without running tools in that turn`, async () => {
      const job = await claimNew();
      const s = script([{ content: [{ text: "cut" }, use("t1")], stopReason: reason }]);
      const d = counter();
      const r = await runAgent({
        storage, job, task: "t", maxUsd: 0.25, modelId: HAIKU,
        converse: s.fn, dispatch: d.fn, ...ctxFor(job),
      });
      expect(r.stop_reason).toBe(reason);
      expect(d.calls).toHaveLength(0);
      // A resume of the same job ends the same way without calling the model.
      const again = script([]);
      const r2 = await runAgent({
        storage, job, task: "t", maxUsd: 0.25, modelId: HAIKU,
        converse: again.fn, dispatch: d.fn,
      });
      expect(r2.stop_reason).toBe(reason);
      expect(again.calls).toHaveLength(0);
    });
  }

  it("holds the turn cap", async () => {
    const job = await claimNew();
    const s = script(
      Array.from({ length: 5 }, (_, i) => ({ content: [use(`t${i}`)], stopReason: "tool_use" })),
    );
    const d = counter();
    const r = await runAgent({
      storage, job, task: "t", maxUsd: 0.25, modelId: HAIKU, maxTurns: 3,
      converse: s.fn, dispatch: d.fn, ...ctxFor(job),
    });
    expect(r.stop_reason).toBe("turn_cap");
    expect(r.turns).toBe(3);
    expect(s.calls).toHaveLength(3);
    expect(d.calls).toHaveLength(3);
  });
});

describe("runAgent after losing its claim", () => {
  it("stops after a Converse call once a newer attempt holds the job", async () => {
    const job = await claimNew();
    const s = script([
      { content: [use("t1")], stopReason: "tool_use" },
      { content: [{ text: "never" }], stopReason: "end_turn" },
    ]);
    // The stall sweep requeues and re-claims the row while turn 1 is in flight.
    const losing: ConverseFn = async (input) => {
      const out = await s.fn(input);
      await reclaim(job);
      return out;
    };
    const d = counter();
    await expect(
      runAgent({
        storage, job, task: "t", maxUsd: 0.25, modelId: HAIKU,
        converse: losing, dispatch: d.fn, ...ctxFor(job),
      }),
    ).rejects.toBeInstanceOf(AgentClaimLost);
    expect(s.calls).toHaveLength(1);
    expect(d.calls).toHaveLength(0);
    // Nothing after the task: the orphan's turn is not in the ledger.
    expect((await listMessages(storage, job.id)).map((m) => m.role)).toEqual(["user"]);
    expect(await listToolExecutions(storage, job.id)).toHaveLength(0);
  });

  it("does not call the model again when the claim is lost while tools run", async () => {
    const job = await claimNew();
    const s = script([
      { content: [use("t1")], stopReason: "tool_use" },
      { content: [{ text: "never" }], stopReason: "end_turn" },
    ]);
    const d = counter(async () => {
      await reclaim(job);
      return { content: [{ type: "text", text: "ok" }] };
    });
    await expect(
      runAgent({
        storage, job, task: "t", maxUsd: 0.25, modelId: HAIKU,
        converse: s.fn, dispatch: d.fn, ...ctxFor(job),
      }),
    ).rejects.toBeInstanceOf(AgentClaimLost);
    expect(s.calls).toHaveLength(1);
    expect(d.calls).toHaveLength(1);
  });

  it("stops when the job was dead-lettered under the same claim", async () => {
    const job = await claimNew();
    const s = script([
      { content: [use("t1")], stopReason: "tool_use" },
      { content: [{ text: "never" }], stopReason: "end_turn" },
    ]);
    const timingOut: ConverseFn = async (input) => {
      const out = await s.fn(input);
      await queue.fail(job.id, job.claimGeneration, "timed out", { terminal: true });
      return out;
    };
    const d = counter();
    await expect(
      runAgent({
        storage, job, task: "t", maxUsd: 0.25, modelId: HAIKU,
        converse: timingOut, dispatch: d.fn, ...ctxFor(job),
      }),
    ).rejects.toBeInstanceOf(AgentClaimLost);
    expect(s.calls).toHaveLength(1);
    expect(d.calls).toHaveLength(0);
  });
});

describe("subagent handler", () => {
  it("refuses a job queued without a timeout, before any model call", async () => {
    const job = await claimNew();
    expect(job.timeoutMs).toBeNull();
    const s = script([{ content: [{ text: "never" }], stopReason: "end_turn" }]);
    const handler = makeSubagentHandler(storage, { converse: s.fn, modelId: HAIKU });
    await expect(handler({ task: "t" }, { job, ...ctxFor(job) })).rejects.toThrow(/timeout_ms/);
    expect(s.calls).toHaveLength(0);
    expect(await listMessages(storage, job.id)).toHaveLength(0);
  });

  it("runs a job queued with a timeout", async () => {
    await queue.enqueue({
      kind: SUBAGENT_JOB_KIND, payload: { task: "t" }, maxRetries: 0, timeoutMs: AGENT_JOB_TIMEOUT_MS,
    });
    const job = (await queue.claim({ kinds: [SUBAGENT_JOB_KIND] }))!;
    const s = script([{ content: [{ text: "done" }], stopReason: "end_turn" }]);
    const handler = makeSubagentHandler(storage, { converse: s.fn, modelId: HAIKU });
    const r = await handler({ task: "t" }, { job, ...ctxFor(job) });
    expect(r).toMatchObject({ stop_reason: "end_turn", final_text: "done" });
  });
});

describe("parseSubagentPayload", () => {
  it("requires a non-empty task of at most 8 KB", () => {
    expect(() => parseSubagentPayload({}, 0.25)).toThrow(/task/);
    expect(() => parseSubagentPayload({ task: "   " }, 0.25)).toThrow(/task/);
    expect(() => parseSubagentPayload({ task: "x".repeat(8 * 1024 + 1) }, 0.25)).toThrow(/8192/);
    expect(parseSubagentPayload({ task: "x".repeat(8 * 1024) }, 0.25).task).toHaveLength(8192);
  });

  it("clamps max_usd to the ceiling and refuses a non-positive one", () => {
    expect(parseSubagentPayload({ task: "t" }, 0.25).maxUsd).toBe(0.25);
    expect(parseSubagentPayload({ task: "t", max_usd: 0.1 }, 0.25).maxUsd).toBe(0.1);
    expect(parseSubagentPayload({ task: "t", max_usd: 5 }, 0.25).maxUsd).toBe(0.25);
    expect(() => parseSubagentPayload({ task: "t", max_usd: 0 }, 0.25)).toThrow(/max_usd/);
    expect(() => parseSubagentPayload({ task: "t", max_usd: "1" }, 0.25)).toThrow(/max_usd/);
  });
});
