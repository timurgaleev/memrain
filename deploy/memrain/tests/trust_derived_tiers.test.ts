import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { putPage } from "../src/core/pages.ts";
import { registerSource } from "../src/core/sources.ts";
import { addFact } from "../src/core/facts.ts";
import { addTimelineEvent } from "../src/core/timeline.ts";
import { readTrustTiers } from "../src/core/trust-frame.ts";
import { lowerConceptPageTier, lowerPageTier, minFactTier } from "../src/core/trust-derived.ts";
import { persistThinkSynthesis, saveThinkTake } from "../src/core/synthesis/think-persist.ts";
import type { ThinkResult } from "../src/core/synthesis/think.ts";

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`derived rows inherit trust tiers (${name})`, () => {
  let db: Awaited<ReturnType<typeof open>>;
  const q = <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => db.storage.engine().query<T>(sql, params);
  const tierOf = async (table: string, where: string, params: unknown[]) =>
    (await q<{ trust_tier: string | null }>(`SELECT trust_tier FROM ${table} WHERE ${where}`, params)).rows[0]?.trust_tier;
  let atomSeq = 0;
  const atom = async (sourceRef: string, kind: "page" | "document", supplied?: string) => {
    atomSeq += 1;
    const r = await q<{ id: number; trust_tier: string | null }>(
      `INSERT INTO synth_atoms (atom_key, source_ref, source_kind, source_hash, title, body, model_id${supplied ? ", trust_tier" : ""})
       VALUES ($1, $2, $3, 'h', 't', 'b', 'm'${supplied ? ", $4" : ""}) RETURNING id, trust_tier`,
      [`k${atomSeq}`, sourceRef, kind, ...(supplied ? [supplied] : [])]);
    return r.rows[0]!;
  };

  beforeAll(async () => {
    db = await open();
    await registerSource(db.storage.engine(), { id: "inbox", kind: "meeting", pathPrefix: "/inbox" });
    await putPage(db.storage, { slug: "notes/own", markdown_body: "Owner text", written_by_principal: "operator" });
    await putPage(db.storage, { slug: "notes/agent", markdown_body: "Agent text", written_by_principal: "client:bot" });
    await putPage(db.storage, { slug: "meet/call", markdown_body: "Meeting text", source_id: "inbox" });
    await q(`INSERT INTO documents (id, source_path, source_id) VALUES ('doc-inbox', 'inbox/raw.md', 'inbox')`);
    await q(`INSERT INTO documents (id, source_path) VALUES ('doc-own', 'notes/raw.md')`);
  });
  afterAll(async () => { await db.close(); });

  it("an atom takes the tier of the page or document it was drawn from, and a supplied tier only lowers it", async () => {
    expect((await atom("notes/own", "page")).trust_tier).toBe("owner");
    expect((await atom("notes/agent", "page")).trust_tier).toBe("agent");
    expect((await atom("doc-inbox", "document")).trust_tier).toBe("external");
    expect((await atom("doc-own", "document")).trust_tier).toBe("owner");
    expect((await atom("notes/agent", "page", "owner")).trust_tier).toBe("agent");
    expect((await atom("notes/own", "page", "agent")).trust_tier).toBe("agent");
  });

  it("a take drawn from an agent's page is recorded at the agent's tier", async () => {
    const r = await q<{ trust_tier: string }>(
      `INSERT INTO synth_takes (take_key, source_ref, source_hash, prompt_version, claim_text, model_id)
       VALUES ('tk1', 'notes/agent', 'h', 'v', 'Agent claim', 'm') RETURNING trust_tier`);
    expect(r.rows[0]!.trust_tier).toBe("agent");
  });

  it("a fact the internal extractor drew from an agent's page is recorded at the agent's tier", async () => {
    const f = await addFact(db.storage, { entity_slug: "notes/own", fact: "Drawn from the agent page", source_slug: "notes/agent" });
    expect(await tierOf("entity_facts", "id = $1", [f.id])).toBe("agent");
    const own = await addFact(db.storage, { entity_slug: "notes/own", fact: "Written by the owner" });
    expect(await tierOf("entity_facts", "id = $1", [own.id])).toBe("owner");
  });

  it("a timeline entry parsed from a meeting page is external, and the reader sees it so", async () => {
    const r = await addTimelineEvent(db.storage, {
      slug: "notes/own", occurred_at: "2026-11-01", event: "Call about the orchard",
      source_chunk_id: "meeting-timeline:meet/call", source_id: "default",
    });
    expect(await tierOf("timeline_events", "id = $1", [r.id])).toBe("external");
    // Postgres returns a bigint id as a string; the tier map is keyed by number.
    const id = Number(r.id);
    const tiers = await readTrustTiers(db.storage.engine(), { events: [id] });
    expect(tiers.events.get(id)).toBe("external");
  });

  it("a chronicle projection takes its event page's tier, and a refresh never raises it", async () => {
    await putPage(db.storage, { slug: "events/launch", markdown_body: "Launch", written_by_principal: "client:bot" });
    const ins = await q<{ id: number; trust_tier: string }>(
      `INSERT INTO timeline_events (slug, occurred_at, event, detail, source_label, event_slug)
       VALUES ('notes/own', '2026-11-02', 'Launch', '', 'chronicle:event:events/launch', 'events/launch') RETURNING id, trust_tier`);
    expect(ins.rows[0]!.trust_tier).toBe("agent");
    await q(`UPDATE timeline_events SET event = 'Launch moved' WHERE id = $1`, [ins.rows[0]!.id]);
    expect(await tierOf("timeline_events", "id = $1", [ins.rows[0]!.id])).toBe("agent");
  });

  it("a concept page drops to the least trusted atom it was built from", async () => {
    const own = await atom("notes/own", "page");
    const agent = await atom("notes/agent", "page");
    // An atom written before migration 184 has no tier; its source decides.
    const legacy = await atom("doc-own", "document");
    await q(`UPDATE synth_atoms SET trust_tier = NULL WHERE id = $1`, [legacy.id]);
    await q(`INSERT INTO synth_concepts (concept_slug, title, narrative, model_id) VALUES ('orchard', 'Orchard', 'n', 'm')`);
    for (const a of [own, legacy]) await q(`INSERT INTO synth_concept_atoms (concept_slug, atom_id) VALUES ('orchard', $1)`, [a.id]);
    await putPage(db.storage, { slug: "concepts/orchard", markdown_body: "Concept", written_by_principal: "operator" });
    await lowerConceptPageTier(db.storage.engine(), "orchard", "concepts/orchard");
    expect(await tierOf("pages", "slug = $1", ["concepts/orchard"])).toBe("owner");
    await q(`INSERT INTO synth_concept_atoms (concept_slug, atom_id) VALUES ('orchard', $1)`, [agent.id]);
    await lowerConceptPageTier(db.storage.engine(), "orchard", "concepts/orchard");
    expect(await tierOf("pages", "slug = $1", ["concepts/orchard"])).toBe("agent");
    // A later owner rewrite does not raise it back.
    await putPage(db.storage, { slug: "concepts/orchard", markdown_body: "Concept again", written_by_principal: "operator" });
    expect(await tierOf("pages", "slug = $1", ["concepts/orchard"])).toBe("agent");
  });

  it("lowerPageTier never raises a page", async () => {
    await lowerPageTier(db.storage.engine(), "notes/agent", "default", "owner");
    expect(await tierOf("pages", "slug = $1", ["notes/agent"])).toBe("agent");
  });

  it("minFactTier is the least trusted effective tier of the facts", async () => {
    const a = await addFact(db.storage, { entity_slug: "notes/own", fact: "Owner one" });
    const b = await addFact(db.storage, { entity_slug: "notes/own", fact: "Agent one", written_by_principal: "client:bot" });
    expect(await minFactTier(db.storage.engine(), [a.id!])).toBe("owner");
    expect(await minFactTier(db.storage.engine(), [a.id!, b.id!])).toBe("agent");
    expect(await minFactTier(db.storage.engine(), [])).toBeUndefined();
  });

  const thinkResult = (pages: string[]): ThinkResult => ({
    ran: true, reason: "", pagesGathered: pages.length, takesGathered: 0, spentUsd: 0, modelId: "m", budgetExhausted: false,
    synthesisStatus: "ok",
    synthesis: { answer: "The orchard ledger balances.", citations: [], gaps: [] },
    evidence: { pages, takes: [], facts: [], events: [] },
  } as unknown as ThinkResult);

  it("a saved think synthesis takes the tier of the least trusted evidence it read", async () => {
    const own = await persistThinkSynthesis(db.storage, { question: "Owner only question", result: thinkResult(["notes/own"]) });
    expect(await tierOf("pages", "slug = $1", [own.slug])).toBe("owner");
    const mixed = await persistThinkSynthesis(db.storage, { question: "Mixed question", result: thinkResult(["notes/own", "meet/call"]) });
    expect(await tierOf("pages", "slug = $1", [mixed.slug])).toBe("external");
  });

  it("a think take takes the tier of the least trusted evidence it read", async () => {
    const own = await saveThinkTake(db.storage.engine(), { claim: "Owner-grounded claim", anchorSlug: "notes/own", evidence: { pages: ["notes/own"], takes: [], facts: [], events: [] } });
    expect(await tierOf("synth_takes", "take_key = $1", [own.take_key])).toBe("owner");
    const agent = await saveThinkTake(db.storage.engine(), { claim: "Agent-grounded claim", anchorSlug: "notes/own", evidence: { pages: ["notes/agent"], takes: [], facts: [], events: [] } });
    expect(await tierOf("synth_takes", "take_key = $1", [agent.take_key])).toBe("agent");
  });
});
