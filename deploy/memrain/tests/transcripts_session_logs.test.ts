/**
 * Codex CLI rollouts and Claude Code session logs: turn selection (what was
 * said stays; tool traffic, injected context and sub-agents go), detection,
 * drift, and the CLI over one file and over a directory of logs.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { parseClaudeCodeSession } from "../src/core/transcripts/claude-code.ts";
import { parseCodexRollout } from "../src/core/transcripts/codex.ts";
import { parseTranscriptJsonl } from "../src/core/transcripts/detect.ts";
import { parseJsonlRecords, titleFromText } from "../src/core/transcripts/jsonl.ts";
import { prepareSession } from "../src/core/transcripts/ingest.ts";
import { runTranscripts } from "../src/commands/transcripts.ts";
import { deterministicEmbed } from "./det-embed.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "transcripts");
const codexRaw = readFileSync(join(FIXTURES, "codex-rollout.jsonl"), "utf-8");
const codexSubagentRaw = readFileSync(join(FIXTURES, "codex-subagent-rollout.jsonl"), "utf-8");
const claudeRaw = readFileSync(join(FIXTURES, "claude-code-session.jsonl"), "utf-8");
const PAT = `memex_${"cd34".repeat(16)}`;
const embedFn = async (t: string) => deterministicEmbed(t);

function allText(raw: string, parse: typeof parseCodexRollout): string {
  return parse(parseJsonlRecords(raw).records).sessions.flatMap((s) => s.messages.map((m) => m.text)).join("\n");
}

describe("codex rollout adapter", () => {
  const { sessions, skipped, skippedMessages } = parseCodexRollout(parseJsonlRecords(codexRaw).records);

  it("keeps typed user text and assistant answers, in order", () => {
    expect(skipped).toEqual([]);
    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(s.format).toBe("codex");
    expect(s.messages.map((m) => [m.role, m.speaker])).toEqual([
      ["user", "User"],
      ["assistant", "Codex"],
      ["user", "User"],
      ["assistant", "Codex"],
    ]);
    expect(s.messages[0]!.text).toBe("Remind me: which fund led the widget-co seed round?");
    expect(s.messages[3]!.text).toBe("Noted: bridge check-in every Thursday.\nI will keep that in the plan.");
    expect(s.messages[1]!.id).toBe("ri-6");
    expect(s.messages[0]!.ts).toBe(Date.parse("2026-08-02T09:00:03.000Z"));
    // Injected developer/user response items are counted as dropped.
    expect(skippedMessages).toBe(2);
  });

  it("takes identity and start from the first header, not an inherited one", () => {
    const s = sessions[0]!;
    expect(s.id).toBe("rollout-1");
    expect(s.startedAt).toBe(Date.parse("2026-08-02T09:00:00.000Z"));
    expect(s.title).toBe("Remind me: which fund led the widget-co seed round?");
  });

  it("drops injected context, reasoning and tool traffic", () => {
    const text = allText(codexRaw, parseCodexRollout);
    for (const marker of ["PREAMBLE-ONLY", "PLUGIN-LIST-ONLY", "REASONING-ONLY", "TOOL-OUTPUT-ONLY", "FUNCTION-OUTPUT-ONLY", "widget-co seed\\\""]) {
      expect(text).not.toContain(marker);
    }
  });

  it("falls back to session_id and skips a rollout with no header", () => {
    const meta = { type: "session_meta", payload: { session_id: "root-1" } };
    const turn = { type: "event_msg", payload: { type: "user_message", message: "hi" } };
    expect(parseCodexRollout([meta, turn]).sessions[0]!.id).toBe("root-1");
    expect(parseCodexRollout([turn]).skipped[0]!.reason).toBe("no session_meta id");
  });

  it("skips a sub-agent rollout and keeps string sources", () => {
    const sub = parseCodexRollout(parseJsonlRecords(codexSubagentRaw).records);
    expect(sub.sessions).toEqual([]);
    expect(sub.skipped).toEqual([{ index: 0, id: "rollout-review-1", reason: "subagent rollout" }]);
    const turn = { type: "event_msg", payload: { type: "user_message", message: "hi" } };
    const review = { type: "session_meta", payload: { id: "r", source: { subagent: "review" } } };
    expect(parseCodexRollout([review, turn]).skipped[0]!.reason).toBe("subagent rollout");
    for (const source of ["cli", "exec", "vscode"]) {
      const meta = { type: "session_meta", payload: { id: "s", source } };
      expect(parseCodexRollout([meta, turn]).sessions).toHaveLength(1);
    }
  });
});

describe("claude code session adapter", () => {
  const { sessions, skipped, skippedMessages } = parseClaudeCodeSession(parseJsonlRecords(claudeRaw).records);

  it("keeps what was said and joins a reply split across records", () => {
    expect(skipped).toEqual([]);
    const s = sessions[0]!;
    expect(s.format).toBe("claude-code");
    expect(s.id).toBe("cc-fixture-session-1");
    expect(s.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "What do we know about widget-co's seed round?"],
      ["assistant", "widget-co raised a seed round led by fund-a.\n\nalice-example introduced the founders to charlie-example."],
      ["assistant", "Summary: the widget-co seed closed in early 2026 with fund-a leading."],
      ["user", "Note that the bridge check-in is every Thursday."],
      ["assistant", "Noted: bridge check-in every Thursday."],
    ]);
    expect(s.messages[0]!.id).toBe("u-0001");
    expect(s.messages[1]!.speaker).toBe("Claude");
    expect(s.startedAt).toBe(Date.parse("2026-08-01T10:00:00.000Z"));
    // caveat, /clear, tool_use-only, tool_result, sidechain, interrupt, compact summary
    expect(skippedMessages).toBe(7);
  });

  it("titles the session from its own summary, never a resumed one's", () => {
    expect(sessions[0]!.title).toBe("widget-co seed round and the Thursday check-in");
    const noOwn = parseJsonlRecords(claudeRaw).records.filter(
      (r) => (r as { leafUuid?: string }).leafUuid !== "a-0011",
    );
    expect(parseClaudeCodeSession(noOwn).sessions[0]!.title).toBe("What do we know about widget-co's seed round?");
  });

  it("drops system reminders, harness bookkeeping, tools, thinking and sub-agents", () => {
    const text = allText(claudeRaw, parseClaudeCodeSession);
    for (const marker of [
      "REMINDER-ONLY",
      "CAVEAT-ONLY",
      "/clear",
      "TOOL-INPUT-ONLY",
      "TOOL-RESULT-ONLY",
      "THINKING-ONLY",
      "SIDECHAIN-ONLY",
      "COMPACT-SUMMARY-ONLY",
      "Request interrupted",
      "FOREIGN-SUMMARY",
    ]) {
      expect(text).not.toContain(marker);
    }
  });

  describe("turns the harness wrote, told apart by origin.kind", () => {
    const asst = { type: "assistant", uuid: "a1", sessionId: "s", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "We decided X." }] } };
    const user = (text: string, origin?: unknown) => ({
      type: "user",
      uuid: "u1",
      sessionId: "s",
      timestamp: "2026-08-01T10:00:00Z",
      ...(origin === undefined ? {} : { origin }),
      message: { role: "user", content: text },
    });
    const real = { ...user("What did we decide?"), uuid: "u0" };
    const userTexts = (rec: unknown) =>
      parseClaudeCodeSession([real, rec, asst]).sessions[0]!.messages.filter((m) => m.role === "user").map((m) => m.text);

    for (const kind of ["task-notification", "peer", "auto-continuation"]) {
      it(`drops a user record of origin.kind ${kind} and counts it`, () => {
        const r = parseClaudeCodeSession([user(`<task-notification>\n<task-id>abc</task-id>\n</task-notification>`, { kind }), real, asst]);
        expect(r.sessions[0]!.messages.map((m) => m.text)).toEqual(["What did we decide?", "We decided X."]);
        expect(r.sessions[0]!.title).toBe("What did we decide?");
        expect(r.skippedMessages).toBe(1);
      });
    }

    it("never turns a queue-operation record into a turn", () => {
      const queued = { type: "queue-operation", operation: "enqueue", sessionId: "s", content: "<task-notification>x</task-notification>" };
      expect(userTexts(queued)).toEqual(["What did we decide?"]);
    });

    it("keeps a human turn that quotes a notification, a channel turn, an unknown kind and a log without origin", () => {
      const quoted = "Why did this fail?\n<task-notification>\n<status>failed</status>\n</task-notification>";
      expect(userTexts(user(quoted, { kind: "human" }))).toEqual(["What did we decide?", quoted]);
      expect(userTexts(user("sent from my phone", { kind: "channel" }))).toEqual(["What did we decide?", "sent from my phone"]);
      expect(userTexts(user("new kind", { kind: "some-new-kind" }))).toEqual(["What did we decide?", "new kind"]);
      expect(userTexts(user("older log"))).toEqual(["What did we decide?", "older log"]);
    });
  });

  describe("AskUserQuestion answers", () => {
    const ask = { type: "assistant", uuid: "a1", sessionId: "s", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "Two questions." }] } };
    const questions = [
      { question: "Which DB?", header: "Database", options: [{ label: "Postgres" }, { label: "SQLite" }], multiSelect: false },
      { question: "Keep the archive?", header: "Archive", options: [{ label: "Yes" }, { label: "No" }], multiSelect: false },
    ];
    const answered = (answers: Record<string, unknown>, uuid = "u1") => ({
      type: "user",
      uuid,
      sessionId: "s",
      timestamp: "2026-08-01T10:01:00Z",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "Your questions have been answered: …" }] },
      toolUseResult: { questions, answers },
    });

    it("imports the answers as a user turn, one line per question, and nothing for a cancelled one", () => {
      const r = parseClaudeCodeSession([ask, answered({ "Which DB?": "Postgres", "Keep the archive?": "No" }), answered({}, "u2")]);
      expect(r.sessions[0]!.messages.map((m) => [m.role, m.text])).toEqual([
        ["assistant", "Two questions."],
        ["user", "Database → Postgres\nArchive → No"],
      ]);
      expect(r.sessions[0]!.messages[1]!.id).toBe("u1");
      expect(r.sessions[0]!.messages[1]!.speaker).toBe("User");
    });

    it("falls back to the question text when no header names it", () => {
      const r = parseClaudeCodeSession([ask, answered({ "Unlisted?": "Sure" })]);
      expect(r.sessions[0]!.messages[1]!.text).toBe("Unlisted? → Sure");
    });

    it("redacts a credential pasted as an answer", () => {
      const token = `${"gh"}p_${"a1".repeat(18)}`;
      const s = parseClaudeCodeSession([ask, answered({ "Which DB?": token })]).sessions[0]!;
      const body = prepareSession(s).parts.map((p) => p.body).join("");
      expect(body).not.toContain(token);
      expect(body).toContain("[REDACTED:github-token:");
    });
  });

  it("reports a log of only sub-agent traffic as having no text", () => {
    const side = { type: "user", isSidechain: true, sessionId: "s", message: { role: "user", content: "x" } };
    expect(parseClaudeCodeSession([side]).skipped[0]).toMatchObject({ id: "s", reason: "no user or assistant text" });
  });
});

describe("session log detection", () => {
  it("detects each log by shape and counts malformed lines", () => {
    const codex = parseTranscriptJsonl(codexRaw, codexRaw.length);
    expect(codex.diagnostics).toMatchObject({ format: "codex", detected_by: "detection", sessions: 1, malformed_lines: 1 });
    const claude = parseTranscriptJsonl(claudeRaw, claudeRaw.length);
    expect(claude.diagnostics).toMatchObject({ format: "claude-code", sessions: 1, malformed_lines: 1, format_drift: false });
  });

  it("finds a Claude Code turn past a long run of bookkeeping lines", () => {
    const filler = Array.from({ length: 60 }, () => JSON.stringify({ type: "file-history-snapshot", snapshot: {} }));
    const turn = JSON.stringify({ type: "user", sessionId: "late", uuid: "u", message: { role: "user", content: "hello" } });
    const raw = [...filler, turn].join("\n");
    expect(parseTranscriptJsonl(raw, raw.length).diagnostics.format).toBe("claude-code");
  });

  it("calls a file of broken lines drift, not an empty log", () => {
    const raw = "{not json\n{still not\n";
    expect(parseTranscriptJsonl(raw, raw.length).diagnostics).toMatchObject({ format_drift: true, malformed_lines: 2 });
  });

  it("titles from the first non-blank line, capped", () => {
    expect(titleFromText("\n  first line\nsecond")).toBe("first line");
    expect(titleFromText("x".repeat(100))).toBe(`${"x".repeat(80)}…`);
    expect(titleFromText("   ")).toBeNull();
  });
});

describe("secret redaction on session logs", () => {
  it("redacts a credential in a Claude Code turn through the shared pipeline", () => {
    const line = JSON.stringify({
      type: "user",
      sessionId: "sec",
      uuid: "u1",
      message: { role: "user", content: `use token ${PAT} for the deploy` },
    });
    const { sessions } = parseTranscriptJsonl(line, line.length);
    const prepared = prepareSession(sessions[0]!);
    expect(prepared.findings.length).toBeGreaterThan(0);
    expect(prepared.parts.map((p) => p.body).join("")).not.toContain(PAT);
    expect(prepared.parts[0]!.slug).toBe("transcripts/claude-code/sec-p1");
  });
});

describe("memrain transcripts ingest (session logs)", () => {
  const cliTmp = mkdtempSync(join(tmpdir(), "memrain-transcripts-logs-"));
  const cfgPath = join(cliTmp, ".memex", "config.json");
  const logsDir = join(cliTmp, "logs");
  let log: ReturnType<typeof spyOn>;

  beforeAll(() => {
    mkdirSync(join(cliTmp, ".memex"), { recursive: true });
    writeFileSync(
      cfgPath,
      JSON.stringify({
        database: { type: "pglite", path: join(cliTmp, ".memex", "brain.pglite") },
        embedding: { provider: "bedrock-titan", model: "amazon.titan-embed-text-v2:0", region: "eu-west-1" },
        storage: {},
      }),
    );
    mkdirSync(join(logsDir, "2026", "08", "02"), { recursive: true });
    mkdirSync(join(logsDir, "proj", "sub"), { recursive: true });
    writeFileSync(join(logsDir, "2026", "08", "02", "rollout-2026-08-02-a.jsonl"), codexRaw);
    writeFileSync(join(logsDir, "proj", "cc-fixture-session-1.jsonl"), claudeRaw);
    writeFileSync(
      join(logsDir, "proj", "sub", "agent-1.jsonl"),
      JSON.stringify({ type: "user", isSidechain: true, sessionId: "a", message: { role: "user", content: "x" } }),
    );
    writeFileSync(join(logsDir, "proj", "notes.txt"), "not a log");
  });
  beforeEach(() => {
    log = spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => log.mockRestore());
  afterAll(() => rmSync(cliTmp, { recursive: true, force: true }));

  const lastJson = () => JSON.parse(String(log.mock.calls.at(-1)![0]));

  it("reads a single rollout with --format codex", async () => {
    const file = join(logsDir, "2026", "08", "02", "rollout-2026-08-02-a.jsonl");
    expect(await runTranscripts({ sub: "ingest", file, format: "codex", dryRun: true, json: true, configPath: cfgPath })).toBe(0);
    expect(lastJson()).toMatchObject({
      ok: true,
      diagnostics: { format: "codex", detected_by: "override", sessions: 1, malformed_lines: 1 },
      preview: { sessions: 1, parts: 1 },
    });
  });

  it("rejects an unknown --format naming every accepted one", async () => {
    expect(await runTranscripts({ sub: "ingest", file: logsDir, format: "gemini", json: true, configPath: cfgPath })).toBe(1);
    expect(lastJson().error).toContain("codex, claude-code");
  });

  it("walks a directory, lists logs with no session, and imports idempotently", async () => {
    expect(await runTranscripts({ sub: "ingest", file: logsDir, dryRun: true, json: true, configPath: cfgPath })).toBe(0);
    const dry = lastJson();
    expect(dry.diagnostics).toMatchObject({ files: 3, sessions: 2, format: null, detected_by: "detection", format_drift: false });
    expect(dry.diagnostics.skipped).toEqual([{ index: 2, id: join("proj", "sub", "agent-1.jsonl"), reason: "no user or assistant text" }]);

    const run = () => runTranscripts({ sub: "ingest", file: logsDir, json: true, configPath: cfgPath, embedFn });
    expect(await run()).toBe(0);
    expect(lastJson().result).toMatchObject({ sessions: 2, parts_written: 2 });
    expect(await run()).toBe(0);
    expect(lastJson().result).toMatchObject({ parts_written: 0, parts_unchanged: 2 });

    const s = new Storage(JSON.parse(readFileSync(cfgPath, "utf-8")));
    await s.init();
    try {
      const r = await s.engine().query<{ slug: string; type: string }>(`SELECT slug, type FROM pages ORDER BY slug`);
      expect(r.rows).toEqual([
        { slug: "transcripts/claude-code/cc-fixture-session-1-p1", type: "conversation" },
        { slug: "transcripts/codex/rollout-1-p1", type: "conversation" },
      ]);
    } finally {
      await s.close();
    }
  });

  it("limits a codex directory walk to rollout files", async () => {
    expect(await runTranscripts({ sub: "ingest", file: logsDir, format: "codex", dryRun: true, json: true, configPath: cfgPath })).toBe(0);
    expect(lastJson().diagnostics).toMatchObject({ files: 1, sessions: 1 });
  });

  it("leaves sub-agent rollouts out of a directory import", async () => {
    const dir = join(cliTmp, "codex-with-workers");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "rollout-2026-08-02-a.jsonl"), codexRaw);
    writeFileSync(join(dir, "rollout-2026-08-02-b.jsonl"), codexSubagentRaw);
    expect(await runTranscripts({ sub: "ingest", file: dir, format: "codex", dryRun: true, json: true, configPath: cfgPath })).toBe(0);
    const dry = lastJson();
    expect(dry.diagnostics).toMatchObject({ files: 2, sessions: 1 });
    expect(dry.diagnostics.skipped).toEqual([expect.objectContaining({ reason: "subagent rollout" })]);
    expect(JSON.stringify(dry)).not.toContain("DELEGATED-PROMPT-ONLY");
  });

  it("calls a directory whose logs yield nothing drift", async () => {
    const empty = join(cliTmp, "only-agents");
    mkdirSync(empty, { recursive: true });
    writeFileSync(join(empty, "x.jsonl"), "{broken\n");
    expect(await runTranscripts({ sub: "ingest", file: empty, json: true, configPath: cfgPath })).toBe(1);
    expect(lastJson()).toMatchObject({ ok: false, diagnostics: { format_drift: true, sessions: 0 } });
  });
});
