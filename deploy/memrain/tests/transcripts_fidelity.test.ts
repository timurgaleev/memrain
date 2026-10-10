/**
 * Session-log fidelity: Codex 0.153+ user turns, sessions with no user turn
 * reported as drift, paste-only turns kept out of the title and the user-turn
 * count; and the ingest run controls (--since, --no-embed, --facts, status).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SonnetFn } from "../src/core/llm/sonnet.ts";
import { Storage } from "../src/core/storage.ts";
import { parseClaudeCodeSession } from "../src/core/transcripts/claude-code.ts";
import { parseCodexRollout } from "../src/core/transcripts/codex.ts";
import { parseTranscriptJsonl } from "../src/core/transcripts/detect.ts";
import { parseJsonlRecords } from "../src/core/transcripts/jsonl.ts";
import { runTranscripts } from "../src/commands/transcripts.ts";
import { deterministicEmbed } from "./det-embed.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "transcripts");
const read = (name: string) => readFileSync(join(FIXTURES, name), "utf-8");
const codex0154 = read("codex-rollout-0154.jsonl");
const codexOld = read("codex-rollout.jsonl");
const pasted = read("claude-code-pasted.jsonl");
const assistantOnly = read("claude-code-assistant-only.jsonl");
const embedFn = async (t: string) => deterministicEmbed(t);

describe("codex 0.153+ rollouts", () => {
  const { sessions, skipped } = parseCodexRollout(parseJsonlRecords(codex0154).records);

  it("reads user turns recorded as item_completed UserMessage, and keeps a doubled turn once", () => {
    expect(skipped).toEqual([]);
    const s = sessions[0]!;
    expect(s.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "Which bakery did we pick for the offsite?"],
      ["assistant", "The corner bakery on Elm Street."],
      ["user", "Book it for Friday."],
      ["assistant", "Booked for Friday."],
    ]);
    expect(s.title).toBe("Which bakery did we pick for the offsite?");
  });

  it("leaves agent items, non-text blocks and injected context out", () => {
    const text = sessions[0]!.messages.map((m) => m.text).join("\n");
    for (const marker of ["AGENT-ITEM-ONLY", "IMAGE-BLOCK-ONLY", "INJECTED-ONLY"]) expect(text).not.toContain(marker);
  });

  it("still reads the older user_message shape", () => {
    expect(parseCodexRollout(parseJsonlRecords(codexOld).records).sessions[0]!.messages.filter((m) => m.role === "user")).toHaveLength(2);
  });
});

describe("sessions with no user turn", () => {
  it("skips an assistant-only Claude Code log as user_turns_missing and calls it drift", () => {
    const r = parseClaudeCodeSession(parseJsonlRecords(assistantOnly).records);
    expect(r.sessions).toEqual([]);
    expect(r.skipped).toEqual([{ index: 0, id: "cc-assistant-only-1", reason: "user_turns_missing" }]);
    const parsed = parseTranscriptJsonl(assistantOnly, assistantOnly.length);
    expect(parsed.diagnostics).toMatchObject({ format: "claude-code", user_turns_missing: 1, format_drift: true });
  });

  it("skips a codex rollout whose user turns are gone", () => {
    const noUser = codex0154
      .split("\n")
      .filter((l) => !l.includes("UserMessage") && !l.includes("\"user_message\""))
      .join("\n");
    const r = parseTranscriptJsonl(noUser, noUser.length);
    expect(r.sessions).toEqual([]);
    expect(r.diagnostics).toMatchObject({ format: "codex", user_turns_missing: 1, format_drift: true });
  });

  it("does not flag a log whose user records were all tool traffic", () => {
    const records = [
      { type: "user", sessionId: "t1", message: { role: "user", content: [{ type: "tool_result", content: "x" }] } },
      { type: "assistant", sessionId: "t1", message: { id: "m", role: "assistant", content: [{ type: "text", text: "done" }] } },
    ];
    const r = parseClaudeCodeSession(records);
    expect(r.sessions).toHaveLength(1);
  });
});

describe("paste-only turns", () => {
  it("never name the session and are not counted as user turns, but stay in the transcript", () => {
    const parsed = parseTranscriptJsonl(pasted, pasted.length);
    const s = parsed.sessions[0]!;
    expect(s.title).toBe("Summarise it in one line for my notes");
    expect(parsed.diagnostics.user_turns).toBe(1);
    expect(s.messages[0]!.text).toContain("PASTED-EMAIL-BODY");
  });
});

describe("memrain transcripts ingest run controls", () => {
  const tmp = mkdtempSync(join(tmpdir(), "memrain-transcripts-fidelity-"));
  const cfgPath = join(tmp, ".memex", "config.json");
  const logs = join(tmp, "logs");
  let log: ReturnType<typeof spyOn>;
  let errLog: ReturnType<typeof spyOn>;

  beforeAll(() => {
    mkdirSync(join(tmp, ".memex"), { recursive: true });
    writeFileSync(
      cfgPath,
      JSON.stringify({
        database: { type: "pglite", path: join(tmp, ".memex", "brain.pglite") },
        embedding: { provider: "bedrock-titan", model: "amazon.titan-embed-text-v2:0", region: "eu-west-1" },
        storage: {},
      }),
    );
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, "rollout-2026-10-01-a.jsonl"), codex0154);
    writeFileSync(join(logs, "cc-pasted-1.jsonl"), pasted);
  });
  beforeEach(() => {
    log = spyOn(console, "log").mockImplementation(() => {});
    errLog = spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    log.mockRestore();
    errLog.mockRestore();
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  const lastJson = () => JSON.parse(String(log.mock.calls.at(-1)![0]));
  const query = async <T,>(sql: string): Promise<T[]> => {
    const s = new Storage(JSON.parse(readFileSync(cfgPath, "utf-8")));
    await s.init();
    try {
      return (await s.engine().query<T>(sql)).rows;
    } finally {
      await s.close();
    }
  };

  it("imports the rest of a directory but exits non-zero for an assistant-only log", async () => {
    const dir = join(tmp, "with-drift");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "cc-pasted-1.jsonl"), pasted);
    writeFileSync(join(dir, "cc-assistant-only-1.jsonl"), assistantOnly);
    expect(await runTranscripts({ sub: "ingest", file: dir, json: true, configPath: cfgPath, embedFn, sourceId: "default" })).toBe(1);
    const out = lastJson();
    expect(out).toMatchObject({ ok: false, diagnostics: { user_turns_missing: 1, sessions: 1 }, result: { parts_written: 1 }, watermark: null });
  });

  it("refuses a single assistant-only log as drift", async () => {
    const file = join(tmp, "with-drift", "cc-assistant-only-1.jsonl");
    expect(await runTranscripts({ sub: "ingest", file, json: true, configPath: cfgPath })).toBe(1);
    expect(lastJson().error).toContain("user_turns_missing");
  });

  it("--no-embed writes the pages and leaves them out of search for the cycle", async () => {
    const file = join(logs, "rollout-2026-10-01-a.jsonl");
    expect(await runTranscripts({ sub: "ingest", file, json: true, configPath: cfgPath, noEmbed: true })).toBe(0);
    expect(lastJson().result).toMatchObject({ parts_written: 1, mirror_deferred: 1 });
    const docs = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM documents WHERE source_path LIKE '%transcripts/codex/rollout-0154%'`,
    );
    expect(docs[0]!.n).toBe(0);
  });

  it("--since auto skips what a clean run already covered, and an explicit --since filters", async () => {
    const run = (since?: string) =>
      runTranscripts({ sub: "ingest", file: logs, json: true, configPath: cfgPath, embedFn, ...(since ? { since } : {}) });
    expect(await run("auto")).toBe(0);
    const first = lastJson();
    expect(first.since).toEqual({ since: null, sessions_before: 2 });
    expect(first.watermark).toBe("2026-10-02T10:01:04.000Z");

    expect(await run("auto")).toBe(0);
    expect(lastJson()).toMatchObject({ since: { since: "2026-10-02T10:01:04.000Z", sessions_before: 2 }, result: { sessions: 0 } });

    expect(await run("2026-10-01T12:00:00Z")).toBe(0);
    expect(lastJson().result.sessions).toBe(1);
    expect(lastJson().watermark).toBeNull();

    expect(await runTranscripts({ sub: "ingest", file: logs, since: "yesterday-ish", json: true, configPath: cfgPath })).toBe(1);
  });

  it("status reports sessions per source and format, and the watermark", async () => {
    expect(await runTranscripts({ sub: "status", json: true, configPath: cfgPath })).toBe(0);
    const out = lastJson();
    expect(out.transcripts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source_id: "default", format: "claude-code", sessions: 1 }),
        expect.objectContaining({ source_id: "default", format: "codex", sessions: 1, parts: 1 }),
      ]),
    );
    // One per path: the single-file run before keeps its own.
    expect(out.watermarks).toHaveLength(2);
    expect(out.watermarks).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_id: "default", path: expect.stringMatching(/rollout-2026-10-01-a\.jsonl$/), watermark: "2026-10-01T08:01:02.000Z" }),
      expect.objectContaining({ source_id: "default", path: expect.stringMatching(/logs$/), watermark: "2026-10-02T10:01:04.000Z" }),
    ]));
  });

  it("--facts needs a dollar cap and the extraction gate", async () => {
    const file = join(logs, "cc-pasted-1.jsonl");
    expect(await runTranscripts({ sub: "ingest", file, facts: true, json: true, configPath: cfgPath })).toBe(1);
    expect(lastJson().error).toContain("--max-cost-usd");
    expect(await runTranscripts({ sub: "ingest", file, maxCostUsd: "1", json: true, configPath: cfgPath })).toBe(1);
    const saved = process.env.MEMRAIN_FACTS_EXTRACTION;
    delete process.env.MEMRAIN_FACTS_EXTRACTION;
    try {
      expect(await runTranscripts({ sub: "ingest", file, facts: true, maxCostUsd: "1", json: true, configPath: cfgPath })).toBe(1);
      expect(lastJson().error).toContain("MEMRAIN_FACTS_EXTRACTION=1");
    } finally {
      if (saved !== undefined) process.env.MEMRAIN_FACTS_EXTRACTION = saved;
    }
  });

  it("--facts extracts from the parts this run wrote, within the cap", async () => {
    let calls = 0;
    const sonnetFn: SonnetFn = async () => {
      calls++;
      return {
        text: JSON.stringify({ facts: [{ fact: "keeps one-line notes", kind: "preference", entity: "people/alice", confidence: 0.9, notability: "medium" }] }),
        modelId: "eu.anthropic.claude-sonnet-4-6",
        usage: { inputTokens: 100, outputTokens: 40 },
      };
    };
    const dir = join(tmp, "facts-run");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "cc-pasted-1.jsonl"), pasted.replaceAll("cc-pasted-1", "cc-facts-1"));
    expect(
      await runTranscripts({ sub: "ingest", file: dir, facts: true, maxCostUsd: "0.5", json: true, configPath: cfgPath, embedFn, sonnetFn }),
    ).toBe(0);
    expect(calls).toBe(1);
    expect(lastJson().facts).toMatchObject({ parts: 1, facts_written: 1, budget_exhausted: false });

    // An unchanged re-run writes no part, so it pays for nothing.
    expect(
      await runTranscripts({ sub: "ingest", file: dir, facts: true, maxCostUsd: "0.5", json: true, configPath: cfgPath, embedFn, sonnetFn }),
    ).toBe(0);
    expect(calls).toBe(1);
  });
});
