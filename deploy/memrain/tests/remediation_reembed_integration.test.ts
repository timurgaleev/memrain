/**
 * reembed-source remediation, end to end: a real Queue + Worker + registered
 * handler + embed backfill on PGLite. Only the Titan embedder is swapped for a
 * deterministic function.
 *
 * Pins that the job really fills the source's missing vectors (it used to
 * succeed as a no-op), stays inside the pinned source, is idempotent on a
 * re-run, and fails instead of succeeding when nothing could be embedded or
 * the pin owns no document (the NULL-source '(unclassified)' bucket).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { Queue } from "../src/core/jobs/queue.ts";
import { Worker } from "../src/core/jobs/worker.ts";
import { _resetHandlersForTesting } from "../src/core/jobs/handlers.ts";
import { registerRemediationHandlers } from "../src/core/jobs/remediation-handlers.ts";
import { REMEDIATION_JOB_KIND } from "../src/core/remediation.ts";
import { writeDocumentTransaction } from "../src/core/indexer-tx.ts";
import { registerSource } from "../src/core/sources.ts";
import { collectPerSourceHealth, UNCLASSIFIED_BUCKET } from "../src/core/source-health.ts";
import { brokenSourcesFromHealth } from "../src/commands/doctor.ts";
import { deterministicEmbed } from "./det-embed.ts";
import { runEmbedBackfill } from "../src/core/embed-backfill.ts";

const detEmbed = (t: string) => Promise.resolve(deterministicEmbed(t));

let tmp: string;
let storage: Storage;
let queue: Queue;

const ALPHA_EMBEDDABLE = 3;

async function seed(): Promise<void> {
  const engine = storage.engine();
  await registerSource(engine, { id: "alpha", kind: "other", pathPrefix: "alpha/" });
  await registerSource(engine, { id: "beta", kind: "other", pathPrefix: "beta/" });
  await writeDocumentTransaction(
    storage,
    { documentId: "doc_alpha_1", sourcePath: "alpha/one.md", title: "one", frontmatter: {}, embeddingModel: "det", sourceId: "alpha" },
    [
      { text: "alpha first chunk about retrieval", entities: [] },
      { text: "alpha second chunk about vectors", entities: [] },
    ],
  );
  await writeDocumentTransaction(
    storage,
    { documentId: "doc_alpha_2", sourcePath: "alpha/two.md", title: "two", frontmatter: {}, embeddingModel: "det", sourceId: "alpha" },
    [{ text: "alpha third chunk about coverage", entities: [] }],
  );
  await writeDocumentTransaction(
    storage,
    { documentId: "doc_alpha_code", sourcePath: "alpha/x.ts", title: "x.ts", frontmatter: { kind: "code", language: "typescript" }, embeddingModel: "det", sourceId: "alpha" },
    [{ text: "function alpha() { return 1; }", entities: [], symbolName: "alpha" }],
  );
  await writeDocumentTransaction(
    storage,
    { documentId: "doc_beta_1", sourcePath: "beta/one.md", title: "beta one", frontmatter: {}, embeddingModel: "det", sourceId: "beta" },
    [
      { text: "beta chunk about something else", entities: [] },
      { text: "beta chunk number two", entities: [] },
    ],
  );
  // No sourceId → documents.source_id stays NULL: the '(unclassified)' bucket.
  await writeDocumentTransaction(
    storage,
    { documentId: "doc_legacy_1", sourcePath: "legacy/one.md", title: "legacy", frontmatter: {}, embeddingModel: "det" },
    [{ text: "legacy chunk with no owning source", entities: [] }],
  );
}

async function unembeddedChunks(documentId: string): Promise<number> {
  const r = await storage.engine().query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM chunks c
     LEFT JOIN embeddings em ON em.chunk_id = c.id
     WHERE c.document_id = $1 AND em.chunk_id IS NULL`,
    [documentId],
  );
  return r.rows[0]?.n ?? 0;
}

async function runReembedJob(sourceId: string) {
  const job = await queue.enqueue({
    kind: REMEDIATION_JOB_KIND,
    payload: { action: "reembed-source", source_id: sourceId },
    maxRetries: 0,
  });
  await new Worker(queue).drainOnce();
  return queue.get(job.id);
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-remreembed-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  queue = new Queue(storage.engine());
  _resetHandlersForTesting();
  await seed();
});

afterEach(async () => {
  _resetHandlersForTesting();
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("reembed-source remediation through the real worker", () => {
  it("fills the pinned source's missing vectors and nothing else", async () => {
    registerRemediationHandlers(storage, { embed: detEmbed });
    const before = await collectPerSourceHealth(storage.engine(), ["alpha", "beta"]);
    expect(before.find((s) => s.source_id === "alpha")?.embedded_chunks).toBe(0);

    const final = await runReembedJob("alpha");
    expect(final?.status).toBe("succeeded");
    expect(final?.result).toMatchObject({
      action: "reembed-source",
      source_id: "alpha",
      candidates: ALPHA_EMBEDDABLE,
      embedded: ALPHA_EMBEDDABLE,
      failed: 0,
    });
    expect(typeof final?.result?.["last_id"]).toBe("string");

    expect(await unembeddedChunks("doc_alpha_1")).toBe(0);
    expect(await unembeddedChunks("doc_alpha_2")).toBe(0);
    // Code chunks are graph-only; the other tenant is outside the pin.
    expect(await unembeddedChunks("doc_alpha_code")).toBe(1);
    expect(await unembeddedChunks("doc_beta_1")).toBe(2);

    const after = await collectPerSourceHealth(storage.engine(), ["alpha", "beta"]);
    const alpha = after.find((s) => s.source_id === "alpha");
    const beta = after.find((s) => s.source_id === "beta");
    expect(alpha?.embedded_chunks).toBe(ALPHA_EMBEDDABLE);
    expect(alpha?.embed_coverage_pct).toBe(1);
    expect(beta?.embedded_chunks).toBe(0);
    expect(beta?.embed_coverage_pct).toBe(0);
  });

  it("a re-run on an already fixed source is an idempotent no-op", async () => {
    registerRemediationHandlers(storage, { embed: detEmbed });
    expect((await runReembedJob("alpha"))?.status).toBe("succeeded");

    const again = await runReembedJob("alpha");
    expect(again?.status).toBe("succeeded");
    expect(again?.result).toMatchObject({ candidates: 0, embedded: 0, failed: 0 });
  });

  it("an aborted backfill stops before its next page", async () => {
    const abort = new AbortController();
    const embed = (t: string) => {
      abort.abort(new Error("lost its claim"));
      return detEmbed(t);
    };
    await expect(
      runEmbedBackfill(storage.engine(), { sourceId: "alpha", embed, pageSize: 1, concurrency: 1, signal: abort.signal }),
    ).rejects.toThrow("lost its claim");
    expect((await unembeddedChunks("doc_alpha_1")) + (await unembeddedChunks("doc_alpha_2"))).toBe(ALPHA_EMBEDDABLE - 1);
  });

  it("fails instead of succeeding when nothing could be embedded", async () => {
    registerRemediationHandlers(storage, {
      embed: () => Promise.reject(new Error("embedder down")),
    });
    const final = await runReembedJob("alpha");
    expect(final?.status).not.toBe("succeeded");
    expect(final?.lastError).toContain("chunks embedded for source alpha");
    expect(await unembeddedChunks("doc_alpha_1")).toBe(2);
  });

  it("succeeds when another embedder filled the chunks this run failed on", async () => {
    let filled = false;
    registerRemediationHandlers(storage, {
      embed: async () => {
        if (!filled) {
          filled = true;
          await runEmbedBackfill(storage.engine(), { sourceId: "alpha", embed: detEmbed });
        }
        throw new Error("embedder down");
      },
    });
    const final = await runReembedJob("alpha");
    expect(final?.status).toBe("succeeded");
    expect(final?.result).toMatchObject({ embedded: 0, remaining: 0 });
    expect(await unembeddedChunks("doc_alpha_1")).toBe(0);
  });

  it("does not count a blank chunk or a deleted document's chunk as embeddable", async () => {
    await writeDocumentTransaction(
      storage,
      { documentId: "doc_alpha_gone", sourcePath: "alpha/gone.md", title: "gone", frontmatter: {}, embeddingModel: "det", sourceId: "alpha" },
      [{ text: "alpha chunk of a deleted page", entities: [] }],
    );
    await storage.engine().query(`UPDATE documents SET deleted_at = NOW() WHERE id = 'doc_alpha_gone'`);
    await storage.engine().query(`UPDATE chunks SET content = '   ' WHERE document_id = 'doc_alpha_2'`);

    const health = await collectPerSourceHealth(storage.engine(), ["alpha"]);
    expect(health[0]?.embeddable_chunks).toBe(ALPHA_EMBEDDABLE - 1);
    const dry = await runEmbedBackfill(storage.engine(), { sourceId: "alpha", dryRun: true });
    expect(dry.candidates).toBe(ALPHA_EMBEDDABLE - 1);

    registerRemediationHandlers(storage, { embed: detEmbed });
    expect((await runReembedJob("alpha"))?.status).toBe("succeeded");
    expect((await collectPerSourceHealth(storage.engine(), ["alpha"]))[0]?.embed_coverage_pct).toBe(1);
    expect(await unembeddedChunks("doc_alpha_gone")).toBe(1);
  });

  it("never plans a fix for the unclassified bucket, and a job pinned to it fails", async () => {
    const health = await collectPerSourceHealth(storage.engine());
    const unclassified = health.find((s) => s.source_id === UNCLASSIFIED_BUCKET);
    expect(unclassified?.embeddable_chunks).toBe(1);
    expect(unclassified?.embedded_chunks).toBe(0);

    const broken = brokenSourcesFromHealth(health).map((b) => b.source_id).sort();
    expect(broken).toEqual(["alpha", "beta"]);

    registerRemediationHandlers(storage, { embed: detEmbed });
    const final = await runReembedJob(UNCLASSIFIED_BUCKET);
    expect(final?.status).not.toBe("succeeded");
    expect(final?.lastError).toContain("no live documents for source (unclassified)");
    expect(await unembeddedChunks("doc_legacy_1")).toBe(1);
  });
});
