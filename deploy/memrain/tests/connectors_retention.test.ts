/**
 * Connector deletion, retention and disconnect. An item deleted at the
 * provider leaves no text, vector or fact behind; a run that wants to delete
 * too much is held; retention windows age pages out; disconnect previews and
 * then deletes exactly what it previewed. Nothing outside the account's own
 * connector pages is ever touched.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { putPage } from "../src/core/pages.ts";
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
  hardDeleteConnectorPage,
  massDeleteVerdict,
  previewConnectorData,
  retentionDays,
  sweepRetention,
} from "../src/core/connectors/retention.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import { deterministicEmbed } from "./det-embed.ts";

const OWNER = "owner@example.org";
const OTHER = "second@example.org";
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

  it("leaves no text, vector, fact, event or link behind when the provider deletes an item", async () => {
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

    const result = await hardDeleteConnectorPage(db.storage, scope, { slug: page.slug, reason: "provider_deleted", externalId: "t1" });
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
    expect(receipts[0]!.source_ref).toContain("provider_deleted");
    const receiptText = JSON.stringify(receipts[0]);
    expect(receiptText).not.toContain(canary);
    expect(receiptText).not.toContain(OWNER);
    expect(receiptText).not.toContain(page.slug);
    expect(receiptText).not.toContain("t1\"");
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

    const result = await hardDeleteConnectorPage(db.storage, scope, { slug: page.slug, reason: "provider_deleted" });
    expect(result.counts.atoms).toBe(1);
    expect(result.counts.atom_pages).toBe(1);
    expect(result.counts.takes).toBe(1);
    expect(result.counts.contradictions).toBe(1);
    expect(await rowsContaining(e, canary)).toEqual([]);
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

    const result = await hardDeleteConnectorPage(db.storage, scope, { slug: page.slug, reason: "provider_deleted" });
    expect(result.counts.atom_pages).toBe(0);
    expect(result.counts.atom_pages_kept).toBe(2);
    expect((await e.query("SELECT slug FROM pages WHERE slug IN ('atoms/edited', 'notes/claims-origin') ORDER BY slug")).rows)
      .toEqual([{ slug: "atoms/edited" }, { slug: "notes/claims-origin" }]);
  });

  it("refuses a page that is not this account's connector page", async () => {
    const e = db.storage.engine();
    await putPage(db.storage, { slug: "mail/handwritten", markdown_body: "my own note", source_id: "inbox" });
    const other = await ingest(mailPage("t9", "othercanary", OTHER));
    for (const slug of ["mail/handwritten", other.slug, "people/bob-stone"]) {
      const r = await hardDeleteConnectorPage(db.storage, scope, { slug, reason: "provider_deleted" });
      expect(r.deleted).toBe(false);
    }
    expect((await e.query("SELECT slug FROM pages WHERE slug IN ('mail/handwritten', $1, 'people/bob-stone')", [other.slug])).rows).toHaveLength(3);
    expect((await e.query("SELECT 1 FROM ingest_log WHERE source_type = 'connector-delete'")).rows).toHaveLength(0);
  });

  it("refuses a source that is not a connector source", async () => {
    await expect(hardDeleteConnectorPage(db.storage, { sourceId: "notes", accountRef: scope.accountRef }, { slug: "people/bob-stone", reason: "provider_deleted" }))
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
    expect((await db.storage.engine().query<{ n: number }>("SELECT count(*)::int AS n FROM pages WHERE source_id = 'inbox'")).rows[0]!.n).toBe(8);
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

    const old = await ingest(mailPage("old", "oldcanary", OWNER, "2026-01-01T00:00:00.000Z"));
    const fresh = await ingest(mailPage("new", "freshcanary", OWNER, "2026-11-01T00:00:00.000Z"));
    const now = () => Date.parse("2026-11-14T00:00:00.000Z");
    const result = await sweepRetention(db.storage, scope, { kind: "mail", env: {}, now });
    expect(result.deleted).toEqual([old.slug]);
    expect((await db.storage.engine().query("SELECT slug FROM pages WHERE source_id = 'inbox'")).rows).toEqual([{ slug: fresh.slug }]);
    expect(await rowsContaining(db.storage.engine(), "oldcanary")).toEqual([]);
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
