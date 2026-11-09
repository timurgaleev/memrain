import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { putPage } from "../src/core/pages.ts";
import { repairTranscriptOrigin } from "../src/core/transcripts/origin-repair.ts";

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`origin repair pinning (${name})`, () => {
  let db: Awaited<ReturnType<typeof open>>;
  beforeAll(async () => { db = await open(); });
  afterAll(async () => { await db.close(); });
  const evidence = (id: string) => [{ format: "codex", id, evidence_hash: "a".repeat(64) }];
  async function seed(id: string) {
    const slug = `transcripts/codex/${id}-p1`;
    await putPage(db.storage, { slug, markdown_body: "Preserved body", compiled_truth: { format: "codex", conversation_id: id } });
    await db.storage.engine().query("INSERT INTO entity_facts(entity_slug,fact,source_slug,attributed_to) VALUES('projects/pin',$1,$2,'user')", [`Claim ${id}`, slug]);
    return slug;
  }
  const repair = (sessions: ReturnType<typeof evidence>, apply = false, planHash?: string) =>
    repairTranscriptOrigin(db.storage, sessions, "default", apply, planHash);
  const facts = (slug: string) => db.storage.engine().query<Record<string, unknown>>("SELECT * FROM entity_facts WHERE source_slug=$1 ORDER BY id", [slug]);

  it("requires the reviewed hash before changing attribution", async () => {
    const slug = await seed("missing");
    const before = (await facts(slug)).rows;
    await expect(repair(evidence("missing"), true)).rejects.toThrow("plan hash");
    expect((await facts(slug)).rows).toEqual(before);
  });
  it("refuses a page version changed after preview without relabeling facts", async () => {
    const slug = await seed("version");
    const plan = await repair(evidence("version"));
    await putPage(db.storage, { slug, title: "Changed after preview" });
    const before = (await facts(slug)).rows;
    await expect(repair(evidence("version"), true, plan.plan_hash)).rejects.toThrow("stale");
    expect((await facts(slug)).rows).toEqual(before);
  });
  it("pins session evidence and the exact fact set", async () => {
    const slug = await seed("facts");
    const plan = await repair(evidence("facts"));
    await expect(repair([{ ...evidence("facts")[0]!, evidence_hash: "b".repeat(64) }], true, plan.plan_hash)).rejects.toThrow("stale");
    await db.storage.engine().query("INSERT INTO entity_facts(entity_slug,fact,source_slug,attributed_to) VALUES('projects/pin','New fact',$1,'user')", [slug]);
    const before = (await facts(slug)).rows;
    await expect(repair(evidence("facts"), true, plan.plan_hash)).rejects.toThrow("stale");
    expect((await facts(slug)).rows).toEqual(before);
  });
  it("applies exactly the pinned attribution delta and returns its rollback receipt", async () => {
    const slug = await seed("valid");
    const before = (await facts(slug)).rows;
    const versions = (await db.storage.engine().query("SELECT * FROM page_versions WHERE slug=$1 ORDER BY version_n", [slug])).rows;
    const plan = await repair(evidence("valid"));
    const applied = await repair(evidence("valid"), true, plan.plan_hash);
    expect(applied).toMatchObject({ applied: true, changed: 1, plan_hash: plan.plan_hash,
      receipt: [{ id: before[0]!.id, old_attributed_to: "user", new_attributed_to: "other" }] });
    expect((await facts(slug)).rows).toEqual(before.map(row => ({ ...row, attributed_to: "other" })));
    expect((await db.storage.engine().query("SELECT * FROM page_versions WHERE slug=$1 ORDER BY version_n", [slug])).rows).toEqual(versions);
  });
});
