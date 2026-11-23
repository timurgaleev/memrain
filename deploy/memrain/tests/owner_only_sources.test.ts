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
import { putPage } from "../src/core/pages.ts";
import { registerSource } from "../src/core/sources.ts";
import { provenanceBackfill, provenanceBackfilled, recordConceptPageOrigins, setSourceOwnerOnly } from "../src/core/owner-only.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";
import { seedFact, seedTimelineEvent, seedMember, seedOwner } from "./helpers/seed-rows.ts";


for (const engine of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`owner-only sources ${engine.name}`, () => {
  let db: Awaited<ReturnType<typeof engine.open>>;
  const auth = (memberId?: string): AuthInfo => ({ token: "t", clientId: memberId ?? "loose", scopes: ["read"], isPublic: false, ...(memberId ? { memberId } : {}) });
  const call = async (name: string, args: Record<string, unknown>, opts: Parameters<typeof dispatchTool>[2]) => {
    const r = await dispatchTool(db.storage, { name, arguments: args }, opts);
    return { isError: r.isError === true, body: JSON.parse(r.content[0]!.text) };
  };
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
    mailFactId = Number((await seedFact(db.storage, { entity_slug: "people/bob", fact: "from mail", visibility: "world", source_id: "shared", source_slug: "mail/thread-1" })).id);
    const retired = await seedFact(db.storage, { entity_slug: "people/bob", fact: "old mail claim", visibility: "world", source_id: "shared", source_slug: "mail/thread-1" });
    await e.query(`UPDATE entity_facts SET forgotten_at = now(), superseded_by = $1 WHERE id = $2`, [mailFactId, retired.id]);
    await seedFact(db.storage, { entity_slug: "people/bob", fact: "from team notes", visibility: "world", source_id: "shared", source_slug: "notes/team" });
    await seedTimelineEvent(db.storage, { slug: "people/bob", occurred_at: "2026-11-02T10:00:00Z", event: "Meeting: call", source_label: "meeting", source_chunk_id: "meeting-timeline:meetings/2026-11-02-bob", source_id: "shared" });
    await seedTimelineEvent(db.storage, { slug: "people/bob", occurred_at: "2026-11-03T10:00:00Z", event: "Joined the team", source_id: "shared" });
    // A concept page built from an atom of the mailbox.
    const atom = await e.query<{ id: number }>(
      `INSERT INTO synth_atoms (atom_key, source_ref, source_kind, source_hash, title, body, atom_type, concepts, model_id)
       VALUES ('k1', 'mail/thread-1', 'page', 'h', 'Relocation', 'Bob relocates', 'fact', '[]'::jsonb, 'm') RETURNING id`);
    await e.query(`INSERT INTO synth_concepts (concept_slug, title, narrative, tier, atom_count, model_id) VALUES ('relocation', 'Relocation', 'n', 'T3', 1, 'm')`);
    await e.query(`INSERT INTO synth_concept_atoms (concept_slug, atom_id) VALUES ('relocation', $1)`, [atom.rows[0]!.id]);
    await putPage(db.storage, { slug: "concepts/relocation", type: "concept", markdown_body: "Relocation", source_id: "default" });
    await recordConceptPageOrigins(e, "relocation");
    await seedMember(e, "ora");
    await seedOwner(e, "ora");
  });
  afterAll(async () => { await db.close(); });

  it("a one-person brain already closes the source and its lineage to an unbound key, not to the owner's", async () => {
    expect(await visible("mail/thread-1", { authInfo: auth() })).toBe(false);
    expect(await visible("concepts/relocation", { authInfo: auth() })).toBe(false);
    expect(await visible("notes/team", { authInfo: auth() })).toBe(true);
    expect(await visible("mail/thread-1", { authInfo: auth("ora") })).toBe(true);
  });


  it("on a shared brain another member reads neither the source nor what was derived from it", async () => {
    await seedMember(db.storage.engine(), "alice");
    const alice = { authInfo: auth("alice") };
    expect(await visible("mail/thread-1", alice)).toBe(false);
    expect(await visible("notes/team", alice)).toBe(true);
    expect(await visible("concepts/relocation", alice)).toBe(false);
    expect(await listed(alice)).toEqual([]);
    expect(await exact("Relocation", alice)).toEqual([]);
    expect(await chunksFor("concepts/relocation", alice)).toEqual([]);
  });

  it("the owner's credential and the operator read all of it", async () => {
    for (const opts of [{ authInfo: auth("ora") }, {}]) {
      expect(await visible("mail/thread-1", opts)).toBe(true);
      expect(await visible("concepts/relocation", opts)).toBe(true);
      expect(await listed(opts)).toEqual(["concepts/relocation"]);
      expect(await exact("Relocation", opts)).toEqual(["concepts/relocation"]);
    }
  });



  it("an explicit grant of the owner-only source does not open it to another member", async () => {
    const granted = { authInfo: { ...auth("alice"), sourceId: "me-mail", allowedSources: ["me-mail", "shared"] } };
    expect(await visible("mail/thread-1", granted)).toBe(false);
  });

  it("turning the flag off opens the lineage again", async () => {
    await setSourceOwnerOnly(db.storage.engine(), "me-mail", false);
    await setSourceOwnerOnly(db.storage.engine(), "me-mail", true);
  });

  it("a derived row stays closed after its owner-only source is removed", async () => {
    const e = db.storage.engine();
    await registerSource(e, { id: "old-mail", kind: "mailbox", pathPrefix: "mail:old" });
    await setSourceOwnerOnly(e, "old-mail", true);
    await putPage(db.storage, { slug: "mail/old-thread", markdown_body: "Old", source_id: "old-mail" });
    await seedFact(db.storage, { entity_slug: "people/bob", fact: "from old mail", visibility: "world", source_id: "shared", source_slug: "mail/old-thread" });
    await e.query(`DELETE FROM pages WHERE source_id = 'old-mail'`);
    await e.query(`DELETE FROM sources WHERE id = 'old-mail'`);
  });

  it("the provenance backfill records older rows, dry run first, without touching their content", async () => {
    const e = db.storage.engine();
    const old = await seedFact(db.storage, { entity_slug: "people/bob", fact: "older mail fact", visibility: "world", source_id: "shared", source_slug: "mail/thread-1" });
    await e.query(`DELETE FROM derived_origins WHERE row_kind = 'fact' AND row_id = $1`, [String(old.id)]);
    const before = await e.query(`SELECT fact, written_at, visibility, source_id FROM entity_facts WHERE id = $1`, [old.id]);

    const dry = await provenanceBackfill(e, { apply: false });
    expect(dry.dry_run).toBe(true);
    expect(dry.kinds.fact).toEqual({ missing: 1, owner_only: 1, recorded: 0 });

    expect(await provenanceBackfilled(e)).toBe(false);
    const applied = await provenanceBackfill(e, { apply: true });
    expect(applied.kinds.fact.recorded).toBe(1);
    expect(await provenanceBackfilled(e)).toBe(true);
    expect((await e.query(`SELECT fact, written_at, visibility, source_id FROM entity_facts WHERE id = $1`, [old.id])).rows).toEqual(before.rows);
    expect((await provenanceBackfill(e, { apply: false })).kinds.fact.missing).toBe(0);
  });
});
