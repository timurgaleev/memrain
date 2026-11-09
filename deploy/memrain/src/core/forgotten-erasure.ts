import type { Engine } from "./engine/interface.ts";
import { validateSlug } from "./pages.ts";
import { pageSourcePath, pageTruthSourcePath } from "./page-index.ts";
import { withdrawLockKey } from "./fact-withdrawals.ts";
import { deadlockSafeTransaction } from "./retry.ts";
import { bumpClock, bumpDocumentClock } from "./generation.ts";
import { erasureHash, erasureSchema, erasureForeignKeys, readErasureCensus, sqlName, type ErasureCensus, type ErasureRow } from "./forgotten-erasure-census.ts";

export interface ErasureTargets { source: string; factIds?: number[]; deletedPages?: string[] }
interface Blocker { table: string; code: string; count: number }
interface Guard { source_id: string; visibility: string; entity_slug: string; claim_key: string }
interface ErasureSnapshot { plan: ErasurePlan; census: ErasureCensus; closure: Map<string, ErasureRow[]>; guards: Guard[] }
export interface ErasurePlan {
  source: string; fact_ids: number[]; deleted_pages: string[]; plan_hash: string;
  blockers: Blocker[]; deletions: Array<{ table: string; count: number; rows_hash: string }>;
  withdrawal_guards: number; schema_hash: string; snapshot_hash: string; cost_usd: 0;
  scope: string;
}
const SCOPE = "Irreversible removal of selected public-schema rows and modeled dependencies. Backups, external files/exports/clients, external logs, paraphrases and unlinked fragments are outside this operation; reverting the binary cannot restore erased rows.";
function selection(input: ErasureTargets) {
  if (!input.source || input.source.trim() !== input.source) throw new Error("Erasure requires one exact source");
  const factIds = [...new Set(input.factIds ?? [])].sort((a, b) => a - b);
  const deletedPages = [...new Set(input.deletedPages ?? [])].sort();
  if (factIds.length + deletedPages.length < 1 || factIds.length + deletedPages.length > 100) throw new Error("Erasure requires 1..100 explicit targets");
  if (factIds.some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error("Erasure fact IDs must be positive safe integers");
  deletedPages.forEach(validateSlug);
  return { source: input.source, factIds, deletedPages };
}
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}
function factReferences(value: unknown, ids: Set<number>, implicitId = false): boolean {
  if (Array.isArray(value)) return value.some(v => factReferences(v, ids, implicitId));
  if (value && typeof value === "object") return Object.entries(value).some(([key, v]) =>
    /(?:^|_)fact_ids?$/.test(key) || (implicitId && key === "id")
      ? (Array.isArray(v) ? v : [v]).some(id => ids.has(Number(id)))
      : factReferences(v, ids, implicitId || key === "fact" || key === "facts"));
  return false;
}
const normalized = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim();
const rowKey = (row: ErasureRow) => erasureHash(row);

