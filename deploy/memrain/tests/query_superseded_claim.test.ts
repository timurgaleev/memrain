/**
 * `query` marks a page hit `superseded_claim` when a shown fact replaced a
 * claim taken from that page (facts-query-match.ts supersededClaims), and the
 * correcting fact leads the facts block. Deterministic, no model call; a fact
 * the caller cannot read never marks anything.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { addFact } from "../src/core/facts.ts";
import { putPage, getPage } from "../src/core/pages.ts";
import { indexPageIntoSearch } from "../src/core/page-index.ts";
import { registerSource } from "../src/core/sources.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import { deterministicEmbed } from "./det-embed.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";

for (const engine of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`superseded claims ${engine.name}`, () => {
  let db: Awaited<ReturnType<typeof engine.open>>;
  const auth: AuthInfo = { token: "test", clientId: "superseded", sourceId: "sc-a", allowedSources: ["sc-a"], scopes: ["read"], isPublic: false };
  const call = async (q: string, extra: Record<string, unknown> = {}, remote = false) => {
    const r = await dispatchTool(db.storage, { name: "query", arguments: { q, expand: false, ...extra } }, { embedQuery: async () => [], ...(remote ? { authInfo: auth } : {}) });
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
    return JSON.parse(r.content[0]!.text);
  };
  const page = async (slug: string, body: string) => {
    await putPage(db.storage, { slug, markdown_body: body, source_id: "sc-a" });
    await indexPageIntoSearch(db.storage, (await getPage(db.storage, slug))!, { embedFn: async (t) => deterministicEmbed(t) });
  };
  const fact = async (entity_slug: string, text: string, opts: { from: string; page?: string; slot?: { dimension: string; value: string }; visibility?: string }) =>
    (await addFact(db.storage, {
      entity_slug, fact: text, source_id: "sc-a", valid_from: opts.from, visibility: opts.visibility ?? "world",
      ...(opts.page ? { source_slug: opts.page } : {}), ...(opts.slot ? { slot: opts.slot } : {}),
    })).id as number;
  let headcountNew = 0;

  beforeAll(async () => {
    db = await engine.open();
    await registerSource(db.storage.engine(), { id: "sc-a", kind: "vault", pathPrefix: "/sc-a" });
    // A slot value a later, change-cued value ended.
    await page("notes/ann-profile", "Ann Lee location Berlin harbor project notes");
    await fact("people/ann-lee", "Ann Lee location is Berlin", { from: "2025-01-10", page: "notes/ann-profile", slot: { dimension: "location", value: "Berlin" } });
    await fact("people/ann-lee", "Ann Lee location changed, she moved to Munich", { from: "2026-03-01", slot: { dimension: "location", value: "Munich" } });
    // An explicit replacement, retired the way the supersede write retires it.
    await page("notes/acme-sheet", "Acme Widget headcount 40 staff in the plant");
    const old = await fact("companies/acme-widget", "Acme Widget headcount 40", { from: "2025-02-01", page: "notes/acme-sheet" });
    headcountNew = await fact("companies/acme-widget", "Acme Widget headcount 55", { from: "2026-02-01" });
    await fact("companies/acme-widget", "Acme Widget headcount survey planned", { from: "2026-02-15" });
    await db.storage.engine().query(
      `UPDATE entity_facts SET forgotten_at = now(), forgotten_cause = 'supersede', superseded_by = $2 WHERE id = $1`,
      [old, headcountNew],
    );
    // A restatement of the same value ends nothing.
    await page("notes/bo-profile", "Bo Kim location Paris office notes");
    await fact("people/bo-kim", "Bo Kim location is Paris", { from: "2025-01-10", page: "notes/bo-profile", slot: { dimension: "location", value: "Paris" } });
    await fact("people/bo-kim", "Bo Kim location Paris confirmed, she moved within Paris", { from: "2026-03-01", slot: { dimension: "location", value: "Paris" } });
    // A change dated in the future ends nothing yet.
    await page("notes/dee-profile", "Dee Park location Oslo office notes");
    await fact("people/dee-park", "Dee Park lives in Oslo", { from: "2025-01-10", page: "notes/dee-profile", slot: { dimension: "location", value: "Oslo" } });
    await fact("people/dee-park", "Dee Park location changes later, she relocated to Rome", { from: "2099-01-01", slot: { dimension: "location", value: "Rome" } });
    // The replacement is private: only the operator reads it.
    await page("notes/cara-sheet", "Cara Dune salary band 3 record");
    const caraOld = await fact("people/cara-dune", "Cara Dune salary band 3", { from: "2025-02-01", page: "notes/cara-sheet" });
    const caraNew = await fact("people/cara-dune", "Cara Dune salary band 4", { from: "2026-02-01", visibility: "private" });
    await db.storage.engine().query(
      `UPDATE entity_facts SET forgotten_at = now(), forgotten_cause = 'supersede', superseded_by = $2 WHERE id = $1`,
      [caraOld, caraNew],
    );
  });
  afterAll(async () => { await db.close(); });

  interface QueryHit { sourcePath: string; superseded_claim?: { fact_id: number; fact: string; valid_from: string | null } }
  const hitFor = (r: { hits: QueryHit[] }, slug: string): QueryHit => {
    const hit = r.hits.find((h) => h.sourcePath.endsWith(slug));
    if (!hit) throw new Error(`no hit for ${slug}`);
    return hit;
  };

  // Value: protects=the stale page carries the correction a later, change-cued slot value made;
  // fails_when=query returns the page text with no mark (the pre-change behavior).
  it("marks the page whose slot value a newer fact ended", async () => {
    const r = await call("Ann Lee location");
    const claim = hitFor(r, "notes/ann-profile").superseded_claim;
    expect(claim).toMatchObject({ valid_from: "2026-03-01" });
    expect(claim?.fact).toContain("Munich");
    expect(r.facts[0].fact_id).toBe(claim?.fact_id);
  });

  it("marks the page of an explicitly replaced claim and puts the correction first in the block", async () => {
    const r = await call("Acme Widget headcount");
    expect(hitFor(r, "notes/acme-sheet").superseded_claim?.fact_id).toBe(headcountNew);
    expect(r.facts[0].fact_id).toBe(headcountNew);
    expect(r.facts.map((f: { fact: string }) => f.fact)).toContain("Acme Widget headcount survey planned");
  });

  it("keeps the correction on the hit when the token budget cuts the facts block", async () => {
    const r = await call("Acme Widget headcount", { token_budget: 40 });
    expect(hitFor(r, "notes/acme-sheet").superseded_claim?.fact_id).toBe(headcountNew);
    expect(r.facts_truncated).toBe(true);
    // The mark is part of its hit's cost, so hits and marks stay within the budget.
    const tokens = (t: string | null | undefined) => Math.ceil((t ?? "").length / 4);
    const used = r.hits.reduce((n: number, h: { content: string; title?: string | null; superseded_claim?: { fact: string } }) =>
      n + tokens(h.content) + tokens(h.title) + tokens(h.superseded_claim?.fact), 0);
    expect(used).toBeLessThanOrEqual(40);
  });

  // Value: protects=a page is not called stale for a change that has not happened yet;
  // fails_when=a future slot end (or a future-dated correction) marks it today.
  it("does not mark a page whose slot value ends only in the future", async () => {
    expect(hitFor(await call("Dee Park location"), "notes/dee-profile").superseded_claim).toBeUndefined();
  });

  it("does not mark a page whose value was only restated", async () => {
    const r = await call("Bo Kim location");
    expect(hitFor(r, "notes/bo-profile").superseded_claim).toBeUndefined();
  });

  // Value: protects=a fact the caller cannot read never marks or reveals anything;
  // fails_when=the older-claim read ignores the caller's visibility.
  it("marks for the operator but not for a remote caller who cannot read the replacement", async () => {
    expect(hitFor(await call("Cara Dune salary band"), "notes/cara-sheet").superseded_claim).toBeDefined();
    const remote = await call("Cara Dune salary band", {}, true);
    expect(hitFor(remote, "notes/cara-sheet").superseded_claim).toBeUndefined();
    expect(JSON.stringify(remote)).not.toContain("band 4");
  });
});
