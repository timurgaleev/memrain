import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkTranscriptFileSize,
  detectFormat,
  parseTranscriptExport,
  parseTranscriptJsonl,
  transcriptMaxFileBytes,
} from "../src/core/transcripts/detect.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "transcripts");
const emptyClaude = readFileSync(join(FIXTURES, "claude-code-empty.jsonl"), "utf-8");
const emptyCodex = readFileSync(join(FIXTURES, "codex-rollout-empty.jsonl"), "utf-8");

const chatgpt = {
  id: "g1",
  title: "t",
  mapping: {
    a: { id: "a", parent: null, children: [], message: { id: "a", author: { role: "user" }, content: { content_type: "text", parts: ["hi"] } } },
  },
  current_node: "a",
};
const claude = { uuid: "c1", name: "n", chat_messages: [{ uuid: "m", sender: "human", text: "hello" }] };

describe("detectFormat", () => {
  it("recognises each export by shape, in order", () => {
    expect(detectFormat([chatgpt])).toBe("chatgpt");
    expect(detectFormat([claude])).toBe("claude-ai");
    // An item carrying both shapes resolves to the first adapter in order.
    expect(detectFormat([{ ...claude, ...chatgpt }])).toBe("chatgpt");
    expect(detectFormat([{ hello: "world" }])).toBeNull();
  });

  it("lets an explicit --format win over detection", () => {
    const r = parseTranscriptExport([claude], 100, "chatgpt");
    expect(r.diagnostics.detected_by).toBe("override");
    expect(r.diagnostics.format).toBe("chatgpt");
    // Read as the wrong format, nothing comes out — which is drift.
    expect(r.sessions).toHaveLength(0);
    expect(r.diagnostics.format_drift).toBe(true);
  });

  it("finds the conversation list under a wrapping object", () => {
    const r = parseTranscriptExport({ conversations: [claude] }, 100);
    expect(r.diagnostics.format).toBe("claude-ai");
    expect(r.sessions).toHaveLength(1);
  });
});

describe("format drift", () => {
  it("reports non-empty unknown JSON as drift with zero sessions", () => {
    const r = parseTranscriptExport({ some: "other export" }, 30);
    expect(r.sessions).toHaveLength(0);
    expect(r.diagnostics).toMatchObject({ format: null, detected_by: "none", format_drift: true });
    const items = parseTranscriptExport([{ x: 1 }, { y: 2 }], 20);
    expect(items.diagnostics).toMatchObject({ items: 2, sessions: 0, format_drift: true });
  });

  it("does not call an empty export drift", () => {
    expect(parseTranscriptExport([], 2).diagnostics.format_drift).toBe(false);
    expect(parseTranscriptExport({ conversations: [] }, 20).diagnostics.format_drift).toBe(false);
  });

  it("calls a session log with an id but no text empty, not drift", () => {
    const r = parseTranscriptJsonl(emptyClaude, emptyClaude.length);
    expect(r.diagnostics).toMatchObject({ format: "claude-code", sessions: 0, format_drift: false, empty_sessions: 1 });
    expect(r.diagnostics.skipped[0]).toMatchObject({ id: "cc-empty-session-1", reason: "empty_session" });
    const codex = parseTranscriptJsonl(emptyCodex, emptyCodex.length);
    expect(codex.diagnostics).toMatchObject({ format: "codex", sessions: 0, format_drift: false, empty_sessions: 1 });
  });

  it("calls a log whose only user turns the harness wrote empty", () => {
    const peer = JSON.stringify({ type: "user", origin: { kind: "peer" }, sessionId: "p", uuid: "u", message: { role: "user", content: "teammate" } });
    const r = parseTranscriptJsonl(peer, peer.length);
    expect(r.diagnostics).toMatchObject({ format_drift: false, empty_sessions: 1, skippedMessages: 1 });
  });

  it("calls an empty log with a broken or non-record line drift, not empty", () => {
    const harness = emptyClaude.trimEnd();
    const codex = emptyCodex.trimEnd();
    for (const raw of [`${harness}\n{"type":"user","sessionId":"cc-em`, `${harness}\n42`, `${codex}\n{"type":"event_ms`, `${codex}\n"x"`]) {
      const r = parseTranscriptJsonl(raw, raw.length);
      expect(r.diagnostics).toMatchObject({ sessions: 0, format_drift: true, empty_sessions: 0 });
    }
  });

  it("still calls a log with turns it could not read drift, not empty", () => {
    const jsonl = (recs: unknown[]) => recs.map((r) => JSON.stringify(r)).join("\n");
    const renamedBlocks = jsonl([
      { type: "user", sessionId: "rb", uuid: "u1", message: { role: "user", content: [{ type: "input_text", text: "hi" }] } },
      { type: "assistant", sessionId: "rb", uuid: "a1", message: { role: "assistant", content: [{ type: "output_text", text: "hello" }] } },
    ]);
    const renamedEvent = jsonl([
      { type: "session_meta", payload: { id: "re", source: "cli" } },
      { type: "event_msg", payload: { type: "user_input", message: "hi" } },
    ]);
    for (const raw of [renamedBlocks, renamedEvent]) {
      const r = parseTranscriptJsonl(raw, raw.length);
      expect(r.diagnostics).toMatchObject({ sessions: 0, format_drift: true, empty_sessions: 0 });
      expect(r.diagnostics.skipped[0]?.reason).toBe("no user or assistant text");
    }
  });
});

describe("size cap", () => {
  it("rejects a file over the cap instead of truncating it", () => {
    expect(checkTranscriptFileSize(10, 10)).toBeNull();
    expect(checkTranscriptFileSize(11, 10)).toContain("over the 10-byte cap");
  });

  it("reads the cap from MEMRAIN_TRANSCRIPT_MAX_FILE_BYTES, ignoring junk", () => {
    expect(transcriptMaxFileBytes({ MEMRAIN_TRANSCRIPT_MAX_FILE_BYTES: "4096" })).toBe(4096);
    const fallback = transcriptMaxFileBytes({});
    expect(transcriptMaxFileBytes({ MEMRAIN_TRANSCRIPT_MAX_FILE_BYTES: "-3" })).toBe(fallback);
    expect(transcriptMaxFileBytes({ MEMRAIN_TRANSCRIPT_MAX_FILE_BYTES: "lots" })).toBe(fallback);
  });
});
