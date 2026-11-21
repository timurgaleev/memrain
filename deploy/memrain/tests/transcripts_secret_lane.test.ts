/**
 * Transcript ingest runs the transcript lane's rules (cookie values, `.netrc`
 * passwords, split labels, a label left dangling at the end of a message) and
 * keeps every original it redacts in the secret store, through the CLI ingest
 * and through a push whose worker writes the pages later. Neither the queue
 * nor the store holds a value in clear.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetHandlersForTesting, getHandler } from "../src/core/jobs/handlers.ts";
import type { JobRow } from "../src/core/jobs/types.ts";
import { Storage } from "../src/core/storage.ts";
import { getPage } from "../src/core/pages.ts";
import { revealSecret } from "../src/core/secret-store.ts";
import { ingestSessions, prepareSession } from "../src/core/transcripts/ingest.ts";
import type { TranscriptSession } from "../src/core/transcripts/types.ts";
import { handleIngestRoute, registerIngestCaptureHandler, TRANSCRIPTS_INGEST_JOB_KIND } from "../src/http/ingest.ts";
import { mintIngestPat } from "./helpers/ingest-principal.ts";

const SID = ["SYNTH", "cookieA0001fake"].join("");
const KEY = ["Synth3tic", "ApiKeyValue0042"].join("");
const MARKER = /\[REDACTED:([a-z0-9-]+):([0-9a-f]{16})\]/g;
const CT = "application/x-memrain-transcript+jsonl";

function session(id: string, texts: string[]): TranscriptSession {
  return {
    format: "claude-code",
    id,
    title: `Session ${id}`,
    startedAt: Date.parse("2026-04-02T08:00:00Z"),
    messages: texts.map((text, i) => ({
      id: `${id}-m${i}`,
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      speaker: i % 2 === 0 ? "User" : "Claude",
      text,
      ts: Date.parse("2026-04-02T08:00:00Z") + i * 1000,
    })),
  };
}

let tmp: string;
let storage: Storage;
const saved: Record<string, string | undefined> = {};
const ENV = ["MEMRAIN_CONNECTOR_KEK", "MEMRAIN_CONNECTOR_KEK_FILE", "MEMRAIN_SECRET_SCAN_DISPOSITION"] as const;

beforeEach(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  delete process.env.MEMRAIN_CONNECTOR_KEK_FILE;
  delete process.env.MEMRAIN_SECRET_SCAN_DISPOSITION;
  process.env.MEMRAIN_CONNECTOR_KEK = randomBytes(32).toString("base64");
  tmp = mkdtempSync(join(tmpdir(), "memrain-transcript-lane-"));
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

async function storeText(): Promise<string> {
  const e = await storage.engine().query("SELECT * FROM secret_store");
  const o = await storage.engine().query("SELECT * FROM secret_store_occurrences");
  return JSON.stringify([e.rows, o.rows]);
}

describe("prepareSession", () => {
  it("joins a label left dangling at the end of one message to the value opening the next", () => {
    const p = prepareSession(session("dangle-1", ["here is my API key:", KEY, `I set it to ${KEY} in the config`]));
    const text = JSON.stringify(p.session);
    expect(text).not.toContain(KEY);
    expect(p.session.messages[1]!.text).toMatch(/^\[REDACTED:labeled-credential:[0-9a-f]{16}\]$/);
    expect(p.originals.size).toBe(1);
  });
  it("leaves a value two messages after its label alone", () => {
    const p = prepareSession(session("dangle-2", ["here is my API key:", "one sec", KEY]));
    expect(p.session.messages[2]!.text).toBe(KEY);
  });
});

describe("ingestSessions", () => {
  it("redacts a cookie value and keeps its original sealed, revealable by slug and fingerprint", async () => {
    const r = await ingestSessions(storage, [session("cookie-1", [`curl -H 'Cookie: sid=${SID}' https://app.acme-example.test/`, "done"])], { deferMirror: true });
    expect(r.parts_written).toBe(1);
    const slug = "transcripts/claude-code/cookie-1-p1";
    const body = (await getPage(storage, slug))!.markdown_body;
    expect(body).not.toContain(SID);
    const [m] = [...body.matchAll(MARKER)];
    expect(m![1]).toBe("cookie-header");
    expect(await storeText()).not.toContain(SID);
    expect((await revealSecret(storage.engine(), { slug, fingerprint: m![2]! }, "test")).value).toBe(SID);
  });

  it("leaves a value the owner allowed in that source in place", async () => {
    await ingestSessions(storage, [session("cookie-2", [`Cookie: sid=${SID}`, "a"])], { deferMirror: true });
    expect((await getPage(storage, "transcripts/claude-code/cookie-2-p1"))!.markdown_body).not.toContain(SID);
    await storage.engine().query(`UPDATE secret_store SET status = 'allowed'`);
    await ingestSessions(storage, [session("cookie-2", [`Cookie: sid=${SID}`, "b"])], { deferMirror: true });
    expect((await getPage(storage, "transcripts/claude-code/cookie-2-p1"))!.markdown_body).toContain(`sid=${SID}`);
  });
});

describe("transcript push", () => {
  it("queues only sealed originals and the worker keeps them for the pages it writes", async () => {
    const user = JSON.stringify({ type: "user", sessionId: "push-cookie", uuid: "u1", message: { role: "user", content: `Cookie: sid=${SID}` } });
    const reply = JSON.stringify({ type: "assistant", sessionId: "push-cookie", uuid: "a1", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "ok" }] } });
    const { auth } = await mintIngestPat(storage.engine(), { name: "laptop-1" });
    const deps = { storage, authInfo: auth, allowRequest: () => true, clientIp: "1.2.3.4" };
    const res = await handleIngestRoute(new Request("http://test/ingest", { method: "POST", headers: { "content-type": CT }, body: `${user}\n${reply}\n` }), deps);
    expect(res.status).toBe(202);
    const jobId = String(((await res.json()) as Record<string, unknown>).job_id);
    const row = (await storage.engine().query<JobRow>(`SELECT * FROM jobs WHERE id = $1`, [jobId])).rows[0]!;
    const payloadText = typeof row.payload === "string" ? row.payload : JSON.stringify(row.payload);
    expect(payloadText).not.toContain(SID);
    expect(payloadText).toContain("sealed_originals");

    registerIngestCaptureHandler(storage);
    const payload = JSON.parse(payloadText) as Record<string, unknown>;
    await getHandler(TRANSCRIPTS_INGEST_JOB_KIND)!(payload, { job: row });
    const slug = "transcripts/claude-code/push-cookie-p1";
    const body = (await getPage(storage, slug))!.markdown_body;
    const [m] = [...body.matchAll(MARKER)];
    expect(m![1]).toBe("cookie-header");
    expect(await storeText()).not.toContain(SID);
    expect((await revealSecret(storage.engine(), { slug, fingerprint: m![2]! }, "test")).value).toBe(SID);
  });
});
