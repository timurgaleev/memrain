/**
 * Alias fan-out (alias-fanout.ts): a name inside a longer query that a page
 * declares as an alias is searched again under the page's own name, as one
 * more keyword list. PGLite, no Bedrock: the vector arm is off (failingEmbed),
 * so the keyword lists are the whole retrieval.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { indexPageIntoSearch } from "../src/core/page-index.ts";
import { writeDocumentTransaction } from "../src/core/indexer-tx.ts";
import { aliasFanoutQueries, MAX_ALIAS_FANOUT } from "../src/core/search/alias-fanout.ts";
import { hybridSearch } from "../src/core/search/hybrid.ts";
import { TargetTrace, diagnoseTarget } from "../src/core/search/target-trace.ts";
import { deterministicEmbed } from "./det-embed.ts";
import { failingEmbed } from "./rank-flags-fixture.ts";

const embedFn = async (text: string) => deterministicEmbed(text);

let tmp: string;
let storage: Storage;
const savedFanout = process.env["MEMRAIN_ALIAS_FANOUT"];
const restoreFanout = (): void => {
  if (savedFanout === undefined) delete process.env["MEMRAIN_ALIAS_FANOUT"];
  else process.env["MEMRAIN_ALIAS_FANOUT"] = savedFanout;
};

async function page(slug: string, title: string, aliases: string[], body: string, sourceId?: string): Promise<void> {
  await putPage(storage, { slug, type: "person", title, compiled_truth: { aliases }, markdown_body: body, ...(sourceId ? { source_id: sourceId } : {}) });
  await indexPageIntoSearch(storage, { slug, title, markdown_body: body, ...(sourceId ? { source_id: sourceId } : {}) }, { embedFn });
}

async function note(id: string, text: string): Promise<void> {
  await writeDocumentTransaction(
    storage,
    { documentId: id, sourcePath: `notes/${id}.md`, title: id, frontmatter: {}, embeddingModel: "deterministic-test" },
    [{ text, entities: [], embedding: deterministicEmbed(text) }],
  );
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-alias-fanout-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  await storage.engine().query(
    `INSERT INTO sources (id, kind, path_prefix) VALUES ('tenant-b', 'other', '__tenant_b__') ON CONFLICT (id) DO NOTHING`,
  );
  await page("people/robert-smith", "Robert Smith", ["Bobby"], "Leads the platform team.");
  await page("companies/acme", "Acme Corporation", ["the widget company"], "Makes widgets.");
  await page("people/zed", "Zed Person", ["Zeddy"], "One.");
  await page("people/quill", "Quill Person", ["Quilly"], "Two.");
  await page("people/moxie", "Moxie Person", ["Moxy"], "Three.");
  await page("people/ghost", "Ghost Person", ["Casper"], "Gone.");
  await page("people/hidden", "Hidden Person", ["Hidey"], "Archived.");
  await page("people/tb", "Tibor Bauer", ["Tibby"], "Tenant b.", "tenant-b");
  await page("people/shade-a", "Shade Alpha", ["Shadow"], "Default shade.");
  await page("people/shade-b", "Shade Beta", ["Shadow"], "Tenant shade.", "tenant-b");
  await putPage(storage, { slug: "life/journal-jo", type: "journal", title: "Jo Journal", compiled_truth: { aliases: ["Journo"] }, markdown_body: "Private." });
  await indexPageIntoSearch(storage, { slug: "life/journal-jo", title: "Jo Journal", markdown_body: "Private." }, { embedFn });
  await storage.engine().query(`UPDATE pages SET deleted_at = now() WHERE slug = 'people/ghost'`);
  await storage.engine().query(`UPDATE documents SET archived = true WHERE source_path = 'page://people/hidden'`);
  await note("budget-meeting", "Robert Smith presented the quarterly budget forecast to the board.");
  await note("budget-noise", "The quarterly budget forecast slipped again this spring.");
});

afterAll(async () => {
  restoreFanout();
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

const fan = (q: string, sourceIds?: string[]) =>
  aliasFanoutQueries(storage.engine(), q, sourceIds ? { sourceIds } : {}).then((rows) => rows.map((r) => r.query));

describe("aliasFanoutQueries", () => {
  it("replaces a capitalized alias inside the query with the page's name", async () => {
    expect(await fan("Bobby budget forecast")).toEqual(["Robert Smith budget forecast"]);
  });

  it("resolves a lowercase phrase of several words", async () => {
    expect(await fan("the widget company budget")).toEqual(["Acme Corporation budget"]);
  });

  it("ignores a lowercase single word, a whole-query alias and a name the query already uses", async () => {
    expect(await fan("bobby budget forecast")).toEqual([]);
    expect(await fan("Bobby")).toEqual([]);
    expect(await fan("Bobby Robert Smith budget")).toEqual([]);
  });

  it("searches at most MAX_ALIAS_FANOUT names", async () => {
    expect(await fan("Zeddy Quilly Moxy budget")).toHaveLength(MAX_ALIAS_FANOUT);
  });

  // Value: protects=an alias of a page the caller cannot read never steers its search;
  // fails_when=the lookup skips the deleted, visibility or source checks.
  it("never resolves a deleted page, a hidden mirror or another source's page", async () => {
    expect(await fan("Casper budget")).toEqual([]);
    expect(await fan("Hidey budget")).toEqual([]);
    expect(await fan("Tibby budget", ["default"])).toEqual([]);
    expect(await fan("Tibby budget")).toEqual(["Tibor Bauer budget"]);
  });

  it("never resolves a journal page for a remote caller", async () => {
    expect(await fan("Journo budget")).toEqual(["Jo Journal budget"]);
    const remote = await aliasFanoutQueries(storage.engine(), "Journo budget", { remote: true });
    expect(remote).toEqual([]);
  });

  it("skips an alias two readable pages claim, and resolves it inside one source", async () => {
    expect(await fan("Shadow budget")).toEqual([]);
    expect(await fan("Shadow budget", ["default"])).toEqual(["Shade Alpha budget"]);
  });
});

describe("alias fan-out in hybridSearch", () => {
  const traced = async (q: string) => {
    const trace = new TargetTrace();
    await hybridSearch(storage, q, { embedQuery: failingEmbed, noCache: true, noTelemetry: true, k: 5, traceTarget: trace });
    return diagnoseTarget(storage.engine(), trace, "notes/budget-meeting.md", { k: 5 });
  };

  // Value: protects=a note that names the person only by the canonical name is retrieved for a
  // query using the alias; fails_when=the fan-out list is not fused (the note never reaches the
  // fused candidates, only the keyword-only any-word fill).
  it("fuses the note filed under the canonical name", async () => {
    const diag = await traced("Bobby budget forecast");
    expect(diag.arms).toContainEqual({ arm: "alias", rank: 1 });
    expect(diag.stages.find((s) => s.stage === "fused")).toEqual({ stage: "fused", present: true, rank: 1 });
    expect(diag.rank).toBe(1);
  });

  it("adds no list when MEMRAIN_ALIAS_FANOUT=0", async () => {
    process.env["MEMRAIN_ALIAS_FANOUT"] = "0";
    try {
      const diag = await traced("Bobby budget forecast");
      expect(diag.arms.map((a) => a.arm)).not.toContain("alias");
      expect(diag.stages.find((s) => s.stage === "fused")?.present).toBe(false);
    } finally {
      restoreFanout();
    }
  });
});
