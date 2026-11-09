import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { dispatchTool, type DispatchOptions } from "../src/mcp/dispatch.ts";
import { putPage } from "../src/core/pages.ts";
import { syncTakesFromFence } from "../src/core/synthesis/takes-canon.ts";

const body = ["Prose", "<!--- memrain:takes:begin -->", "| # | claim | kind | who | weight | since | source |",
  "|---|---|---|---|---|---|---|", "| 1 | First claim | fact | world | 1 | | |",
  "| 7 | Broken | unknown | world | bad | | |", "<!-- preserve -->", "<!--- memrain:takes:end -->"].join("\n");
const authInfo: NonNullable<DispatchOptions["authInfo"]> = { token: "fixture", isPublic: false, clientId: "take-editor", scopes: ["read", "write"], sourceId: "a", allowedSources: ["a"], takesHolders: ["world"], boundSlugPrefixes: ["notes"] };
for (const spec of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`takes MCP (${spec.name})`, () => {
  let db: Awaited<ReturnType<typeof spec.open>>;
  let oldMirror: string | undefined;
  beforeAll(async () => { db = await spec.open(); oldMirror = process.env.MEMRAIN_PAGE_MIRROR_SYNC; process.env.MEMRAIN_PAGE_MIRROR_SYNC = "0"; });
  afterAll(async () => { await db.close(); if (oldMirror === undefined) delete process.env.MEMRAIN_PAGE_MIRROR_SYNC; else process.env.MEMRAIN_PAGE_MIRROR_SYNC = oldMirror; });
  beforeEach(async () => {
    await db.storage.engine().exec("DELETE FROM synth_takes; DELETE FROM pages; DELETE FROM jobs; DELETE FROM documents; INSERT INTO sources(id,kind,path_prefix) VALUES('a','other','/a'),('b','other','/b') ON CONFLICT DO NOTHING");
    await putPage(db.storage, { slug: "notes/takes", source_id: "a", markdown_body: body, written_by_principal: "operator" });
    await syncTakesFromFence(db.storage.engine(), "notes/takes", body.replace("| unknown | world | bad |", "| fact | world | 0.5 |"));
  });
  const request = (name: string, args: Record<string, unknown>, options: DispatchOptions = { authInfo }) =>
    dispatchTool(db.storage, { name, arguments: args }, options);
  async function call(name: string, args: Record<string, unknown>, options?: DispatchOptions) {
    const result = await request(name, args, options);
    expect(result.isError, result.content[0]!.text).toBeFalsy();
    return JSON.parse(result.content[0]!.text);
  }
  const add = { slug: "notes/takes", expected_version: 1, claim: "Added <claim>", kind: "take", holder: "world" };
  const state = async () => ({
    pages: (await db.storage.engine().query<Record<string, unknown>>("SELECT * FROM pages ORDER BY slug")).rows,
    versions: (await db.storage.engine().query<Record<string, unknown>>("SELECT * FROM page_versions ORDER BY slug,version_n")).rows,
    takes: (await db.storage.engine().query<Record<string, unknown>>("SELECT * FROM synth_takes ORDER BY id")).rows,
    jobs: (await db.storage.engine().query<Record<string, unknown>>("SELECT * FROM jobs ORDER BY id")).rows,
  });
  it("previews without derived work then appends one version, one mirror job and only one take row", async () => {
    const before = await state();
    const preview = await call("takes_add", { ...add, dry_run: true, reason: "Verified claim" });
    expect(await state()).toEqual(before);
    const applied = await call("takes_add", { ...add, plan_hash: preview.plan_hash, reason: "Verified claim" });
    expect(applied).toMatchObject({ version_n: 2, row_num: 8, search_pending: true });
    const after = await state();
    expect(after.takes.slice(0, 2)).toEqual(before.takes);
    expect(after.takes).toHaveLength(3);
    expect(after.versions).toHaveLength(2);
    expect(after.versions[1]).toMatchObject({ written_by_principal: "client:take-editor", change_reason: "Verified claim" });
    expect(after.jobs).toHaveLength(1);
    expect(after.pages[0]?.markdown_body).toContain("<!-- preserve -->");
    const stale = await request("takes_add", add);
    expect(stale.isError).toBe(true);
    expect(await state()).toEqual(after);
  });
  it("resolves with server provenance and full precision, then clears only an edited claim", async () => {
    await call("takes_resolve", { slug: add.slug, expected_version: 1, row_num: 1, quality: "correct", value: 12.3456789 });
    const row = (await db.storage.engine().query<Record<string, unknown>>("SELECT * FROM synth_takes WHERE row_num=1")).rows[0]!;
    expect(Number(row.resolved_value)).toBe(12.3456789);
    expect(row.resolved_by).toBe("client:take-editor");
    await call("takes_update", { slug: add.slug, expected_version: 2, row_num: 1, claim: "Revised claim" });
    expect((await db.storage.engine().query("SELECT resolved_value,resolved_quality FROM synth_takes WHERE row_num=1")).rows[0])
      .toEqual({ resolved_value: null, resolved_quality: null });
  });
  it("rejects public, scope, holder, prefix, forged actor and absent-version requests before mutations", async () => {
    const before = await state();
    for (const [args, options] of [
      [add, { isPublic: true }], [add, { authInfo: { ...authInfo, scopes: ["read"] } }],
      [add, { authInfo: { ...authInfo, sourceId: "b", allowedSources: ["b"] } }],
      [add, { authInfo: { ...authInfo, takesHolders: ["brain"] } }],
      [add, { authInfo: { ...authInfo, boundSlugPrefixes: ["inbox"] } }],
      [{ ...add, written_by_principal: "operator" }, { authInfo }],
      [{ ...add, expected_version: undefined }, { authInfo }],
    ] as Array<[Record<string, unknown>, DispatchOptions]>) {
      expect((await request("takes_add", args, options)).isError).toBe(true);
      expect(await state()).toEqual(before);
    }
  });
  it("frames canonical claims and applies holder and diary fences to existing reads and status changes", async () => {
    await call("takes_add", add);
    const listed = await call("list_takes", {});
    const added = listed.takes.find((row: { claim_text: string }) => row.claim_text.includes("Added"));
    expect(added.claim_text).toContain('<external_content trust="external">');
    expect(added.claim_text).toContain("&lt;claim&gt;");
    expect(added.written_by_principal).toBeUndefined();
    const status = await call("set_take_status", { take_key: added.take_key, status: "rejected" }, { authInfo: { ...authInfo, boundSlugPrefixes: undefined, takesHolders: ["brain"] } });
    expect(status.updated).toBe(false);
    await db.storage.engine().query("UPDATE pages SET type='diary' WHERE slug=$1", [add.slug]);
    expect((await call("list_takes", {})).takes).toEqual([]);
    expect((await call("takes_search", { q: "Added" })).takes).toEqual([]);
    expect((await call("takes_scorecard", {})).scorecard.total_takes).toBe(0);
    expect((await call("takes_calibration", {})).buckets).toEqual([]);
    const before = await state();
    expect((await request("takes_add", { ...add, expected_version: 2 })).isError).toBe(true);
    expect(await state()).toEqual(before);
  });
});
