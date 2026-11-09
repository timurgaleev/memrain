import { createHash } from "node:crypto";
import type { Engine } from "./engine/interface.ts";
import type { Storage } from "./storage.ts";
import { lockPageSlugs } from "./pages.ts";
import { deadlockSafeTransaction } from "./retry.ts";
import { bumpDocumentClock, currentDocumentClock } from "./generation.ts";
import { chunkMarkdown, AUTO_MARKDOWN_RECHUNK_VERSION } from "./chunkers/recursive.ts";
import { stripFactsFence } from "./facts-fence.ts";
import { stripTakesFence } from "./synthesis/takes-fence.ts";
import { guardSecrets, SecretRejectedError } from "./secret-scan.ts";
import { compiledTruthHash, PAGE_MIRROR_PATH_SQL, PAGE_TRUTH_PATH_SQL, pageText, serializeCompiledTruth } from "./page-index.ts";

interface AdoptionOptions { source: string; limit?: number }
interface MirrorRow {
  id: string; source_path: string; source_id: string | null; title: string | null;
  frontmatter: Record<string, unknown>; generation: number; chunker_version: number;
  deleted_at: string | null; archived: boolean;
}
interface OwnerRow {
  slug: string; source_id: string; title: string | null; markdown_body: string;
  compiled_truth: unknown; content_hash: string; version: number;
}
interface AdoptionTarget {
  document_id: string; source_path: string; page_slug: string; old_source: null; new_source: string;
  generation: number; content_hash: string; chunks_hash: string; embeddings_hash: string; snapshot_hash: string;
  chunk_owners: Array<{ id: string; source_id: string | null }>;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const ownerMatch = () => `(d.source_path = ${PAGE_MIRROR_PATH_SQL} OR d.source_path = ${PAGE_TRUTH_PATH_SQL})`;

async function prove(engine: Engine, doc: MirrorRow, source: string): Promise<AdoptionTarget | string> {
  if (doc.source_id !== null) return "foreign_owner";
  if (doc.deleted_at !== null || doc.archived) return "retired_mirror";
  const duplicates = await engine.query("SELECT id FROM documents WHERE source_path=$1", [doc.source_path]);
  if (duplicates.rows.length !== 1) return "ambiguous_path";
  const owners = await engine.query<OwnerRow>(`SELECT p.slug,p.source_id,p.title,p.markdown_body,p.compiled_truth,p.content_hash,
    COALESCE((SELECT MAX(v.version_n) FROM page_versions v WHERE v.slug=p.slug),0)::int AS version
    FROM pages p JOIN documents d ON ${ownerMatch()} WHERE d.id=$1 AND p.deleted_at IS NULL ORDER BY p.slug`, [doc.id]);
  if (owners.rows.length !== 1 || owners.rows[0]!.source_id !== source) return "ambiguous_owner";
  const page = owners.rows[0]!;
  const truth = doc.source_path.startsWith("page-truth://");
  const text = truth ? serializeCompiledTruth(page.title, page.slug, page.compiled_truth) : pageText(page.title, page.markdown_body);
  if (!text.trim() || doc.chunker_version < AUTO_MARKDOWN_RECHUNK_VERSION) return "stale_mirror";
  if (truth ? doc.frontmatter?.page_truth_hash !== compiledTruthHash(text)
    : doc.frontmatter?.page_content_hash !== page.content_hash || doc.frontmatter?.page_title !== (page.title ?? "")) return "stale_mirror";
  let guarded: string;
  try { guarded = guardSecrets(text, "mirror-adoption").text; }
  catch (error) { if (error instanceof SecretRejectedError) return "secret_guard"; throw error; }
  const expected = chunkMarkdown(stripTakesFence(stripFactsFence(guarded)));
  const chunks = await engine.query<{ id: string; content: string; chunk_index: number; source_id: string | null }>(
    "SELECT id,content,chunk_index,source_id FROM chunks WHERE document_id=$1 ORDER BY chunk_index,id", [doc.id]);
  if (chunks.rows.some(c => c.source_id !== null && c.source_id !== source)) return "foreign_chunk_owner";
  if (doc.title !== expected.title || chunks.rows.length !== expected.chunks.length ||
    chunks.rows.some((c, i) => c.chunk_index !== i || c.content !== expected.chunks[i])) return "unproven_chunks";
  const fingerprints = (await engine.query<{ chunks_hash: string; embeddings_hash: string; snapshot_hash: string }>(
    `SELECT md5(COALESCE((SELECT jsonb_agg(to_jsonb(c)-'source_id' ORDER BY c.id)::text FROM chunks c WHERE c.document_id=d.id),'')) AS chunks_hash,
       md5(COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.chunk_id,e.model)::text FROM embeddings e JOIN chunks c ON c.id=e.chunk_id WHERE c.document_id=d.id),'')) AS embeddings_hash,
       md5(to_jsonb(d)::text || COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id)::text FROM chunks c WHERE c.document_id=d.id),'')) AS snapshot_hash
       FROM documents d WHERE d.id=$1`, [doc.id])).rows[0]!;
  return { document_id: doc.id, source_path: doc.source_path, page_slug: page.slug, old_source: null, new_source: source,
    generation: Number(doc.generation), content_hash: compiledTruthHash(text), chunks_hash: fingerprints.chunks_hash,
    embeddings_hash: fingerprints.embeddings_hash, snapshot_hash: hash({ page, fingerprints }),
    chunk_owners: chunks.rows.map(c => ({ id: c.id, source_id: c.source_id })) };
}

export async function buildMirrorAdoptionPlan(engine: Engine, opts: AdoptionOptions) {
  const limit = opts.limit ?? 100;
  if (!opts.source || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("mirror-adopt requires --source and --limit 1..200");
  if (!(await engine.query("SELECT id FROM sources WHERE id=$1", [opts.source])).rows.length) throw new Error("mirror-adopt source does not exist");
  const candidates = await engine.query<MirrorRow>(`SELECT d.* FROM documents d
    WHERE EXISTS (SELECT 1 FROM pages p WHERE p.source_id=$1 AND p.deleted_at IS NULL AND ${ownerMatch()})
      AND d.source_id IS DISTINCT FROM $1 ORDER BY d.id LIMIT $2`, [opts.source, limit + 1]);
  const targets: AdoptionTarget[] = [];
  const held: Array<{ document_id: string; reason: string }> = [];
  for (const doc of candidates.rows.slice(0, limit)) {
    const proof = await prove(engine, doc, opts.source);
    if (typeof proof === "string") held.push({ document_id: doc.id, reason: proof });
    else targets.push(proof);
  }
  const selection = { source: opts.source, limit };
  const plan = { selection, targets, held, truncated: candidates.rows.length > limit, cost_usd: 0 };
  return { ...plan, plan_hash: hash(plan) };
}

export async function applyMirrorAdoptionPlan(storage: Storage, opts: AdoptionOptions, planHash: string) {
  if (!planHash) throw new Error("mirror-adopt plan hash is required for apply");
  return deadlockSafeTransaction(storage.engine(), async tx => {
    const initial = await buildMirrorAdoptionPlan(tx, opts);
    if (initial.plan_hash !== planHash) throw new Error("mirror-adopt stale plan hash; preview again");
    await lockPageSlugs(tx, ...initial.targets.map(t => t.page_slug));
    for (const target of initial.targets) {
      await tx.query("SELECT slug FROM pages WHERE slug=$1 FOR UPDATE", [target.page_slug]);
      await tx.query("SELECT id FROM documents WHERE id=$1 FOR UPDATE", [target.document_id]);
      await tx.query("SELECT id FROM chunks WHERE document_id=$1 ORDER BY id FOR UPDATE", [target.document_id]);
      await tx.query("SELECT e.chunk_id FROM embeddings e JOIN chunks c ON c.id=e.chunk_id WHERE c.document_id=$1 ORDER BY e.chunk_id,e.model FOR UPDATE OF e", [target.document_id]);
    }
    const locked = await buildMirrorAdoptionPlan(tx, opts);
    if (locked.plan_hash !== planHash) throw new Error("mirror-adopt stale plan hash; preview again");
    for (const target of locked.targets) {
      const updated = await tx.query("UPDATE documents SET source_id=$2,generation=generation+1 WHERE id=$1 AND source_id IS NULL RETURNING id", [target.document_id, target.new_source]);
      if (updated.rows.length !== 1) throw new Error("mirror-adopt stale owner; preview again");
      await tx.query("UPDATE chunks SET source_id=$2 WHERE document_id=$1 AND source_id IS NULL", [target.document_id, target.new_source]);
    }
    if (locked.targets.length > 0) await bumpDocumentClock(tx);
    const clock = await currentDocumentClock(tx);
    return { ...locked, applied: true, adopted: locked.targets.length,
      document_clock: { before: clock - (locked.targets.length > 0 ? 1 : 0), after: clock },
      receipt: locked.targets.map(t => ({ ...t, old_generation: t.generation, new_generation: t.generation + 1 })) };
  });
}

export async function reconcileUnownedMirrors(storage: Storage, limit: number) {
  const sources = await storage.engine().query<{ source_id: string }>(`SELECT DISTINCT p.source_id FROM pages p
    JOIN documents d ON ${ownerMatch()} WHERE p.deleted_at IS NULL AND d.source_id IS NULL ORDER BY p.source_id`);
  let left = Math.min(limit, 200);
  let adopted = 0;
  const held: string[] = [];
  for (const { source_id } of sources.rows) {
    if (left <= 0) break;
    const plan = await buildMirrorAdoptionPlan(storage.engine(), { source: source_id, limit: left });
    const result = await applyMirrorAdoptionPlan(storage, plan.selection, plan.plan_hash);
    adopted += result.adopted;
    left -= plan.targets.length + plan.held.length;
    held.push(...plan.held.map(h => `${h.document_id}: mirror adoption held (${h.reason})`));
  }
  return { adopted, held };
}
