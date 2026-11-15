/**
 * Connector deletion, retention and disconnect. An item deleted at the
 * provider is soft-deleted, restorable until the purge; a page the owner
 * deletes leaves no text, vector or fact behind; a run that wants to delete
 * too much is held; retention windows age pages out; disconnect previews and
 * then deletes exactly what it previewed. Nothing outside the account's own
 * connector pages is ever touched.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { putPage, restorePage } from "../src/core/pages.ts";
import { purgeDeletedPages } from "../src/core/pages-purge.ts";
import { mirrorPage } from "../src/core/page-index.ts";
import { registerSource } from "../src/core/sources.ts";
import { addFact } from "../src/core/facts.ts";
import { addTimelineEvent } from "../src/core/timeline.ts";
import { addLink } from "../src/core/links.ts";
import { accountRef, type MailThread } from "../src/core/connectors/model.ts";
import { renderMailThread, type RenderedConnectorPage } from "../src/core/connectors/render.ts";
import { enrichConnectorPage } from "../src/core/connectors/enrich-deterministic.ts";
import {
  applyProviderDeletions,
  deleteAllConnectorData,
  deleteStaleParts,
  hardDeleteConnectorPage,
  massDeleteVerdict,
  previewConnectorData,
  retentionDays,
  softDeleteUpstreamPage,
  sweepRetention,
} from "../src/core/connectors/retention.ts";
import { createAccount } from "../src/core/connectors/accounts.ts";
import { confirmHeldDeletes, rejectHeldDeletes } from "../src/core/connectors/sync-store.ts";
import { currentProblems } from "../src/core/notifications/store.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import { deterministicEmbed } from "./det-embed.ts";

const OWNER = "owner@example.org";
const OTHER = "second@example.org";
/** An account id with no account row: these sweeps stay under the guard, so nothing is recorded against it. */
const NO_ACCOUNT = "0a0b0c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d";
const embedFn = async (t: string) => deterministicEmbed(t);

const thread = (id: string, canary: string, date = "2026-11-01T08:00:00.000Z"): MailThread => ({
  threadId: id,
  messages: [{
    id: `${id}-m`, messageIdHeader: null, subject: `Subject ${canary}`, from: { name: "Bob Stone", email: "bob@example.net" },
    to: [{ name: null, email: OWNER }], cc: [], date, bodyText: `The secret plan is ${canary} and more words.`, bodyHtml: null,
    attachments: [], listUnsubscribe: false, categories: [],
  }],
});

