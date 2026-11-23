import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as embedding from "../src/core/embedding.ts";
import { storageEngines } from "./helpers/storage-engines.ts";
import { putPage, renamePage } from "../src/core/pages.ts";
import { registerSource } from "../src/core/sources.ts";
import { indexPageIntoSearch } from "../src/core/page-index.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import { hybridSearch } from "../src/core/search/hybrid.ts";
import { deterministicEmbedQuery } from "./det-embed.ts";
import { readExternalTrust, readTrustTiers } from "../src/core/trust-frame.ts";
import { meetsMinTrust, parseMinTrust, principalTier, TRUST_TIERS } from "../src/core/trust-tier.ts";
import { OperationError } from "../src/core/operation-error.ts";
import { seedFact } from "./helpers/seed-rows.ts";

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
    ids.ownFact = (await seedFact(db.storage, { entity_slug: "notes/own", fact: "Owner fact", written_by_principal: "operator", visibility: "world" })).id!;
    ids.agentFact = (await seedFact(db.storage, { entity_slug: "notes/own", fact: "Agent fact", written_by_principal: "client:bot", visibility: "world" })).id!;
    ids.meetFact = (await seedFact(db.storage, { entity_slug: "meet/call", fact: "Meeting fact", source_id: "inbox", visibility: "world" })).id!;
    ids.originFact = (await seedFact(db.storage, { entity_slug: "notes/own", fact: "Fact extracted from an agent page", source_slug: "notes/agent", visibility: "world" })).id!;
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
