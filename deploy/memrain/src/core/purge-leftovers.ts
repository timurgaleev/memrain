/**
 * `memrain purge-leftovers`: what purges that ran before synthesis cleanup
 * existed left behind — atoms, atom pages, takes and contradiction rows whose
 * source no longer exists, the concepts narrated over them, and live facts
 * written on a page that is gone (synthesis/derived-cleanup.ts plans them).
 *
 * Doctor counts them read-only. The command is a dry run by default and
 * prints the frozen plan: every row with its lineage, action and reason, and a
 * hash over all of it. The apply takes that hash and an export path; inside
 * one transaction it plans again, refuses when the hash differs, writes every
 * row it is about to change to the export (0600), and only then applies. The
 * synth tables have no soft delete, so that export is the undo: `restore`
 * puts the rows, the pages' earlier bodies and the facts back. Both drop the
 * search mirrors of the pages they rewrite inside the transaction and, given a
 * storage handle, rebuild them from the new bodies once it commits; a page
 * whose mirror fails is listed and left to the cycle's mirror-pages phase.
 */
import { randomUUID } from "node:crypto";
import { writeFileSync, readFileSync } from "node:fs";
import type { Engine } from "./engine/interface.ts";
import type { Storage } from "./storage.ts";
import type { EmbedFn } from "./indexer.ts";
import { mirrorPage } from "./page-index.ts";
import type { OpsCheckResult } from "./doctor-ops.ts";
import { lockPageSlugs } from "./pages.ts";
import { bumpClock, bumpPageGeneration } from "./generation.ts";
import { OperationError } from "./operation-error.ts";
import { applyDerivedCleanup, planDerivedCleanup, type DerivedCleanupPlan, type DerivedCleanupResult } from "./derived-cleanup.ts";

const EXPORT_KIND = "memrain-purge-leftovers-export";
const RESTORE_WRITER = "purge-leftovers:restore";

/** Read-only doctor probe: how many leftovers a repair would act on. */
export async function checkPurgeLeftovers(engine: Engine): Promise<OpsCheckResult> {
  const plan = await planDerivedCleanup(engine, { orphans: true });
  const s = plan.summary;
  const parts = ([
    [s.atoms.retire, "atom(s)"],
    [s.atom_pages.retire, "atom page(s)"],
    [(s.concepts.retire ?? 0) + (s.concepts.regenerate ?? 0), "concept(s) narrated over them"],
    [s.takes.retire, "take(s)"],
    [s.contradictions.retire, "contradiction row(s)"],
    [s.facts.retire, "fact(s) written on a gone page"],
  ] as Array<[number | undefined, string]>).filter(([count]) => (count ?? 0) > 0).map(([count, label]) => `${count} ${label}`);
  if (parts.length === 0) return { ok: true, status: "ok", detail: "no synthesis rows or facts left behind by a purged source" };
  return { ok: true, status: "warn",
    detail: `left behind by purged sources: ${parts.join(", ")}; preview with memrain purge-leftovers, then apply with the plan hash it prints` };
}

