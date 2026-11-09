import { createHash } from "node:crypto";
import type { Engine } from "../engine/interface.ts";
import type { Storage } from "../storage.ts";
import { deletePage } from "../pages.ts";
import { phaseFenceCheck, PhaseStoppedError } from "../cycle/phase-context.ts";
import { atomPageMatches, lockAtomSource, tryLockAtomSlugs, type AtomSourceExpectation } from "./atoms-source.ts";

export interface AtomPageSnapshot {
  slug: string;
  version: number;
  hash: string;
  atom_key: string;
  source_hash: string;
}

export interface AtomCompletion {
  hash: string;
  pages: AtomPageSnapshot[];
}

export function readAtomCompletion(frontmatter: Record<string, unknown>): AtomCompletion | null {
  const hash = frontmatter.atoms_completed_hash;
  const pages = frontmatter.atoms_completed_pages;
  if (typeof hash !== "string" || !/^[a-f0-9]{16}$/.test(hash) || !Array.isArray(pages) || pages.length > 100) return null;
  const valid = pages.every((p: unknown) => {
    if (!p || typeof p !== "object") return false;
    const page = p as Record<string, unknown>;
    return typeof page.slug === "string" && page.slug.startsWith("atoms/") && page.slug.length <= 500 &&
      Number.isSafeInteger(page.version) && Number(page.version) > 0 &&
      typeof page.hash === "string" && /^[a-f0-9]{64}$/.test(page.hash) &&
      typeof page.atom_key === "string" && /^[a-f0-9]{64}$/.test(page.atom_key) &&
      typeof page.source_hash === "string" && /^[a-f0-9]{16}$/.test(page.source_hash);
  });
  return valid ? { hash, pages: pages as AtomPageSnapshot[] } : null;
}

export interface CurrentAtomPage {
  slug: string;
  source_id: string;
  version: number;
  hash: string;
  deleted: boolean;
  automatic: boolean;
  legacy: boolean;
  origin: { source_ref?: string; source_hash?: string; source_id?: string; atom_key?: string } | null;
}

export async function readCurrentAtomPage(engine: Engine, slug: string): Promise<CurrentAtomPage | undefined> {
  const { rows } = await engine.query<CurrentAtomPage>(
    `SELECT p.slug, p.source_id, v.version_n::int AS version, p.content_hash AS hash,
            p.deleted_at IS NOT NULL AS deleted, p.compiled_truth->'atom_origin' AS origin,
            (v.written_by = 'extract-atoms' AND v.written_by_principal IS NULL AND NOT p.compiled_truth ? 'atom_origin') AS legacy,
            (p.type = 'atom' AND v.written_by = 'extract-atoms' AND v.written_by_principal = 'operator' AND v.hash_new = p.content_hash
              AND v.body_snapshot = p.markdown_body AND v.compiled_truth_snapshot = p.compiled_truth) AS automatic
       FROM pages p LEFT JOIN LATERAL (
         SELECT version_n, written_by, written_by_principal, hash_new, body_snapshot, compiled_truth_snapshot
          FROM page_versions WHERE slug = p.slug ORDER BY version_n DESC LIMIT 1
       ) v ON true WHERE p.slug = $1`, [slug],
  );
  return rows[0];
}

export async function validateCompletedPages(tx: Engine, source: AtomSourceExpectation, pages: AtomPageSnapshot[]): Promise<void> {
  if (pages.length === 0) return;
  if (source.sourceId === null || !await tryLockAtomSlugs(tx, ...pages.map((p) => p.slug))) {
    throw new Error("atom page publication held: source_busy");
  }
  for (const page of pages) {
    const current = await readCurrentAtomPage(tx, page.slug);
    if (current?.version !== page.version || !await atomPageMatches(tx, page.slug, {
      sourceRef: source.id, sourceHash: page.source_hash, atomKey: page.atom_key, contentHash: page.hash,
    }, source.sourceId)) throw new Error("atom page publication held: page_changed");
  }
}

export async function retireCompletedAtomPages(storage: Storage, source: AtomSourceExpectation,
  previous: readonly AtomPageSnapshot[], keep: ReadonlySet<string>): Promise<AtomRetirementResult> {
  let retired = 0;
  let held = 0;
  const targets: AtomRetirementResult["targets"] = [];
  const obsolete = previous.filter((page) => !keep.has(page.slug));
  for (const page of obsolete.slice(0, 100)) {
    if (process.env.MEMRAIN_SYNTH_PAGES?.trim() === "0") {
      held++;
      targets.push({ slug: page.slug, status: "held", reason: "pages_disabled" });
      continue;
    }
    await phaseFenceCheck();
    try {
      const result = await deletePage(storage, page.slug, "extract-atoms:retired", source.sourceId ?? undefined, {
        expectedVersion: page.version, expectedOriginDocument: source,
        expectedAtomPage: { sourceRef: source.id, sourceHash: page.source_hash, atomKey: page.atom_key, contentHash: page.hash },
      });
      if (result.held) {
        held++;
        targets.push({ slug: page.slug, status: "held", reason: result.held });
      } else {
        if (!result.already_deleted) retired++;
        targets.push({ slug: page.slug, status: result.already_deleted ? "already_deleted" : "retired" });
      }
    } catch (error) {
      if (error instanceof PhaseStoppedError) throw error;
      held++;
      targets.push({ slug: page.slug, status: "held", reason: "changed_or_unavailable" });
    }
  }
  return { retired, held: held + Math.max(0, obsolete.length - 100), targets };
}

