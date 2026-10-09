/**
 * Diary fence over the insight reads that emit PAGE rows.
 *
 * find_orphans / find_experts / find_contradictions / get_recent_salience /
 * find_anomalies all project `pages.slug` + `pages.title`, and `recall` projects
 * a fact's `source_slug` — the page it was extracted from. A non-operator caller
 * (OAuth tenant, even one scoped into the diary's own source) must receive none
 * of those when the page is life/diary/*. The operator (authInfo undefined) sees
 * everything, unchanged.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { dispatchTool, type ToolCallResult } from "../src/mcp/dispatch.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";
import { putPage } from "../src/core/pages.ts";
import { indexPageIntoSearch } from "../src/core/page-index.ts";
import { addLink } from "../src/core/links.ts";
import { addFact } from "../src/core/facts.ts";
import { registerSource } from "../src/core/sources.ts";
import { setSlugAlias } from "../src/core/slug-aliases.ts";
import { deterministicEmbed } from "./det-embed.ts";

const SOURCE = "fence-a";
const NORMAL = "projects/roadmap";
const DIARY = "life/diary/2026-07-01";

let tmp: string;
let storage: Storage;
let diaryFactId: number;
let normalFactId: number;

const tenant: AuthInfo = {
  token: "tok-fence",
  clientId: "client-fence",
  scopes: ["read", "write"],
  sourceId: SOURCE,
  allowedSources: [SOURCE],
  isPublic: false,
};

function payload(result: ToolCallResult): any {
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0]!.text);
}

const embedQuery = async (text: string) => deterministicEmbed(text);

const call = async (name: string, args: Record<string, unknown>, remote: boolean) =>
  await dispatchTool(
    storage,
    { name, arguments: args },
    remote ? { authInfo: tenant, embedQuery } : { embedQuery },
  );

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-dispatch-fence-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();

  await registerSource(storage.engine(), { id: SOURCE, kind: "vault", pathPrefix: "/fence" });
  await putPage(storage, { slug: NORMAL, type: "note", title: "Roadmap", source_id: SOURCE });
  await putPage(storage, { slug: DIARY, title: "Diary 2026-07-01", source_id: SOURCE });
  // One `contradicts` edge per page, pointing at unresolved targets so neither
  // page gains an inbound link (find_orphans needs both to stay orphans).
  await addLink(storage, { source_slug: DIARY, target_slug: "other/claim-a", type: "contradicts", source_id: SOURCE });
  await addLink(storage, { source_slug: NORMAL, target_slug: "other/claim-b", type: "contradicts", source_id: SOURCE });
  // Salient + cold, so both pages qualify as stale_salient anomalies.
  await storage.engine().query(
    `UPDATE pages SET salience = 1, updated_at = NOW() - interval '400 days'`,
    [],
  );
  // `id` is null when the claim was already on file; both are fresh inserts
  // here, and the recall cases below are meaningless without a real row id.
  const diaryFact = await addFact(storage, {
    entity_slug: NORMAL,
    fact: "diary interiority",
    source_slug: DIARY,
    source_id: SOURCE,
  });
  expect(diaryFact.id).not.toBeNull();
  diaryFactId = diaryFact.id!;
  const normalFact = await addFact(storage, {
    entity_slug: NORMAL,
    fact: "public claim",
    source_slug: NORMAL,
    source_id: SOURCE,
  });
  expect(normalFact.id).not.toBeNull();
  normalFactId = normalFact.id!;
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

const slugs = (rows: { slug: string }[]) => rows.map((r) => r.slug);

describe("insight reads: page-row diary fence", () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ["find_orphans", {}, "pages"],
    ["find_experts", {}, "experts"],
    ["get_recent_salience", {}, "pages"],
    ["find_anomalies", {}, "anomalies"],
  ];

  for (const [tool, args, key] of cases) {
    it(`${tool}: operator sees the diary page, a tenant does not`, async () => {
      const asOperator = payload(await call(tool, args, false));
      expect(slugs(asOperator[key])).toContain(DIARY);
      expect(slugs(asOperator[key])).toContain(NORMAL);

      const res = await call(tool, args, true);
      const asTenant = payload(res);
      expect(slugs(asTenant[key])).toContain(NORMAL);
      expect(slugs(asTenant[key])).not.toContain(DIARY);
      expect(res.content[0]!.text).not.toContain("Diary 2026-07-01");
    });
  }
});

describe("find_contradictions diary fence", () => {
  it("operator sees both asserted pairs", async () => {
    const out = payload(await call("find_contradictions", {}, false));
    expect(out.contradictions.map((c: any) => c.source_slug).sort()).toEqual([DIARY, NORMAL].sort());
  });

  it("a tenant loses the pair anchored on the diary page", async () => {
    const res = await call("find_contradictions", {}, true);
    expect(payload(res).contradictions.map((c: any) => c.source_slug)).toEqual([NORMAL]);
    expect(res.content[0]!.text).not.toContain(DIARY);
  });
});

describe("recall diary fence", () => {
  it("operator recalls a diary-sourced fact", async () => {
    const out = payload(await call("recall", { id: diaryFactId }, false));
    expect(out.fact.source_slug).toBe(DIARY);
  });

  it("a tenant gets not_found for a diary-sourced fact but keeps the normal one", async () => {
    const fenced = await call("recall", { id: diaryFactId }, true);
    expect(fenced.isError).toBeTruthy();
    expect(fenced.content[0]!.text).not.toContain("diary interiority");

    const out = payload(await call("recall", { id: normalFactId }, true));
    expect(out.fact.source_slug).toBe(NORMAL);
  });
});

describe("think fallback diary fence", () => {
  const WORD = "quokkaharbor";
  const DIARY_TEXT = `diary interiority ${WORD} never shared`;
  const NOTE_TEXT = `roadmap note ${WORD} milestone`;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    // Core putPage does not mirror into search (the dispatch write path does),
    // and think gathers from the search store, so index explicitly.
    for (const [slug, title, body] of [
      ["projects/harbor", "Harbor", NOTE_TEXT],
      ["life/diary/2026-07-02", "Diary 2026-07-02", DIARY_TEXT],
    ] as const) {
      await putPage(storage, { slug, title, markdown_body: body, source_id: SOURCE });
      await indexPageIntoSearch(storage, { slug, title, markdown_body: body, source_id: SOURCE }, { embedFn: embedQuery });
    }
    // Live gate on, budget too small for any call: the pre-flight refuses, so
    // the run ends on the extractive fallback without touching a model.
    for (const k of ["MEMRAIN_THINK", "MEMRAIN_THINK_BUDGET_USD"]) saved[k] = process.env[k];
    process.env["MEMRAIN_THINK"] = "1";
    process.env["MEMRAIN_THINK_BUDGET_USD"] = "0.0000001";
  });

  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("operator's fallback may quote the diary page", async () => {
    const out = payload(await call("think", { question: WORD }, false));
    expect(out.synthesis).toBeNull();
    expect(out.fallback?.kind).toBe("extractive");
    expect(out.fallback.answer).toContain("life/diary/2026-07-02");
  });

  it("a tenant scoped into the diary's source gets no diary text or ref", async () => {
    const res = await call("think", { question: WORD }, true);
    const out = payload(res);
    expect(out.synthesis).toBeNull();
    expect(out.fallback?.kind).toBe("extractive");
    expect(out.fallback.answer).toContain("milestone");
    expect(res.content[0]!.text).not.toContain("never shared");
    expect(res.content[0]!.text).not.toContain("life/diary");
  });
});

// Last on purpose: the edge added here gives the diary page an inbound link,
// which would break the find_orphans case above.
describe("backlinks diary fence", () => {
  it("hides edges into a diary target from a remote caller", async () => {
    await addLink(storage, { source_slug: NORMAL, target_slug: DIARY, type: "wikilink", source_id: SOURCE });
    const local = payload(await call("backlinks", { name: DIARY }, false));
    expect(local.hits.map((h: { sourcePath: string }) => h.sourcePath)).toEqual([
      `page://${SOURCE}/${NORMAL}`,
    ]);
    const remote = payload(await call("backlinks", { name: DIARY }, true));
    expect(remote.hits).toEqual([]);
  });

  it("hides an alias edge whose alias resolves to a diary page", async () => {
    await setSlugAlias(storage.engine(), {
      alias_slug: "notes/old-diary",
      canonical_slug: DIARY,
      source_id: SOURCE,
    });
    await addLink(storage, {
      source_slug: NORMAL,
      target_slug: "notes/old-diary",
      type: "wikilink",
      source_id: SOURCE,
    });
    const local = payload(await call("backlinks", { name: "notes/old-diary" }, false));
    expect(local.hits.length).toBeGreaterThan(0);
    const remote = payload(await call("backlinks", { name: "notes/old-diary" }, true));
    expect(remote.hits).toEqual([]);
  });

  it("rejects an over-long name", async () => {
    const res = await call("backlinks", { name: "x".repeat(257) }, true);
    expect(res.isError).toBe(true);
  });
});