/** Every row the plan changes, as stored now. */
async function exportRows(tx: Engine, plan: DerivedCleanupPlan): Promise<Record<string, unknown[]>> {
  const rows = async (sql: string, param: unknown[]) => (await tx.query<{ r: unknown }>(sql, [param])).rows.map((row) => row.r);
  const concepts = plan.concepts.map((c) => c.concept_slug);
  const takes = plan.takes.map((t) => t.id);
  const pairs = plan.contradictions.map((c) => c.pair_key);
  const pages = [...plan.atom_pages, ...plan.concepts.flatMap((c) => c.page ? [c.page] : [])].filter((p) => p.action !== "keep").map((p) => p.slug);
  return {
    synth_atoms: await rows(`SELECT to_jsonb(t) AS r FROM synth_atoms t WHERE id = ANY($1::bigint[]) ORDER BY id`, plan.atoms.map((a) => a.id)),
    synth_concepts: await rows(`SELECT to_jsonb(t) AS r FROM synth_concepts t WHERE concept_slug = ANY($1::text[]) ORDER BY concept_slug`, concepts),
    synth_concept_atoms: await rows(`SELECT to_jsonb(t) AS r FROM synth_concept_atoms t WHERE concept_slug = ANY($1::text[]) ORDER BY concept_slug, atom_id`, concepts),
    synth_takes: await rows(`SELECT to_jsonb(t) AS r FROM synth_takes t WHERE id = ANY($1::bigint[]) ORDER BY id`, takes),
    synth_take_grades: await rows(`SELECT to_jsonb(t) AS r FROM synth_take_grades t WHERE take_id = ANY($1::bigint[]) ORDER BY id`, takes),
    // scope: operator-only the rows the operator's reviewed plan changes, read in full for the export
    synth_contradictions: await rows(`SELECT to_jsonb(t) AS r FROM synth_contradictions t WHERE pair_key = ANY($1::text[]) ORDER BY pair_key`, pairs),
    synth_contradiction_verdicts: await rows(`SELECT to_jsonb(t) AS r FROM synth_contradiction_verdicts t WHERE pair_key = ANY($1::text[])`, pairs),
    // scope: operator-only the pages and facts the reviewed plan changes
    pages: await rows(`SELECT to_jsonb(t) AS r FROM pages t WHERE slug = ANY($1::text[]) ORDER BY slug`, pages),
    entity_facts: await rows(`SELECT to_jsonb(t) AS r FROM entity_facts t WHERE id = ANY($1::bigint[]) ORDER BY id`,
      plan.facts.filter((f) => f.action === "retire").map((f) => f.id)),
  };
}

interface AfterState {
  pages: Array<{ slug: string; content_hash: string | null; live: boolean | null }>;
  concepts: Array<{ concept_slug: string; generated_at: string | null }>;
}

/** The touched pages and concepts as the apply left them (null: no row). */
async function afterState(tx: Engine, rows: Record<string, unknown[]>): Promise<AfterState> {
  const slugs = (rows.pages ?? []).map((p) => String((p as { slug: unknown }).slug));
  const concepts = (rows.synth_concepts ?? []).map((c) => String((c as { concept_slug: unknown }).concept_slug));
  return {
    pages: (await tx.query<AfterState["pages"][number]>(
      // scope: upstream the pages the reviewed plan changed
      `SELECT s.slug, p.content_hash, p.deleted_at IS NULL AS live FROM unnest($1::text[]) AS s(slug) LEFT JOIN pages p ON p.slug = s.slug ORDER BY s.slug`,
      [slugs])).rows,
    concepts: (await tx.query<AfterState["concepts"][number]>(
      `SELECT s.concept_slug, c.generated_at::text AS generated_at FROM unnest($1::text[]) AS s(concept_slug)
         LEFT JOIN synth_concepts c ON c.concept_slug = s.concept_slug ORDER BY s.concept_slug`,
      [concepts])).rows,
  };
}

export interface MirrorRebuild {
  mirrored: string[];
  /** Pages whose mirror could not be rebuilt now: the hourly housekeeping retries them. */
  failed: string[];
}

export interface MirrorOptions {
  /** Rebuilds the search mirrors of the touched pages after the commit; without it they wait for the mirror phase. */
  storage?: Storage;
  /** Test seam; production embeds through the usual path. */
  embedFn?: EmbedFn;
}

/** Mirror each of `slugs` that is live into search, from its current body. */
async function rebuildMirrors(engine: Engine, slugs: readonly string[], opts: MirrorOptions): Promise<MirrorRebuild> {
  const out: MirrorRebuild = { mirrored: [], failed: [] };
  if (opts.storage === undefined) return out;
  for (const slug of slugs) {
    const page = (await engine.query<{ slug: string; title: string | null; markdown_body: string; content_hash: string; source_id: string }>(
      // scope: upstream a page this repair just changed
      `SELECT slug, title, markdown_body, content_hash, source_id FROM pages WHERE slug = $1 AND deleted_at IS NULL`, [slug])).rows[0];
    if (page === undefined) continue;
    const ok = await mirrorPage(opts.storage, page, { remote: false, ...(opts.embedFn ? { embedFn: opts.embedFn } : {}) });
    (ok ? out.mirrored : out.failed).push(slug);
  }
  return out;
}

