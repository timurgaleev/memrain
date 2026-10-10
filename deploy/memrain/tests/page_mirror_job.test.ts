/**
 * The search mirror of a written page, built inline (the default) or by a
 * `page_mirror` job (`MEMRAIN_PAGE_MIRROR_SYNC=0`).
 *
 * Locks: the default path is unchanged; a queued write says so and the job
 * builds the mirror; `wait_for_index` forces the inline path; the job trusts
 * the page row for the owner and treats a caller of unknown trust as untrusted;
 * a revert-shaped A->B->A sequence still ends with the right text mirrored; and
 * deleting a tenant's page drops its tenant-keyed mirror.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import { putPage } from "../src/core/pages.ts";
import { mirrorPage } from "../src/core/page-index.ts";
import { Queue } from "../src/core/jobs/queue.ts";
import { Worker } from "../src/core/jobs/worker.ts";
import { _resetHandlersForTesting, getHandler } from "../src/core/jobs/handlers.ts";
import type { JobRow } from "../src/core/jobs/types.ts";
import { registerPageMirrorHandler } from "../src/core/jobs/page-mirror-handler.ts";
import { deterministicEmbed } from "./det-embed.ts";

let tmp: string;
let storage: Storage;
let prevSync: string | undefined;

const embedFn = async (t: string) => deterministicEmbed(t);
const body = (word: string) =>
  `## Notes\n\nThis page talks about ${word} at enough length to be indexed as one chunk of prose ` +
  `that search can find, and it mentions ${word} again so the keyword arm matches it clearly.`;

beforeEach(async () => {
  prevSync = process.env.MEMRAIN_PAGE_MIRROR_SYNC;
  tmp = mkdtempSync(join(tmpdir(), "memrain-mirror-job-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  _resetHandlersForTesting();
  registerPageMirrorHandler(storage, { embedFn });
});
afterEach(async () => {
  if (prevSync === undefined) delete process.env.MEMRAIN_PAGE_MIRROR_SYNC;
  else process.env.MEMRAIN_PAGE_MIRROR_SYNC = prevSync;
  _resetHandlersForTesting();
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function put(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await dispatchTool(storage, { name: "page_put", arguments: args });
  expect(r.isError ?? false).toBe(false);
  return JSON.parse((r.content[0] as { text: string }).text) as Record<string, unknown>;
}

async function mirror(path: string): Promise<{ content: string; frontmatter: Record<string, unknown> } | null> {
  const r = await storage.engine().query<{ content: string; frontmatter: Record<string, unknown> }>(
    `SELECT string_agg(c.content, ' ' ORDER BY c.chunk_index) AS content, d.frontmatter
       FROM documents d JOIN chunks c ON c.document_id = d.id
      WHERE d.source_path = $1 GROUP BY d.frontmatter`,
    [path],
  );
  return r.rows[0] ?? null;
}

async function drain(): Promise<void> {
  await new Worker(new Queue(storage.engine()), { logger: () => {} }).drainOnce();
}

describe("where the mirror is built", () => {
  it("builds it inline by default and queues nothing", async () => {
    delete process.env.MEMRAIN_PAGE_MIRROR_SYNC;
    const res = await put({ slug: "notes/inline", markdown_body: body("otters") });
    expect("search_indexed" in res).toBe(true);
    expect(res.search_pending).toBeUndefined();
    const jobs = await storage.engine().query(`SELECT 1 FROM jobs WHERE kind = 'page_mirror'`);
    expect(jobs.rows).toHaveLength(0);
  });

  it("queues it when mirrors are asynchronous, and the job builds it", async () => {
    process.env.MEMRAIN_PAGE_MIRROR_SYNC = "0";
    const res = await put({ slug: "notes/queued", markdown_body: body("badgers") });
    expect(res.search_pending).toBe(true);
    expect(typeof res.search_job_id).toBe("string");
    expect(res.search_indexed).toBeUndefined();
    expect(await mirror("page://notes/queued")).toBeNull();

    await drain();
    const job = await new Queue(storage.engine()).get(res.search_job_id as string);
    expect(job?.status).toBe("succeeded");
    expect((await mirror("page://notes/queued"))?.content).toContain("badgers");
  });

  it("builds it inline when the caller asks to wait for the index", async () => {
    process.env.MEMRAIN_PAGE_MIRROR_SYNC = "0";
    const res = await put({ slug: "notes/waited", markdown_body: body("herons"), wait_for_index: true });
    expect(res.search_pending).toBeUndefined();
    expect("search_indexed" in res).toBe(true);
  });

  it("ends an A -> B -> A sequence with A mirrored", async () => {
    // A content-addressed job id would collapse the second A onto the first,
    // long-finished job and never mirror it again.
    process.env.MEMRAIN_PAGE_MIRROR_SYNC = "0";
    await put({ slug: "notes/abba", markdown_body: body("apples") });
    await drain();
    await put({ slug: "notes/abba", markdown_body: body("bananas") });
    await drain();
    const again = await put({ slug: "notes/abba", markdown_body: body("apples") });
    expect(again.search_pending).toBe(true);
    await drain();
    expect((await mirror("page://notes/abba"))?.content).toContain("apples");
  });
});

describe("the page_mirror job", () => {
  it("files a tenant's page under the owner the page row names", async () => {
    await storage.engine().query(`INSERT INTO sources (id, kind, path_prefix) VALUES ('tenant-a', 'other', 'tenant:a')`);
    await putPage(storage, { slug: "notes/tenant", markdown_body: body("lynx"), source_id: "tenant-a" });
    await new Queue(storage.engine()).enqueue({
      kind: "page_mirror",
      payload: { slug: "notes/tenant", remote: true },
      id: "page_mirror:test:tenant",
    });
    await drain();
    expect((await mirror("page://tenant-a/notes/tenant"))?.content).toContain("lynx");
    expect(await mirror("page://notes/tenant")).toBeNull();
  });

  it("treats a payload without a trust flag as an untrusted caller", async () => {
    const withMarker = `---\nembed_skip: true\n---\n\n${body("voles")}`;
    await putPage(storage, { slug: "notes/marker-remote", markdown_body: withMarker });
    await putPage(storage, { slug: "notes/marker-local", markdown_body: withMarker });
    const q = new Queue(storage.engine());
    await q.enqueue({ kind: "page_mirror", payload: { slug: "notes/marker-remote" }, id: "page_mirror:test:r" });
    await q.enqueue({ kind: "page_mirror", payload: { slug: "notes/marker-local", remote: false }, id: "page_mirror:test:l" });
    await drain();
    // A gate-owned marker is honoured only from an explicitly trusted write.
    const remoteMirror = await mirror("page://notes/marker-remote");
    const localMirror = await mirror("page://notes/marker-local");
    expect(remoteMirror).not.toBeNull();
    expect(localMirror).not.toBeNull();
    expect(remoteMirror!.frontmatter.embed_skip).toBeUndefined();
    expect(localMirror!.frontmatter.embed_skip).toBeDefined();
  });

  it("skips a page that is gone instead of failing", async () => {
    await new Queue(storage.engine()).enqueue({
      kind: "page_mirror",
      payload: { slug: "notes/never-existed", remote: true },
      id: "page_mirror:test:gone",
    });
    await drain();
    const job = await new Queue(storage.engine()).get("page_mirror:test:gone");
    expect(job?.status).toBe("succeeded");
    expect(job?.result).toMatchObject({ status: "skipped" });
  });

  it("fails a payload without a slug at once instead of retrying it", async () => {
    await new Queue(storage.engine()).enqueue({
      kind: "page_mirror",
      payload: { remote: true },
      id: "page_mirror:test:noslug",
      maxRetries: 3,
    });
    await drain();
    const job = await new Queue(storage.engine()).get("page_mirror:test:noslug");
    expect(job?.status).toBe("failed");
    expect(job?.lastError).toBe("unrecoverable: page_mirror: payload.slug is required");
  });
});

describe("the page_mirror job acts for one write", () => {
  it("skips when the body has moved on since its write", async () => {
    // Its trust flag describes the OLD write; the newer write queued its own job.
    const first = await putPage(storage, { slug: "notes/moved", markdown_body: body("ferns") });
    await putPage(storage, { slug: "notes/moved", markdown_body: body("mosses") });
    await new Queue(storage.engine()).enqueue({
      kind: "page_mirror",
      payload: { slug: "notes/moved", remote: false, contentHash: first.content_hash },
      id: "page_mirror:test:moved",
    });
    await drain();
    const job = await new Queue(storage.engine()).get("page_mirror:test:moved");
    expect(job?.result).toMatchObject({ status: "skipped", reason: "superseded" });
    expect(await mirror("page://notes/moved")).toBeNull();
  });

  it("skips a soft-deleted page", async () => {
    await putPage(storage, { slug: "notes/gone", markdown_body: body("reeds") });
    await dispatchTool(storage, { name: "page_delete", arguments: { slug: "notes/gone" } });
    await new Queue(storage.engine()).enqueue({
      kind: "page_mirror",
      payload: { slug: "notes/gone", remote: false },
      id: "page_mirror:test:deleted",
    });
    await drain();
    const job = await new Queue(storage.engine()).get("page_mirror:test:deleted");
    expect(job?.result).toMatchObject({ status: "skipped", reason: "page_not_found" });
    expect(await mirror("page://notes/gone")).toBeNull();
  });

  it("takes the mirror back out when the page is deleted while it embeds", async () => {
    _resetHandlersForTesting();
    let deleted = false;
    registerPageMirrorHandler(storage, {
      embedFn: async (t: string) => {
        if (!deleted) {
          deleted = true;
          await dispatchTool(storage, { name: "page_delete", arguments: { slug: "notes/racing" } });
        }
        return deterministicEmbed(t);
      },
    });
    await putPage(storage, { slug: "notes/racing", markdown_body: body("gulls") });
    await new Queue(storage.engine()).enqueue({
      kind: "page_mirror",
      payload: { slug: "notes/racing", remote: false },
      id: "page_mirror:test:racing",
    });
    await drain();
    const job = await new Queue(storage.engine()).get("page_mirror:test:racing");
    expect(job?.result).toMatchObject({ status: "skipped", reason: "deleted_while_mirroring" });
    expect(await mirror("page://notes/racing")).toBeNull();
  });

  it("records one failure row for a failing page, not one per retry", async () => {
    _resetHandlersForTesting();
    registerPageMirrorHandler(storage, {
      embedFn: async () => {
        throw new Error("bedrock down");
      },
    });
    await putPage(storage, { slug: "notes/failing", markdown_body: body("terns") });
    const q = new Queue(storage.engine());
    await q.enqueue({
      kind: "page_mirror",
      payload: { slug: "notes/failing", remote: false },
      id: "page_mirror:test:failing",
      maxRetries: 2,
    });
    for (let i = 0; i < 3; i++) {
      await storage.engine().query(`UPDATE jobs SET next_attempt_at = NOW() WHERE id = 'page_mirror:test:failing'`);
      await drain();
    }
    expect((await q.get("page_mirror:test:failing"))?.status).toBe("failed");
    const rows = await storage.engine().query(
      `SELECT 1 FROM ingest_log WHERE source_type = 'page-mirror-failed' AND source_ref = 'notes/failing'`,
    );
    expect(rows.rows).toHaveLength(1);
  });
});

describe("an abandoned page_mirror attempt", () => {
  const job = { retryCount: 0, maxRetries: 3 } as JobRow;

  it("writes no mirror once its attempt is aborted", async () => {
    await putPage(storage, { slug: "notes/abandoned", markdown_body: body("voles") });
    const abort = new AbortController();
    abort.abort(new Error("lost its claim"));
    await expect(
      getHandler("page_mirror")!({ slug: "notes/abandoned", remote: false }, { job, signal: abort.signal }),
    ).rejects.toThrow("lost its claim");
    expect(await mirror("page://notes/abandoned")).toBeNull();
  });

  it("does not report success when the attempt is aborted while it embeds", async () => {
    _resetHandlersForTesting();
    const abort = new AbortController();
    registerPageMirrorHandler(storage, {
      embedFn: async (t: string) => {
        abort.abort(new Error("lost its claim"));
        return deterministicEmbed(t);
      },
    });
    await putPage(storage, { slug: "notes/midway", markdown_body: body("shrews") });
    await expect(
      getHandler("page_mirror")!({ slug: "notes/midway", remote: false }, { job, signal: abort.signal }),
    ).rejects.toThrow("lost its claim");
  });
});

describe("deleting a page", () => {
  it("drops a tenant's mirror, not only the legacy one", async () => {
    await storage.engine().query(`INSERT INTO sources (id, kind, path_prefix) VALUES ('tenant-a', 'other', 'tenant:a')`);
    await putPage(storage, { slug: "notes/doomed", markdown_body: body("moles"), source_id: "tenant-a" });
    await mirrorPage(
      storage,
      { slug: "notes/doomed", title: null, markdown_body: body("moles"), source_id: "tenant-a" },
      { remote: false, embedFn },
    );
    expect(await mirror("page://tenant-a/notes/doomed")).not.toBeNull();

    const r = await dispatchTool(storage, { name: "page_delete", arguments: { slug: "notes/doomed" } });
    expect(r.isError ?? false).toBe(false);
    expect(await mirror("page://tenant-a/notes/doomed")).toBeNull();
  });
});
