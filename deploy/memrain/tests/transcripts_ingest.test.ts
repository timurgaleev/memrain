/**
 * Transcript ingest end to end on PGLite: idempotent re-runs, stale-part
 * deletion within one source, whole-session secret handling, vector coverage
 * of a long session, and the CLI's refusals and dry run.
 *
 * Credential fixtures are assembled at run time so no literal credential
 * shape sits in the repository.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { getPage, putPage } from "../src/core/pages.ts";
import { pageSourcePath } from "../src/core/page-index.ts";
import { fingerprintSecret } from "../src/core/secret-scan.ts";
import { listRecentTranscripts } from "../src/core/transcripts-read.ts";
import { mergePage } from "../src/core/entity-merge.ts";
import { ingestSessions, prepareSession } from "../src/core/transcripts/ingest.ts";
import type { TranscriptSession } from "../src/core/transcripts/types.ts";
import { runTranscripts } from "../src/commands/transcripts.ts";
import { deterministicEmbed } from "./det-embed.ts";

const embedFn = async (t: string) => deterministicEmbed(t);
const PAT = `memex_${"cd34".repeat(16)}`;
const T0 = Date.parse("2026-04-02T08:00:00Z");

function session(id: string, n: number, filler = 1500, text?: (i: number) => string): TranscriptSession {
  return {
    format: "chatgpt",
    id,
    title: `Session ${id}`,
    startedAt: T0,
    messages: Array.from({ length: n }, (_, i) => ({
      id: `${id}-m${i}`,
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      speaker: i % 2 === 0 ? "User" : "ChatGPT",
      text: text ? text(i) : `turn ${i} ${"words about retrieval ".repeat(filler / 22)}`,
      ts: T0 + i * 1000,
    })),
  };
}

async function count(storage: Storage, sql: string, params: unknown[] = []): Promise<number> {
  const r = await storage.engine().query<{ n: number }>(sql, params);
  return Number(r.rows[0]!.n);
}

async function liveParts(storage: Storage, base: string): Promise<string[]> {
  const r = await storage.engine().query<{ slug: string }>(
    `SELECT slug FROM pages WHERE slug LIKE $1 AND deleted_at IS NULL ORDER BY slug`,
    [`${base}-p%`],
  );
  return r.rows.map((x) => x.slug);
}

async function chunkCount(storage: Storage, slug: string, sourceId: string): Promise<number> {
  return count(
    storage,
    `SELECT COUNT(*)::int AS n FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.source_path = $1`,
    [pageSourcePath(slug, sourceId)],
  );
}

let tmp: string;
let storage: Storage;
const savedDisposition = process.env.MEMRAIN_SECRET_SCAN_DISPOSITION;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-transcripts-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  for (const id of ["alpha", "other"]) {
    await storage.engine().query(`INSERT INTO sources (id, kind, path_prefix) VALUES ($1, 'other', $2)`, [id, `/srv/${id}`]);
  }
});
afterEach(async () => {
  if (savedDisposition === undefined) delete process.env.MEMRAIN_SECRET_SCAN_DISPOSITION;
  else process.env.MEMRAIN_SECRET_SCAN_DISPOSITION = savedDisposition;
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("ingestSessions", () => {
  it("writes conversation parts under the source, and an unchanged re-run writes nothing", async () => {
    const s = session("abc", 60);
    const first = await ingestSessions(storage, [s], { sourceId: "default", embedFn, ref: "t" });
    expect(first.parts_written).toBeGreaterThan(1);
    const parts = await liveParts(storage, "transcripts/chatgpt/abc");
    expect(parts).toHaveLength(first.parts_written);
    const p1 = await getPage(storage, "transcripts/chatgpt/abc-p1");
    expect(p1).toMatchObject({ type: "conversation", source_id: "default" });
    expect(await chunkCount(storage, "transcripts/chatgpt/abc-p1", "default")).toBeGreaterThan(0);

    const versions = await count(storage, `SELECT COUNT(*)::int AS n FROM page_versions`);
    const logs = await count(storage, `SELECT COUNT(*)::int AS n FROM ingest_log`);
    expect(logs).toBe(1);
    const again = await ingestSessions(storage, [s], { sourceId: "default", embedFn, ref: "t" });
    expect(again).toMatchObject({ parts_written: 0, parts_deleted: 0, parts_unchanged: first.parts_written });
    expect(await count(storage, `SELECT COUNT(*)::int AS n FROM page_versions`)).toBe(versions);
    expect(await count(storage, `SELECT COUNT(*)::int AS n FROM ingest_log`)).toBe(logs);
  });

  it("stops between parts once its signal aborts", async () => {
    const abort = new AbortController();
    const aborting = async (t: string) => {
      abort.abort(new Error("lost its claim"));
      return embedFn(t);
    };
    await expect(
      ingestSessions(storage, [session("cut", 60)], { sourceId: "default", embedFn: aborting, signal: abort.signal }),
    ).rejects.toThrow("lost its claim");
    expect(await liveParts(storage, "transcripts/chatgpt/cut")).toHaveLength(1);
    await expect(
      ingestSessions(storage, [session("never", 60)], { sourceId: "default", embedFn, signal: abort.signal }),
    ).rejects.toThrow("lost its claim");
    expect(await liveParts(storage, "transcripts/chatgpt/never")).toHaveLength(0);
  });

  it("soft-deletes the parts a shrunken session no longer has, only in its own source", async () => {
    const long = session("shrink", 80);
    const first = await ingestSessions(storage, [long], { sourceId: "default", embedFn });
    expect(first.parts_written).toBeGreaterThanOrEqual(3);
    // A page in another source that happens to share the prefix.
    await putPage(storage, {
      slug: "transcripts/chatgpt/shrink-p99",
      type: "conversation",
      allowAdHocType: true,
      markdown_body: "User: someone else's page",
      source_id: "other",
    });

    const short = { ...long, messages: long.messages.slice(0, 4) };
    const r = await ingestSessions(storage, [short], { sourceId: "default", embedFn });
    expect(r.parts_deleted).toBe(first.parts_written - 1);
    expect(await liveParts(storage, "transcripts/chatgpt/shrink")).toEqual([
      "transcripts/chatgpt/shrink-p1",
      "transcripts/chatgpt/shrink-p99",
    ]);
    expect(await chunkCount(storage, "transcripts/chatgpt/shrink-p2", "default")).toBe(0);
    expect(await chunkCount(storage, "transcripts/chatgpt/shrink-p1", "default")).toBeGreaterThan(0);
    expect((await getPage(storage, "transcripts/chatgpt/shrink-p99"))?.deleted_at).toBeNull();
  });

  it("stores a credential redacted in every part and audits it by fingerprint", async () => {
    const s = session("secret", 40, 1500, (i) => `turn ${i} token ${PAT} ${"padding text ".repeat(120)}`);
    const r = await ingestSessions(storage, [s], { sourceId: "default", embedFn });
    expect(r.parts_written).toBeGreaterThan(1);
    expect(r.redactions).toBe(40);
    for (const slug of await liveParts(storage, "transcripts/chatgpt/secret")) {
      const body = (await getPage(storage, slug))!.markdown_body;
      expect(body).not.toContain(PAT);
      expect(body).toContain(`[REDACTED:memex-pat:${fingerprintSecret(PAT)}]`);
    }
    const chunks = await storage.engine().query<{ content: string }>(`SELECT content FROM chunks`);
    for (const c of chunks.rows) expect(c.content).not.toContain(PAT);
    const audit = await storage.engine().query<{ summary: string; source_ref: string }>(
      `SELECT summary, source_ref FROM ingest_log WHERE source_type = 'secret-redacted'`,
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.source_ref).toBe("transcripts/chatgpt/secret");
    expect(audit.rows[0]!.summary).toContain(fingerprintSecret(PAT));
    expect(audit.rows[0]!.summary).not.toContain(PAT);
  });

  it("redacts a bare echo in the title and earlier messages of a value claimed later", () => {
    const token = "Zx9Kq2Lm7Np4Rt8Vw3Yb6Hd1Fg5";
    const s = session("echo", 3, 1500, (i) =>
      i === 0 ? `my token is ${token}, keep it` : i === 1 ? "noted" : `curl -H "Authorization: Bearer ${token}" https://api.example.com`,
    );
    const prepared = prepareSession({ ...s, title: `debugging ${token}` });
    expect(prepared.session.title).not.toContain(token);
    for (const m of prepared.session.messages) expect(m.text).not.toContain(token);
    expect(prepared.session.messages[0]!.text).toContain("[REDACTED:bearer-token-echo:");
    for (const p of prepared.parts) expect(p.body).not.toContain(token);
  });

  it("refuses the whole session under the reject disposition", async () => {
    process.env.MEMRAIN_SECRET_SCAN_DISPOSITION = "reject";
    // The credential sits in the last message, so a per-part scan would have
    // written the earlier parts first.
    const s = session("refused", 60, 1500, (i) => (i === 59 ? `late ${PAT}` : `turn ${i} ${"filler ".repeat(300)}`));
    const clean = session("fine", 2);
    const r = await ingestSessions(storage, [s, clean], { sourceId: "default", embedFn });
    expect(r).toMatchObject({ sessions_rejected: 1, parts_written: 1 });
    expect(await liveParts(storage, "transcripts/chatgpt/refused")).toEqual([]);
    expect(await count(storage, `SELECT COUNT(*)::int AS n FROM ingest_log WHERE source_type = 'secret-rejected'`)).toBe(1);
  });

  it("does not re-audit a refused session on an unchanged re-run", async () => {
    process.env.MEMRAIN_SECRET_SCAN_DISPOSITION = "reject";
    const s = session("again", 4, 1500, (i) => (i === 3 ? `late ${PAT}` : `turn ${i}`));
    for (let run = 0; run < 3; run++) {
      const r = await ingestSessions(storage, [s], { sourceId: "default", embedFn });
      expect(r.sessions_rejected).toBe(1);
    }
    expect(await count(storage, `SELECT COUNT(*)::int AS n FROM ingest_log`)).toBe(1);
  });

  it("audits flagged credentials once per written part, and not again on a re-run", async () => {
    process.env.MEMRAIN_SECRET_SCAN_DISPOSITION = "flag";
    const s = session("flagged", 40, 1500, (i) => `turn ${i} token ${PAT} ${"padding text ".repeat(120)}`);
    const first = await ingestSessions(storage, [s], { sourceId: "default", embedFn });
    expect(first.parts_written).toBeGreaterThan(1);
    expect((await getPage(storage, "transcripts/chatgpt/flagged-p1"))!.markdown_body).toContain(PAT);
    // Rows come from each written part, not from a session-level row on top.
    const refs = await storage.engine().query<{ source_ref: string }>(
      `SELECT DISTINCT source_ref FROM ingest_log WHERE source_type = 'secret-flagged' ORDER BY source_ref`,
    );
    expect(refs.rows.length).toBeGreaterThan(0);
    for (const r of refs.rows) expect(r.source_ref).toMatch(/flagged-p\d+$/);
    const logs = await count(storage, `SELECT COUNT(*)::int AS n FROM ingest_log`);
    const again = await ingestSessions(storage, [s], { sourceId: "default", embedFn });
    expect(again).toMatchObject({ parts_written: 0, parts_unchanged: first.parts_written });
    expect(await count(storage, `SELECT COUNT(*)::int AS n FROM ingest_log`)).toBe(logs);
  });

  it("fails a session whose part another source owns, and carries on with the rest", async () => {
    await putPage(storage, {
      slug: "transcripts/chatgpt/moved-p1",
      type: "conversation",
      allowAdHocType: true,
      markdown_body: "User: moved to a tenant",
      source_id: "other",
    });
    const r = await ingestSessions(storage, [session("moved", 2), session("after", 2)], {
      sourceId: "default",
      embedFn,
      ref: "t",
    });
    expect(r).toMatchObject({ sessions_failed: 1, sessions_rejected: 0, parts_written: 1 });
    expect(r.failed).toEqual([
      expect.objectContaining({ id: "moved", code: "permission_denied" }),
    ]);
    // The other tenant's slugs are not this caller's to learn.
    expect(r.failed[0]!.reason).not.toContain("moved-p1");
    expect(r.failed[0]!.reason).toContain("1 part(s)");
    expect((await getPage(storage, "transcripts/chatgpt/moved-p1"))!.source_id).toBe("other");
    expect(await liveParts(storage, "transcripts/chatgpt/after")).toEqual(["transcripts/chatgpt/after-p1"]);
    const log = await storage.engine().query<{ summary: string }>(
      `SELECT summary FROM ingest_log WHERE source_type = 'transcripts'`,
    );
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0]!.summary).toContain("failed 1");
  });

  it("fails a session whose part was merged away, and carries on with the rest", async () => {
    await ingestSessions(storage, [session("merged", 2)], { sourceId: "default", embedFn });
    await putPage(storage, { slug: "notes/canon", type: "note", markdown_body: "canonical", source_id: "default" });
    expect((await mergePage(storage, "transcripts/chatgpt/merged-p1", "notes/canon")).merged).toBe(true);

    const edited = session("merged", 2, 1500, (i) => `edited turn ${i}`);
    const r = await ingestSessions(storage, [edited, session("next", 2)], { sourceId: "default", embedFn });
    expect(r.sessions_failed).toBe(1);
    expect(r.failed[0]!.id).toBe("merged");
    expect(await liveParts(storage, "transcripts/chatgpt/next")).toEqual(["transcripts/chatgpt/next-p1"]);
  });

  it("audits the redactions of a session that only partly landed", async () => {
    await ingestSessions(storage, [session("partial", 20)], { sourceId: "default", embedFn });
    await putPage(storage, { slug: "notes/canon", type: "note", markdown_body: "canonical", source_id: "default" });
    expect((await mergePage(storage, "transcripts/chatgpt/partial-p2", "notes/canon")).merged).toBe(true);

    const edited = session("partial", 20, 1500, (i) => `edited ${i} token ${PAT} ${"padding text ".repeat(110)}`);
    const r = await ingestSessions(storage, [edited], { sourceId: "default", embedFn });
    expect(r).toMatchObject({ sessions_failed: 1, parts_written: 1 });
    expect((await getPage(storage, "transcripts/chatgpt/partial-p1"))!.markdown_body).toContain("[REDACTED:memex-pat:");
    const audit = await storage.engine().query<{ source_ref: string }>(
      `SELECT source_ref FROM ingest_log WHERE source_type = 'secret-redacted'`,
    );
    expect(audit.rows.map((row) => row.source_ref)).toEqual(["transcripts/chatgpt/partial"]);
  });

  it("splits a 5 MB session into searchable parts with vector coverage", async () => {
    const s = session("big", 2600, 2000);
    const r = await ingestSessions(storage, [s], { sourceId: "default", embedFn });
    expect(r.parts_written).toBeGreaterThanOrEqual(100);
    expect(r.mirror_failures).toBe(0);
    const docs = await storage.engine().query<{ source_path: string; skipped: boolean; chunks: number; vectors: number }>(
      `SELECT d.source_path,
              (d.frontmatter ? 'embed_skip') AS skipped,
              COUNT(c.id)::int AS chunks,
              COUNT(e.chunk_id)::int AS vectors
         FROM documents d
         LEFT JOIN chunks c ON c.document_id = d.id
         LEFT JOIN embeddings e ON e.chunk_id = c.id
        WHERE d.source_path LIKE 'page://transcripts/chatgpt/big-p%'
        GROUP BY d.source_path, d.frontmatter`,
    );
    expect(docs.rows).toHaveLength(r.parts_written);
    for (const d of docs.rows) {
      expect(d.skipped).toBe(false);
      expect(d.chunks).toBeGreaterThan(0);
      expect(d.vectors).toBe(d.chunks);
    }
  }, 180_000);

  it("lists ingested parts in get_recent_transcripts for their source only", async () => {
    await expect(ingestSessions(storage, [session("x", 2)], { sourceId: "nope" })).rejects.toThrow("unknown source");
    await ingestSessions(storage, [session("listed", 2)], { sourceId: "alpha", embedFn });
    const own = await listRecentTranscripts(storage.engine(), { sourceIds: ["alpha"] });
    expect(own.map((t) => [t.slug, t.type])).toEqual([["transcripts/chatgpt/listed-p1", "conversation"]]);
    expect(await listRecentTranscripts(storage.engine(), { sourceIds: [] })).toEqual([]);
    expect(await listRecentTranscripts(storage.engine(), { sourceIds: ["beta"] })).toEqual([]);
  });
});

describe("memrain transcripts ingest", () => {
  const cliTmp = mkdtempSync(join(tmpdir(), "memrain-transcripts-cli-"));
  const cfgPath = join(cliTmp, ".memex", "config.json");
  const exportPath = join(cliTmp, "conversations.json");
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
    writeFileSync(
      exportPath,
      JSON.stringify([
        {
          uuid: "cli-conv",
          name: "From the CLI",
          created_at: "2026-04-02T08:00:00Z",
          chat_messages: [
            { uuid: "u1", sender: "human", text: "Remember the deploy window", created_at: "2026-04-02T08:00:01Z" },
            { uuid: "u2", sender: "assistant", text: "Noted: Tuesdays.", created_at: "2026-04-02T08:00:02Z" },
          ],
        },
      ]),
    );
  });
  beforeEach(() => {
    log = spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => log.mockRestore());
  afterAll(() => rmSync(cliTmp, { recursive: true, force: true }));

  const lastJson = () => JSON.parse(String(log.mock.calls.at(-1)![0]));

  async function pagesInCliBrain(): Promise<number> {
    const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
    const s = new Storage(cfg);
    await s.init();
    try {
      return await count(s, `SELECT COUNT(*)::int AS n FROM pages`);
    } finally {
      await s.close();
    }
  }

  it("refuses a binary file before parsing it", async () => {
    const bin = join(cliTmp, "export.bin");
    writeFileSync(bin, Buffer.from(`[{"uuid": "x"}] ${String.fromCharCode(0)} tail`));
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await runTranscripts({ sub: "ingest", file: bin, configPath: cfgPath })).toBe(1);
      expect(String(err.mock.calls[0]![0])).toContain("binary");
    } finally {
      err.mockRestore();
    }
  });

  it("exits non-zero on format drift", async () => {
    const odd = join(cliTmp, "odd.json");
    writeFileSync(odd, JSON.stringify([{ something: "else" }]));
    expect(await runTranscripts({ sub: "ingest", file: odd, json: true, configPath: cfgPath })).toBe(1);
    expect(lastJson()).toMatchObject({ ok: false, diagnostics: { format_drift: true, sessions: 0 } });
  });

  it("previews on --dry-run without writing, then imports for real", async () => {
    expect(await runTranscripts({ sub: "ingest", file: exportPath, dryRun: true, json: true, configPath: cfgPath })).toBe(0);
    expect(lastJson()).toMatchObject({
      ok: true,
      dry_run: true,
      diagnostics: { format: "claude-ai", format_drift: false, sessions: 1 },
      preview: { sessions: 1, parts: 1 },
    });
    expect(await pagesInCliBrain()).toBe(0);

    const run = () => runTranscripts({ sub: "ingest", file: exportPath, json: true, sourceId: "default", configPath: cfgPath, embedFn });
    expect(await run()).toBe(0);
    expect(lastJson().result).toMatchObject({ parts_written: 1, parts_deleted: 0 });
    expect(await run()).toBe(0);
    expect(lastJson().result).toMatchObject({ parts_written: 0, parts_unchanged: 1, parts_deleted: 0 });
  });
});
