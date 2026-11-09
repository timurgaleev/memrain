import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { planForgottenErasure, applyForgottenErasure } from "../src/core/forgotten-erasure.ts";
import { putPage, getPage, deletePage } from "../src/core/pages.ts";
import { forgetFact } from "../src/core/facts-recall.ts";
import { indexPageIntoSearch } from "../src/core/page-index.ts";
import { deterministicEmbed } from "./det-embed.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import { withdrawLockKey } from "../src/core/fact-withdrawals.ts";

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`forgotten erasure (${name})`, () => {
  let db: Awaited<ReturnType<typeof open>>;
  beforeAll(async () => { db = await open(); });
  afterAll(async () => { await db.close(); });
  async function fact(text: string, cause: "forget" | "supersede" = "forget") {
    const row = (await db.storage.engine().query<{ id: number | string }>(`INSERT INTO entity_facts(entity_slug,fact,source_id) VALUES('people/erasure',$1,'default') RETURNING id`, [text])).rows[0]!;
    const id = Number(row.id);
    await forgetFact(db.storage, id, { cause, reason: "Private reason must disappear" });
    return id;
  }
  it("physically removes a selected forgotten fact but retains a non-text withdrawal guard", async () => {
    const text = "Unique selected fact for complete erasure 8274";
    const id = await fact(text);
    await db.storage.engine().query("UPDATE entity_facts SET embedding=$2::vector WHERE id=$1", [id, JSON.stringify(deterministicEmbed(text))]);
    const targets = { source: "default", factIds: [id] };
    const plan = await planForgottenErasure(db.storage.engine(), targets);
    expect(plan.blockers).toEqual([]);
    expect(JSON.stringify(plan)).not.toContain(text);
    expect(JSON.stringify(plan)).not.toContain("Private reason");
    await applyForgottenErasure(db.storage.engine(), targets, plan.plan_hash);
    expect((await db.storage.engine().query("SELECT id FROM entity_facts WHERE id=$1", [id])).rows).toEqual([]);
    const guard = (await db.storage.engine().query<{ reason: string | null; first_fact_id: number | null }>("SELECT reason,first_fact_id FROM fact_withdrawals WHERE claim_key=memrain_fact_claim_key($1)", [text])).rows[0]!;
    expect(guard).toEqual({ reason: null, first_fact_id: null });
    const reinsert = await db.storage.engine().query<{ forgotten_cause: string }>(`INSERT INTO entity_facts(entity_slug,fact,source_id) VALUES('people/erasure',$1,'default') RETURNING forgotten_cause`, [text]);
    expect(reinsert.rows[0]!.forgotten_cause).toBe("forget");
  });
  it("removes a deleted page and its exact history and sidecars while preserving unrelated rows", async () => {
    const slug = "notes/erasure-page";
    await putPage(db.storage, { slug, markdown_body: "Unique selected deleted page bytes 7219", compiled_truth: { summary: "Deleted understanding 7219" } });
    await indexPageIntoSearch(db.storage, (await getPage(db.storage, slug))!, { embedFn: async text => deterministicEmbed(text) });
    const mirrorIds = (await db.storage.engine().query<{ id: string }>("SELECT id FROM documents WHERE source_path=ANY($1::text[])", [[`page://${slug}`, `page-truth://${slug}`]])).rows.map(r => r.id);
    expect(mirrorIds).toHaveLength(2);
    const chunkIds = (await db.storage.engine().query<{ id: string }>("SELECT id FROM chunks WHERE document_id=ANY($1::text[])", [mirrorIds])).rows.map(r => r.id);
    expect(chunkIds.length).toBeGreaterThan(0);
    await putPage(db.storage, { slug: "notes/retained-erasure-control", markdown_body: "Unrelated retained content" });
    await db.storage.engine().query("INSERT INTO raw_data(slug,source,data) VALUES($1,'fixture','{\"note\":\"sidecar\"}'::jsonb)", [slug]);
    await db.storage.engine().query("INSERT INTO slug_aliases(source_id,alias_slug,canonical_slug) VALUES('default','notes/old-erasure-alias',$1)", [slug]);
    await deletePage(db.storage, slug);
    const before = (await db.storage.engine().query("SELECT to_jsonb(p) AS row FROM pages p WHERE slug='notes/retained-erasure-control'")).rows;
    const targets = { source: "default", deletedPages: [slug] };
    const plan = await planForgottenErasure(db.storage.engine(), targets);
    expect(plan.blockers).toEqual([]);
    await applyForgottenErasure(db.storage.engine(), targets, plan.plan_hash);
    for (const table of ["pages", "page_versions", "raw_data"]) expect((await db.storage.engine().query(`SELECT slug FROM ${table} WHERE slug=$1`, [slug])).rows).toEqual([]);
    expect((await db.storage.engine().query("SELECT id FROM slug_aliases WHERE canonical_slug=$1", [slug])).rows).toEqual([]);
    expect((await db.storage.engine().query("SELECT id FROM documents WHERE id=ANY($1::text[])", [mirrorIds])).rows).toEqual([]);
    expect((await db.storage.engine().query("SELECT id FROM chunks WHERE id=ANY($1::text[])", [chunkIds])).rows).toEqual([]);
    expect((await db.storage.engine().query("SELECT chunk_id FROM embeddings WHERE chunk_id=ANY($1::text[])", [chunkIds])).rows).toEqual([]);
    expect((await db.storage.engine().query("SELECT to_jsonb(p) AS row FROM pages p WHERE slug='notes/retained-erasure-control'")).rows).toEqual(before);
  });
  it("refuses live, merely superseded and copied claims without deleting anything", async () => {
    const live = Number((await db.storage.engine().query<{ id: number | string }>("INSERT INTO entity_facts(entity_slug,fact) VALUES('people/erasure','Live fact must survive 6482') RETURNING id")).rows[0]!.id);
    const livePlan = await planForgottenErasure(db.storage.engine(), { source: "default", factIds: [live] });
    expect(livePlan.blockers.some(b => b.code === "fact_not_withdrawn")).toBe(true);
    const id = await fact("History-only superseded fact 5392", "supersede");
    const plan = await planForgottenErasure(db.storage.engine(), { source: "default", factIds: [id] });
    expect(plan.blockers.some((b: { code: string }) => b.code === "fact_not_withdrawn")).toBe(true);
    await expect(applyForgottenErasure(db.storage.engine(), { source: "default", factIds: [id] }, plan.plan_hash)).rejects.toThrow("blocked");
    const copied = await fact("Copied literal claim outside selection 5194");
    await putPage(db.storage, { slug: "notes/erasure-copy", markdown_body: "Copied literal claim outside selection 5194" });
    const copiedPlan = await planForgottenErasure(db.storage.engine(), { source: "default", factIds: [copied] });
    expect(copiedPlan.blockers.some((b: { code: string }) => b.code === "unselected_reference")).toBe(true);
    expect((await db.storage.engine().query("SELECT id FROM entity_facts WHERE id=ANY($1::bigint[])", [[id, copied]])).rows).toHaveLength(2);
  });
  it("preserves a surviving successor and permits a proven legacy withdrawal", async () => {
    const id = await fact("Legacy withdrawn claim selected 2269");
    const engine = db.storage.engine();
    const successor = Number((await engine.query<{ id: number | string }>("INSERT INTO entity_facts(entity_slug,fact) VALUES('people/erasure','Unrelated successor content 3379') RETURNING id")).rows[0]!.id);
    await engine.query("UPDATE entity_facts SET forgotten_cause=NULL,superseded_by=$2 WHERE id=$1", [id, successor]);
    const before = (await engine.query("SELECT to_jsonb(f) AS row FROM entity_facts f WHERE id=$1", [successor])).rows;
    const targets = { source: "default", factIds: [id] };
    const plan = await planForgottenErasure(engine, targets);
    expect(plan.blockers).toEqual([]);
    await applyForgottenErasure(engine, targets, plan.plan_hash);
    expect((await engine.query("SELECT to_jsonb(f) AS row FROM entity_facts f WHERE id=$1", [successor])).rows).toEqual(before);
  });
  it("blocks a terminal add_fact replay receipt even when it contains only the numeric result ID", async () => {
    const id = await fact("Receipt-linked selected fact 8837");
    const engine = db.storage.engine();
    await engine.query("INSERT INTO write_requests(principal,tool,request_id,args_hash,result) VALUES('operator','add_fact','erase-receipt','fixture',$1::text::jsonb)", [JSON.stringify({ id })]);
    try {
      const plan = await planForgottenErasure(engine, { source: "default", factIds: [id] });
      expect(plan.blockers.some(b => b.table === "write_requests" && b.code === "unselected_reference")).toBe(true);
    } finally { await engine.exec("DELETE FROM write_requests WHERE request_id='erase-receipt'"); }
  });
  it("rejects drift and unknown delete triggers, and rolls the closure back on a database error", async () => {
    const id = await fact("Atomic erasure selected fact 8173");
    const targets = { source: "default", factIds: [id] };
    const plan = await planForgottenErasure(db.storage.engine(), targets);
    await db.storage.engine().query("UPDATE entity_facts SET context='Drift' WHERE id=$1", [id]);
    await expect(applyForgottenErasure(db.storage.engine(), targets, plan.plan_hash)).rejects.toThrow("stale");
    const fresh = await planForgottenErasure(db.storage.engine(), targets);
    await db.storage.engine().exec(`CREATE FUNCTION erasure_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture failure'; END $$;
      CREATE TRIGGER erasure_failure BEFORE DELETE ON entity_facts FOR EACH ROW EXECUTE FUNCTION erasure_failure()`);
    const withTrigger = await planForgottenErasure(db.storage.engine(), targets);
    expect(withTrigger.blockers.some(b => b.code === "unmodelled_trigger")).toBe(true);
    await expect(applyForgottenErasure(db.storage.engine(), targets, withTrigger.plan_hash)).rejects.toThrow("blocked");
    await db.storage.engine().exec("DROP TRIGGER erasure_failure ON entity_facts; DROP FUNCTION erasure_failure()");
    const engine = db.storage.engine();
    const failing = new Proxy(engine, { get(target, key) {
      if (key === "transaction") return <T>(fn: (tx: Engine) => Promise<T>) => engine.transaction(tx => fn(new Proxy(tx, { get(t, k) {
        if (k === "query") return async <R>(sql: string, params?: unknown[]) => {
          if (sql.startsWith('DELETE FROM "entity_facts"')) await t.exec("DO $$ BEGIN RAISE EXCEPTION 'fixture failure'; END $$");
          return t.query<R>(sql, params);
        };
        const value = t[k as keyof Engine]; return typeof value === "function" ? value.bind(t) : value;
      } })));
      const value = target[key as keyof Engine]; return typeof value === "function" ? value.bind(target) : value;
    } });
    const beforeFailure = await planForgottenErasure(engine, targets);
    const before = (await db.storage.engine().query("SELECT to_jsonb(w) AS row FROM fact_withdrawals w ORDER BY claim_key")).rows;
    await expect(applyForgottenErasure(failing, targets, beforeFailure.plan_hash)).rejects.toThrow("fixture failure");
    expect((await db.storage.engine().query("SELECT to_jsonb(w) AS row FROM fact_withdrawals w ORDER BY claim_key")).rows).toEqual(before);
    expect((await db.storage.engine().query("SELECT id FROM entity_facts WHERE id=$1", [id])).rows).toHaveLength(1);
    expect(fresh.plan_hash).not.toBe(plan.plan_hash);
  });
  it("rejects a busy advisory lock before changing targets or guards", async () => {
    const id = await fact("Busy selected fact with retained bytes 9203");
    const targets = { source: "default", factIds: [id] };
    const plan = await planForgottenErasure(db.storage.engine(), targets);
    const engine = db.storage.engine();
    const busy = new Proxy(engine, { get(target, key) {
      if (key === "transaction") return <T>(fn: (tx: Engine) => Promise<T>) => engine.transaction(tx => fn(new Proxy(tx, { get(t, k) {
        if (k === "query") return async <R>(sql: string, params?: unknown[]) => sql.includes("pg_try_advisory_xact_lock") ? { rows: [{ acquired: false } as R] } : t.query<R>(sql, params);
        const value = t[k as keyof Engine]; return typeof value === "function" ? value.bind(t) : value;
      } })));
      const value = target[key as keyof Engine]; return typeof value === "function" ? value.bind(target) : value;
    } });
    await expect(applyForgottenErasure(busy, targets, plan.plan_hash)).rejects.toThrow("busy");
    expect(await planForgottenErasure(engine, targets)).toEqual(plan);
  });
  it("blocks unknown dependent foreign keys, source drift and active work without exposing their text", async () => {
    const id = await fact("Referenced forgotten fact with closure 8392");
    const engine = db.storage.engine();
    const targets = { source: "default", factIds: [id] };
    const original = await planForgottenErasure(engine, targets);
    await engine.exec("CREATE TABLE erase_unknown_dependency(id integer PRIMARY KEY, target bigint REFERENCES entity_facts(id) ON DELETE CASCADE)");
    await engine.query("INSERT INTO erase_unknown_dependency VALUES(1,$1)", [id]);
    await expect(applyForgottenErasure(engine, targets, original.plan_hash)).rejects.toThrow("stale");
    let plan = await planForgottenErasure(engine, targets);
    expect(plan.blockers.some(b => b.code === "unselected_foreign_key")).toBe(true);
    await expect(applyForgottenErasure(engine, targets, plan.plan_hash)).rejects.toThrow("blocked");
    await engine.exec("DROP TABLE erase_unknown_dependency");
    await engine.query("INSERT INTO jobs(id,kind,payload) VALUES('erase-active','fixture','{\"private\":\"active text\"}'::jsonb)");
    plan = await planForgottenErasure(engine, targets);
    expect(plan.blockers.some(b => b.code === "active_work")).toBe(true);
    expect(JSON.stringify(plan)).not.toContain("active text");
    await engine.exec("DELETE FROM jobs WHERE id='erase-active'");
    await engine.exec("INSERT INTO sources(id,kind,path_prefix) VALUES('erase-other','other','erase-other:fixture')");
    await engine.query("UPDATE entity_facts SET source_id='erase-other' WHERE id=$1", [id]);
    plan = await planForgottenErasure(engine, targets);
    expect(plan.blockers.some(b => b.code === "unproven_owner")).toBe(true);
    await expect(applyForgottenErasure(engine, targets, plan.plan_hash)).rejects.toThrow("blocked");
    expect((await engine.query("SELECT id FROM entity_facts WHERE id=$1", [id])).rows).toHaveLength(1);
  });
  it("refuses an unowned mirror and an empty or unbounded target selection", async () => {
    const engine = db.storage.engine();
    for (const targets of [{ source: "default" }, { source: "default", factIds: Array.from({ length: 101 }, (_, i) => i + 1) }, { source: "default", factIds: [1.5] }]) {
      await expect(planForgottenErasure(engine, targets)).rejects.toThrow();
    }
    const slug = "notes/erasure-unowned";
    await putPage(db.storage, { slug, markdown_body: "Unowned mirror must be retained 7319" });
    await indexPageIntoSearch(db.storage, (await getPage(db.storage, slug))!, { embedFn: async text => deterministicEmbed(text) });
    await deletePage(db.storage, slug);
    await engine.query("UPDATE documents SET source_id=NULL WHERE source_path=$1", [`page://${slug}`]);
    const targets = { source: "default", deletedPages: [slug] };
    const plan = await planForgottenErasure(engine, targets);
    expect(plan.blockers.some(b => b.table === "documents" && b.code === "unproven_owner")).toBe(true);
    const before = (await engine.query("SELECT to_jsonb(d) AS row FROM documents d WHERE source_path=$1", [`page://${slug}`])).rows;
    await expect(applyForgottenErasure(engine, targets, plan.plan_hash)).rejects.toThrow("blocked");
    expect((await engine.query("SELECT to_jsonb(d) AS row FROM documents d WHERE source_path=$1", [`page://${slug}`])).rows).toEqual(before);
  });
  if (name === "Postgres") it("refuses an actually held PostgreSQL withdrawal lock without deleting rows", async () => {
    const id = await fact("Concurrent PostgreSQL lock fixture 6638");
    const engine = db.storage.engine();
    const targets = { source: "default", factIds: [id] };
    const plan = await planForgottenErasure(engine, targets);
    let release!: () => void; let acquired!: () => void;
    const held = new Promise<void>(resolve => { acquired = resolve; });
    const finish = new Promise<void>(resolve => { release = resolve; });
    const holding = engine.transaction(async tx => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [withdrawLockKey("default")]);
      acquired(); await finish;
    });
    try {
      await held;
      await expect(applyForgottenErasure(engine, targets, plan.plan_hash)).rejects.toThrow("busy");
    } finally { release(); await holding; }
    expect(await planForgottenErasure(engine, targets)).toEqual(plan);
  });
});
