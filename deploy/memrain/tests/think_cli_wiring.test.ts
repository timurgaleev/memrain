/**
 * `memrain think --save/--take` CLI wiring — the persistence hooks around
 * runThink. With MEMRAIN_THINK unset the run is skipped, so these pin the
 * wiring semantics without any paid call: --save on an empty synthesis
 * refuses to persist (warning surfaced), --take without an anchor errors.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runThinkCli } from "../src/commands/think.ts";
import type { SonnetFn } from "../src/core/llm/sonnet.ts";
import type { SearchHit } from "../src/core/search/hybrid.ts";
import { restoreExitCode } from "./helpers/exit-code.ts";

const tmp = mkdtempSync(join(tmpdir(), "memrain-think-cli-"));
const cfgDir = join(tmp, ".memex");
const cfgPath = join(cfgDir, "config.json");

function capture(): { out: string[]; err: string[]; restore: () => void } {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => out.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => err.push(a.map(String).join(" "));
  return {
    out,
    err,
    restore: () => {
      console.log = origLog;
      console.error = origErr;
    },
  };
}

beforeAll(() => {
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(
    cfgPath,
    JSON.stringify({
      database: { type: "pglite", path: join(cfgDir, "brain.pglite") },
      embedding: {
        provider: "bedrock-titan",
        model: "amazon.titan-embed-text-v2:0",
        region: "eu-west-1",
      },
      storage: {},
    }),
  );
  delete process.env["MEMRAIN_THINK"]; // ensure the paid gate stays closed
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("think CLI persistence wiring", () => {
  it("--save on a skipped run persists nothing and surfaces the warning", async () => {
    const cap = capture();
    try {
      await runThinkCli({
        question: "what changed last week?",
        save: true,
        json: true,
        configPath: cfgPath,
      });
    } finally {
      cap.restore();
    }
    const out = JSON.parse(cap.out.join("\n"));
    expect(out.ran).toBe(false);
    expect(out.saved_slug).toBeNull();
    expect(out.save_warnings).toContain("SYNTHESIS_EMPTY_NOT_PERSISTED");
  });

  it("--take without --save or --anchor is a usage error", async () => {
    const prevExit = process.exitCode;
    const cap = capture();
    try {
      await runThinkCli({
        question: "q",
        take: "some claim",
        json: true,
        configPath: cfgPath,
      });
      expect(cap.err.join("\n")).toContain("--take needs an anchor");
      expect(process.exitCode).toBe(1);
    } finally {
      cap.restore();
      restoreExitCode(prevExit);
    }
  });

});

describe("think CLI failure reporting", () => {
  const pagesFn = async () =>
    [{ sourcePath: "notes/plan.md", title: "Plan", content: "The plan is to migrate in Q3." }] as SearchHit[];
  const throttled: SonnetFn = async () => {
    throw Object.assign(new Error("slow down"), { name: "ThrottlingException" });
  };

  it("--json carries synthesisStatus and the extractive fallback", async () => {
    const cap = capture();
    try {
      await runThinkCli({ question: "what is the plan?", json: true, configPath: cfgPath, sonnetFn: throttled, pagesFn });
    } finally {
      cap.restore();
    }
    const out = JSON.parse(cap.out.join("\n"));
    expect(out.synthesis).toBeNull();
    expect(out.synthesisStatus).toBe("llm_error");
    expect(out.fallback.kind).toBe("extractive");
    expect(out.fallback.citations).toEqual([{ ref: "notes/plan.md", kind: "page" }]);
  });

  it("text mode prints the status and labels the digest", async () => {
    const cap = capture();
    try {
      await runThinkCli({ question: "what is the plan?", configPath: cfgPath, sonnetFn: throttled, pagesFn });
    } finally {
      cap.restore();
    }
    const text = cap.out.join("\n");
    expect(text).toContain("think: no synthesis (llm_error): synthesis call failed: slow down");
    expect(text).toContain("[extractive fallback, not a synthesized answer]");
    expect(text).toContain("[notes/plan.md]");
  });
});