export interface AtomRetirementResult {
  retired: number;
  held: number;
  targets: { slug: string; status: "retired" | "held" | "already_deleted"; reason?: string }[];
}

export interface AtomRetirementPlan {
  source: AtomSourceExpectation;
  completed_hash: string;
  eligible: AtomPageSnapshot[];
  held: { slug: string; reason: string }[];
  truncated: boolean;
  plan_hash: string;
}

/** Explicit inspection only; ordinary extraction retires only its previous manifest. */
export async function planAtomRetirement(engine: Engine, sourceRef: string, completedHash: string): Promise<AtomRetirementPlan> {
  const { rows } = await engine.query<{ source_id: string | null; frontmatter: Record<string, unknown> }>(
    "SELECT source_id, COALESCE(frontmatter, '{}'::jsonb) AS frontmatter FROM documents WHERE id = $1 AND deleted_at IS NULL", [sourceRef],
  );
  const doc = rows[0];
  const completion = doc && readAtomCompletion(doc.frontmatter);
  if (!doc || doc.source_id === null || completion?.hash !== completedHash) throw new Error("authoritative atom completion not found");
  const chunks = await engine.query<{ text: string }>(
    "SELECT string_agg(content, E'\\n\\n' ORDER BY chunk_index) AS text FROM chunks WHERE document_id = $1", [sourceRef],
  );
  const contentHash = createHash("sha256").update(chunks.rows[0]?.text ?? "").digest("hex").slice(0, 16);
  if (contentHash !== completedHash || Object.hasOwn(doc.frontmatter, "quarantine")) throw new Error("atom source changed or is held");
  const candidates = await engine.query<{ slug: string }>(
    `SELECT slug FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND type = 'atom'
      AND (compiled_truth #>> '{atom_origin,source_ref}' = $2 OR EXISTS (
        SELECT 1 FROM page_versions v WHERE v.slug = pages.slug AND v.source_id = pages.source_id
          AND v.compiled_truth_snapshot #>> '{atom_origin,source_ref}' = $2) OR
        (NOT compiled_truth ? 'atom_origin' AND EXISTS (
          SELECT 1 FROM synth_atoms a WHERE a.source_ref = $2 AND a.source_kind = 'document' AND a.title = pages.title)))
      AND compiled_truth #>> '{atom_origin,source_hash}' IS DISTINCT FROM $3
      ORDER BY slug LIMIT 101`, [doc.source_id, sourceRef, completedHash],
  );
  const eligible: AtomPageSnapshot[] = [];
  const held: AtomRetirementPlan["held"] = [];
  for (const candidate of candidates.rows.slice(0, 100)) {
    const page = await readCurrentAtomPage(engine, candidate.slug);
    const origin = page?.origin;
    if (!page || !page.automatic || origin?.source_id !== doc.source_id ||
        !origin.atom_key || !/^[a-f0-9]{64}$/.test(origin.atom_key) ||
        !origin.source_hash || !/^[a-f0-9]{16}$/.test(origin.source_hash)) {
      held.push({ slug: candidate.slug, reason: page?.legacy ? "held_legacy" : "authored_or_unproven" });
    } else {
      eligible.push({ slug: page.slug, version: page.version, hash: page.hash, atom_key: origin.atom_key, source_hash: origin.source_hash });
    }
  }
  const plan = { source: { id: sourceRef, sourceId: doc.source_id, contentHash }, completed_hash: completedHash,
    eligible, held, truncated: candidates.rows.length > 100 };
  return { ...plan, plan_hash: createHash("sha256").update(JSON.stringify(plan)).digest("hex") };
}

/** Validate the entire reviewed set before the first soft deletion. */
export async function applyAtomRetirement(storage: Storage, plan: AtomRetirementPlan): Promise<AtomRetirementResult> {
  const current = await planAtomRetirement(storage.engine(), plan.source.id, plan.completed_hash);
  if (current.plan_hash !== plan.plan_hash) throw new Error("atom retirement plan changed; preview again");
  await storage.engine().transaction(async (tx) => { await lockAtomSource(tx, current.source); });
  const result = await retireCompletedAtomPages(storage, current.source, current.eligible, new Set());
  return { ...result, held: result.held + current.held.length,
    targets: [...result.targets, ...current.held.map((page) => ({ ...page, status: "held" as const }))] };
}
