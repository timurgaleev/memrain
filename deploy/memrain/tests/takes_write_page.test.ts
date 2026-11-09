import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { putPage, getPage } from "../src/core/pages.ts";
import { runTakeMutation } from "../src/core/synthesis/takes-write-page.ts";
import { fenceTakeKey, syncTakesFromFence } from "../src/core/synthesis/takes-canon.ts";
import { gradeTakesPhase, setTakeStatus } from "../src/core/synthesis/takes.ts";
import { resolveTake } from "../src/core/synthesis/takes-canon.ts";
import { calibrationProfilePhase } from "../src/core/synthesis/calibration.ts";
import { listTakes, searchTakes, getTakesScorecard, getTakesCalibration } from "../src/core/synthesis/reads.ts";

const raw = ["Prose", "<!--- memrain:takes:begin -->", "| # | claim | kind | who | weight | since | source |",
  "|---|---|---|---|---|---|---|", "| 1 | First claim | fact | world | 1 | | |", "| 7 | Broken | unknown | world | bad | | |",
  "<!-- keep -->", "<!--- memrain:takes:end -->"].join("\n");
const actor = { principal: "client:test", holderAllowList: ["world"] };
const add = { op: "add" as const, claim: "Added claim", kind: "take", holder: "world" };

for (const spec of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`canonical takes writes ${spec.name}`, () => {
  let db: Awaited<ReturnType<typeof spec.open>>;
  beforeAll(async () => { db = await spec.open(); });
  afterAll(async () => { await db.close(); });
  beforeEach(async () => {
    await db.storage.engine().exec("DELETE FROM synth_calibration_profile; DELETE FROM synth_takes; DELETE FROM pages; DELETE FROM documents; DELETE FROM sources WHERE id IN ('a','b'); INSERT INTO sources (id,kind,path_prefix) VALUES ('a','other','/a'),('b','other','/b');");
    await putPage(db.storage, { slug: "notes/takes", markdown_body: raw, source_id: "a", written_by_principal: "operator" });
    await syncTakesFromFence(db.storage.engine(), "notes/takes", raw.replace("| unknown | world | bad |", "| fact | world | 0.5 |"));
  });
  const engine = () => db.storage.engine();
  const run = (overrides: Record<string, unknown> = {}) => runTakeMutation(db.storage, {
    slug: "notes/takes", expectedVersion: 1, mutation: add, actor, sourceIds: ["a"], writeSource: "a", ...overrides,
  });
  const state = async () => ({
    pages: (await engine().query<Record<string, unknown>>("SELECT * FROM pages ORDER BY slug")).rows,
    versions: (await engine().query<Record<string, unknown>>("SELECT * FROM page_versions ORDER BY slug, version_n")).rows,
    takes: (await engine().query<Record<string, unknown>>("SELECT * FROM synth_takes ORDER BY id")).rows,
    audits: (await engine().query<Record<string, unknown>>("SELECT * FROM ingest_log ORDER BY id")).rows,
  });

  it("atomically adds exactly the requested row and preserves malformed ledger neighbors and provenance", async () => {
    const before = await state();
    const result = await run();
    expect(result).toMatchObject({ ok: true, changed: true, version_n: 2, row_num: 8, take_key: fenceTakeKey("notes/takes", 8) });
    const after = await state();
    expect(after.takes.slice(0, 2)).toEqual(before.takes);
    expect(after.takes).toHaveLength(3);
    expect(after.versions.at(-1)?.written_by_principal).toBe("client:test");
    expect(after.pages[0]?.markdown_body).toContain("<!-- keep -->");
    expect(result.content_hash).toBe(result.after_hash);
  });

  it("previews without any writes and applies only the pinned hash and version", async () => {
    const before = await state();
    const preview = await run({ dryRun: true, reason: "Add verified claim" });
    expect(preview).toMatchObject({ ok: true, dry_run: true, row_num: 8 });
    expect(preview.plan_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(await state()).toEqual(before);
    await expect(run({ planHash: preview.plan_hash, reason: "Different" })).rejects.toThrow();
    expect(await state()).toEqual(before);
    expect(await run({ planHash: preview.plan_hash, reason: "Add verified claim" })).toMatchObject({ version_n: 2 });
    await expect(run({ planHash: preview.plan_hash })).rejects.toThrow();
  });

  it("has exactly one winner for concurrent edits at the same expected version", async () => {
    const results = await Promise.allSettled([run(), run()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await state()).versions).toHaveLength(2);
    expect((await state()).takes).toHaveLength(3);
  });

  it("rolls back the page and its version if projection violates a real SQL constraint", async () => {
    const before = await state();
    await engine().exec("ALTER TABLE synth_takes ADD CONSTRAINT test_refuse_added CHECK (claim_text <> 'Added claim')");
    try { await expect(run()).rejects.toThrow(); } finally { await engine().exec("ALTER TABLE synth_takes DROP CONSTRAINT test_refuse_added"); }
    expect(await state()).toEqual(before);
  });

  for (const overrides of [{ sourceIds: ["b"], writeSource: "b" }, { sourceIds: [] },
    { actor: { principal: "client:test", holderAllowList: ["brain"] } }, { expectedVersion: undefined }]) {
    it("refuses scope, holder and missing-version violations without mutations", async () => {
      const before = await state();
      await expect(run(overrides)).rejects.toThrow();
      expect(await state()).toEqual(before);
    });
  }

  it("refuses remote diary and quarantined page mutations", async () => {
    await engine().query("UPDATE pages SET type = 'diary' WHERE slug = 'notes/takes'");
    const before = await state();
    await expect(run({ excludeDiary: true })).rejects.toThrow();
    expect(await state()).toEqual(before);
    await engine().query("UPDATE pages SET type = 'note' WHERE slug = 'notes/takes'");
    await engine().query("INSERT INTO documents (id,source_id,source_path,frontmatter) VALUES ('mirror','a','page://a/notes/takes',$1::text::jsonb)", [JSON.stringify({ quarantine: {} })]);
    const held = await state();
    await expect(run()).rejects.toThrow();
    expect(await state()).toEqual(held);
  });

  it("preserves full resolution precision through unrelated mutation and clears only a changed claim", async () => {
    await run({ mutation: { op: "resolve", rowNum: 1, quality: "correct", value: 12.34567 } });
    await run({ expectedVersion: 2 });
    const resolved = (await engine().query<{ resolved_value: string | null; resolved_quality: string | null }>("SELECT resolved_value,resolved_quality FROM synth_takes WHERE row_num = 1")).rows[0];
    expect(Number(resolved?.resolved_value)).toBe(12.34567);
    await run({ expectedVersion: 3, mutation: { op: "update", rowNum: 1, claim: "Changed claim" } });
    expect((await engine().query<{ resolved_value: string | null; resolved_quality: string | null }>("SELECT resolved_value,resolved_quality FROM synth_takes WHERE row_num = 1")).rows[0])
      .toEqual({ resolved_value: null, resolved_quality: null });
  });

  it("scopes canonical reads to page ownership even when a foreign document has the same identifier", async () => {
    await run();
    await engine().query("INSERT INTO documents (id,source_id,source_path) VALUES ('notes/takes','b','/b/foreign.md')");
    expect((await listTakes(engine(), { sourceIds: ["a"] })).map((r) => r.claim_text)).toContain("Added claim");
    expect(await listTakes(engine(), { sourceIds: ["b"] })).toEqual([]);
    expect((await searchTakes(engine(), { q: "Added claim", sourceIds: ["a"] })).map((r) => r.claim_text)).toContain("Added claim");
    expect(await searchTakes(engine(), { q: "Added claim", sourceIds: ["b"] })).toEqual([]);
    expect((await getPage(db.storage, "notes/takes"))?.source_id).toBe("a");
  });
  it("uses known live canonical owners for grading and calibration, never unscoped evidence", async () => {
    await run();
    await engine().query("UPDATE synth_takes SET generated_at = '2020-01-01'");
    await engine().query("INSERT INTO documents (id,source_id,source_path) VALUES ('notes/takes','b','/b/foreign.md')");
    await engine().query(`INSERT INTO synth_takes (take_key,source_ref,source_hash,prompt_version,claim_text,model_id,generated_at)
      VALUES ('orphan','missing','h','v','Orphan','fake','2020-01-01')`);
    const sources: Array<string | undefined> = [];
    const graded = await gradeTakesPhase(engine(), { minAgeDays: 0, evidenceFn: async (_claim, source) => {
      sources.push(source); return "Supporting evidence";
    }, llmFn: async () => ({ text: '{"verdict":"correct","confidence":0.8,"reasoning":"Supported"}', modelId: "fake" }) });
    expect(graded.errors).toEqual([]);
    expect(sources).toEqual(["a", "a", "a"]);
    const profile = await calibrationProfilePhase(engine(), { minGraded: 1, llmFn: async () => ({ text: "[]", modelId: "fake" }) });
    expect(profile.profiles.map((p) => p.sourceId)).toEqual(["a"]);
    expect((await listTakes(engine(), { sourceIds: ["a"] }))[0]?.written_by_principal).toBe("client:test");
    expect((await getTakesScorecard(engine(), { sourceIds: ["a"] })).total_takes).toBe(3);
    expect((await getTakesScorecard(engine(), { sourceIds: ["b"] })).total_takes).toBe(0);
    expect((await getTakesCalibration(engine(), { sourceIds: ["a"] })).reduce((n, b) => n + b.n, 0)).toBe(3);
    expect(await getTakesCalibration(engine(), { sourceIds: ["b"] })).toEqual([]);
    expect(await setTakeStatus(engine(), fenceTakeKey("notes/takes", 8), "rejected", ["b"])).toEqual({ updated: false });
    expect(await setTakeStatus(engine(), fenceTakeKey("notes/takes", 8), "rejected", ["a"])).toEqual({ updated: true });
    expect(await resolveTake(engine(), fenceTakeKey("notes/takes", 1), { quality: "correct" }, { sourceIds: ["b"] })).toEqual({ resolved: false });
    expect(await resolveTake(engine(), fenceTakeKey("notes/takes", 1), { quality: "correct" }, { sourceIds: ["a"] })).toEqual({ resolved: true });
  });

  it("uses the same pure secret disposition and reason validation in preview with zero audit writes", async () => {
    const old = process.env.MEMRAIN_SECRET_SCAN_DISPOSITION;
    const token = "ghp_" + "A".repeat(36);
    const mutation = { ...add, claim: `A token ${token}` };
    const before = await state();
    try {
      process.env.MEMRAIN_SECRET_SCAN_DISPOSITION = "reject";
      await expect(run({ dryRun: true, mutation, reason: "Check secret" })).rejects.toThrow();
      expect(await state()).toEqual(before);
      await expect(run({ dryRun: true, reason: "bad\nreason" })).rejects.toThrow();
      expect(await state()).toEqual(before);
      process.env.MEMRAIN_SECRET_SCAN_DISPOSITION = "redact";
      const preview = await run({ dryRun: true, mutation, reason: `Credential ${token}` });
      expect(JSON.stringify(preview)).not.toContain(token);
      expect(await state()).toEqual(before);
      const applied = await run({ mutation, reason: `Credential ${token}`, planHash: preview.plan_hash });
      expect(applied.after_hash).toBe(preview.after_hash);
      expect((await state()).versions.at(-1)?.change_reason).not.toContain(token);
    } finally {
      if (old === undefined) delete process.env.MEMRAIN_SECRET_SCAN_DISPOSITION;
      else process.env.MEMRAIN_SECRET_SCAN_DISPOSITION = old;
    }
  });

  it("keeps forbidden sources, holders and diaries out of scoped reads and status/resolution writes", async () => {
    await run();
    const key = fenceTakeKey("notes/takes", 8);
    expect(await setTakeStatus(engine(), key, "rejected", ["a"], { holderAllowList: ["brain"] })).toEqual({ updated: false });
    expect(await resolveTake(engine(), key, { quality: "correct" }, { sourceIds: ["a"], holderAllowList: ["brain"] })).toEqual({ resolved: false });
    await engine().query("UPDATE pages SET type = 'diary' WHERE slug = 'notes/takes'");
    expect(await listTakes(engine(), { sourceIds: ["a"], excludeDiary: true })).toEqual([]);
    expect(await searchTakes(engine(), { q: "Added claim", sourceIds: ["a"], excludeDiary: true })).toEqual([]);
    expect((await getTakesScorecard(engine(), { sourceIds: ["a"], excludeDiary: true })).total_takes).toBe(0);
    expect(await setTakeStatus(engine(), key, "rejected", ["a"], { excludeDiary: true })).toEqual({ updated: false });
    await engine().query("UPDATE pages SET type = 'note', deleted_at = now() WHERE slug = 'notes/takes'");
    expect(await listTakes(engine(), { sourceIds: ["a"] })).toEqual([]);
    let calls = 0;
    await gradeTakesPhase(engine(), { minAgeDays: 0, evidenceFn: async () => { calls++; return "evidence"; },
      llmFn: async () => { calls++; return { text: "{}", modelId: "fake" }; } });
    expect(calls).toBe(0);
  });

  it("pins resolve previews independently of runtime resolution timestamps", async () => {
    const mutation = { op: "resolve", rowNum: 1, quality: "partial", value: 12.34567 };
    const preview = await run({ mutation, dryRun: true, actor: { ...actor, resolvedAt: "2026-11-09T00:00:00Z" } });
    const applied = await run({ mutation, planHash: preview.plan_hash, actor: { ...actor, resolvedAt: "2026-11-09T00:00:01Z" } });
    expect(applied.plan_hash).toBe(preview.plan_hash);
    expect(applied.after_hash).not.toBe(preview.after_hash);
    expect(applied.content_hash).toBe(applied.after_hash);
  });

  it("refuses secret sanitization that would alter unrelated canonical bytes", async () => {
    const old = process.env.MEMRAIN_SECRET_SCAN_DISPOSITION;
    try {
      process.env.MEMRAIN_SECRET_SCAN_DISPOSITION = "flag";
      const token = "ghp_" + "B".repeat(36);
      await putPage(db.storage, { slug: "notes/takes", markdown_body: `Private token ${token}\n${raw}`, source_id: "a" });
      const before = await state();
      process.env.MEMRAIN_SECRET_SCAN_DISPOSITION = "redact";
      await expect(run({ expectedVersion: 2, dryRun: true })).rejects.toThrow();
      await expect(run({ expectedVersion: 2 })).rejects.toThrow();
      expect(await state()).toEqual(before);
    } finally {
      if (old === undefined) delete process.env.MEMRAIN_SECRET_SCAN_DISPOSITION;
      else process.env.MEMRAIN_SECRET_SCAN_DISPOSITION = old;
    }
  });

  it("cannot publish an in-flight verdict onto a concurrently changed canonical claim", async () => {
    await engine().query("UPDATE synth_takes SET generated_at = '2020-01-01', active = (row_num = 1)");
    const result = await gradeTakesPhase(engine(), { minAgeDays: 0, evidenceFn: async () => {
      await run({ mutation: { op: "update", rowNum: 1, claim: "New live claim" } });
      return "Evidence for the previous claim";
    }, llmFn: async () => ({ text: '{"verdict":"correct","confidence":0.99,"reasoning":"Old claim"}', modelId: "fake" }) });
    expect(result.gradesWritten).toBe(0);
    expect((await engine().query("SELECT * FROM synth_take_grades")).rows).toEqual([]);
    expect((await engine().query("SELECT claim_text,resolved_quality,status FROM synth_takes WHERE row_num = 1")).rows)
      .toEqual([{ claim_text: "New live claim", resolved_quality: null, status: "accepted" }]);
  });

  it("excludes document takes from same-source custom diary page mirrors on remote reads", async () => {
    await engine().query("UPDATE pages SET type = 'journal' WHERE slug = 'notes/takes'");
    await engine().query("INSERT INTO documents (id,source_path,source_id) VALUES ('mirror','page://a/notes/takes','a')");
    await engine().query(`INSERT INTO synth_takes (take_key,source_ref,source_hash,prompt_version,claim_text,model_id,holder)
      VALUES ('from-mirror','mirror','h','v','A private claim','fake','world')`);
    expect(await listTakes(engine(), { sourceIds: ["a"], excludeDiary: true })).toEqual([]);
    expect(await searchTakes(engine(), { q: "private", sourceIds: ["a"], excludeDiary: true })).toEqual([]);
  });

  it("denies a forbidden existing holder before disclosing version conflicts", async () => {
    for (const dryRun of [false, true]) {
      try {
        await run({ expectedVersion: 999, dryRun, mutation: { op: "update", rowNum: 1, claim: "Forbidden" },
          actor: { principal: "client:test", holderAllowList: ["brain"] } });
        throw new Error("unexpected success");
      } catch (error) {
        expect((error as { code: string }).code).toBe("permission_denied");
        expect((error as { currentVersion?: number }).currentVersion).toBeUndefined();
      }
    }
  });

});
