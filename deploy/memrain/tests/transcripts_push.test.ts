/**
 * Transcript push: POST /ingest with the transcript content type (tenancy,
 * prefix fence, size cap, scan before queueing, refusals that never echo the
 * log), the `transcripts_ingest` job, and the `memrain transcripts push`
 * client's path confinement.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthInfo } from "../src/core/auth-info.ts";
import { _resetHandlersForTesting, getHandler } from "../src/core/jobs/handlers.ts";
import type { JobRow } from "../src/core/jobs/types.ts";
import { Storage } from "../src/core/storage.ts";
import { pushEndpoint, resolvePushPath, transcriptPushMaxBytes } from "../src/core/transcripts/push.ts";
import * as pageIndex from "../src/core/page-index.ts";
import { currentSpendContext } from "../src/core/budget.ts";
import { runTranscripts } from "../src/commands/transcripts.ts";
import { handleIngestRoute, registerIngestCaptureHandler, TRANSCRIPTS_INGEST_JOB_KIND } from "../src/http/ingest.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "transcripts");
const claudeRaw = readFileSync(join(FIXTURES, "claude-code-session.jsonl"), "utf-8");
const assistantOnly = readFileSync(join(FIXTURES, "claude-code-assistant-only.jsonl"), "utf-8");
const PAT = `memex_${"ef56".repeat(16)}`;
const CT = "application/x-memrain-transcript+jsonl";

const writeAuth: AuthInfo = { token: "t", clientId: "laptop-1", scopes: ["write"], sourceId: "default", isPublic: false };

function pushReq(body: string, headers: Record<string, string> = { "content-type": CT }): Request {
  return new Request("http://test/ingest", { method: "POST", headers, body });
}

describe("POST /ingest transcript push", () => {
  let tmp: string;
  let storage: Storage;
  const saved: Record<string, string | undefined> = {};
  const ENV = ["MEMRAIN_INGEST_MAX_BYTES", "MEMRAIN_INGEST_TRANSCRIPT_MAX_BYTES", "MEMRAIN_SECRET_SCAN_DISPOSITION", "MEMRAIN_TENANT_FAIL_CLOSED"];

  beforeEach(async () => {
    for (const k of ENV) saved[k] = process.env[k];
    tmp = mkdtempSync(join(tmpdir(), "memrain-push-"));
    storage = new Storage({ dbPath: join(tmp, "db") });
    await storage.init();
  });
  afterEach(async () => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
    _resetHandlersForTesting();
  });

  const deps = (auth: AuthInfo) => ({ storage, authInfo: auth, allowRequest: () => true, clientIp: "1.2.3.4" });
  const jobs = async () =>
    (await storage.engine().query<{ id: string; kind: string; payload: unknown }>(`SELECT id, kind, payload::text AS payload FROM jobs`)).rows;

  async function runJob(id: string): Promise<Record<string, unknown>> {
    registerIngestCaptureHandler(storage);
    const row = await storage.engine().query<JobRow>(`SELECT * FROM jobs WHERE id = $1`, [id]);
    const job = row.rows[0]!;
    const payload = (typeof job.payload === "string" ? JSON.parse(job.payload) : job.payload) as Record<string, unknown>;
    return (await getHandler(TRANSCRIPTS_INGEST_JOB_KIND)!(payload, { job })) as Record<string, unknown>;
  }

  it("queues one idempotent job and the worker writes conversation pages under the caller's source", async () => {
    const res = await handleIngestRoute(pushReq(claudeRaw), deps(writeAuth));
    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ source_id: "default", format: "claude-code", sessions: 1, parts: 1 });
    expect(String(body.job_id)).toMatch(/^ingest:transcript:laptop-1:[0-9a-f]{64}$/);

    const again = await handleIngestRoute(pushReq(claudeRaw), deps(writeAuth));
    expect(((await again.json()) as Record<string, unknown>).job_id).toBe(body.job_id);
    expect(await jobs()).toHaveLength(1);

    const result = await runJob(String(body.job_id));
    expect(result).toMatchObject({ sessions: 1, parts_written: 1 });
    const pages = await storage.engine().query<{ slug: string; source_id: string; type: string }>(
      `SELECT slug, source_id, type FROM pages`,
    );
    expect(pages.rows).toEqual([{ slug: "transcripts/claude-code/cc-fixture-session-1-p1", source_id: "default", type: "conversation" }]);
  });

  it("takes a log over the capture cap, within its own cap", async () => {
    process.env.MEMRAIN_INGEST_MAX_BYTES = "100";
    expect((await handleIngestRoute(pushReq(claudeRaw), deps(writeAuth))).status).toBe(202);
    process.env.MEMRAIN_INGEST_TRANSCRIPT_MAX_BYTES = "100";
    expect((await handleIngestRoute(pushReq(claudeRaw), deps(writeAuth))).status).toBe(413);
  });

  it("defaults the transcript cap to 8 MiB", () => {
    expect(transcriptPushMaxBytes({})).toBe(8 * 1024 * 1024);
  });

  it("refuses a second push from a client while its first is still being read", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = new ReadableStream<Uint8Array>({
      async pull(c) {
        await gate;
        c.enqueue(new TextEncoder().encode(claudeRaw));
        c.close();
      },
    });
    const first = handleIngestRoute(
      new Request("http://test/ingest", { method: "POST", headers: { "content-type": CT }, body: slow }),
      deps(writeAuth),
    );
    await Bun.sleep(5);
    const second = await handleIngestRoute(pushReq(claudeRaw), deps(writeAuth));
    expect(second.status).toBe(429);
    expect(second.headers.get("Retry-After")).not.toBeNull();
    // Another client is not held up.
    expect((await handleIngestRoute(pushReq(claudeRaw), deps({ ...writeAuth, clientId: "laptop-2" }))).status).toBe(202);
    release();
    expect((await first).status).toBe(202);
    expect((await handleIngestRoute(pushReq(claudeRaw), deps(writeAuth))).status).toBe(202);
  });

  it("runs the job under the pushing client's spend id and cap, mirrored as a remote write", async () => {
    const res = await handleIngestRoute(pushReq(claudeRaw), deps({ ...writeAuth, spendId: "grant-9", budgetUsdPerDay: 0.25 }));
    const jobId = String(((await res.json()) as Record<string, unknown>).job_id);
    const seen: Array<{ spend: unknown; remote: boolean }> = [];
    const spy = spyOn(pageIndex, "mirrorPage").mockImplementation(async (_s, _p, opts) => {
      seen.push({ spend: currentSpendContext(), remote: opts.remote });
      return true;
    });
    try {
      expect(await runJob(jobId)).toMatchObject({ parts_written: 1 });
    } finally {
      spy.mockRestore();
    }
    expect(seen).toEqual([{ spend: { clientId: "grant-9", capUsd: 0.25 }, remote: true }]);
  });

  it("refuses an unreadable log without echoing it", async () => {
    const res = await handleIngestRoute(pushReq('{"note":"SECRET-BODY-MARKER"}\n{broken'), deps(writeAuth));
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(JSON.parse(text).error).toBe("transcript_unreadable");
    expect(text).not.toContain("SECRET-BODY-MARKER");
    expect(await jobs()).toHaveLength(0);
  });

  it("refuses a log with assistant turns but no user turn", async () => {
    const res = await handleIngestRoute(pushReq(assistantOnly), deps(writeAuth));
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(JSON.parse(text).error).toBe("user_turns_missing");
    expect(text).not.toContain("plan you asked for");
  });

  it("holds a bound client to its prefixes", async () => {
    const outside = await handleIngestRoute(pushReq(claudeRaw), deps({ ...writeAuth, boundSlugPrefixes: ["notes"] }));
    expect(outside.status).toBe(403);
    // A prefix equal to one part slug does not cover the session's other parts.
    const exact = await handleIngestRoute(
      pushReq(claudeRaw),
      deps({ ...writeAuth, boundSlugPrefixes: ["transcripts/claude-code/cc-fixture-session-1-p1"] }),
    );
    expect(exact.status).toBe(403);
    const inside = await handleIngestRoute(pushReq(claudeRaw), deps({ ...writeAuth, boundSlugPrefixes: ["transcripts/claude-code"] }));
    expect(inside.status).toBe(202);
  });

  it("refuses a client with no write source under fail-closed tenancy", async () => {
    process.env.MEMRAIN_TENANT_FAIL_CLOSED = "1";
    const { sourceId: _granted, ...noGrant } = writeAuth;
    expect((await handleIngestRoute(pushReq(claudeRaw), deps(noGrant))).status).toBe(403);
  });

  it("stores only redacted text in the queue, and refuses under reject", async () => {
    const line = JSON.stringify({ type: "user", sessionId: "sec-1", uuid: "u1", message: { role: "user", content: `deploy with ${PAT}` } });
    const reply = JSON.stringify({ type: "assistant", sessionId: "sec-1", uuid: "a1", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "ok" }] } });
    const log = `${line}\n${reply}\n`;
    expect((await handleIngestRoute(pushReq(log), deps(writeAuth))).status).toBe(202);
    expect(JSON.stringify(await jobs())).not.toContain(PAT);

    process.env.MEMRAIN_SECRET_SCAN_DISPOSITION = "reject";
    const refused = await handleIngestRoute(pushReq(log.replace("sec-1", "sec-2")), deps(writeAuth));
    expect(refused.status).toBe(400);
    const text = await refused.text();
    expect(JSON.parse(text).error).toBe("secret_in_content");
    expect(text).not.toContain(PAT);
  });

  it("the job re-checks the fence and the payload shape", async () => {
    registerIngestCaptureHandler(storage);
    const handler = getHandler(TRANSCRIPTS_INGEST_JOB_KIND)!;
    const job = {} as JobRow;
    await expect(handler({ source_id: "default", sessions: [{ format: "chatgpt" }] }, { job })).rejects.toThrow("codex or claude-code");
    const session = { format: "codex", id: "x", title: null, startedAt: null, messages: [{ id: "", role: "user", speaker: "User", text: "hi", ts: null }] };
    await expect(
      handler({ source_id: "default", sessions: [session], bound_slug_prefixes: ["notes"] }, { job }),
    ).rejects.toThrow("bound prefixes");
  });
});

describe("memrain transcripts push", () => {
  const home = mkdtempSync(join(tmpdir(), "memrain-push-home-"));
  const roots = [join(home, ".claude", "projects"), join(home, ".codex", "sessions")];
  const logPath = join(roots[0]!, "proj", "cc-fixture-session-1.jsonl");
  const tokenFile = join(home, "token");
  let log: ReturnType<typeof spyOn>;
  let errLog: ReturnType<typeof spyOn>;

  beforeAll(() => {
    mkdirSync(join(roots[0]!, "proj"), { recursive: true });
    mkdirSync(roots[1]!, { recursive: true });
    writeFileSync(logPath, claudeRaw);
    writeFileSync(join(home, "outside.jsonl"), claudeRaw);
    symlinkSync(join(home, "outside.jsonl"), join(roots[0]!, "proj", "link.jsonl"));
    mkdirSync(join(home, "elsewhere"), { recursive: true });
    writeFileSync(join(home, "elsewhere", "s.jsonl"), claudeRaw);
    symlinkSync(join(home, "elsewhere"), join(roots[0]!, "escape"));
    writeFileSync(tokenFile, "mrn_test_token_value\n");
    chmodSync(tokenFile, 0o600);
  });
  beforeEach(() => {
    log = spyOn(console, "log").mockImplementation(() => {});
    errLog = spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    log.mockRestore();
    errLog.mockRestore();
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  const lastJson = () => JSON.parse(String(log.mock.calls.at(-1)![0]));

  it("confines the path to the session log roots after resolving links", () => {
    expect(resolvePushPath(logPath, roots)).toHaveProperty("path");
    expect(resolvePushPath(join(home, "outside.jsonl"), roots)).toHaveProperty("error");
    expect((resolvePushPath(join(roots[0]!, "proj", "link.jsonl"), roots) as { error: string }).error).toContain("symlink");
    expect((resolvePushPath(join(roots[0]!, "escape", "s.jsonl"), roots) as { error: string }).error).toContain("outside");
    expect(resolvePushPath(join(roots[0]!, "proj", "..", "..", "..", "outside.jsonl"), roots)).toHaveProperty("error");
  });

  it("sends only over https, except to localhost", () => {
    expect(pushEndpoint("https://brain.example.com")).toEqual({ url: "https://brain.example.com/ingest" });
    expect(pushEndpoint("http://127.0.0.1:8080/")).toEqual({ url: "http://127.0.0.1:8080/ingest" });
    expect(pushEndpoint("http://brain.example.com")).toHaveProperty("error");
    expect(pushEndpoint("https://u:p@localhost")).toHaveProperty("error");
  });

  it("posts the log with the transcript type and a bearer from the token file", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Response.json({ job_id: "ingest:transcript:x:y", sessions: 1, parts: 1 }, { status: 202 });
    };
    const code = await runTranscripts({ sub: "push", file: logPath, url: "https://brain.example.com", tokenFile, json: true, pushRoots: roots, fetchFn });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(calls[0]!.url).toBe("https://brain.example.com/ingest");
    expect(headers["content-type"]).toBe(CT);
    expect(headers.authorization).toBe("Bearer mrn_test_token_value");
    expect(lastJson()).toMatchObject({ ok: true, job_id: "ingest:transcript:x:y" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("mrn_test_token_value");
  });

  it("refuses a token file other users can read", async () => {
    const loose = join(home, "loose-token");
    writeFileSync(loose, "abc");
    chmodSync(loose, 0o644);
    const fetchFn = async () => new Response(null, { status: 500 });
    expect(await runTranscripts({ sub: "push", file: logPath, url: "https://b.example.com", tokenFile: loose, json: true, pushRoots: roots, fetchFn })).toBe(1);
    expect(lastJson().error).toContain("chmod 600");
  });

  it("refuses a path outside the roots, and under --hook-stdin never fails the hook", async () => {
    const outside = join(home, "outside.jsonl");
    expect(await runTranscripts({ sub: "push", file: outside, url: "https://b.example.com", tokenFile, pushRoots: roots })).toBe(1);
    const fetchFn = async () => {
      throw new Error("network down");
    };
    const hook = (stdin: string) =>
      runTranscripts({ sub: "push", hookStdin: true, url: "https://b.example.com", tokenFile, pushRoots: roots, fetchFn, readStdin: async () => stdin });
    expect(await hook(JSON.stringify({ transcript_path: outside }))).toBe(0);
    expect(await hook("not json")).toBe(0);
    expect(await hook(JSON.stringify({ transcript_path: logPath }))).toBe(0);
    expect(String(errLog.mock.calls.at(-1)![0])).toContain("network down");
  });

  it("previews on --dry-run without sending", async () => {
    expect(await runTranscripts({ sub: "push", file: logPath, dryRun: true, json: true, pushRoots: roots })).toBe(0);
    expect(lastJson()).toMatchObject({ ok: true, dry_run: true, format: "claude-code", sessions: 1 });
  });
});
