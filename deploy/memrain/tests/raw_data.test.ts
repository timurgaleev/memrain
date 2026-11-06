/**
 * raw_data sidecar completion (migration 078 + core/raw-data.ts): the
 * UNIQUE(slug, source) upsert key (newest-wins replace), the scoped-write
 * ownership guard, and scoped reads.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { deletePage, putPage } from "../src/core/pages.ts";
import { getRawData, putRawData } from "../src/core/raw-data.ts";
import { purgeDeletedPages } from "../src/core/pages-purge.ts";
import { PageNotFoundError } from "../src/core/operation-error.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-raw-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  await putPage(storage, { slug: "people/alice", type: "person" });
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("putRawData / getRawData", () => {
  it("upserts on (slug, source): re-put REPLACES the payload", async () => {
    const first = await putRawData(storage, "people/alice", "crustdata", { v: 1 });
    expect(first.created).toBe(true);
    const second = await putRawData(storage, "people/alice", "crustdata", { v: 2 });
    expect(second.created).toBe(false);
    const rows = await getRawData(storage, "people/alice");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data).toEqual({ v: 2 });
  });

  it("distinct sources coexist and filter", async () => {
    await putRawData(storage, "people/alice", "crustdata", { a: 1 });
    await putRawData(storage, "people/alice", "happenstance", { b: 2 });
    expect(await getRawData(storage, "people/alice")).toHaveLength(2);
    const one = await getRawData(storage, "people/alice", { source: "crustdata" });
    expect(one).toHaveLength(1);
    expect(one[0]!.data).toEqual({ a: 1 });
  });

  it("scoped write requires page ownership; scoped read filters by tenant", async () => {
    await expect(
      putRawData(storage, "people/alice", "crustdata", { x: 1 }, "tenant-b"),
    ).rejects.toThrow(/page not found/);
    await putRawData(storage, "people/alice", "crustdata", { x: 1 }, "default");
    expect(
      await getRawData(storage, "people/alice", { sourceIds: ["default"] }),
    ).toHaveLength(1);
    expect(
      await getRawData(storage, "people/alice", { sourceIds: ["tenant-b"] }),
    ).toHaveLength(0);
  });

  it("a new owner of a purged slug does not inherit the old payload", async () => {
    await putRawData(storage, "people/alice", "crustdata", { secret: 1 });
    await deletePage(storage, "people/alice");
    await purgeDeletedPages(storage.engine(), 0);
    await storage.engine().query(`INSERT INTO sources (id, kind, path_prefix) VALUES ('tenant-b', 'other', '/tenant-b')`);
    await putPage(storage, { slug: "people/alice", type: "person", source_id: "tenant-b" });
    expect(await getRawData(storage, "people/alice")).toEqual([]);
  });

  it("putRawData refuses a slug with no live page", async () => {
    await expect(putRawData(storage, "people/nobody", "crm", { v: 1 })).rejects.toBeInstanceOf(PageNotFoundError);
    await deletePage(storage, "people/alice");
    await expect(putRawData(storage, "people/alice", "crm", { v: 1 })).rejects.toBeInstanceOf(PageNotFoundError);
    await expect(putRawData(storage, "people/alice", "crm", { v: 1 }, "default")).rejects.toBeInstanceOf(PageNotFoundError);
  });

  it("rejects a non-object payload", async () => {
    await expect(
      putRawData(storage, "people/alice", "crustdata", [1, 2] as unknown as Record<string, unknown>),
    ).rejects.toThrow(/plain object/);
  });
});
