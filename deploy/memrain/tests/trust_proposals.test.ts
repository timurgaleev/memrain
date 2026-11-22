/**
 * A less trusted write never silently replaces a more trusted fact or value:
 * the old one stays, the new one is stored beside it, and a proposal waits for
 * the owner (core/trust-proposals.ts, migration 185).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { addFact } from "../src/core/facts.ts";
import { replaceFact } from "../src/core/facts-replace.ts";
import { getOntology, mergeOntologyFact } from "../src/core/ontology-facts.ts";
import { deriveSlotEnds, type SlotRow } from "../src/core/fact-slots.ts";
import { decideTrustProposal, listTrustProposals } from "../src/core/trust-proposals.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";

const vector = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
const supersedes = (id: number | null) => ({
  embed: async () => vector, cheapThreshold: 1.1,
  llmFn: async () => ({ text: JSON.stringify({ decision: "supersede", matched_id: id }), modelId: "test", usage: { inputTokens: 1, outputTokens: 1 } }),
});

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`trust proposals (${name})`, () => {
  let db: Awaited<ReturnType<typeof open>>;
  const fact = async (id: number) => (await db.storage.engine().query<{ forgotten_at: string | null; forgotten_cause: string | null; superseded_by: number | null }>(
    `SELECT forgotten_at::text AS forgotten_at, forgotten_cause, superseded_by FROM entity_facts WHERE id = $1`, [id])).rows[0]!;
  beforeAll(async () => { db = await open(); });
  afterAll(async () => { await db.close(); });

  it("an agent's replaces on an owner fact files a proposal and retires nothing", async () => {
    const old = await addFact(db.storage, { entity_slug: "people/ana", fact: "Ana works at Acme", written_by_principal: "operator" });
    const fresh = await addFact(db.storage, { entity_slug: "people/ana", fact: "Ana works at Globex", written_by_principal: "client:bot" });
    const out = await replaceFact(db.storage.engine(), old.id!, fresh.id!, undefined);
    expect(out.replaced).toBe(false);
    expect(out.replace_reason).toBe("contested");
    expect(out.proposal_id).toBeGreaterThan(0);
    expect((await fact(old.id!)).forgotten_at).toBeNull();
    expect((await fact(fresh.id!)).forgotten_at).toBeNull();
    const [p] = await listTrustProposals(db.storage.engine(), { status: "pending" });
    expect(p).toMatchObject({ id: out.proposal_id, guard: "replaces", target_id: old.id, related_id: fresh.id, old_tier: "owner", new_tier: "agent", entity_slug: "people/ana" });
    expect(p!.old_fact).toBe("Ana works at Acme");
    expect(p!.new_fact).toBe("Ana works at Globex");
    // The same write again reuses the pending proposal.
    const again = await replaceFact(db.storage.engine(), old.id!, fresh.id!, undefined);
    expect(again.proposal_id).toBe(out.proposal_id);
  });

  it("accepting applies the replacement; deciding twice is refused", async () => {
    const [p] = await listTrustProposals(db.storage.engine(), { status: "pending" });
    const r = await decideTrustProposal(db.storage.engine(), p!.id, "accept", "operator");
    expect(r.status).toBe("accepted");
    const old = await fact(p!.target_id);
    expect(old.forgotten_cause).toBe("supersede");
    expect(Number(old.superseded_by)).toBe(p!.related_id!);
    expect((await fact(p!.related_id!)).forgotten_at).toBeNull();
    expect((await decideTrustProposal(db.storage.engine(), p!.id, "reject", "operator")).status).toBe("already_decided");
    expect((await decideTrustProposal(db.storage.engine(), 999_999, "accept", "operator")).status).toBe("not_found");
  });

  it("rejecting keeps the more trusted fact and retires the contested one in its favour", async () => {
    const old = await addFact(db.storage, { entity_slug: "people/ben", fact: "Ben lives in Porto", written_by_principal: "operator" });
    const fresh = await addFact(db.storage, { entity_slug: "people/ben", fact: "Ben lives in Faro", written_by_principal: "client:bot" });
    const out = await replaceFact(db.storage.engine(), old.id!, fresh.id!, undefined);
    const r = await decideTrustProposal(db.storage.engine(), out.proposal_id!, "reject", "admin");
    expect(r.status).toBe("rejected");
    expect((await fact(old.id!)).forgotten_at).toBeNull();
    const lost = await fact(fresh.id!);
    expect(lost.forgotten_cause).toBe("supersede");
    expect(Number(lost.superseded_by)).toBe(old.id!);
    const decided = (await listTrustProposals(db.storage.engine(), { status: "all" })).find(x => x.id === out.proposal_id)!;
    expect(decided).toMatchObject({ status: "rejected", decided_by: "admin" });
  });

  it("a proposal whose fact changed meanwhile goes stale and changes nothing", async () => {
    const old = await addFact(db.storage, { entity_slug: "people/cy", fact: "Cy is CTO", written_by_principal: "operator" });
    const fresh = await addFact(db.storage, { entity_slug: "people/cy", fact: "Cy is CEO", written_by_principal: "client:bot" });
    const out = await replaceFact(db.storage.engine(), old.id!, fresh.id!, undefined);
    await db.storage.engine().query(`UPDATE entity_facts SET forgotten_at = NOW(), forgotten_cause = 'forget' WHERE id = $1`, [fresh.id]);
    expect((await decideTrustProposal(db.storage.engine(), out.proposal_id!, "accept", "operator")).status).toBe("stale");
    expect((await fact(old.id!)).forgotten_at).toBeNull();
  });

  it("an equal or more trusted writer replaces as before", async () => {
    const agentOld = await addFact(db.storage, { entity_slug: "people/dee", fact: "Dee plays chess", written_by_principal: "client:bot" });
    const ownerNew = await addFact(db.storage, { entity_slug: "people/dee", fact: "Dee plays go", written_by_principal: "operator" });
    expect(await replaceFact(db.storage.engine(), agentOld.id!, ownerNew.id!, undefined)).toEqual({ replaced: true });
    const a = await addFact(db.storage, { entity_slug: "people/eve", fact: "Eve likes tea", written_by_principal: "client:bot" });
    const b = await addFact(db.storage, { entity_slug: "people/eve", fact: "Eve likes coffee", written_by_principal: "client:other" });
    expect(await replaceFact(db.storage.engine(), a.id!, b.id!, undefined)).toEqual({ replaced: true });
  });

  it("the classifier's supersede of an owner fact by an agent's fact is contested", async () => {
    const old = await addFact(db.storage, { entity_slug: "people/fay", fact: "Fay was CFO", written_by_principal: "operator", dedup: { embed: async () => vector } });
    const fresh = await addFact(db.storage, { entity_slug: "people/fay", fact: "Fay is CEO", written_by_principal: "client:bot", dedup: supersedes(old.id) });
    expect(fresh.inserted).toBe(true);
    expect(fresh.contested?.fact_id).toBe(old.id!);
    expect((await fact(old.id!)).forgotten_at).toBeNull();
    const p = (await listTrustProposals(db.storage.engine(), { status: "pending" })).find(x => x.related_id === fresh.id)!;
    expect(p.guard).toBe("conflict");
    expect(p.id).toBe(fresh.contested!.proposal_id);
    // The owner's own supersede still applies at once.
    const own = await addFact(db.storage, { entity_slug: "people/fay", fact: "Fay is chair", written_by_principal: "operator", dedup: supersedes(old.id) });
    expect(own.contested).toBeUndefined();
    expect(Number((await fact(old.id!)).superseded_by)).toBe(own.id!);
  });

  it("an agent's ontology value never closes the owner's current value; accepting makes it current", async () => {
    await mergeOntologyFact(db.storage, { entitySlug: "people/gil", dimension: "employer", value: "Acme", sourceId: "default", principal: "operator" });
    const agent = await mergeOntologyFact(db.storage, { entitySlug: "people/gil", dimension: "employer", value: "Globex", sourceId: "default", principal: "client:bot" });
    expect(agent.contested?.proposal_id).toBeGreaterThan(0);
    expect(agent.supersededId).toBeNull();
    const now = await getOntology(db.storage, "people/gil", { sourceIds: ["default"] });
    expect(now.find(v => v.dimension === "employer")?.value).toBe("Acme");
    expect((await decideTrustProposal(db.storage.engine(), agent.contested!.proposal_id, "accept", "operator")).status).toBe("accepted");
    const after = await getOntology(db.storage, "people/gil", { sourceIds: ["default"] });
    expect(after.find(v => v.dimension === "employer")?.value).toBe("Globex");
  });

  it("add_fact reports the contested replacement to the agent", async () => {
    const old = await addFact(db.storage, { entity_slug: "people/hal", fact: "Hal lives in Oslo", written_by_principal: "operator", visibility: "world" });
    const auth = { token: "t", clientId: "bot", scopes: ["read", "write"], isPublic: false };
    const r = await dispatchTool(db.storage, { name: "add_fact", arguments: { entity_slug: "people/hal", fact: "Hal lives in Bergen", visibility: "world", replaces: old.id } }, { authInfo: auth as never });
    const body = JSON.parse(r.content[0]!.text);
    expect(body.replaced).toBe(false);
    expect(body.replace_reason).toBe("contested");
    expect(body.proposal_id).toBeGreaterThan(0);
    expect((await fact(old.id!)).forgotten_at).toBeNull();
  });

  it("an agent's forget of an owner fact files a forget proposal and forgets nothing; accepting forgets it", async () => {
    const owned = await addFact(db.storage, { entity_slug: "people/ivy", fact: "Ivy lives in Rome", written_by_principal: "operator", visibility: "world" });
    const auth = { token: "t", clientId: "bot", scopes: ["read", "write"], isPublic: false };
    const forget = async () => {
      const r = await dispatchTool(db.storage, { name: "forget_fact", arguments: { id: owned.id, reason: "wrong" } }, { authInfo: auth as never });
      return { isError: r.isError === true, body: JSON.parse(r.content[0]!.text) };
    };
    const first = await forget();
    expect(first.isError).toBe(true);
    expect(first.body.error).toBe("permission_denied");
    expect(first.body.message).toContain("forget_requires_owner");
    expect((await fact(owned.id!)).forgotten_at).toBeNull();
    const withdrawn = await db.storage.engine().query(`SELECT 1 FROM fact_withdrawals WHERE first_fact_id = $1`, [owned.id]);
    expect(withdrawn.rows).toHaveLength(0);
    const pending = (await listTrustProposals(db.storage.engine(), { status: "pending" })).filter(x => x.target_id === owned.id);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ action: "forget", guard: "remote_forget", related_id: null, old_tier: "owner", new_tier: "agent", proposer_principal: "client:bot" });
    // A retry reuses the pending proposal.
    await forget();
    expect((await listTrustProposals(db.storage.engine(), { status: "pending" })).filter(x => x.target_id === owned.id)).toHaveLength(1);
    expect((await decideTrustProposal(db.storage.engine(), pending[0]!.id, "accept", "operator")).status).toBe("accepted");
    expect((await fact(owned.id!)).forgotten_cause).toBe("forget");
    expect((await db.storage.engine().query(`SELECT 1 FROM fact_withdrawals WHERE first_fact_id = $1`, [owned.id])).rows).toHaveLength(1);
    // A retry once the fact is forgotten files nothing new.
    await forget();
    expect((await listTrustProposals(db.storage.engine(), { status: "pending" })).filter(x => x.target_id === owned.id)).toHaveLength(0);
  });

  it("an agent forgets its own fact at once, and rejecting a forget proposal keeps the fact", async () => {
    const auth = { token: "t", clientId: "bot", scopes: ["read", "write"], isPublic: false };
    const mine = await addFact(db.storage, { entity_slug: "people/jo", fact: "Jo likes jazz", written_by_principal: "client:bot", visibility: "world" });
    const r = await dispatchTool(db.storage, { name: "forget_fact", arguments: { id: mine.id } }, { authInfo: auth as never });
    expect(JSON.parse(r.content[0]!.text).forgotten).toBe(true);
    const owned = await addFact(db.storage, { entity_slug: "people/jo", fact: "Jo lives in Nice", written_by_principal: "operator", visibility: "world" });
    await dispatchTool(db.storage, { name: "forget_fact", arguments: { id: owned.id } }, { authInfo: auth as never });
    const [p] = (await listTrustProposals(db.storage.engine(), { status: "pending" })).filter(x => x.target_id === owned.id);
    expect((await decideTrustProposal(db.storage.engine(), p!.id, "reject", "admin")).status).toBe("rejected");
    expect((await fact(owned.id!)).forgotten_at).toBeNull();
  });
});

describe("fact slots and trust", () => {
  const row = (id: number, value: string, from: string, rank?: number): SlotRow & { trust_rank?: number } => ({
    id, source_id: "default", entity_slug: "people/x", dimension: "location", value_hash: value, valid_from: from,
    source_markdown_slug: "p", fact: `moved to ${value}`, ...(rank === undefined ? {} : { trust_rank: rank }),
  });
  it("a less trusted later value does not end a more trusted one", () => {
    expect(deriveSlotEnds([row(1, "berlin", "2026-01-01", 3), row(2, "lisbon", "2026-03-01", 1)]).size).toBe(0);
  });
  it("an equally or more trusted later value ends it as before", () => {
    expect(deriveSlotEnds([row(1, "berlin", "2026-01-01", 1), row(2, "lisbon", "2026-03-01", 3)]).get(1)?.by).toBe(2);
    expect(deriveSlotEnds([row(1, "berlin", "2026-01-01"), row(2, "lisbon", "2026-03-01")]).get(1)?.by).toBe(2);
  });
  it("a later trusted change still ends the trusted value after a less trusted one in between", () => {
    const ends = deriveSlotEnds([row(1, "berlin", "2026-01-01", 3), row(2, "lisbon", "2026-03-01", 1), row(3, "paris", "2026-05-01", 3)]);
    expect(ends.get(1)?.by).toBe(3);
    expect(ends.get(2)?.by).toBe(3);
    expect(ends.has(3)).toBe(false);
  });
  it("a trusted value restated after a less trusted one is not ended by its own restatement", () => {
    const ends = deriveSlotEnds([row(1, "berlin", "2026-01-01", 3), row(2, "lisbon", "2026-03-01", 1), row(3, "berlin", "2026-05-01", 3)]);
    expect(ends.has(1)).toBe(false);
    expect(ends.get(2)?.by).toBe(3);
    // ...and the next trusted change ends the first row along with its restatement.
    const later = deriveSlotEnds([row(1, "berlin", "2026-01-01", 3), row(2, "lisbon", "2026-03-01", 1), row(3, "berlin", "2026-05-01", 3), row(4, "paris", "2026-07-01", 3)]);
    expect(later.get(1)?.by).toBe(4);
    expect(later.get(3)?.by).toBe(4);
  });
});
