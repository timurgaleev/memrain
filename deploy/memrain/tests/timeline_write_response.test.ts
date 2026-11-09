import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { putPage } from "../src/core/pages.ts";
import { registerSource } from "../src/core/sources.ts";
import { addTimelineEvent } from "../src/core/timeline.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`timeline write response (${name})`, () => {
  let db: Awaited<ReturnType<typeof open>>;
  const authInfo = { token: "test", clientId: "test", scopes: ["read", "write"], sourceId: "default", allowedSources: ["default"], isPublic: false };
  beforeAll(async () => {
    db = await open();
    await registerSource(db.storage.engine(), { id: "timeline-other", kind: "vault", pathPrefix: "/timeline-other" });
    await putPage(db.storage, { slug: "people/event-owner" });
    await putPage(db.storage, { slug: "life/diary/event-owner", type: "diary" });
  });
  afterAll(async () => { await db.close(); });
  const write = async (args: Record<string, unknown>, opts = { authInfo }) => {
    const result = await dispatchTool(db.storage, { name: "add_timeline_event", arguments: { slug: "people/event-owner", occurred_at: "2026-04-05T02:00:00+02:00", ...args } }, opts);
    expect(result.isError).toBeFalsy();
    return JSON.parse(result.content[0]!.text);
  };

  it("returns the stored row and normalized timestamp with correction guidance", async () => {
    const result = await write({ event: "Joined the project" });
    expect(result.row).toMatchObject({ id: result.id, slug: result.slug, event: "Joined the project", occurred_at: "2026-04-05T00:00:00.000Z", detail: "", source_label: "", source_chunk_id: null });
    expect(Number.isNaN(Date.parse(result.row.written_at))).toBe(false);
    expect(result.correction_hint).toContain("new event");
  });

  it("returns original stored wording on both manual and chunk-key duplicates", async () => {
    const first = await write({ event: "Original wording", source_chunk_id: "response-chunk" });
    const retry = await write({ event: "Changed wording that is not saved", source_chunk_id: "response-chunk" });
    expect(retry).toMatchObject({ id: null, inserted: false, row: first.row });
    const manual = await write({ event: "Manual retry" });
    expect((await write({ event: "Manual retry" })).row).toEqual(manual.row);
  });

  it("does not echo a conflicting row owned by another source", async () => {
    const prior = await addTimelineEvent(db.storage, { slug: "people/event-owner", occurred_at: "2026-04-05", event: "Foreign legacy row", source_chunk_id: "foreign-chunk" });
    await db.storage.engine().query("UPDATE timeline_events SET source_id = 'timeline-other' WHERE id = $1", [prior.id]);
    const result = await write({ event: "Local request", source_chunk_id: "foreign-chunk" });
    expect(result).toMatchObject({ id: null, inserted: false, row: null });
    expect(JSON.stringify(result)).not.toContain("Foreign legacy row");
  });

  it("withholds diary rows and public bodies in the write echo", async () => {
    const diary = await write({ slug: "life/diary/event-owner", event: "Private diary event" });
    expect(diary.row).toBeNull();
    const result = await dispatchTool(db.storage, { name: "add_timeline_event", arguments: { slug: "people/event-owner", occurred_at: "2026-04-06", event: "Public body canary" } }, { authInfo, isPublic: true });
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).not.toContain("Public body canary");
  });

  it("scans pre-existing secret text returned by dedup", async () => {
    const first = await write({ event: "Safe original", source_chunk_id: "secret-chunk" });
    const token = `gh${"p"}_${"z".repeat(36)}`;
    await db.storage.engine().query("UPDATE timeline_events SET event = $1 WHERE id = $2", [`Old token ${token}`, first.id]);
    const result = await write({ event: "Safe retry", source_chunk_id: "secret-chunk" });
    expect(result.row.event).toContain("[REDACTED:");
    expect(JSON.stringify(result)).not.toContain(token);
  });
});
