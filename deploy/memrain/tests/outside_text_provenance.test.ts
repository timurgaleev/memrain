import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { getPage, putPage } from "../src/core/pages.ts";
import { carryForwardFences, OUTSIDE_NEUTRALIZED } from "../src/core/fence-carry.ts";
import { renderFactsFence } from "../src/core/facts-fence.ts";
import { upsertTakeRow } from "../src/core/synthesis/takes-fence.ts";
import { reconcileFactsForPage } from "../src/core/facts-reconcile.ts";
import { ingestSessions } from "../src/core/transcripts/ingest.ts";
import type { TranscriptSession } from "../src/core/transcripts/types.ts";

function session(id: string): TranscriptSession {
  return { format: "chatgpt", id, title: "Source", startedAt: 0,
    messages: [{ id: "m1", role: "user", speaker: "User", text: "Original source.", ts: 0 }] };
}
const fence = renderFactsFence([{ rowNum: 1, claim: "Keeps the original claim.", confidence: 1, active: true }]);
const withFence = (body: string) => `${body}\n## Facts\n\n${fence}\n`;

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`outside provenance (${name})`, () => {
  let db: Awaited<ReturnType<typeof open>>;
  beforeAll(async () => { db = await open(); });
  afterAll(async () => { await db.close(); });

  it("keeps established provenance through metadata-only replacement and the next import", async () => {
    const s = session("metadata-carry");
    const slug = "transcripts/chatgpt/metadata-carry-p1";
    await ingestSessions(db.storage, [s], { deferMirror: true });
    const initial = (await getPage(db.storage, slug))!;
    const body = withFence(initial.markdown_body);
    await putPage(db.storage, { slug, markdown_body: body, compiled_truth: initial.compiled_truth });
    await putPage(db.storage, { slug, compiled_truth: { operator_note: "Reviewed" } });
    expect((await getPage(db.storage, slug))!.compiled_truth[OUTSIDE_NEUTRALIZED]).toBe(1);
    await ingestSessions(db.storage, [s], { deferMirror: true });
    expect((await getPage(db.storage, slug))!.markdown_body).toBe(body);
  });

  it("cannot establish provenance through caller metadata or an importer writer name", async () => {
    const slug = "notes/planted-marker";
    await putPage(db.storage, { slug, markdown_body: withFence("Untrusted source."),
      compiled_truth: { [OUTSIDE_NEUTRALIZED]: 1 }, written_by: "transcripts-ingest", written_by_principal: "client:untrusted" });
    expect((await getPage(db.storage, slug))!.compiled_truth[OUTSIDE_NEUTRALIZED]).toBeUndefined();
  });

  it("drops old provenance when a changed full body brings hostile outside text", async () => {
    const s = session("changed-body");
    const slug = "transcripts/chatgpt/changed-body-p1";
    await ingestSessions(db.storage, [s], { deferMirror: true });
    const old = (await getPage(db.storage, slug))!;
    await putPage(db.storage, { slug, markdown_body: withFence("Replaced outside text."),
      compiled_truth: old.compiled_truth, written_by: "transcripts-ingest" });
    expect((await getPage(db.storage, slug))!.compiled_truth[OUTSIDE_NEUTRALIZED]).toBeUndefined();
  });

  it("holds an ambiguous import without altering body, versions or fact identities", async () => {
    const s = session("ambiguous-carry");
    const slug = "transcripts/chatgpt/ambiguous-carry-p1";
    const written = await putPage(db.storage, { slug, markdown_body: withFence("Legacy source."), compiled_truth: {} });
    await reconcileFactsForPage(db.storage, slug, written.content_hash, "default");
    const snapshot = async () => ({
      page: (await db.storage.engine().query("SELECT * FROM pages WHERE slug=$1", [slug])).rows,
      versions: (await db.storage.engine().query("SELECT * FROM page_versions WHERE slug=$1 ORDER BY version_n", [slug])).rows,
      facts: (await db.storage.engine().query("SELECT * FROM entity_facts WHERE source_markdown_slug=$1 ORDER BY id", [slug])).rows,
    });
    const before = await snapshot();
    const result = await ingestSessions(db.storage, [s], { deferMirror: true });
    expect(result.parts_written).toBe(0);
    expect(result.failed).toEqual([{ id: s.id, code: "conflict", reason: "Import held: unproven_fences" }]);
    expect(await snapshot()).toEqual(before);
  });

  it.each(["unbalanced", "foreign", "malformed"])("does not treat %s marker edits as proven brain fences", async (kind) => {
    const s = session(`unsafe-${kind}`);
    const slug = `transcripts/chatgpt/unsafe-${kind}-p1`;
    await ingestSessions(db.storage, [s], { deferMirror: true });
    const old = (await getPage(db.storage, slug))!;
    const invalid = kind === "unbalanced" ? fence.replace(/<!--- memrain:facts:end -->/, "")
      : kind === "foreign" ? fence.replaceAll("memrain:", "foreign:")
      : fence.replace("| 1 |", "not a table | 1 |");
    await putPage(db.storage, { slug, markdown_body: `${old.markdown_body}\n## Facts\n\n${invalid}\n`, compiled_truth: old.compiled_truth });
    expect((await getPage(db.storage, slug))!.compiled_truth[OUTSIDE_NEUTRALIZED]).toBeUndefined();
  });
});

describe("carried heading boundary", () => {
  it.each(["memrain", "memex"])("deduplicates an exact trailing heading for %s without changing CRLF fence bytes", (brand) => {
    const span = `## Facts\r\n\r\n${fence.replaceAll("memrain:", `${brand}:`).replaceAll("\n", "\r\n")}\r\n`;
    const old = { slug: "notes/x", markdown_body: `old\r\n\r\n${span}`, compiled_truth: { [OUTSIDE_NEUTRALIZED]: 1 } };
    expect(carryForwardFences(old, "fresh\r\n\r\n## Facts\r\n")).toBe(`fresh\r\n\r\n${span}`);
    expect(carryForwardFences(old, "fresh\r\n\r\n## Facts\r\n\r\n \t\r\n")).toBe(`fresh\r\n\r\n${span}`);
    expect(carryForwardFences(old, "fresh\n## Facts from source\n")).toBe(`fresh\n## Facts from source\n\n${span}`);
  });
  it("deduplicates only the exact Takes heading", () => {
    const { body } = upsertTakeRow("old\n", { claim: "Preserved take.", kind: "take", holder: "brain", weight: 0.5, active: true });
    const span = body.slice(body.indexOf("## Takes"));
    const old = { slug: "notes/t", markdown_body: body, compiled_truth: { [OUTSIDE_NEUTRALIZED]: 1 } };
    expect(carryForwardFences(old, "fresh\n\n## Takes\n")).toBe(`fresh\n\n${span}`);
    expect(carryForwardFences(old, "fresh\n## Takes from source\n")).toBe(`fresh\n## Takes from source\n\n${span}`);
  });
});
