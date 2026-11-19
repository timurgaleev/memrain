import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as embedding from "../src/core/embedding.ts";
import { storageEngines } from "./helpers/storage-engines.ts";
import { putPage, renamePage } from "../src/core/pages.ts";
import { registerSource } from "../src/core/sources.ts";
import { indexPageIntoSearch } from "../src/core/page-index.ts";
import { addFact } from "../src/core/facts.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import { hybridSearch } from "../src/core/search/hybrid.ts";
import { deterministicEmbedQuery } from "./det-embed.ts";
import { readExternalTrust, readTrustTiers } from "../src/core/trust-frame.ts";
import { meetsMinTrust, parseMinTrust, principalTier, TRUST_TIERS } from "../src/core/trust-tier.ts";
import { OperationError } from "../src/core/operation-error.ts";

describe("trust tier vocabulary", () => {
  it("orders owner > member > agent > external", () => {
    expect([...TRUST_TIERS]).toEqual(["owner", "member", "agent", "external"]);
    expect(meetsMinTrust("owner", "member")).toBe(true);
    expect(meetsMinTrust("agent", "member")).toBe(false);
    expect(meetsMinTrust("external", undefined)).toBe(true);
  });

  it("maps the authenticated principal, never a caller label", () => {
    expect(principalTier(undefined)).toBe("owner");
    expect(principalTier(null)).toBe("owner");
    expect(principalTier("operator")).toBe("owner");
    expect(principalTier("member:ann")).toBe("member");
    expect(principalTier("client:bot")).toBe("agent");
    expect(principalTier("client:bot|enrollment:e1")).toBe("agent");
    expect(principalTier("public")).toBe("agent");
  });

  it("parses min_trust strictly; external admits every tier and so adds no predicate", () => {
    expect(parseMinTrust(undefined, "search")).toBeUndefined();
    expect(parseMinTrust("owner", "search")).toBe("owner");
    expect(parseMinTrust("agent", "search")).toBe("agent");
    expect(parseMinTrust("external", "search")).toBeUndefined();
    for (const bad of ["Owner", "trusted", "", 3, ["owner"]]) {
      let thrown: unknown;
      try { parseMinTrust(bad, "search"); } catch (e) { thrown = e; }
      expect(thrown).toBeInstanceOf(OperationError);
      expect((thrown as OperationError).code).toBe("invalid_params");
    }
  });
});

