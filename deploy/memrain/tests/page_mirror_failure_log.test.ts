/**
 * A page whose search mirror failed leaves a durable trace.
 *
 * The caller already sees `search_indexed: false` and the cycle reconciles
 * later, but nothing outlived the request — so a page that silently stayed
 * unsearchable was invisible to anyone looking afterwards. Do NOT read this as
 * a reason to fail the write: the page is committed to the canonical store, and
 * turning a recoverable mirror hiccup into a failed page_put would be strictly
 * worse.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import { getIngestLog } from "../src/core/ingest-log.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-mirrorlog-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("page mirror failure", () => {
  it("records a row when the mirror throws, and still commits the page", async () => {
    // Break the mirror at the storage layer: the chunks insert the search index
    // depends on cannot run, so indexPageIntoSearch throws inside the mirror.
    await storage.engine().exec("ALTER TABLE chunks RENAME TO chunks_hidden");
    let r;
    try {
      r = await dispatchTool(storage, {
        name: "page_put",
        arguments: { slug: "notes/mirror-fail", markdown_body: "body text" },
      });
    } finally {
      await storage.engine().exec("ALTER TABLE chunks_hidden RENAME TO chunks");
    }

    // The write itself succeeded — the page is canonical, the mirror is not.
    expect(r!.isError ?? false).toBe(false);
    const text = JSON.parse((r!.content[0] as { text: string }).text);
    expect(text.ok).toBe(true);
    expect(text.search_indexed).toBe(false);

    const log = await getIngestLog(storage.engine(), { limit: 20 });
    const row = log.find((e) => e.source_type === "page-mirror-failed");
    expect(row).toBeDefined();
    expect(row!.source_ref).toBe("notes/mirror-fail");
    expect(row!.pages_updated).toEqual(["notes/mirror-fail"]);
    expect((row!.summary ?? "").length).toBeGreaterThan(0);
  });

  it("records one row per failed put, not one per page ever written", async () => {
    // The mirror is broken the same way as above, so the assertion holds
    // whether or not embedding would succeed. The row count tracks the number
    // of failing writes, so the log stays readable instead of one row per retry.
    await storage.engine().exec("ALTER TABLE chunks RENAME TO chunks_hidden");
    try {
      for (const slug of ["notes/a", "notes/b"]) {
        await dispatchTool(storage, {
          name: "page_put",
          arguments: { slug, markdown_body: "body text" },
        });
      }
    } finally {
      await storage.engine().exec("ALTER TABLE chunks_hidden RENAME TO chunks");
    }
    const log = await getIngestLog(storage.engine(), { limit: 50 });
    const rows = log.filter((e) => e.source_type === "page-mirror-failed");
    expect(rows.map((r) => r.source_ref).sort()).toEqual(["notes/a", "notes/b"]);
  });
});