async function snapshot(engine: Engine, input: ErasureTargets): Promise<ErasureSnapshot> {
  const deadline = Date.now() + 60_000;
  const opts = selection(input);
  if (!(await engine.query("SELECT id FROM sources WHERE id=$1", [opts.source])).rows.length) throw new Error("Erasure source does not exist");
  const census = await readErasureCensus(engine);
  const rows = (table: string) => census.data.get(table) ?? [];
  const closure = new Map<string, ErasureRow[]>();
  const blocked = new Map<string, Blocker>();
  const block = (table: string, code: string, count = 1) => {
    const key = `${table}:${code}`; const old = blocked.get(key);
    blocked.set(key, { table, code, count: (old?.count ?? 0) + count });
  };
  for (const table of census.unsupported_stores) block(table, "unscanned_store");
  const add = (table: string, predicate: (row: ErasureRow) => boolean, owned = false) => {
    const matched = rows(table).filter(predicate);
    if (owned && matched.some(r => r.source_id !== opts.source)) block(table, "unproven_owner", matched.filter(r => r.source_id !== opts.source).length);
    closure.set(table, matched);
    return matched;
  };
  const factIds = new Set(opts.factIds);
  const slugs = new Set(opts.deletedPages);
  const facts = add("entity_facts", r => factIds.has(Number(r.id)), true);
  const pages = add("pages", r => slugs.has(String(r.slug)), true);
  if (facts.length !== opts.factIds.length) block("entity_facts", "missing_target");
  if (pages.length !== opts.deletedPages.length) block("pages", "missing_target");
  for (const page of pages) if (page.deleted_at === null) block("pages", "page_not_deleted");
  const guards: Guard[] = [];
  for (const fact of facts) {
    const key = (await engine.query<{ claim_key: string }>("SELECT memrain_fact_claim_key($1) AS claim_key", [fact.fact])).rows[0]!.claim_key;
    const guard = { source_id: String(fact.source_id), visibility: String(fact.visibility), entity_slug: String(fact.entity_slug), claim_key: key };
    const withdrawn = rows("fact_withdrawals").some(w => Object.entries(guard).every(([k, v]) => w[k] === v));
    if (fact.dimension !== null) block("entity_facts", "unsupported_typed_withdrawal");
    if (fact.forgotten_at === null || (!withdrawn && fact.forgotten_cause !== "forget")) block("entity_facts", "fact_not_withdrawn");
    if (!guards.some(g => erasureHash(g) === erasureHash(guard))) guards.push(guard);
  }
  for (const table of ["page_versions", "page_aliases", "tags"]) add(table, r => slugs.has(String(r.slug)), true);
  add("raw_data", r => slugs.has(String(r.slug)));
  add("links", r => slugs.has(String(r.source_slug)), true);
  add("wanted_links", r => slugs.has(String(r.from_slug)), true);
  add("slug_aliases", r => slugs.has(String(r.canonical_slug)), true);
  add("timeline_events", r => slugs.has(String(r.slug)) && (r.event_slug === null || slugs.has(String(r.event_slug))), true);
  const paths = new Set(opts.deletedPages.flatMap(slug => [pageSourcePath(slug, opts.source), pageTruthSourcePath(slug, opts.source)]));
  const docs = add("documents", r => paths.has(String(r.source_path)), true);
  const docIds = new Set(docs.map(r => String(r.id)));
  const chunks = add("chunks", r => docIds.has(String(r.document_id)), true);
  const chunkIds = new Set(chunks.map(r => String(r.id)));
  add("embeddings", r => chunkIds.has(String(r.chunk_id)));
  add("entity_mentions", r => chunkIds.has(String(r.chunk_id)));
  add("code_edges_symbol", r => chunkIds.has(String(r.from_chunk_id)), true);
  for (const trigger of census.mutation_triggers) {
    if ((trigger.on_delete && (closure.get(trigger.table_name)?.length ?? 0) > 0)
      || (trigger.on_insert_update && trigger.table_name === "fact_withdrawals" && guards.length > 0)) block(trigger.table_name, "unmodelled_trigger");
  }
  for (const table of census.ruled_tables) if ((closure.get(table)?.length ?? 0) > 0 || (table === "fact_withdrawals" && guards.length > 0)) block(table, "unmodelled_rule");
  const included = new Map([...closure].map(([table, selected]) => [table, new Set(selected.map(rowKey))]));
  const isIncluded = (table: string, row: ErasureRow) => included.get(table)?.has(rowKey(row)) ?? false;
  const guardMatches = (row: ErasureRow) => guards.some(guard => Object.entries(guard).every(([k, v]) => row[k] === v));
  const needles = [...facts.map(f => normalized(String(f.fact))), ...pages.flatMap(p => [p.markdown_body, p.compiled_truth].flatMap(strings).map(normalized))].filter(v => v.length > 0);
  const refs = [...slugs, ...docIds, ...chunkIds, ...opts.factIds.map(id => `fact:${id}`)];
  let referenceWork = 0;
  for (const [table, tableRows] of census.data) for (const row of tableRows) {
    if (Date.now() > deadline) throw new Error("Erasure reference census exceeded 60 seconds; no deletion is permitted");
    if (isIncluded(table, row) || (table === "fact_withdrawals" && guardMatches(row))) continue;
    if ((table === "jobs" && ["pending", "running"].includes(String(row.status))) || table === "worker_lock" || table === "cycle_locks") block(table, "active_work");
    if (table === "write_requests" && row.result === null) block(table, "active_replay_receipt");
    const texts = strings(row);
    referenceWork += texts.reduce((sum, text) => sum + text.length, 0) * (refs.length + needles.length);
    if (referenceWork > 250_000_000) throw new Error("Erasure reference census exceeds its bounded work budget; no deletion is permitted");
    const numericRef = (table === "entity_facts" && [row.superseded_by, row.consolidated_into].some(id => id !== null && factIds.has(Number(id))))
      || (table === "synth_contradictions" && ["a", "b"].some(side => row[`${side}_kind`] === "fact" && factIds.has(Number(row[`${side}_ref`]))))
      || (row.kind === "fact" && factIds.has(Number(row.ref)))
      || factReferences(row, factIds, /fact/.test(String(row.tool ?? row.tool_name ?? row.operation ?? "")));
    if (numericRef || texts.some(text => refs.some(ref => text.includes(ref)) || needles.some(needle => normalized(text).includes(needle)))) block(table, "unselected_reference");
  }
  for (const fk of await erasureForeignKeys(engine)) {
    const parents = closure.get(fk.parent) ?? [];
    if (!parents.length) continue;
    if (!census.data.has(fk.child)) { block(fk.child, "unscanned_foreign_key"); continue; }
    const parentKeys = new Set(parents.map(parent => JSON.stringify(fk.parent_columns.map(key => String(parent[key])))));
    for (const child of rows(fk.child)) if (!isIncluded(fk.child, child) && fk.child_columns.every(key => child[key] !== null)
      && parentKeys.has(JSON.stringify(fk.child_columns.map(key => String(child[key]))))) block(fk.child, "unselected_foreign_key");
  }
  const deletions = [...closure].filter(([, selected]) => selected.length).sort(([a], [b]) => a.localeCompare(b)).map(([table, selected]) => ({ table, count: selected.length, rows_hash: erasureHash(selected) }));
  const base = { source: opts.source, fact_ids: opts.factIds, deleted_pages: opts.deletedPages,
    blockers: [...blocked.values()].sort((a, b) => `${a.table}:${a.code}`.localeCompare(`${b.table}:${b.code}`)),
    deletions, withdrawal_guards: guards.length, schema_hash: census.schema_hash, snapshot_hash: census.data_hash, cost_usd: 0 as const, scope: SCOPE };
  return { plan: { ...base, plan_hash: erasureHash(base) }, census, closure, guards };
}