export interface PurgeLeftoversApply {
  plan: DerivedCleanupPlan;
  result: DerivedCleanupResult;
  export_path: string;
  purge_id: string;
  mirrors: MirrorRebuild;
}

/**
 * Apply the plan the operator reviewed, as one transaction: re-plan, refuse a
 * different hash, export, then apply. A failure anywhere leaves the brain as
 * it was (an export written before a failed apply is harmless).
 */
export async function applyPurgeLeftovers(engine: Engine, opts: { planHash: string; exportPath: string } & MirrorOptions): Promise<PurgeLeftoversApply> {
  const applied = await engine.transaction(async (tx) => {
    const plan = await planDerivedCleanup(tx, { orphans: true });
    if (plan.plan_hash !== opts.planHash) {
      throw new OperationError("conflict", `the purge-leftovers plan changed since the preview (plan_hash now ${plan.plan_hash})`,
        "Run memrain purge-leftovers again, review the plan, and pass the new hash.");
    }
    const purgeId = randomUUID();
    const exported = { kind: EXPORT_KIND, version: 1, plan_hash: plan.plan_hash, purge_id: purgeId,
      exported_at: new Date().toISOString(), plan, rows: await exportRows(tx, plan) };
    writeFileSync(opts.exportPath, `${JSON.stringify(exported, null, 1)}\n`, { mode: 0o600, flag: "wx" });
    const result = await applyDerivedCleanup(tx, plan, purgeId);
    // What the apply left, so a restore refuses anything changed since.
    writeFileSync(opts.exportPath, `${JSON.stringify({ ...exported, after: await afterState(tx, exported.rows) }, null, 1)}\n`, { mode: 0o600 });
    return { plan, result, export_path: opts.exportPath, purge_id: purgeId };
  });
  const rewritten = applied.plan.concepts.flatMap((c) => c.page?.action === "regenerate" ? [c.page.slug] : []);
  return { ...applied, mirrors: await rebuildMirrors(engine, rewritten, opts) };
}

export interface PurgeLeftoversRestore {
  mirrors: MirrorRebuild;
  atoms: number;
  concepts: number;
  takes: number;
  contradictions: number;
  pages: number;
  facts: number;
}

