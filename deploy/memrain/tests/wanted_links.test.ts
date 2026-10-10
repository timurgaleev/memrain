/**
 * Wanted links: a reference written before its page exists is recorded, and
 * the page write that creates the target gives the linking page its edge in
 * the same transaction.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage, deletePage, restorePage, renamePage } from "../src/core/pages.ts";
import { syncWikilinksForPage } from "../src/core/links.ts";
import { listWantedPages, reconnectWantedLinks } from "../src/core/wanted-links.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import { registerSource } from "../src/core/sources.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-wanted-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function edges(from: string): Promise<Array<{ target: string; resolution: string | null }>> {
  const r = await storage.engine().query<{ target: string; resolution: string | null }>(
    `SELECT target_slug AS target, resolution_type AS resolution FROM links
      WHERE source_slug = $1 AND type = 'wikilink' ORDER BY target_slug`,
    [from],
  );
  return r.rows;
}

async function wantedRows(): Promise<Array<{ from_slug: string; target_slug: string }>> {
  const r = await storage.engine().query<{ from_slug: string; target_slug: string }>(
    `SELECT from_slug, target_slug FROM wanted_links ORDER BY from_slug, target_slug`,
  );
  return r.rows;
}

async function write(slug: string, body: string): Promise<void> {
  await putPage(storage, { slug, markdown_body: body });
  await syncWikilinksForPage(storage, slug, body);
}

describe("wanted links", () => {
  it("a markdown link written before its page gains the edge when the page is created", async () => {
    await write("notes/plan", "See [the roadmap](projects/roadmap.md) and [a pic](img/logo.png).");
    expect(await edges("notes/plan")).toEqual([]);
    expect(await wantedRows()).toEqual([{ from_slug: "notes/plan", target_slug: "projects/roadmap" }]);

    await putPage(storage, { slug: "projects/roadmap", markdown_body: "the roadmap" });

    expect(await edges("notes/plan")).toEqual([{ target: "projects/roadmap", resolution: "qualified" }]);
    expect(await wantedRows()).toEqual([]);
  });

  it("a dangling wikilink is moved onto the namespaced page that takes its name", async () => {
    await write("notes/a", "Met [[Alice Smith]] today.");
    expect(await edges("notes/a")).toEqual([{ target: "alice-smith", resolution: "unqualified" }]);
    expect(await listWantedPages(storage.engine())).toMatchObject([
      { target_slug: "alice-smith", referenced_by: 1, sample_from: ["notes/a"], surface: "Alice Smith" },
    ]);

    await putPage(storage, { slug: "people/alice-smith", markdown_body: "Alice" });

    expect(await edges("notes/a")).toEqual([{ target: "people/alice-smith", resolution: "qualified" }]);
    expect(await listWantedPages(storage.engine())).toEqual([]);
  });

  it("does not claim a name two pages share", async () => {
    await putPage(storage, { slug: "companies/acme", markdown_body: "one acme" });
    await putPage(storage, { slug: "projects/acme", markdown_body: "another acme" });
    // Ambiguous for the resolver, so the reference waits.
    await write("notes/c", "Call [[acme]] too.");
    await putPage(storage, { slug: "teams/acme", markdown_body: "third" });
    expect(await edges("notes/c")).toEqual([{ target: "acme", resolution: "unqualified" }]);
    expect((await wantedRows()).map((r) => r.from_slug)).toEqual(["notes/c"]);
  });

  it("a declared alias answers a reference written as that alias", async () => {
    await write("notes/d", "Lunch with [[Bobby]].");
    await putPage(storage, { slug: "people/robert", markdown_body: "Rob", compiled_truth: { aliases: ["Bobby"] } });
    expect(await edges("notes/d")).toEqual([{ target: "people/robert", resolution: "qualified" }]);
  });

  it("re-extraction keeps first_seen and drops references the page no longer makes", async () => {
    await write("notes/e", "[[Zed]] and [[Yan]]");
    const before = await storage.engine().query<{ first_seen: string }>(
      `SELECT first_seen::text FROM wanted_links WHERE target_slug = 'zed'`,
    );
    await write("notes/e", "[[Zed]] only");
    const after = await storage.engine().query<{ first_seen: string }>(
      `SELECT first_seen::text FROM wanted_links WHERE target_slug = 'zed'`,
    );
    expect(after.rows[0]!.first_seen).toBe(before.rows[0]!.first_seen);
    expect((await wantedRows()).map((r) => r.target_slug)).toEqual(["zed"]);
  });

  it("a deleted linking page takes its references out of the wanted list", async () => {
    await write("notes/f", "[[Quill]]");
    await deletePage(storage, "notes/f");
    expect(await listWantedPages(storage.engine())).toEqual([]);
  });

  it("scopes the list and the reconnect to the linking page's source", async () => {
    await registerSource(storage.engine(), { id: "t1", kind: "vault", pathPrefix: "/t1" });
    await putPage(storage, { slug: "t1/notes/g", markdown_body: "[[Orbit]]", source_id: "t1" });
    await syncWikilinksForPage(storage, "t1/notes/g", "[[Orbit]]", "t1");
    expect(await listWantedPages(storage.engine(), { sourceIds: ["default"] })).toEqual([]);
    expect((await listWantedPages(storage.engine(), { sourceIds: ["t1"] })).map((w) => w.target_slug)).toEqual(["orbit"]);

    // A page in another source does not answer it.
    await putPage(storage, { slug: "orbit", markdown_body: "default orbit" });
    expect(await edges("t1/notes/g")).toEqual([{ target: "orbit", resolution: "unqualified" }]);
    await putPage(storage, { slug: "projects/orbit", markdown_body: "t1 orbit", source_id: "t1" });
    expect(await edges("t1/notes/g")).toEqual([{ target: "projects/orbit", resolution: "qualified" }]);
  });

  it("a target created while a re-extract is between resolve and commit still gets the edge", async () => {
    await write("notes/r", "Met [[Alice Smith]] at the [[Roadmap]] review.");
    // Run the target writes right before the re-extract opens its transaction,
    // after its resolver has already called both links dangling.
    const real = storage.engine();
    let raced = false;
    const racing = new Proxy(real, {
      get(t, k) {
        if (k === "transaction") {
          return async (fn: (tx: Engine) => Promise<unknown>) => {
            if (!raced) {
              raced = true;
              await putPage(storage, { slug: "people/alice-smith", markdown_body: "Alice" });
              await putPage(storage, { slug: "roadmap", markdown_body: "the roadmap" });
            }
            return t.transaction(fn);
          };
        }
        const v = Reflect.get(t, k, t);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const racingStorage = new Proxy(storage, {
      get(t, k) {
        if (k === "engine") return () => racing;
        const v = Reflect.get(t, k, t);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    await syncWikilinksForPage(racingStorage, "notes/r", "Met [[Alice Smith]] at the [[Roadmap]] review.");
    expect(raced).toBe(true);
    expect(await edges("notes/r")).toEqual([
      { target: "people/alice-smith", resolution: "qualified" },
      { target: "roadmap", resolution: "qualified" },
    ]);
    expect(await wantedRows()).toEqual([]);
  });

  it("restoring a deleted page answers references written while it was gone", async () => {
    await putPage(storage, { slug: "places/delta-base", markdown_body: "delta" });
    await deletePage(storage, "places/delta-base");
    await write("notes/h", "Back at [[Delta Base]].");
    expect(await edges("notes/h")).toEqual([{ target: "delta-base", resolution: "unqualified" }]);

    expect((await restorePage(storage, "places/delta-base")).restored).toBe(true);
    expect(await edges("notes/h")).toEqual([{ target: "places/delta-base", resolution: "qualified" }]);
    expect(await wantedRows()).toEqual([]);
  });

  it("renaming a page onto a wanted name answers it, and the renamed page keeps its own references", async () => {
    await write("notes/i", "Meet at [[Echo Base]].");
    await write("drafts/base", "Near [[Foxtrot]].");
    const r = await renamePage(storage, "drafts/base", "places/echo-base");
    expect(r.renamed).toBe(true);
    expect(await edges("notes/i")).toEqual([{ target: "places/echo-base", resolution: "qualified" }]);
    expect(await wantedRows()).toEqual([{ from_slug: "places/echo-base", target_slug: "foxtrot" }]);
  });

  it("a deleted linking page gets no edge when its target appears", async () => {
    await write("notes/k", "[[Golf Club]]");
    await deletePage(storage, "notes/k");
    await putPage(storage, { slug: "places/golf-club", markdown_body: "golf" });
    expect((await edges("notes/k")).map((e) => e.target)).not.toContain("places/golf-club");
  });

  it("a basename with LIKE metacharacters is matched literally", async () => {
    const e = storage.engine();
    // Slugs written through putPage cannot carry `_`; rows from older imports can.
    await putPage(storage, { slug: "other/axb", markdown_body: "x" });
    await putPage(storage, { slug: "notes/m", markdown_body: "m" });
    await e.query(
      `INSERT INTO pages (slug, type, title, compiled_truth, markdown_body, content_hash, source_id)
       VALUES ('people/a_b', 'note', 'a_b', '{}'::jsonb, '', 'h', 'default')`,
    );
    await e.query(
      `INSERT INTO wanted_links (source_id, from_slug, target_slug, surface) VALUES ('default', 'notes/m', 'a_b', 'a_b')`,
    );
    expect(await reconnectWantedLinks(e, "people/a_b", "default")).toBe(1);
  });
});
