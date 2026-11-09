/**
 * Page-mirror rechunk on a chunker-version bump.
 *
 * DB-canonical pages (`page://` docs) have no file on disk, so the vault
 * rechunk-sweep skips them — `reconcilePageMirrors` is the only path that
 * re-chunks a page mirror when the markdown chunker changes. This proves a
 * mirror stamped below the current chunker version is re-mirrored (which
 * re-runs the takes-fence strip and re-embeds).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import {
  indexPageIntoSearch,
  reconcilePageMirrors,
} from "../src/core/page-index.ts";
import { AUTO_MARKDOWN_RECHUNK_VERSION, MARKDOWN_CHUNKER_VERSION } from "../src/core/chunkers/recursive.ts";
import { deterministicEmbed } from "./det-embed.ts";

const embedFn = (t: string) => Promise.resolve(deterministicEmbed(t));

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-page-rechunk-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function chunkerVersionOf(sourcePath: string): Promise<number | null> {
  const r = await storage
    .engine()
    .query<{ chunker_version: number }>(
      "SELECT chunker_version FROM documents WHERE source_path = $1",
      [sourcePath],
    );
  return r.rows[0]?.chunker_version ?? null;
}

describe("reconcilePageMirrors chunker-version staleness", () => {
  it("re-mirrors a page whose mirror is below the current chunker version", async () => {
    // Seed a page row so the reconcile SELECT (pages ⋈ documents) has a source.
    await storage.engine().exec(
      `INSERT INTO pages (slug, type, title, markdown_body, content_hash, source_id)
       VALUES ('note-x', 'note', 'Note X', 'Body about retrieval quality.', 'h1', 'default')`,
    );
    await indexPageIntoSearch(
      storage,
      {
        slug: "note-x",
        title: "Note X",
        markdown_body: "Body about retrieval quality.",
        content_hash: "h1",
        source_id: "default",
      },
      { embedFn },
    );
    expect(await chunkerVersionOf("page://note-x")).toBe(MARKDOWN_CHUNKER_VERSION);

    // Simulate a mirror below the automatically approved upgrade floor.
    await storage
      .engine()
      .exec(
        `UPDATE documents SET chunker_version = ${AUTO_MARKDOWN_RECHUNK_VERSION - 1} WHERE source_path = 'page://note-x'`,
      );

    const r = await reconcilePageMirrors(storage, { embedFn });
    expect(r.mirrored).toBeGreaterThanOrEqual(1);
    expect(await chunkerVersionOf("page://note-x")).toBe(MARKDOWN_CHUNKER_VERSION);
  });

  it("re-mirrors a TRUTH mirror below the current chunker version (Pass 1t)", async () => {
    await storage.engine().exec(
      `INSERT INTO pages (slug, type, title, markdown_body, content_hash, source_id, compiled_truth)
       VALUES ('note-t', 'note', 'Note T', 'Body t.', 'h3', 'default', '{"summary":"truth about t"}'::jsonb)`,
    );
    // First reconcile writes the truth mirror at the current version.
    await reconcilePageMirrors(storage, { embedFn });
    expect(await chunkerVersionOf("page-truth://note-t")).toBe(
      MARKDOWN_CHUNKER_VERSION,
    );

    // Simulate a truth mirror below the automatic floor. The hash
    // stamp is still fresh, so ONLY the version arm can trigger the re-mirror.
    await storage
      .engine()
      .exec(
        `UPDATE documents SET chunker_version = ${AUTO_MARKDOWN_RECHUNK_VERSION - 1} WHERE source_path = 'page-truth://note-t'`,
      );
    const r = await reconcilePageMirrors(storage, { embedFn });
    expect(r.mirrored).toBeGreaterThanOrEqual(1);
    expect(await chunkerVersionOf("page-truth://note-t")).toBe(
      MARKDOWN_CHUNKER_VERSION,
    );
  });

  it("leaves a current-version mirror untouched", async () => {
    await storage.engine().exec(
      `INSERT INTO pages (slug, type, title, markdown_body, content_hash, source_id)
       VALUES ('note-y', 'note', 'Note Y', 'Body two.', 'h2', 'default')`,
    );
    await indexPageIntoSearch(
      storage,
      {
        slug: "note-y",
        title: "Note Y",
        markdown_body: "Body two.",
        content_hash: "h2",
        source_id: "default",
      },
      { embedFn },
    );
    const r = await reconcilePageMirrors(storage, { embedFn });
    expect(r.mirrored).toBe(0);
  });
});