/** Every row of every public table whose JSON form contains the needle. */
async function rowsContaining(e: Engine, needle: string): Promise<string[]> {
  const tables = (await e.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")).rows;
  const hits: string[] = [];
  for (const { tablename } of tables) {
    const r = await e.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${tablename}" t WHERE to_jsonb(t)::text LIKE $1`, [`%${needle}%`]);
    if ((r.rows[0]?.n ?? 0) > 0) hits.push(tablename);
  }
  return hits;
}

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`connector deletion and retention (${name})`, () => {
  let db: Awaited<ReturnType<typeof open>>;
  const scope = { sourceId: "inbox", accountRef: accountRef(OWNER) };

  beforeEach(async () => {
    db = await open();
    await registerSource(db.storage.engine(), { id: "inbox", kind: "mailbox", pathPrefix: "mail/" });
    await registerSource(db.storage.engine(), { id: "notes", kind: "other", pathPrefix: "/srv/notes" });
    await putPage(db.storage, { slug: "people/bob-stone", markdown_body: "Bob.", compiled_truth: { aliases: ["bob@example.net"] } });
  });
  afterEach(async () => { await db.close(); });

  const ingest = async (page: RenderedConnectorPage, source = "inbox") => {
    const put = await putPage(db.storage, { slug: page.slug, type: page.type, allowAdHocType: true, title: page.title, markdown_body: page.body,
      compiled_truth: page.truth, written_by: "connector-gmail", source_id: source, outsideText: true });
    expect(await mirrorPage(db.storage, { slug: page.slug, title: page.title, markdown_body: put.outside_body!, content_hash: put.content_hash, source_id: source },
      { remote: true, embedFn })).toBe(true);
    return page;
  };
  const mailPage = (id: string, canary: string, label = OWNER, date?: string) =>
    renderMailThread({ service: "gmail", accountLabel: label }, thread(id, canary, date));

  it("leaves no text, vector, fact, event or link behind when the owner deletes a connector page", async () => {
    const e = db.storage.engine();
    const canary = "zebracanary4471";
    const page = await ingest(mailPage("t1", canary));
    await enrichConnectorPage(db.storage, { page, sourceId: "inbox", ownAddresses: [OWNER], peopleSourceIds: ["default"] });
    const chunk = (await e.query<{ id: string }>(
      `SELECT c.id FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.source_id = 'inbox' LIMIT 1`)).rows[0]!.id;
    await addFact(db.storage, { entity_slug: "people/bob-stone", fact: `Bob mentioned ${canary}`, source_slug: page.slug, source_id: "inbox" });
    await addFact(db.storage, { entity_slug: "people/bob-stone", fact: `Bob plans ${canary} too`, source_chunk_id: chunk });
    await addTimelineEvent(db.storage, { slug: "people/bob-stone", occurred_at: "2026-11-01", event: `Talked about ${canary}`, source_chunk_id: chunk });
    await addLink(db.storage, { source_slug: "people/bob-stone", target_slug: "notes/x", type: "mentions", origin_slug: page.slug, context: `ctx ${canary}` });
    expect((await rowsContaining(e, canary)).length).toBeGreaterThan(0);
    const vectorsBefore = (await e.query<{ n: number }>(`SELECT count(*)::int AS n FROM embeddings`)).rows[0]!.n;
    expect(vectorsBefore).toBeGreaterThan(0);

    const result = await hardDeleteConnectorPage(db.storage, scope, { slug: page.slug, reason: "disconnect", externalId: "t1" });
    expect(result.deleted).toBe(true);
    expect(result.counts.facts).toBe(2);

    expect(await rowsContaining(e, canary)).toEqual([]);
    expect((await e.query("SELECT 1 FROM pages WHERE slug = $1", [page.slug])).rows).toHaveLength(0);
    expect((await e.query("SELECT 1 FROM page_versions WHERE slug = $1", [page.slug])).rows).toHaveLength(0);
    expect((await e.query("SELECT 1 FROM documents WHERE source_id = 'inbox'")).rows).toHaveLength(0);
    expect((await e.query("SELECT 1 FROM chunks WHERE id = $1", [chunk])).rows).toHaveLength(0);
    expect((await e.query("SELECT 1 FROM embeddings WHERE chunk_id = $1", [chunk])).rows).toHaveLength(0);
    expect((await e.query<{ n: number }>(`SELECT count(*)::int AS n FROM embeddings`)).rows[0]!.n).toBeLessThan(vectorsBefore);
    expect((await e.query("SELECT 1 FROM links WHERE source_slug = $1 OR origin_slug = $1", [page.slug])).rows).toHaveLength(0);
    expect((await e.query("SELECT 1 FROM pages WHERE slug = 'people/bob-stone'")).rows).toHaveLength(1);

    const receipts = (await e.query<{ source_ref: string; summary: string; pages_updated: unknown }>(
      "SELECT source_ref, summary, pages_updated FROM ingest_log WHERE source_type = 'connector-delete'")).rows;
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.source_ref).toContain("disconnect");
    const receiptText = JSON.stringify(receipts[0]);
    expect(receiptText).not.toContain(canary);
    expect(receiptText).not.toContain(OWNER);
    expect(receiptText).not.toContain(page.slug);
    expect(receiptText).not.toContain("t1\"");
  });

  it("deletes a split page's parts with it, and a retention sweep never takes a part alone", async () => {
    const e = db.storage.engine();
    const canary = "partcanary5150";
    const page = await ingest(mailPage("t9", "plainwords", OWNER, "2025-01-01T08:00:00.000Z"));
    const part = { ...page, slug: `${page.slug}/part-001`, body: `Tail of the thread ${canary}.\n`, truth: { ...page.truth, part_of: page.slug, part: 1 } };
    await ingest(part);
    const other = await ingest(mailPage("t10", "otherwords", OTHER, "2025-01-01T08:00:00.000Z"));
    await putPage(db.storage, { slug: `${other.slug}/part-001`, type: other.type, allowAdHocType: true, title: other.title,
      markdown_body: `Other account ${canary}.`, compiled_truth: { ...other.truth, part_of: page.slug }, written_by: "connector-gmail", source_id: "inbox", outsideText: true });

    // The sweep picks whole items: the part's own last activity does not select it.
    const swept = await sweepRetention(db.storage, scope, { accountId: NO_ACCOUNT, kinds: ["mail"], now: () => Date.parse("2026-11-14T00:00:00Z") });
    expect(swept.deleted).toEqual([page.slug]);
    expect((await e.query("SELECT 1 FROM pages WHERE slug = $1", [part.slug])).rows).toHaveLength(0);
    // Another account's page claiming the same parent is not this account's to delete.
    expect((await e.query("SELECT 1 FROM pages WHERE slug = $1", [`${other.slug}/part-001`])).rows).toHaveLength(1);
    const left = await rowsContaining(e, canary);
    expect(left).toEqual(["page_versions", "pages"]);
  });

  it("refuses to delete a split page whose part changed since the caller looked", async () => {
    const e = db.storage.engine();
    const page = await ingest(mailPage("t11", "plainwords"));
    const part = await ingest({ ...page, slug: `${page.slug}/part-001`, body: "Tail as previewed.\n", truth: { ...page.truth, part_of: page.slug, part: 1 } });
    const seen = (await e.query<{ content_hash: string }>("SELECT content_hash FROM pages WHERE slug = $1", [part.slug])).rows[0]!.content_hash;
    await putPage(db.storage, { slug: part.slug, markdown_body: "Tail someone edited by hand.\n", source_id: "inbox", written_by: "operator" });

    const r = await hardDeleteConnectorPage(db.storage, scope, { slug: page.slug, reason: "disconnect", expectedPartHashes: new Map([[part.slug, seen]]) });
    expect(r).toMatchObject({ deleted: false, refused: "changed" });
    expect((await e.query("SELECT 1 FROM pages WHERE slug = ANY($1::text[])", [[page.slug, part.slug]])).rows).toHaveLength(2);

    // A fresh preview deletes the connector page; the hand-edited part is no
    // longer connector text, so it stays.
    const preview = await previewConnectorData(db.storage, scope);
    const done = await deleteAllConnectorData(db.storage, scope, { expectedPlanHash: preview.plan_hash });
    expect(done.deleted).toEqual([page.slug]);
    expect((await e.query<{ slug: string }>("SELECT slug FROM pages WHERE slug = ANY($1::text[])", [[page.slug, part.slug]])).rows).toEqual([{ slug: part.slug }]);
  });

  it("removes synthesis atoms and atom pages distilled from the deleted page", async () => {
    const e = db.storage.engine();
    const canary = "atomcanary9931";
    const page = await ingest(mailPage("t2", "plainwords"));
    const doc = (await e.query<{ id: string }>(
      `SELECT id FROM documents WHERE source_id = 'inbox' AND source_path LIKE 'page://%' LIMIT 1`)).rows[0]!.id;
    // What the atoms phase leaves behind for a document (its model call is not needed to prove the cleanup).
    await e.query(
      `INSERT INTO synth_atoms (atom_key, source_ref, source_kind, source_hash, title, body, model_id)
       VALUES ($1, $2, 'document', 'abcdabcdabcdabcd', $3, $3, 'test-model')`,
      ["a".repeat(64), doc, `Atom about ${canary}`]);
    // A concept narrated over that atom and an unrelated one, each with its page.
    await e.query(`INSERT INTO synth_atoms (atom_key, source_ref, source_kind, source_hash, title, body, model_id)
       VALUES ($1, 'doc_unrelated', 'document', 'abcdabcdabcdabcd', 'Other atom', 'Other atom', 'test-model')`, ["c".repeat(64)]);
    for (const [concept, narrative, key] of [["Pricing", `Narrative ${canary}`, "a"], ["Hiring", "Unrelated narrative", "c"]] as const) {
      await e.query(`INSERT INTO synth_concepts (concept_slug, title, narrative, model_id) VALUES ($1, $1, $2, 'test-model')`, [concept, narrative]);
      await e.query(`INSERT INTO synth_concept_atoms (concept_slug, atom_id) SELECT $1, id FROM synth_atoms WHERE atom_key = $2`, [concept, key.repeat(64)]);
      await putPage(db.storage, { slug: `concepts/${concept.toLowerCase()}`, type: "concept", allowAdHocType: true, title: concept,
        markdown_body: narrative, written_by: "synthesize-concepts", written_by_principal: "operator" });
    }
    const atom = await putPage(db.storage, { slug: "atoms/connector-derived", type: "atom", allowAdHocType: true, title: "Atom",
      markdown_body: `Distilled ${canary}`, source_id: "inbox", written_by: "extract-atoms",
      compiled_truth: { atom_origin: { source_ref: doc, source_hash: "abcdabcdabcdabcd", source_id: "inbox", atom_key: "a".repeat(64) } } });
    await mirrorPage(db.storage, { slug: "atoms/connector-derived", title: "Atom", markdown_body: `Distilled ${canary}`, content_hash: atom.content_hash, source_id: "inbox" },
      { remote: false, embedFn });
    await e.query(
      `INSERT INTO synth_takes (take_key, source_ref, source_hash, prompt_version, claim_text, model_id)
       VALUES ($1, $2, 'abcdabcdabcdabcd', 'v1', $3, 'test-model')`,
      ["t".repeat(64), doc, `Take on ${canary}`]);
    const fact = await addFact(db.storage, { entity_slug: "people/bob-stone", fact: `Fact ${canary}`, source_slug: page.slug, source_id: "inbox" });
    await e.query(
      `INSERT INTO synth_contradictions (pair_key, a_ref, a_kind, a_text, b_ref, b_kind, b_text, prompt_version, model_id)
       VALUES ('pair-1', $1, 'fact', $2, 'people/bob-stone', 'page', 'Other side', 'v1', 'test-model')`,
      [String(fact.id), `Fact ${canary}`]);
    await e.query(
      `INSERT INTO synth_contradiction_verdicts (pair_key, contradicts, verdict, model_id, expires_at)
       VALUES ('pair-1', true, $1::text::jsonb, 'test-model', NOW() + interval '1 day')`,
      [JSON.stringify({ rationale: `about ${canary}` })]);
    expect((await rowsContaining(e, canary)).length).toBeGreaterThan(0);

    const result = await hardDeleteConnectorPage(db.storage, scope, { slug: page.slug, reason: "disconnect" });
    expect(result.counts.atoms).toBe(1);
    expect(result.counts.atom_pages).toBe(1);
    expect(result.counts.takes).toBe(1);
    expect(result.counts.contradictions).toBe(1);
    expect(result.counts.concepts).toBe(1);
    expect(result.counts.concept_pages).toBe(1);
    expect(await rowsContaining(e, canary)).toEqual([]);
    expect((await e.query("SELECT concept_slug FROM synth_concepts")).rows).toEqual([{ concept_slug: "Hiring" }]);
    expect((await e.query("SELECT 1 FROM pages WHERE slug = 'concepts/hiring'")).rows).toHaveLength(1);
    expect((await e.query("SELECT 1 FROM pages WHERE slug = 'atoms/connector-derived'")).rows).toHaveLength(0);
  });

  it("keeps an atom page someone edited, and says so in the counts", async () => {
    const e = db.storage.engine();
    const page = await ingest(mailPage("t3", "plainwords"));
    const doc = (await e.query<{ id: string }>(
      `SELECT id FROM documents WHERE source_id = 'inbox' AND source_path LIKE 'page://%' LIMIT 1`)).rows[0]!.id;
    const origin = { atom_origin: { source_ref: doc, source_hash: "abcdabcdabcdabcd", source_id: "inbox", atom_key: "b".repeat(64) } };
    await putPage(db.storage, { slug: "atoms/edited", type: "atom", allowAdHocType: true, title: "Atom", markdown_body: "Distilled",
      source_id: "inbox", written_by: "extract-atoms", compiled_truth: origin });
    await putPage(db.storage, { slug: "atoms/edited", type: "atom", allowAdHocType: true, title: "Atom", markdown_body: "Distilled, plus my own notes",
      source_id: "inbox", written_by: "mcp", compiled_truth: origin });
    await putPage(db.storage, { slug: "notes/claims-origin", markdown_body: "mine", source_id: "inbox", compiled_truth: origin });

    const result = await hardDeleteConnectorPage(db.storage, scope, { slug: page.slug, reason: "disconnect" });
    expect(result.counts.atom_pages).toBe(0);
    expect(result.counts.atom_pages_kept).toBe(2);
    expect((await e.query("SELECT slug FROM pages WHERE slug IN ('atoms/edited', 'notes/claims-origin') ORDER BY slug")).rows)
      .toEqual([{ slug: "atoms/edited" }, { slug: "notes/claims-origin" }]);
  });

  // Only Postgres runs the two transactions side by side.
  if (name === "Postgres") it("keeps an atom page someone edited while the delete waited for its lock", async () => {
    const e = db.storage.engine();
    const page = await ingest(mailPage("t4", "plainwords"));
    const doc = (await e.query<{ id: string }>(
      `SELECT id FROM documents WHERE source_id = 'inbox' AND source_path LIKE 'page://%' LIMIT 1`)).rows[0]!.id;
    await putPage(db.storage, { slug: "atoms/raced", type: "atom", allowAdHocType: true, title: "Atom", markdown_body: "Distilled",
      source_id: "inbox", written_by: "extract-atoms",
      compiled_truth: { atom_origin: { source_ref: doc, source_hash: "abcdabcdabcdabcd", source_id: "inbox", atom_key: "d".repeat(64) } } });
    let settled!: Promise<Awaited<ReturnType<typeof hardDeleteConnectorPage>>>;
    await e.transaction(async (tx) => {
      // A writer holds the atom page's lock while its edit commits.
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["memrain:page:atoms/raced"]);
      settled = hardDeleteConnectorPage(db.storage, scope, { slug: page.slug, reason: "disconnect" });
      await Bun.sleep(500);
      await tx.query(
        `INSERT INTO page_versions (slug, version_n, hash_prev, hash_new, body_snapshot, compiled_truth_snapshot, written_by, source_id, written_by_principal)
         SELECT p.slug, (SELECT max(v.version_n) + 1 FROM page_versions v WHERE v.slug = p.slug), p.content_hash, p.content_hash,
                p.markdown_body, p.compiled_truth, 'mcp', p.source_id, 'member:alice'
           FROM pages p WHERE p.slug = 'atoms/raced'`);
    });
    const r = await settled;
    expect(r.deleted).toBe(true);
    expect(r.counts.atom_pages).toBe(0);
    expect(r.counts.atom_pages_kept).toBe(1);
    expect((await e.query("SELECT 1 FROM pages WHERE slug = 'atoms/raced'")).rows).toHaveLength(1);
  });

  it("refuses a page that is not this account's connector page", async () => {
    const e = db.storage.engine();
    await putPage(db.storage, { slug: "mail/handwritten", markdown_body: "my own note", source_id: "inbox" });
    const other = await ingest(mailPage("t9", "othercanary", OTHER));
    for (const slug of ["mail/handwritten", other.slug, "people/bob-stone"]) {
      const r = await hardDeleteConnectorPage(db.storage, scope, { slug, reason: "disconnect" });
      expect(r.deleted).toBe(false);
      expect(await softDeleteUpstreamPage(db.storage, scope, { slug })).toEqual({ deleted: false, refused: "not_connector_page", pages: 0 });
    }
    expect((await e.query("SELECT slug FROM pages WHERE slug IN ('mail/handwritten', $1, 'people/bob-stone') AND deleted_at IS NULL", [other.slug])).rows).toHaveLength(3);
    expect((await e.query("SELECT 1 FROM ingest_log WHERE source_type = 'connector-delete'")).rows).toHaveLength(0);
  });

  it("refuses a page whose content changed after the plan that named it", async () => {
    const page = await ingest(mailPage("t5", "pinnedcanary"));
    const r = await hardDeleteConnectorPage(db.storage, scope, { slug: page.slug, reason: "disconnect", expectedContentHash: "0".repeat(64) });
    expect(r).toMatchObject({ deleted: false, refused: "changed" });
    expect((await db.storage.engine().query("SELECT 1 FROM pages WHERE slug = $1", [page.slug])).rows).toHaveLength(1);
  });

  it("refuses a source that is not a connector source", async () => {
    await expect(hardDeleteConnectorPage(db.storage, { sourceId: "notes", accountRef: scope.accountRef }, { slug: "people/bob-stone", reason: "disconnect" }))
      .rejects.toThrow("connector");
    await expect(softDeleteUpstreamPage(db.storage, { sourceId: "notes", accountRef: scope.accountRef }, { slug: "people/bob-stone" }))
      .rejects.toThrow("connector");
  });

  it("holds a run that wants to delete more than the guard allows, and deletes when the owner confirms", async () => {
    expect(massDeleteVerdict(201, 100_000).held).toBe(true);
    expect(massDeleteVerdict(60, 1000).held).toBe(true);
    expect(massDeleteVerdict(3, 10).held).toBe(false);
    expect(massDeleteVerdict(40, 1000).held).toBe(false);

    const pages = [];
    for (let i = 0; i < 12; i++) pages.push(await ingest(mailPage(`t${i}`, `bulk${i}canary`)));
    const env = { MEMRAIN_CONNECTOR_MASS_DELETE_PCT: "5", MEMRAIN_CONNECTOR_MASS_DELETE_MIN: "2" };
    const held = await applyProviderDeletions(db.storage, scope, pages.slice(0, 4).map(p => p.slug), { env });
    expect(held.held).toBe(true);
    expect(held.deleted).toEqual([]);
    expect((await db.storage.engine().query<{ n: number }>("SELECT count(*)::int AS n FROM pages WHERE source_id = 'inbox'")).rows[0]!.n).toBe(12);

    const done = await applyProviderDeletions(db.storage, scope, pages.slice(0, 4).map(p => p.slug), { env, confirmed: true });
    expect(done.held).toBe(false);
    expect(done.deleted).toHaveLength(4);
    expect((await db.storage.engine().query<{ n: number }>("SELECT count(*)::int AS n FROM pages WHERE source_id = 'inbox' AND deleted_at IS NULL")).rows[0]!.n).toBe(8);
  });

  it("ages pages out of the retention window and keeps the rest", async () => {
    expect(retentionDays("mail", undefined, {})).toBe(180);
    expect(retentionDays("chat", undefined, {})).toBe(180);
    expect(retentionDays("calendar", undefined, {})).toBe(365);
    expect(retentionDays("meeting", undefined, {})).toBe(365);
    expect(retentionDays("mail", undefined, { MEMRAIN_CONNECTOR_RETENTION_DAYS_MAIL: "30" })).toBe(30);
    expect(retentionDays("mail", undefined, { MEMRAIN_CONNECTOR_RETENTION_DAYS_MAIL: "off" })).toBeNull();
    expect(retentionDays("mail", 7, { MEMRAIN_CONNECTOR_RETENTION_DAYS_MAIL: "30" })).toBe(7);
    expect(() => retentionDays("mail", undefined, { MEMRAIN_CONNECTOR_RETENTION_DAYS_MAIL: "soon" })).toThrow();
    // A window under 30 days from the environment reads as a typo (1 for 180) and is refused, not applied.
    for (const v of ["1", "18", "29"]) expect(() => retentionDays("mail", undefined, { MEMRAIN_CONNECTOR_RETENTION_DAYS_MAIL: v })).toThrow();

    const old = await ingest(mailPage("old", "oldcanary", OWNER, "2026-01-01T00:00:00.000Z"));
    const fresh = await ingest(mailPage("new", "freshcanary", OWNER, "2026-11-01T00:00:00.000Z"));
    const now = () => Date.parse("2026-11-14T00:00:00.000Z");
    const result = await sweepRetention(db.storage, scope, { accountId: NO_ACCOUNT, kinds: ["mail"], env: {}, now });
    expect(result.deleted).toEqual([old.slug]);
    expect((await db.storage.engine().query("SELECT slug FROM pages WHERE source_id = 'inbox'")).rows).toEqual([{ slug: fresh.slug }]);
    expect(await rowsContaining(db.storage.engine(), "oldcanary")).toEqual([]);
  });

  /** A connected account whose items map to `pages`, as the sync engine leaves them. */
  const trackedAccount = async (pages: readonly RenderedConnectorPage[]) => {
    const e = db.storage.engine();
    const account = await createAccount(e, { sourceId: "inbox", provider: "gmail", services: ["gmail"], principalRef: "admin:operator", accountLabel: OWNER });
    for (const p of pages) {
      await e.query(`INSERT INTO connector_items (account_id, external_id, page_slug) VALUES ($1, $2, $3)`, [account.id, String(p.truth.external_id), p.slug]);
    }
    return account;
  };
  const inboxPages = async () => (await db.storage.engine().query<{ n: number }>("SELECT count(*)::int AS n FROM pages WHERE source_id = 'inbox'")).rows[0]!.n;
  const openNotices = async (accountId: string) => (await db.storage.engine().query<{ kind: string }>(
    "SELECT kind FROM connector_notices WHERE account_id = $1 AND resolved_at IS NULL", [accountId])).rows.map(r => r.kind);
  const aged = async (n: number) => {
    const pages: RenderedConnectorPage[] = [];
    for (let i = 0; i < n; i++) pages.push(await ingest(mailPage(`aged${i}`, `agedcanary${i}`, OWNER, "2025-01-01T08:00:00.000Z")));
    return pages;
  };
  const NOW = () => Date.parse("2026-11-14T00:00:00.000Z");

  it("holds a retention sweep past the mass-delete guard, deleting nothing, until the owner confirms", async () => {
    const e = db.storage.engine();
    const pages = await aged(12);
    const account = await trackedAccount(pages);
    const sweep = () => sweepRetention(db.storage, scope, { accountId: account.id, kinds: ["mail"], env: {}, now: NOW });

    // Twelve of twelve pages is past the 5% rule with its floor of 10.
    const held = await sweep();
    expect(held.deleted).toEqual([]);
    expect(held.held).toBe(12);
    expect(await inboxPages()).toBe(12);
    expect(await openNotices(account.id)).toEqual(["mass_delete_held"]);
    expect((await currentProblems(e)).map(p => p.kind)).toContain("deletions_held");
    // The next run holds the same pages again; it deletes nothing either.
    expect((await sweep()).deleted).toEqual([]);
    expect(await inboxPages()).toBe(12);

    expect(await confirmHeldDeletes(e, account.id)).toBe(12);
    const done = await sweep();
    expect(done.deleted).toHaveLength(12);
    expect(await inboxPages()).toBe(0);
    const reasons = (await e.query<{ summary: string }>("SELECT summary FROM ingest_log WHERE source_type = 'connector-delete'")).rows
      .map(r => (JSON.parse(r.summary) as { reason: string }).reason);
    expect(reasons).toEqual(Array(12).fill("retention"));
    expect(await openNotices(account.id)).toEqual([]);
  });

  it("holds pages no sync record maps to past the guard for the owner, and deletes them once confirmed", async () => {
    const e = db.storage.engine();
    await aged(12);
    const account = await trackedAccount([]);
    const sweep = () => sweepRetention(db.storage, scope, { accountId: account.id, kinds: ["mail"], env: {}, now: NOW });
    const r = await sweep();
    expect(r.deleted).toEqual([]);
    expect(r.held).toBe(12);
    expect(await inboxPages()).toBe(12);
    expect(await openNotices(account.id)).toEqual(["mass_delete_held"]);
    expect((await currentProblems(e)).map(p => p.kind)).toContain("deletions_held");
    expect((await sweep()).held).toBe(12);

    expect(await confirmHeldDeletes(e, account.id)).toBe(12);
    expect((await sweep()).deleted).toHaveLength(12);
    expect(await inboxPages()).toBe(0);
    expect(await openNotices(account.id)).toEqual([]);
    // Nothing of the hold outlives the pages it held.
    await sweep();
    expect((await e.query("SELECT 1 FROM connector_items WHERE account_id = $1", [account.id])).rows).toHaveLength(0);
  });

  it("keeps pages no sync record maps to when the owner says so, without asking again", async () => {
    const e = db.storage.engine();
    await aged(12);
    const account = await trackedAccount([]);
    const sweep = () => sweepRetention(db.storage, scope, { accountId: account.id, kinds: ["mail"], env: {}, now: NOW });
    expect((await sweep()).held).toBe(12);
    expect(await rejectHeldDeletes(e, account.id)).toBe(12);
    const again = await sweep();
    expect(again).toMatchObject({ deleted: [], held: 0 });
    expect(await inboxPages()).toBe(12);
    expect(await openNotices(account.id)).toEqual([]);
  });

  it("ages out pages no sync record maps to in a run under the guard", async () => {
    const pages = await aged(2);
    const account = await trackedAccount([]);
    const r = await sweepRetention(db.storage, scope, { accountId: account.id, kinds: ["mail"], env: {}, now: NOW });
    expect(r.deleted.sort()).toEqual(pages.map(p => p.slug).sort());
    expect(await inboxPages()).toBe(0);
  });

  it("keeps held retention pages the owner chose to keep, without asking again", async () => {
    const e = db.storage.engine();
    const pages = await aged(12);
    const account = await trackedAccount(pages);
    const sweep = () => sweepRetention(db.storage, scope, { accountId: account.id, kinds: ["mail"], env: {}, now: NOW });

    expect((await sweep()).held).toBe(12);
    expect(await rejectHeldDeletes(e, account.id)).toBe(12);
    const again = await sweep();
    expect(again.deleted).toEqual([]);
    expect(again.held).toBe(0);
    expect(await inboxPages()).toBe(12);
    expect(await openNotices(account.id)).toEqual([]);
  });

  it("keeps pages already waiting for the owner held when the limit is raised", async () => {
    const pages = await aged(3);
    const account = await trackedAccount(pages);
    const env = { MEMRAIN_CONNECTOR_MASS_DELETE_ITEMS: "2" };
    const held = await sweepRetention(db.storage, scope, { accountId: account.id, kinds: ["mail", "calendar"], env, now: NOW });
    expect(held.deleted).toEqual([]);
    expect(held.held).toBe(3);
    const under = await sweepRetention(db.storage, scope, { accountId: account.id, kinds: ["mail"], env: { MEMRAIN_CONNECTOR_MASS_DELETE_ITEMS: "3" }, now: NOW });
    // Pages already waiting for the owner stay held; a raised limit does not release them.
    expect(under.deleted).toEqual([]);
    expect(await inboxPages()).toBe(3);
  });

  /** A hand edit as page_edit leaves it: the body changes, the connector's truth stays. */
  const editByHand = async (page: RenderedConnectorPage, note: string, writer: { written_by: string; written_by_principal?: string }) => {
    const current = (await db.storage.engine().query<{ markdown_body: string; compiled_truth: Record<string, unknown> }>(
      "SELECT markdown_body, compiled_truth FROM pages WHERE slug = $1", [page.slug])).rows[0]!;
    await putPage(db.storage, { slug: page.slug, type: page.type, allowAdHocType: true, title: page.title,
      markdown_body: `${current.markdown_body}\n${note}\n`, compiled_truth: current.compiled_truth, source_id: "inbox", ...writer });
  };
  const truthOf = async (slug: string) => (await db.storage.engine().query<{ compiled_truth: Record<string, unknown>; markdown_body: string }>(
    "SELECT compiled_truth, markdown_body FROM pages WHERE slug = $1", [slug])).rows[0];

  it("detaches a connector page edited by hand instead of aging it out, keeping the edit", async () => {
    const e = db.storage.engine();
    const page = await ingest(mailPage("hand1", "handcanary", OWNER, "2025-01-01T08:00:00.000Z"));
    await editByHand(page, "My own follow-up note.", { written_by: "mcp", written_by_principal: "member:alice" });
    const sweep = () => sweepRetention(db.storage, scope, { accountId: NO_ACCOUNT, kinds: ["mail"], env: {}, now: NOW });

    const r = await sweep();
    expect(r.deleted).toEqual([]);
    expect(r.detached).toEqual([page.slug]);
    const kept = await truthOf(page.slug);
    expect(kept?.markdown_body).toContain("My own follow-up note.");
    expect(kept?.markdown_body).toContain("handcanary");
    // No longer the connector's: no expiry, and neither a sweep nor an upstream deletion reaches it.
    expect(kept?.compiled_truth.origin).not.toBe("connector");
    expect(kept?.compiled_truth.last_activity_at).toBeUndefined();
    expect(kept?.compiled_truth.trust).toBe("untrusted");
    expect((await sweep()).detached).toEqual([]);
    expect((await softDeleteUpstreamPage(db.storage, scope, { slug: page.slug })).refused).toBe("not_connector_page");
    expect(await truthOf(page.slug)).toBeDefined();
    expect((await e.query("SELECT 1 FROM ingest_log WHERE source_type = 'connector-delete'")).rows).toHaveLength(0);
    // The detach is on record without text, and in the page's history.
    const receipt = (await e.query<{ summary: string }>("SELECT summary FROM ingest_log WHERE source_type = 'connector-detach'")).rows;
    expect(receipt).toHaveLength(1);
    expect(receipt[0]!.summary).not.toContain(page.slug);
    expect(receipt[0]!.summary).not.toContain("handcanary");
    const versions = (await e.query<{ written_by: string | null }>("SELECT written_by FROM page_versions WHERE slug = $1 ORDER BY version_n", [page.slug])).rows;
    expect(versions.map(v => v.written_by)).toEqual(["connector-gmail", "mcp", "retention-detach"]);
  });

  const live = async (slugs: readonly string[]) => (await db.storage.engine().query<{ slug: string; deleted: boolean }>(
    "SELECT slug, deleted_at IS NOT NULL AS deleted FROM pages WHERE slug = ANY($1::text[]) ORDER BY slug", [[...slugs]])).rows;

  it("soft-deletes an item deleted at the provider with its parts, whatever a person wrote on it, until the purge", async () => {
    const e = db.storage.engine();
    const canary = "softcanary6612";
    const page = await ingest(mailPage("s1", canary));
    const part = await ingest({ ...page, slug: `${page.slug}/part-001`, body: `Tail ${canary}.\n`, truth: { ...page.truth, part_of: page.slug, part: 1 } });
    await editByHand(page, "My own note.", { written_by: "mcp", written_by_principal: "member:alice" });
    const fenced = await addFact(db.storage, { entity_slug: "people/bob-stone", fact: `Fenced ${canary}`, source_slug: page.slug, source_id: "inbox" });
    await e.query("UPDATE entity_facts SET source_markdown_slug = $1 WHERE id = $2", [page.slug, fenced.id]);
    const named = await addFact(db.storage, { entity_slug: "people/bob-stone", fact: `Named ${canary}`, source_slug: page.slug, source_id: "inbox" });
    const versions = async (slug: string) => (await e.query<{ written_by: string | null; deleted: boolean }>(
      "SELECT written_by, compiled_truth_snapshot ? 'deleted_at' AS deleted FROM page_versions WHERE slug = $1 ORDER BY version_n", [slug])).rows;
    const before = await versions(page.slug);

    const r = await softDeleteUpstreamPage(db.storage, scope, { slug: page.slug, externalId: "s1" });
    expect(r).toEqual({ deleted: true, pages: 2 });
    // The rows and their history stay, each with a tombstone version.
    expect(await live([page.slug, part.slug])).toEqual([{ slug: page.slug, deleted: true }, { slug: part.slug, deleted: true }]);
    expect(await versions(page.slug)).toEqual([...before, { written_by: "connector-delete", deleted: true }]);
    expect((await versions(part.slug)).at(-1)).toEqual({ written_by: "connector-delete", deleted: true });
    // Hidden while deleted, as page_delete leaves a page: out of search, its fence facts gone.
    expect((await e.query("SELECT 1 FROM documents WHERE source_id = 'inbox'")).rows).toHaveLength(0);
    expect((await e.query("SELECT 1 FROM entity_facts WHERE id = $1", [fenced.id])).rows).toHaveLength(0);
    const receipts = (await e.query<{ source_ref: string; summary: string }>(
      "SELECT source_ref, summary FROM ingest_log WHERE source_type = 'connector-delete'")).rows;
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.source_ref).toContain("provider_deleted");
    for (const needle of [canary, OWNER, page.slug, "s1\""]) expect(JSON.stringify(receipts[0])).not.toContain(needle);
    // A second report of the same deletion changes nothing.
    expect(await softDeleteUpstreamPage(db.storage, scope, { slug: page.slug })).toEqual({ deleted: true, pages: 0 });

    // Recoverable until the purge.
    expect((await restorePage(db.storage, page.slug)).restored).toBe(true);
    expect(await live([page.slug])).toEqual([{ slug: page.slug, deleted: false }]);
    await softDeleteUpstreamPage(db.storage, scope, { slug: page.slug });
    const purged = await purgeDeletedPages(e, 0);
    expect(purged.slugs.sort()).toEqual([page.slug, part.slug].sort());
    expect(await live([page.slug, part.slug])).toEqual([]);
    expect((await e.query<{ retired: boolean }>("SELECT forgotten_at IS NOT NULL AS retired FROM entity_facts WHERE id = $1", [named.id])).rows)
      .toEqual([{ retired: true }]);
  });

  it("takes what synthesis distilled from an item deleted upstream with it, soft-deleting the pages it published", async () => {
    const e = db.storage.engine();
    const canary = "softatomcanary2208";
    const page = await ingest(mailPage("s4", "plainwords"));
    const doc = (await e.query<{ id: string }>(
      `SELECT id FROM documents WHERE source_id = 'inbox' AND source_path LIKE 'page://%' LIMIT 1`)).rows[0]!.id;
    await e.query(`INSERT INTO synth_atoms (atom_key, source_ref, source_kind, source_hash, title, body, model_id)
       VALUES ($1, $2, 'document', 'abcdabcdabcdabcd', $3, $3, 'test-model')`, ["e".repeat(64), doc, `Atom about ${canary}`]);
    await e.query(`INSERT INTO synth_concepts (concept_slug, title, narrative, model_id) VALUES ('Pricing', 'Pricing', $1, 'test-model')`, [`Narrative ${canary}`]);
    await e.query(`INSERT INTO synth_concept_atoms (concept_slug, atom_id) SELECT 'Pricing', id FROM synth_atoms WHERE atom_key = $1`, ["e".repeat(64)]);
    await putPage(db.storage, { slug: "concepts/pricing", type: "concept", allowAdHocType: true, title: "Pricing",
      markdown_body: `Narrative ${canary}`, written_by: "synthesize-concepts", written_by_principal: "operator" });
    await putPage(db.storage, { slug: "atoms/soft-derived", type: "atom", allowAdHocType: true, title: "Atom",
      markdown_body: `Distilled ${canary}`, source_id: "inbox", written_by: "extract-atoms",
      compiled_truth: { atom_origin: { source_ref: doc, source_hash: "abcdabcdabcdabcd", source_id: "inbox", atom_key: "e".repeat(64) } } });
    await e.query(`INSERT INTO synth_takes (take_key, source_ref, source_hash, prompt_version, claim_text, model_id)
       VALUES ($1, $2, 'abcdabcdabcdabcd', 'v1', $3, 'test-model')`, ["u".repeat(64), doc, `Take on ${canary}`]);
    const fact = await addFact(db.storage, { entity_slug: "people/bob-stone", fact: `Fact ${canary}`, source_slug: page.slug, source_id: "inbox" });
    await e.query(`INSERT INTO synth_contradictions (pair_key, a_ref, a_kind, a_text, b_ref, b_kind, b_text, prompt_version, model_id)
       VALUES ('pair-2', $1, 'fact', $2, 'people/bob-stone', 'page', 'Other side', 'v1', 'test-model')`, [String(fact.id), `Fact ${canary}`]);

    expect((await softDeleteUpstreamPage(db.storage, scope, { slug: page.slug })).deleted).toBe(true);
    for (const table of ["synth_atoms", "synth_concepts", "synth_takes", "synth_contradictions"]) {
      expect((await e.query(`SELECT 1 FROM ${table} t WHERE to_jsonb(t)::text LIKE $1`, [`%${canary}%`])).rows).toHaveLength(0);
    }
    // The pages synthesis published from it go the same recoverable way.
    expect(await live(["atoms/soft-derived", "concepts/pricing"])).toEqual([
      { slug: "atoms/soft-derived", deleted: true }, { slug: "concepts/pricing", deleted: true }]);
    // After the purge only the retired fact still holds the text.
    await purgeDeletedPages(e, 0);
    expect(await rowsContaining(e, canary)).toEqual(["entity_facts"]);
  });

  it("takes the chronicle rows and chunk facts drawn from an item deleted upstream with its documents", async () => {
    const e = db.storage.engine();
    const canary = "softchroniclecanary3317";
    const page = await ingest(mailPage("s5", "plainwords"));
    const chunk = (await e.query<{ id: string }>(
      `SELECT c.id FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.source_id = 'inbox' LIMIT 1`)).rows[0]!.id;
    await addTimelineEvent(db.storage, { slug: page.slug, occurred_at: "2026-11-01", event: `Meeting: ${canary}`, source_label: "connector:gmail", source_chunk_id: "connector-event-key", source_id: "inbox" });
    await addTimelineEvent(db.storage, { slug: "people/bob-stone", occurred_at: "2026-11-01", event: `Talked about ${canary}`, source_chunk_id: chunk });
    const drawn = await addFact(db.storage, { entity_slug: "people/bob-stone", fact: `Bob plans ${canary}`, source_chunk_id: chunk });
    const named = await addFact(db.storage, { entity_slug: "people/bob-stone", fact: `Named ${canary}`, source_slug: page.slug, source_id: "inbox" });

    await softDeleteUpstreamPage(db.storage, scope, { slug: page.slug });
    expect((await e.query("SELECT 1 FROM timeline_events WHERE event LIKE $1", [`%${canary}%`])).rows).toHaveLength(0);
    expect((await e.query("SELECT 1 FROM entity_facts WHERE id = $1", [drawn.id])).rows).toHaveLength(0);
    // A fact written on the page stays, hidden while it is deleted, for the purge to retire.
    expect((await e.query<{ live: boolean }>("SELECT forgotten_at IS NULL AS live FROM entity_facts WHERE id = $1", [named.id])).rows)
      .toEqual([{ live: true }]);
  });

  it("leaves a page soft-deleted upstream to the purge: retention does not take it", async () => {
    const page = await ingest(mailPage("s2", "waitcanary", OWNER, "2025-01-01T08:00:00.000Z"));
    await softDeleteUpstreamPage(db.storage, scope, { slug: page.slug });
    const r = await sweepRetention(db.storage, scope, { accountId: NO_ACCOUNT, kinds: ["mail"], env: {}, now: NOW });
    expect(r.deleted).toEqual([]);
    expect(await live([page.slug])).toEqual([{ slug: page.slug, deleted: true }]);
  });

  it("soft-deletes the parts a shrunk item no longer has, whatever a person wrote on them", async () => {
    const e = db.storage.engine();
    const page = await ingest(mailPage("s3", "shrinkcanary"));
    const parts = [];
    for (const n of [1, 2]) {
      parts.push(await ingest({ ...page, slug: `${page.slug}/part-00${n}`, body: `Part ${n}.\n`, truth: { ...page.truth, part_of: page.slug, part: n } }));
    }
    await editByHand(parts[1]!, "Annotated.", { written_by: "mcp", written_by_principal: "member:alice" });
    const r = await deleteStaleParts(db.storage, scope, page.slug, [parts[0]!.slug]);
    expect(r.parts).toBe(1);
    expect(await live(parts.map(p => p.slug))).toEqual([{ slug: parts[0]!.slug, deleted: false }, { slug: parts[1]!.slug, deleted: true }]);
    // Already gone: a later write of the item finds nothing stale.
    expect((await deleteStaleParts(db.storage, scope, page.slug, [parts[0]!.slug])).parts).toBe(0);
    expect((await e.query("SELECT 1 FROM ingest_log WHERE source_type = 'connector-delete'")).rows).toHaveLength(1);
  });

  it("ages out a page only the brain's own writers touched since the connector", async () => {
    const page = await ingest(mailPage("auto1", "automatedcanary", OWNER, "2025-01-01T08:00:00.000Z"));
    // A redaction rewrite and an enrichment pass carry no credential; a
    // generator stamped with the operator principal is still the brain itself.
    await editByHand(page, "[redacted]", { written_by: "secrets-audit" });
    await editByHand(page, "Enriched summary.", { written_by: "enrichment" });
    await editByHand(page, "Distilled.", { written_by: "extract-atoms", written_by_principal: "operator" });
    const r = await sweepRetention(db.storage, scope, { accountId: NO_ACCOUNT, kinds: ["mail"], env: {}, now: NOW });
    expect(r.detached).toEqual([]);
    expect(r.deleted).toEqual([page.slug]);
  });

  it("ages out a page whose hand edit the connector has since written over", async () => {
    const page = await ingest(mailPage("hand2", "overwrittencanary", OWNER, "2025-01-01T08:00:00.000Z"));
    await editByHand(page, "An older note.", { written_by: "mcp", written_by_principal: "member:alice" });
    await ingest({ ...page, body: `${page.body}\nNew upstream reply.\n` });
    const r = await sweepRetention(db.storage, scope, { accountId: NO_ACCOUNT, kinds: ["mail"], env: {}, now: NOW });
    expect(r.deleted).toEqual([page.slug]);
    expect(r.detached).toEqual([]);
  });

  it("detaches the whole item when a person edited only one of its parts, whatever writer name they used", async () => {
    const page = await ingest(mailPage("hand3", "parentcanary", OWNER, "2025-01-01T08:00:00.000Z"));
    const part = await ingest({ ...page, slug: `${page.slug}/part-001`, body: "Tail of the thread.\n", truth: { ...page.truth, part_of: page.slug, part: 1 } });
    // A connector writer name from an authenticated caller is still a person's edit.
    await editByHand(part, "Annotated tail.", { written_by: "connector-gmail", written_by_principal: "agent:helper" });
    const r = await sweepRetention(db.storage, scope, { accountId: NO_ACCOUNT, kinds: ["mail"], env: {}, now: NOW });
    expect(r.deleted).toEqual([]);
    expect(r.detached).toEqual([page.slug]);
    expect((await truthOf(part.slug))?.markdown_body).toContain("Annotated tail.");
    expect((await truthOf(part.slug))?.compiled_truth.origin).not.toBe("connector");
    expect((await truthOf(page.slug))?.compiled_truth.origin).not.toBe("connector");
  });

  it("previews disconnect deletion, refuses a stale preview, and leaves other accounts alone", async () => {
    const mine = [await ingest(mailPage("a", "minecanary1")), await ingest(mailPage("b", "minecanary2"))];
    const theirs = await ingest(mailPage("c", "theircanary", OTHER));
    const preview = await previewConnectorData(db.storage, scope);
    expect(preview.pages).toBe(2);
    expect(preview.chunks).toBeGreaterThan(0);
    expect(JSON.stringify(preview)).not.toContain("minecanary");

    await ingest(mailPage("d", "latecanary"));
    await expect(deleteAllConnectorData(db.storage, scope, { expectedPlanHash: preview.plan_hash })).rejects.toThrow("changed");

    const again = await previewConnectorData(db.storage, scope);
    const result = await deleteAllConnectorData(db.storage, scope, { expectedPlanHash: again.plan_hash });
    expect(result.deleted).toHaveLength(3);
    const left = (await db.storage.engine().query<{ slug: string }>("SELECT slug FROM pages WHERE source_id = 'inbox'")).rows;
    expect(left).toEqual([{ slug: theirs.slug }]);
    for (const p of mine) expect((await db.storage.engine().query("SELECT 1 FROM pages WHERE slug = $1", [p.slug])).rows).toHaveLength(0);
  });
});
