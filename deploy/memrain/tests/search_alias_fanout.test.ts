/**
 * Alias fan-out (alias-fanout.ts): an entity the query names, by its title or
 * an alias, is searched again under each of its other names, as one more
 * keyword list per name. PGLite, no Bedrock: the vector arm is off (failingEmbed),
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
import { aliasFanoutMax, aliasFanoutPlan, DEFAULT_ALIAS_FANOUT_MAX } from "../src/core/search/alias-fanout.ts";
import type { SearchMeta } from "../src/core/search/search-meta.ts";
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
  await note("bobby-hiring", "Bobby approved the hiring plan for next quarter.");
  await page("people/multi", "Multi Person", ["multi-alias-one", "multi-alias-two", "multi-three", "multi-four", "mfive"], "Many names.");
});

afterAll(async () => {
  restoreFanout();
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

const plan = (q: string, opts: { sourceIds?: string[]; remote?: boolean; max?: number } = {}) =>
  aliasFanoutPlan(storage.engine(), q, opts);
const fan = async (q: string, sourceIds?: string[]) => (await plan(q, sourceIds ? { sourceIds } : {}))?.names.map((n) => n.alias) ?? [];

describe("aliasFanoutPlan", () => {
  it("searches the page's name when the query uses its alias", async () => {
    const p = await plan("Bobby budget forecast");
    expect(p?.entity).toEqual({ slug: "people/robert-smith", source_id: "default" });
    expect(p?.names).toEqual([{ alias: "Robert Smith", page: "people/robert-smith" }]);
    expect(p?.terms).toEqual(["budget", "forecast"]);
  });

  // Value: protects=a query using the canonical name also finds records filed under a nickname;
  // fails_when=fan-out only goes from an alias to the title.
  it("searches the aliases when the query uses the page's title", async () => {
    expect(await fan("Robert Smith budget")).toEqual(["bobby"]);
  });

  it("resolves a lowercase phrase of several words", async () => {
    expect(await fan("the widget company budget")).toEqual(["Acme Corporation"]);
  });

  it("keeps stopwords and the entity's own words out of the ranking terms", async () => {
    expect((await plan("what did Bobby say about the budget"))?.terms).toEqual(["budget"]);
  });

  it("ignores a lowercase single word and a name the query already uses", async () => {
    expect(await fan("bobby budget forecast")).toEqual([]);
    expect(await fan("Bobby Robert Smith budget")).toEqual([]);
  });

  it("fans out a query that is the whole alias", async () => {
    expect(await fan("Bobby")).toEqual(["Robert Smith"]);
  });

  it("searches at most the cap of names and reports the rest as skipped", async () => {
    const p = await plan("Multi Person budget");
    expect(p?.names.map((n) => n.alias)).toEqual(["multi-alias-one", "multi-alias-two", "multi-three", "multi-four"]);
    expect(p?.skipped).toEqual(["mfive"]);
    expect((await plan("Multi Person budget", { max: 1 }))?.names).toHaveLength(1);
    expect(await plan("Multi Person budget", { max: 0 })).toBeNull();
  });

  it("reads MEMRAIN_ALIAS_FANOUT_MAX as an integer 0..16", () => {
    expect(aliasFanoutMax(undefined)).toBe(DEFAULT_ALIAS_FANOUT_MAX);
    expect(aliasFanoutMax("0")).toBe(0);
    expect(aliasFanoutMax("16")).toBe(16);
    expect(aliasFanoutMax("17")).toBe(DEFAULT_ALIAS_FANOUT_MAX);
    expect(aliasFanoutMax("two")).toBe(DEFAULT_ALIAS_FANOUT_MAX);
  });

  // Value: protects=an alias of a page the caller cannot read never steers its search;
  // fails_when=the lookup skips the deleted, visibility or source checks.
  it("never resolves a deleted page, a hidden mirror or another source's page", async () => {
    expect(await fan("Casper budget")).toEqual([]);
    expect(await fan("Ghost Person budget")).toEqual([]);
    expect(await fan("Hidey budget")).toEqual([]);
    expect(await fan("Tibby budget", ["default"])).toEqual([]);
    expect(await fan("Tibby budget")).toEqual(["Tibor Bauer"]);
  });

  it("never resolves a journal page for a remote caller", async () => {
    expect(await fan("Journo budget")).toEqual(["Jo Journal"]);
    expect(await plan("Journo budget", { remote: true })).toBeNull();
  });

  it("skips an alias two readable pages claim, and resolves it inside one source", async () => {
    expect(await fan("Shadow budget")).toEqual([]);
    expect(await fan("Shadow budget", ["default"])).toEqual(["Shade Alpha"]);
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

  // Value: protects=a conversational query reaches the note filed under the canonical name;
  // fails_when=the fan-out list needs every query word (stopwords included) in one chunk.
  it("finds the note for a conversational query", async () => {
    const diag = await traced("what did Bobby say about the budget forecast");
    expect(diag.arms).toContainEqual({ arm: "alias", rank: 1 });
    expect(diag.rank).not.toBeNull();
  });

  // Value: protects=the caller can tell why a row appeared; fails_when=fan-out rows carry no name
  // and the meta says nothing about what was searched.
  it("stamps the name a fan-out row was found under and reports it in the meta", async () => {
    let meta: SearchMeta | undefined;
    const hits = await hybridSearch(storage, "Robert Smith hiring", {
      embedQuery: failingEmbed, noCache: true, noTelemetry: true, k: 5, onMeta: (m) => { meta = m; },
    });
    const note = hits.find((h) => h.sourcePath === "notes/bobby-hiring.md");
    expect(note?.matched_alias).toBe("bobby");
    expect(meta?.fanout).toEqual({
      resolved_entity: "people/robert-smith",
      aliases_searched: [{ alias: "bobby", page: "people/robert-smith", hits: 1, truncated: false }],
      aliases_skipped: [],
      truncated: false,
    });
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