const BODY = "Orchard ledger entry";
for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`trust tiers on rows (${name})`, () => {
  let db: Awaited<ReturnType<typeof open>>;
  const ids: Record<string, number> = {};
  const pagePut = async (slug: string, body: string, principal?: string, source = "default") => {
    await putPage(db.storage, { slug, markdown_body: body, source_id: source, title: slug, ...(principal ? { written_by_principal: principal } : {}) });
    await indexPageIntoSearch(db.storage, { slug, markdown_body: body, source_id: source, title: slug }, { embedFn: deterministicEmbedQuery });
  };
  const stored = async (table: "pages" | "entity_facts", key: string, value: string | number) => {
    const col = table === "pages" ? "slug" : "id";
    const r = await db.storage.engine().query<{ trust_tier: string | null }>(`SELECT trust_tier FROM ${table} WHERE ${col} = $1`, [value]);
    return r.rows[0]?.trust_tier ?? `missing:${key}`;
  };
  const call = async (tool: string, args: Record<string, unknown>, authInfo?: Record<string, unknown>) =>
    dispatchTool(db.storage, { name: tool, arguments: args }, { embedQuery: deterministicEmbedQuery, ...(authInfo ? { authInfo: authInfo as never } : {}) });
  const ok = async (tool: string, args: Record<string, unknown>, authInfo?: Record<string, unknown>) => {
    const r = await call(tool, args, authInfo);
    expect(r.isError).toBeFalsy();
    return JSON.parse(r.content[0]!.text);
  };

  beforeAll(async () => {
    db = await open();
    await registerSource(db.storage.engine(), { id: "inbox", kind: "meeting", pathPrefix: "/inbox" });
    await pagePut("notes/own", `${BODY} written by the owner`, "operator");
    await pagePut("notes/agent", `${BODY} written by an agent`, "client:bot");
    await pagePut("meet/call", `${BODY} from a meeting connector`, undefined, "inbox");
    await pagePut("notes/tainted", `${BODY} agent draft`, "client:bot");
    await pagePut("notes/tainted", `${BODY} agent draft with owner edit`, "operator");
    await pagePut("meet/edited", `${BODY} meeting text`, undefined, "inbox");
    await pagePut("meet/edited", `${BODY} meeting text with owner edit`, "operator", "inbox");
    ids.ownFact = (await addFact(db.storage, { entity_slug: "notes/own", fact: "Owner fact", written_by_principal: "operator", visibility: "world" })).id!;
    ids.agentFact = (await addFact(db.storage, { entity_slug: "notes/own", fact: "Agent fact", written_by_principal: "client:bot", visibility: "world" })).id!;
    ids.meetFact = (await addFact(db.storage, { entity_slug: "meet/call", fact: "Meeting fact", source_id: "inbox", visibility: "world" })).id!;
    ids.originFact = (await addFact(db.storage, { entity_slug: "notes/own", fact: "Fact extracted from an agent page", source_slug: "notes/agent", visibility: "world" })).id!;
  });
  afterAll(async () => { await db.close(); });

  it("records each page's tier at write time from principal and source kind", async () => {
    expect(await stored("pages", "own", "notes/own")).toBe("owner");
    expect(await stored("pages", "agent", "notes/agent")).toBe("agent");
    expect(await stored("pages", "call", "meet/call")).toBe("external");
  });

  it("never lets a later, more trusted edit raise a page's tier", async () => {
    expect(await stored("pages", "tainted", "notes/tainted")).toBe("agent");
    expect(await stored("pages", "edited", "meet/edited")).toBe("external");
    // A direct attempt to raise the stored tier is clamped by the next write.
    await db.storage.engine().query(`UPDATE pages SET trust_tier = 'owner' WHERE slug = 'notes/tainted'`);
    const tiers = await readTrustTiers(db.storage.engine(), { pages: ["notes/tainted"] });
    expect(tiers.pages.get("notes/tainted")).toBe("agent");
  });

  it("carries the recorded tier across a rename", async () => {
    await putPage(db.storage, { slug: "notes/moving", markdown_body: "Agent text that moves", written_by_principal: "client:bot" });
    expect((await renamePage(db.storage, "notes/moving", "notes/moved")).renamed).toBe(true);
    expect(await stored("pages", "moved", "notes/moved")).toBe("agent");
  });

  it("records each fact's tier and clamps a supplied tier to the writer's", async () => {
    expect(await stored("entity_facts", "own", ids.ownFact!)).toBe("owner");
    expect(await stored("entity_facts", "agent", ids.agentFact!)).toBe("agent");
    expect(await stored("entity_facts", "meet", ids.meetFact!)).toBe("external");
    const forged = await db.storage.engine().query<{ trust_tier: string }>(
      `INSERT INTO entity_facts (entity_slug, fact, written_by_principal, trust_tier)
       VALUES ('notes/own', 'Forged owner claim', 'client:bot', 'owner') RETURNING trust_tier`);
    expect(forged.rows[0]!.trust_tier).toBe("agent");
  });

  it("derives a legacy row's tier at read time from the same evidence the framing uses", async () => {
    await db.storage.engine().query(`UPDATE pages SET trust_tier = NULL WHERE slug IN ('notes/own', 'notes/agent', 'meet/call')`);
    await db.storage.engine().query(`UPDATE entity_facts SET trust_tier = NULL WHERE id = ANY($1::bigint[])`, [[ids.agentFact, ids.meetFact]]);
    const tiers = await readTrustTiers(db.storage.engine(), {
      pages: ["notes/own", "notes/agent", "meet/call"],
      facts: [ids.ownFact!, ids.agentFact!, ids.meetFact!, ids.originFact!],
    });
    expect(Object.fromEntries(tiers.pages)).toEqual({ "notes/own": "owner", "notes/agent": "agent", "meet/call": "external" });
    expect(tiers.facts.get(ids.ownFact!)).toBe("owner");
    expect(tiers.facts.get(ids.agentFact!)).toBe("agent");
    expect(tiers.facts.get(ids.meetFact!)).toBe("external");
    // A fact inherits the tier of the page it was drawn from.
    expect(tiers.facts.get(ids.originFact!)).toBe("agent");
  });

  it("frames exactly the rows below owner, so the label and the frame never disagree", async () => {
    const slugs = ["notes/own", "notes/agent", "meet/call", "notes/tainted", "meet/edited"];
    const tiers = await readTrustTiers(db.storage.engine(), { pages: slugs });
    const external = await readExternalTrust(db.storage.engine(), { pages: slugs });
    expect([...external.pages].sort()).toEqual(slugs.filter(s => tiers.pages.get(s) !== "owner").sort());
  });

  it("filters hybrid search by min_trust and leaves the default unchanged", async () => {
    const paths = async (minTrust?: "owner" | "agent") => (await hybridSearch(db.storage, "orchard ledger", {
      k: 20, embedQuery: deterministicEmbedQuery, ...(minTrust ? { minTrust } : {}),
    })).map(h => h.sourcePath).sort();
    const all = await paths();
    expect(all).toEqual(expect.arrayContaining(["page://notes/own", "page://notes/agent", "page://inbox/meet/call"]));
    // The default call above may have cached its ranking; a filtered call must not reuse it.
    expect(await paths("owner")).toEqual(["page://notes/own"]);
    expect(await paths("agent")).toEqual(all.filter(p => !p.startsWith("page://inbox/")));
    expect(await paths()).toEqual(all);
  });

  it("keeps a small k full when lower-tier hits outrank the eligible ones in every arm", async () => {
    const hits = await hybridSearch(db.storage, "notes/agent", {
      k: 1, embedQuery: deterministicEmbedQuery, minTrust: "owner",
    });
    expect(hits.map(h => h.sourcePath)).toEqual(["page://notes/own"]);
  });

  it("context_pack does not spend window slots on entities below min_trust", async () => {
    await putPage(db.storage, { slug: "projects/medlar", type: "note", title: "Medlar Grove", markdown_body: "m", written_by_principal: "client:bot" });
    await putPage(db.storage, { slug: "projects/quince", type: "note", title: "Quince Orchard", markdown_body: "q", written_by_principal: "operator" });
    const window = "user: Quince Orchard and Medlar Grove";
    // The agent's entity resolves first, so without the floor it would take the only slot.
    const first = await ok("context_pack", { window, max_entities: 1, token_budget: 8000 });
    expect(first.cards.map((c: { slug: string }) => c.slug)).toEqual(["projects/medlar"]);
    const pack = await ok("context_pack", { window, max_entities: 1, token_budget: 8000, min_trust: "owner" });
    expect(pack.cards.map((c: { slug: string }) => c.slug)).toEqual(["projects/quince"]);
  });

  for (const tool of ["search", "query"]) it(`${tool} reports trust_tier on every hit and honours min_trust`, async () => {
    const result = await ok(tool, { q: "orchard ledger" });
    expect(result.hits.length).toBeGreaterThan(2);
    for (const hit of result.hits) {
      expect(TRUST_TIERS).toContain(hit.trust_tier);
      expect(hit.trust === "external").toBe(hit.trust_tier !== "owner");
    }
    const tierOf = (path: string) => result.hits.find((h: { sourcePath: string }) => h.sourcePath === path)?.trust_tier;
    expect(tierOf("page://notes/own")).toBe("owner");
    expect(tierOf("page://notes/agent")).toBe("agent");
    expect(tierOf("page://inbox/meet/call")).toBe("external");
    const owner = await ok(tool, { q: "orchard ledger", min_trust: "owner" });
    expect(owner.hits.map((h: { sourcePath: string }) => h.sourcePath)).toEqual(["page://notes/own"]);
    const bad = await call(tool, { q: "orchard ledger", min_trust: "trusted" });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toContain("min_trust");
  });

  it("context_pack drops cards, facts and events below min_trust", async () => {
    const full = await ok("context_pack", { slugs: ["notes/own", "notes/agent"], token_budget: 8000 });
    expect(full.cards.map((c: { slug: string }) => c.slug)).toEqual(["notes/own", "notes/agent"]);
    const owner = await ok("context_pack", { slugs: ["notes/own", "notes/agent"], token_budget: 8000, min_trust: "owner" });
    expect(owner.cards.map((c: { slug: string }) => c.slug)).toEqual(["notes/own"]);
    const factIds = [...owner.cards.flatMap((c: { facts: { id: number }[] }) => c.facts), ...owner.facts].map((f: { id: number }) => f.id);
    expect(factIds).toContain(ids.ownFact!);
    for (const id of [ids.agentFact, ids.meetFact, ids.originFact]) expect(factIds).not.toContain(id);
    const bad = await call("context_pack", { slugs: ["notes/own"], min_trust: 1 });
    expect(bad.isError).toBe(true);
  });

  it("records an agent's inline index as agent text and frames its hits", async () => {
    const auth = { token: "t", clientId: "bot", scopes: ["read", "write"], sourceId: "default", isPublic: false };
    const embed = spyOn(embedding, "embedText").mockImplementation(async (text: string) => deterministicEmbedQuery(text));
    try {
      await ok("index", { sourcePath: "agent/inline-note.md", text: `# Inline\n\n${BODY} indexed inline by an agent` }, auth);
    } finally {
      embed.mockRestore();
    }
    const result = await ok("search", { q: "orchard ledger indexed inline" });
    const hit = result.hits.find((h: { sourcePath: string }) => h.sourcePath === "agent/inline-note.md");
    expect(hit.trust_tier).toBe("agent");
    expect(hit.trust).toBe("external");
  });
});
