/**
 * Owner-only sources: a source marked owner_only — and every row derived from
 * it and stored elsewhere (a fact on a shared person page, an attendee's
 * timeline row, a concept page built from its atoms, a think answer built on
 * them) — is read only by the operator and the owner's credential, whether the
 * brain serves one person or several. The provenance backfill for rows written
 * before migration 181 is metadata only.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { addFact } from "../src/core/facts.ts";
import { putPage } from "../src/core/pages.ts";
import { registerSource } from "../src/core/sources.ts";
import { addTimelineEvent } from "../src/core/timeline.ts";
import { addMember, type MemberActor } from "../src/core/members.ts";
import { setOwner } from "../src/core/brain-owner.ts";
import { provenanceBackfill, provenanceBackfilled, recordConceptPageOrigins, setSourceOwnerOnly } from "../src/core/owner-only.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import { consolidateFactsPhase } from "../src/core/cycle/consolidate-facts.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";
import { persistThinkSynthesis, saveThinkTake } from "../src/core/synthesis/think-persist.ts";
import type { ThinkResult } from "../src/core/synthesis/think.ts";

const OPS: MemberActor = { actor: "ops", via: "cli" };

for (const engine of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`owner-only sources ${engine.name}`, () => {
  let db: Awaited<ReturnType<typeof engine.open>>;
  const auth = (memberId?: string): AuthInfo => ({ token: "t", clientId: memberId ?? "loose", scopes: ["read"], isPublic: false, ...(memberId ? { memberId } : {}) });
  const call = async (name: string, args: Record<string, unknown>, opts: Parameters<typeof dispatchTool>[2]) => {
    const r = await dispatchTool(db.storage, { name, arguments: args }, opts);
    return { isError: r.isError === true, body: JSON.parse(r.content[0]!.text) };
  };
  const facts = async (opts: Parameters<typeof dispatchTool>[2]) =>
    ((await call("entity_facts", { entity_slug: "people/bob" }, opts)).body.facts as Array<{ fact: string }>).map((f) => f.fact).sort();
  const timeline = async (opts: Parameters<typeof dispatchTool>[2]) =>
    ((await call("entity_timeline", { slug: "people/bob" }, opts)).body.timeline as Array<{ event: string }>).map((e) => e.event).sort();
  const SOURCE: Record<string, string> = { "mail/thread-1": "me-mail", "notes/team": "shared", "concepts/relocation": "default" };
  const visible = async (slug: string, opts: Parameters<typeof dispatchTool>[2]) =>
    !(await call("page_get", { slug, source_id: SOURCE[slug] ?? (slug.startsWith("synthesis/") ? "shared" : undefined) }, opts)).isError;

  const listed = async (opts: Parameters<typeof dispatchTool>[2]) =>
    ((await call("page_list", { slug_prefix: "concepts/" }, opts)).body.pages as Array<{ slug: string }>).map((p) => p.slug);
  const exact = async (phrase: string, opts: Parameters<typeof dispatchTool>[2]) =>
    ((await call("search_exact", { phrase }, opts)).body.hits as Array<{ slug: string }>).map((h) => h.slug);
  const chunksFor = async (slug: string, opts: Parameters<typeof dispatchTool>[2]) =>
    (await call("get_chunks", { slug }, opts)).body.chunks as unknown[];

  let mailFactId = 0;
  const recallText = async (opts: Parameters<typeof dispatchTool>[2]) => {
    const r = await call("entity_recall", { slug: "people/bob" }, opts);
    return {
      facts: (r.body.facts as Array<{ fact: string }>).map((f) => f.fact).sort(),
      timeline: (r.body.timeline as Array<{ event: string }>).map((t) => t.event).sort(),
    };
  };
  const packFacts = async (opts: Parameters<typeof dispatchTool>[2]) =>
    JSON.stringify((await call("context_pack", { slugs: ["people/bob"] }, opts)).body);
  const byId = async (opts: Parameters<typeof dispatchTool>[2]) => !(await call("recall", { id: mailFactId }, opts)).isError;
  const trajectory = async (opts: Parameters<typeof dispatchTool>[2]) =>
    ((await call("find_trajectory", { entity_slug: "people/bob" }, opts)).body.points as Array<{ text: string }>).map((p) => p.text).sort();
  const supersessions = async (opts: Parameters<typeof dispatchTool>[2]) =>
    JSON.stringify((await call("fact_supersessions", { entity_slug: "people/bob" }, opts)).body);

  beforeAll(async () => {
    db = await engine.open();
    const e = db.storage.engine();
    await registerSource(e, { id: "shared", kind: "vault", pathPrefix: "/shared" });
    await registerSource(e, { id: "me-mail", kind: "mailbox", pathPrefix: "mail:me" });
    await setSourceOwnerOnly(e, "me-mail", true);
    await putPage(db.storage, { slug: "mail/thread-1", markdown_body: "Bob is moving to Lisbon", source_id: "me-mail" });
    await putPage(db.storage, { slug: "meetings/2026-11-02-bob", type: "meeting", markdown_body: "Call with Bob", source_id: "me-mail" });
    await putPage(db.storage, { slug: "people/bob", type: "person", markdown_body: "Bob", source_id: "shared" });
    await putPage(db.storage, { slug: "notes/team", markdown_body: "Team notes", source_id: "shared" });
    mailFactId = Number((await addFact(db.storage, { entity_slug: "people/bob", fact: "from mail", visibility: "world", source_id: "shared", source_slug: "mail/thread-1" })).id);
    const retired = await addFact(db.storage, { entity_slug: "people/bob", fact: "old mail claim", visibility: "world", source_id: "shared", source_slug: "mail/thread-1" });
    await e.query(`UPDATE entity_facts SET forgotten_at = now(), superseded_by = $1 WHERE id = $2`, [mailFactId, retired.id]);
    await addFact(db.storage, { entity_slug: "people/bob", fact: "from team notes", visibility: "world", source_id: "shared", source_slug: "notes/team" });
    await addTimelineEvent(db.storage, { slug: "people/bob", occurred_at: "2026-11-02T10:00:00Z", event: "Meeting: call", source_label: "meeting", source_chunk_id: "meeting-timeline:meetings/2026-11-02-bob", source_id: "shared" });
    await addTimelineEvent(db.storage, { slug: "people/bob", occurred_at: "2026-11-03T10:00:00Z", event: "Joined the team", source_id: "shared" });
    // A concept page built from an atom of the mailbox.
    const atom = await e.query<{ id: number }>(
      `INSERT INTO synth_atoms (atom_key, source_ref, source_kind, source_hash, title, body, atom_type, concepts, model_id)
       VALUES ('k1', 'mail/thread-1', 'page', 'h', 'Relocation', 'Bob relocates', 'fact', '[]'::jsonb, 'm') RETURNING id`);
    await e.query(`INSERT INTO synth_concepts (concept_slug, title, narrative, tier, atom_count, model_id) VALUES ('relocation', 'Relocation', 'n', 'T3', 1, 'm')`);
    await e.query(`INSERT INTO synth_concept_atoms (concept_slug, atom_id) VALUES ('relocation', $1)`, [atom.rows[0]!.id]);
    await putPage(db.storage, { slug: "concepts/relocation", type: "concept", markdown_body: "Relocation", source_id: "default" });
    await recordConceptPageOrigins(e, "relocation");
    await addMember(e, "ora", {}, OPS);
    await setOwner(e, "ora");
  });
  afterAll(async () => { await db.close(); });

  it("a one-person brain already closes the source and its lineage to an unbound key, not to the owner's", async () => {
    expect(await facts({ authInfo: auth() })).toEqual(["from team notes"]);
    expect(await timeline({ authInfo: auth() })).toEqual(["Joined the team"]);
    expect(await visible("mail/thread-1", { authInfo: auth() })).toBe(false);
    expect(await visible("concepts/relocation", { authInfo: auth() })).toBe(false);
    expect(await visible("notes/team", { authInfo: auth() })).toBe(true);
    expect(await facts({ authInfo: auth("ora") })).toEqual(["from mail", "from team notes"]);
    expect(await visible("mail/thread-1", { authInfo: auth("ora") })).toBe(true);
  });

  it("a think answer and take built on a fact from the owner-only source stay closed with it", async () => {
    const evidence = { pages: [], takes: [], facts: [mailFactId], events: [] };
    const result = {
      ran: true, pagesGathered: 0, takesGathered: 0, spentUsd: 0, modelId: "m", budgetExhausted: false, synthesisStatus: "ok",
      synthesis: { answer: "Bob relocates to Lisbon.", citations: [], gaps: [] }, evidence,
    } as unknown as ThinkResult;
    const saved = await persistThinkSynthesis(db.storage, { question: "Where is Bob moving", result, sourceId: "shared" });
    expect(await visible(saved.slug, { authInfo: auth() })).toBe(false);
    expect(await visible(saved.slug, { authInfo: auth("ora") })).toBe(true);
    const take = await saveThinkTake(db.storage.engine(), { claim: "Bob relocates to Lisbon", anchorSlug: "notes/team", evidence });
    expect(take.inserted).toBe(true);
    const takes = async (opts: Parameters<typeof dispatchTool>[2]) =>
      ((await call("list_takes", {}, opts)).body.takes as Array<{ take_key: string }>).map((t) => t.take_key);
    expect(await takes({ authInfo: auth() })).not.toContain(take.take_key);
    expect(await takes({ authInfo: auth("ora") })).toContain(take.take_key);
  });

  it("on a shared brain another member reads neither the source nor what was derived from it", async () => {
    await addMember(db.storage.engine(), "alice", {}, OPS);
    const alice = { authInfo: auth("alice") };
    expect(await visible("mail/thread-1", alice)).toBe(false);
    expect(await visible("notes/team", alice)).toBe(true);
    expect(await facts(alice)).toEqual(["from team notes"]);
    expect(await timeline(alice)).toEqual(["Joined the team"]);
    expect(await visible("concepts/relocation", alice)).toBe(false);
    expect(await listed(alice)).toEqual([]);
    expect(await exact("Relocation", alice)).toEqual([]);
    expect(await chunksFor("concepts/relocation", alice)).toEqual([]);
  });

  it("the owner's credential and the operator read all of it", async () => {
    for (const opts of [{ authInfo: auth("ora") }, {}]) {
      expect(await visible("mail/thread-1", opts)).toBe(true);
      expect(await facts(opts)).toEqual(["from mail", "from team notes"]);
      expect(await timeline(opts)).toEqual(["Joined the team", "Meeting: call"]);
      expect(await visible("concepts/relocation", opts)).toBe(true);
      expect(await listed(opts)).toEqual(["concepts/relocation"]);
      expect(await exact("Relocation", opts)).toEqual(["concepts/relocation"]);
    }
  });

  it("every other fact and timeline reader closes the lineage too", async () => {
    const alice = { authInfo: auth("alice") };
    // list_concepts reads every concept narrative, so no credential may call it, the owner's included.
    expect((await call("list_concepts", {}, alice)).body.error).toBe("permission_denied");
    expect((await call("list_concepts", {}, { authInfo: auth("ora") })).body.error).toBe("permission_denied");
    expect(await recallText(alice)).toEqual({ facts: ["from team notes"], timeline: ["Joined the team"] });
    expect(await packFacts(alice)).not.toContain("from mail");
    expect(await byId(alice)).toBe(false);
    expect(await trajectory(alice)).toEqual(["Joined the team", "from team notes"]);
    expect(await supersessions(alice)).not.toContain("old mail claim");
    const owner = { authInfo: auth("ora") };
    expect(await recallText(owner)).toEqual({ facts: ["from mail", "from team notes"], timeline: ["Joined the team", "Meeting: call"] });
    expect(await packFacts(owner)).toContain("from mail");
    expect(await byId(owner)).toBe(true);
    expect(await trajectory(owner)).toContain("from mail");
    expect(await supersessions(owner)).toContain("old mail claim");
  });

  it("a consolidated take and a probed contradiction keep the lineage of what they quote", async () => {
    const e = db.storage.engine();
    const vec = JSON.stringify(Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0)));
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
    for (const fact of ["Bob relocates to Lisbon", "Bob is relocating to Lisbon", "Bob relocates to Lisbon soon"]) {
      const r = await addFact(db.storage, { entity_slug: "people/carol", fact, visibility: "world", source_id: "shared", source_slug: "mail/thread-1" });
      await e.query(`UPDATE entity_facts SET embedding = $1::vector, written_at = $2::timestamptz WHERE id = $3`, [vec, old, r.id]);
    }
    const res = await consolidateFactsPhase(e, { minOldestAgeMs: 0 });
    expect(res.takesWritten).toBe(1);
    const carol = async (opts: Parameters<typeof dispatchTool>[2]) =>
      ((await call("entity_facts", { entity_slug: "people/carol" }, opts)).body.facts as unknown[]).length;
    expect(await carol({ authInfo: auth("alice") })).toBe(0);
    expect(await carol({ authInfo: auth("ora") })).toBeGreaterThan(0);

    await e.query(
      `INSERT INTO synth_contradictions (pair_key, a_ref, a_kind, a_text, b_ref, b_kind, b_text, severity, axis, confidence, source_id, prompt_version, model_id)
       VALUES ('pk1', $1, 'fact', 'from mail', 'x', 'fact', 'other', 'high', 'place', 0.9, 'shared', 'v1', 'm')`,
      [String(mailFactId)],
    );
    const probed = async (opts: Parameters<typeof dispatchTool>[2]) =>
      JSON.stringify((await call("find_contradictions", {}, opts)).body);
    expect(await probed({ authInfo: auth("alice") })).not.toContain("pk1");
    expect(await probed({ authInfo: auth("alice") })).not.toContain("from mail");
    expect(await probed({ authInfo: auth("ora") })).toContain("from mail");
  });

  it("an explicit grant of the owner-only source does not open it to another member", async () => {
    const granted = { authInfo: { ...auth("alice"), sourceId: "me-mail", allowedSources: ["me-mail", "shared"] } };
    expect(await visible("mail/thread-1", granted)).toBe(false);
    expect(await facts(granted)).toEqual(["from team notes"]);
  });

  it("turning the flag off opens the lineage again", async () => {
    await setSourceOwnerOnly(db.storage.engine(), "me-mail", false);
    expect(await facts({ authInfo: auth("alice") })).toEqual(["from mail", "from team notes"]);
    await setSourceOwnerOnly(db.storage.engine(), "me-mail", true);
  });

  it("a derived row stays closed after its owner-only source is removed", async () => {
    const e = db.storage.engine();
    await registerSource(e, { id: "old-mail", kind: "mailbox", pathPrefix: "mail:old" });
    await setSourceOwnerOnly(e, "old-mail", true);
    await putPage(db.storage, { slug: "mail/old-thread", markdown_body: "Old", source_id: "old-mail" });
    await addFact(db.storage, { entity_slug: "people/bob", fact: "from old mail", visibility: "world", source_id: "shared", source_slug: "mail/old-thread" });
    await e.query(`DELETE FROM pages WHERE source_id = 'old-mail'`);
    await e.query(`DELETE FROM sources WHERE id = 'old-mail'`);
    expect(await facts({ authInfo: auth("alice") })).toEqual(["from team notes"]);
    expect((await facts({ authInfo: auth("ora") })).includes("from old mail")).toBe(true);
  });

  it("the provenance backfill records older rows, dry run first, without touching their content", async () => {
    const e = db.storage.engine();
    const old = await addFact(db.storage, { entity_slug: "people/bob", fact: "older mail fact", visibility: "world", source_id: "shared", source_slug: "mail/thread-1" });
    await e.query(`DELETE FROM derived_origins WHERE row_kind = 'fact' AND row_id = $1`, [String(old.id)]);
    const before = await e.query(`SELECT fact, written_at, visibility, source_id FROM entity_facts WHERE id = $1`, [old.id]);
    expect(await facts({ authInfo: auth("alice") })).toContain("older mail fact");

    const dry = await provenanceBackfill(e, { apply: false });
    expect(dry.dry_run).toBe(true);
    expect(dry.kinds.fact).toEqual({ missing: 1, owner_only: 1, recorded: 0 });
    expect(await facts({ authInfo: auth("alice") })).toContain("older mail fact");

    expect(await provenanceBackfilled(e)).toBe(false);
    const applied = await provenanceBackfill(e, { apply: true });
    expect(applied.kinds.fact.recorded).toBe(1);
    expect(await provenanceBackfilled(e)).toBe(true);
    expect(await facts({ authInfo: auth("alice") })).toEqual(["from team notes"]);
    expect((await e.query(`SELECT fact, written_at, visibility, source_id FROM entity_facts WHERE id = $1`, [old.id])).rows).toEqual(before.rows);
    expect((await provenanceBackfill(e, { apply: false })).kinds.fact.missing).toBe(0);
  });
});