/** Put back everything an apply changed, from its export, as one transaction. */
export async function restorePurgeLeftovers(engine: Engine, exportPath: string, mirrorOpts: MirrorOptions = {}): Promise<PurgeLeftoversRestore> {
  const exported = JSON.parse(readFileSync(exportPath, "utf8")) as {
    kind?: string; purge_id?: string; rows?: Record<string, Array<Record<string, unknown>>>; after?: AfterState;
  };
  if (exported.kind !== EXPORT_KIND || typeof exported.purge_id !== "string" || exported.rows === undefined || exported.after === undefined) {
    throw new OperationError("invalid_params", `${exportPath} is not the export of a completed purge-leftovers apply`);
  }
  const expected = exported.after;
  const rows = exported.rows;
  const list = (table: string) => rows[table] ?? [];
  const restored = await engine.transaction(async (tx) => {
    const insert = async (table: string, conflict = "ON CONFLICT DO NOTHING") => {
      const data = list(table);
      if (data.length === 0) return 0;
      const r = await tx.query(`INSERT INTO ${table} SELECT * FROM jsonb_populate_recordset(NULL::${table}, $1::text::jsonb) ${conflict} RETURNING 1`,
        [JSON.stringify(data)]);
      return r.rows.length;
    };
    const pages = list("pages");
    if (pages.length > 0) await lockPageSlugs(tx, ...pages.map((p) => String(p.slug)));
    // A page or concept written since the apply holds newer text than the
    // export: refuse rather than overwrite it.
    const now = await afterState(tx, rows);
    const changed = [
      ...now.pages.filter((p) => JSON.stringify(p) !== JSON.stringify(expected.pages.find((e) => e.slug === p.slug))).map((p) => p.slug),
      ...now.concepts.filter((c) => JSON.stringify(c) !== JSON.stringify(expected.concepts.find((e) => e.concept_slug === c.concept_slug)))
        .map((c) => `concept ${c.concept_slug}`),
    ];
    if (changed.length > 0) {
      throw new OperationError("conflict", `changed since the apply, so nothing was restored: ${changed.join(", ")}`,
        "Restore those rows by hand from the export, or re-run the cleanup.");
    }
    for (const page of pages) {
      const cur = (await tx.query<{ content_hash: string; version_n: number }>(
        // scope: upstream a page named in the operator's export, locked above
        `SELECT p.content_hash, COALESCE((SELECT max(v.version_n) FROM page_versions v WHERE v.slug = p.slug), 0)::int AS version_n
           FROM pages p WHERE p.slug = $1`, [page.slug])).rows[0];
      if (cur === undefined) throw new OperationError("conflict", `page '${String(page.slug)}' no longer exists; restore it by hand from the export`);
      await tx.query(
        `UPDATE pages SET markdown_body = $2, content_hash = $3, title = $4, compiled_truth = $5::text::jsonb, deleted_at = $6::timestamptz, updated_at = NOW()
          WHERE slug = $1`,
        [page.slug, page.markdown_body, page.content_hash, page.title, JSON.stringify(page.compiled_truth ?? {}), page.deleted_at ?? null]);
      await tx.query(
        `INSERT INTO page_versions
           (slug, version_n, hash_prev, hash_new, body_snapshot, compiled_truth_snapshot, written_by, source_id, written_by_principal, change_reason)
         VALUES ($1, $2, $3, $4, $5, $6::text::jsonb, $7, $8, NULL, $9)`,
        [page.slug, Number(cur.version_n) + 1, cur.content_hash, page.content_hash, page.markdown_body,
          JSON.stringify(page.compiled_truth ?? {}), RESTORE_WRITER, page.source_id, "restored from a purge-leftovers export"]);
      await bumpPageGeneration(tx, String(page.slug));
    }
    const out: Omit<PurgeLeftoversRestore, "mirrors"> = {
      atoms: await insert("synth_atoms"),
      concepts: await insert("synth_concepts", `ON CONFLICT (concept_slug) DO UPDATE SET title = EXCLUDED.title, narrative = EXCLUDED.narrative,
        tier = EXCLUDED.tier, atom_count = EXCLUDED.atom_count, generated_at = EXCLUDED.generated_at, model_id = EXCLUDED.model_id,
        member_hash = EXCLUDED.member_hash`),
      takes: 0, contradictions: 0, pages: pages.length, facts: 0,
    };
    await insert("synth_concept_atoms");
    out.takes = await insert("synth_takes");
    await insert("synth_take_grades");
    out.contradictions = await insert("synth_contradictions");
    await insert("synth_contradiction_verdicts");
    const factIds = list("entity_facts").map((f) => Number(f.id));
    if (factIds.length > 0) {
      out.facts = (await tx.query(
        // Only the retirement this apply wrote: a fact retired again since by
        // another purge keeps that retirement.
        // scope: upstream the fact ids of the operator's export and this apply's receipt
        `UPDATE entity_facts SET forgotten_at = NULL, forgotten_cause = NULL, forgotten_reason = NULL
          WHERE id = ANY($1::bigint[]) AND forgotten_cause = 'purge' AND forgotten_reason LIKE 'purge leftover:%'
            AND id IN (SELECT unnest(fact_ids) FROM fact_purge_receipts WHERE purge_id = $2::uuid) RETURNING 1`,
        [factIds, exported.purge_id])).rows.length;
      await tx.query(`DELETE FROM fact_purge_receipts WHERE purge_id = $1::uuid`, [exported.purge_id]);
    }
    await bumpClock(tx);
    return out;
  });
  return { ...restored, mirrors: await rebuildMirrors(engine, list("pages").map((p) => String(p.slug)), mirrorOpts) };
}