export async function planForgottenErasure(engine: Engine, targets: ErasureTargets): Promise<ErasurePlan> {
  return engine.transaction(async tx => {
    await tx.exec("SET TRANSACTION READ ONLY; SET LOCAL statement_timeout='30s'");
    return (await snapshot(tx, targets)).plan;
  });
}
export async function applyForgottenErasure(engine: Engine, targets: ErasureTargets, expectedPlanHash: string) {
  if (!/^[a-f0-9]{64}$/.test(expectedPlanHash)) throw new Error("Erasure requires the exact preview plan hash");
  return deadlockSafeTransaction(engine, async tx => {
    const deadline = Date.now() + 60_000;
    const checkTime = () => { if (Date.now() > deadline) throw new Error("Erasure exceeded its 60-second work budget; transaction rolled back"); };
    await tx.exec("SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='30s'");
    const migrationLock = (await tx.query<{ acquired: boolean }>("SELECT pg_try_advisory_xact_lock(hashtext('memrain:migrations')) AS acquired")).rows[0]!;
    if (!migrationLock.acquired) throw new Error("Erasure is busy; no rows were deleted");
    const schema = await erasureSchema(tx);
    // Freeze content dependencies, including inserts that a row lock cannot see.
    // Advisory locks are nonblocking because ordinary writers acquire them first.
    await tx.exec(`LOCK TABLE ${schema.tables.map(sqlName).join(",")} IN SHARE ROW EXCLUSIVE MODE`);
    const opts = selection(targets);
    for (const key of [...opts.deletedPages.map(slug => `memrain:page:${slug}`), withdrawLockKey(opts.source)].sort()) {
      const lock = (await tx.query<{ acquired: boolean }>("SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired", [key])).rows[0]!;
      if (!lock.acquired) throw new Error("Erasure is busy; no rows were deleted");
    }
    await tx.query("SELECT id FROM entity_facts WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE", [opts.factIds]);
    await tx.query("SELECT slug FROM pages WHERE slug=ANY($1::text[]) ORDER BY slug FOR UPDATE", [opts.deletedPages]);
    const current = await snapshot(tx, opts);
    if (current.plan.plan_hash !== expectedPlanHash) throw new Error("Erasure stale plan hash; preview again");
    if (current.plan.blockers.length) throw new Error("Erasure is blocked by unresolved dependencies");
    for (const guard of current.guards) {
      checkTime();
      await tx.query(`INSERT INTO fact_withdrawals(source_id,visibility,entity_slug,claim_key,first_fact_id,reason)
        VALUES($1,$2,$3,$4,NULL,NULL) ON CONFLICT(source_id,visibility,entity_slug,claim_key)
        DO UPDATE SET reason=NULL,first_fact_id=CASE WHEN fact_withdrawals.first_fact_id=ANY($5::bigint[]) THEN NULL ELSE fact_withdrawals.first_fact_id END`,
      [guard.source_id, guard.visibility, guard.entity_slug, guard.claim_key, opts.factIds]);
    }
    // Child-first deletion avoids relying on cascades whose scope could drift.
    const order = ["embeddings", "entity_mentions", "code_edges_symbol", "chunks", "documents", "links", "wanted_links", "timeline_events", "page_aliases", "page_versions", "tags", "raw_data", "slug_aliases", "entity_facts", "pages"];
    for (const table of order) {
      checkTime();
      const selected = current.closure.get(table) ?? [];
      if (!selected.length) continue;
      const removed = await tx.query(`DELETE FROM ${sqlName(table)} t WHERE to_jsonb(t) IN (SELECT value FROM jsonb_array_elements($1::text::jsonb)) RETURNING 1`, [JSON.stringify(selected)]);
      if (removed.rows.length !== selected.length) throw new Error("Erasure closure changed during deletion");
    }
    checkTime();
    await bumpClock(tx);
    if ((current.closure.get("documents") ?? []).length) await bumpDocumentClock(tx);
    return { ...current.plan, applied: true, deleted_rows: current.plan.deletions.reduce((sum, item) => sum + item.count, 0) };
  });
}
