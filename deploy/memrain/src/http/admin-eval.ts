/**
 * Admin routes behind the labelling screen for the live eval set:
 *
 *   GET  /admin/api/eval/candidates      captured queries not yet labelled, plus label counts
 *   POST /admin/api/eval/preview         {candidate_id} or {query}: the top ten documents
 *   POST /admin/api/eval/label           {candidate_id | query, expected_doc_ids, tags?, lang?, split?}
 *   POST /admin/api/eval/dismiss         {candidate_id}: drop a capture that is not worth a label
 *   GET  /admin/api/eval/labels          the labelled set
 *   POST /admin/api/eval/labels/delete   {id}: remove one label made here
 *
 * Dispatched from handleAdminApi after its gates (admin session, same-origin
 * on writes, post-enroll cooldown). Captures land in eval_candidates only
 * while `evalCapture.enabled` is set in memrain.yml, and are PII-scrubbed
 * before insert unless the operator turned scrubbing off. A label taken from a
 * candidate uses the stored (scrubbed) text, never text from the request.
 *
 * The preview runs the real hybrid search with the query cache, telemetry,
 * capture and every paid stage off; it costs one query embedding. A label
 * without an explicit split is put in dev or sealed by a hash of the query
 * (three in ten sealed), so the operator's choice cannot lean the sealed set.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Storage } from "../core/storage.ts";
import type { Engine } from "../core/engine/interface.ts";
import { hybridSearch, type SearchOptions } from "../core/search/hybrid.ts";
import { classifyIntentZeroLlm } from "../core/search/intent.ts";
import { isEvalCaptureEnabled, isEvalScrubEnabled } from "../core/eval-capture.ts";

export interface AdminEvalDeps {
  storage: Storage;
  /** Hermetic query embedder (tests only). */
  embedQuery?: SearchOptions["embedQuery"];
}

/** Labelled queries the protocol wants before the live set carries weight. */
export const LIVE_SET_TARGET = 150;
const MAX_BODY = 16 * 1024;
const MAX_QUERY = 500;
const MAX_DOCS = 20;
const MAX_TAGS = 16;
const TAG = /^[a-z0-9]+(?::[a-z0-9-]+)?$/;
const PREVIEW_DOCS = 10;

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const bad = (error: string) => json({ error }, 400);

async function body(req: Request): Promise<Record<string, unknown> | Response> {
  const text = await req.text();
  if (text.length > MAX_BODY) return bad("body too large");
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return bad("invalid JSON body");
    return parsed as Record<string, unknown>;
  } catch {
    return bad("invalid JSON body");
  }
}

const positiveId = (v: unknown): number | null => (Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : null);

/** The query to work on: a candidate's stored text, or a typed query. */
async function resolveQuery(engine: Engine, b: Record<string, unknown>): Promise<{ query: string; candidateId: number | null } | Response> {
  if (b.candidate_id !== undefined) {
    const id = positiveId(b.candidate_id);
    if (id === null) return bad("candidate_id must be a positive integer");
    const r = await engine.query<{ query: string }>(`SELECT query FROM eval_candidates WHERE id = $1`, [id]);
    if (!r.rows[0]) return json({ error: "no such candidate" }, 404);
    return { query: r.rows[0].query, candidateId: id };
  }
  const q = typeof b.query === "string" ? b.query.trim() : "";
  if (q.length === 0 || q.length > MAX_QUERY) return bad(`send candidate_id, or a query of 1 to ${MAX_QUERY} characters`);
  return { query: q, candidateId: null };
}

async function labelCounts(engine: Engine): Promise<{ dev: number; sealed: number; target: number }> {
  const r = await engine.query<{ dev: number; sealed: number }>(
    `SELECT count(*) FILTER (WHERE split IS NULL OR split = 'dev')::int AS dev,
            count(*) FILTER (WHERE split = 'sealed')::int AS sealed
       FROM eval_queries WHERE tag = 'good' AND expected_doc_ids IS NOT NULL`,
  );
  return { dev: r.rows[0]?.dev ?? 0, sealed: r.rows[0]?.sealed ?? 0, target: LIVE_SET_TARGET };
}

/** dev or sealed by a stable hash of the query: three in ten sealed. */
export function hashedSplit(query: string): "dev" | "sealed" {
  const n = createHash("sha256").update(query.trim().toLowerCase()).digest().readUInt32BE(0);
  return n % 10 < 3 ? "sealed" : "dev";
}

async function preview(deps: AdminEvalDeps, query: string) {
  const hits = await hybridSearch(deps.storage, query, {
    k: PREVIEW_DOCS * 3,
    intent: classifyIntentZeroLlm(query),
    noCache: true,
    noTelemetry: true,
    rerank: false,
    graphRerank: false,
    expansion: false,
    noExpansion: true,
    ...(deps.embedQuery ? { embedQuery: deps.embedQuery } : {}),
  });
  const seen = new Set<string>();
  const out: { document_id: string; source_path: string; title: string | null; snippet: string }[] = [];
  for (const h of hits) {
    if (seen.has(h.documentId)) continue;
    seen.add(h.documentId);
    out.push({ document_id: h.documentId, source_path: h.sourcePath, title: h.title, snippet: h.content.slice(0, 240) });
    if (out.length === PREVIEW_DOCS) break;
  }
  return out;
}

async function label(engine: Engine, b: Record<string, unknown>): Promise<Response> {
  const target = await resolveQuery(engine, b);
  if (target instanceof Response) return target;
  const docs = b.expected_doc_ids;
  if (!Array.isArray(docs) || docs.length === 0 || docs.length > MAX_DOCS || !docs.every((d) => typeof d === "string" && d.length > 0 && d.length <= 200)) {
    return bad(`expected_doc_ids must list 1 to ${MAX_DOCS} document ids`);
  }
  const ids = [...new Set(docs as string[])];
  const tags = b.tags === undefined ? [] : b.tags;
  if (!Array.isArray(tags) || tags.length > MAX_TAGS || !tags.every((t) => typeof t === "string" && TAG.test(t))) {
    return bad(`tags must be up to ${MAX_TAGS} labels like "kind:alias" (lowercase letters, digits, one colon)`);
  }
  const lang = b.lang === undefined ? null : b.lang;
  if (lang !== null && (typeof lang !== "string" || !/^[a-z]{2}$/.test(lang))) return bad("lang must be a two-letter code");
  const split = b.split === undefined ? hashedSplit(target.query) : b.split;
  if (split !== "dev" && split !== "sealed") return bad("split must be dev or sealed");
  const found = await engine.query<{ id: string }>(
    `SELECT id FROM documents WHERE id = ANY($1::text[]) AND deleted_at IS NULL`,
    [ids],
  );
  const missing = ids.filter((id) => !found.rows.some((r) => r.id === id));
  if (missing.length > 0) return bad(`no such document: ${missing.slice(0, 3).join(", ")}`);
  if (target.candidateId !== null) {
    const taken = await engine.query(`SELECT 1 FROM eval_queries WHERE candidate_id = $1`, [target.candidateId]);
    if (taken.rows.length > 0) return json({ error: "this candidate is already labelled" }, 409);
  }
  const id = `lbl-${randomUUID()}`;
  try {
    await engine.query(
      `INSERT INTO eval_queries (id, query, k, expected_doc_id, expected_doc_ids, tag, source, tags, lang, split, candidate_id)
       VALUES ($1, $2, 10, $3, $4::jsonb, 'good', 'labelled', $5::text[], $6, $7, $8)`,
      [id, target.query, ids[0], JSON.stringify(ids), tags, lang, split, target.candidateId],
    );
  } catch (e) {
    // The unique candidate index closes the race the check above leaves open.
    if (target.candidateId !== null && /unique|duplicate/i.test(e instanceof Error ? e.message : "")) {
      return json({ error: "this candidate is already labelled" }, 409);
    }
    throw e;
  }
  return json({ ok: true, id, split, labels: await labelCounts(engine) });
}

export async function handleAdminEval(req: Request, url: URL, deps: AdminEvalDeps): Promise<Response | null> {
  const p = url.pathname;
  const engine = deps.storage.engine();
  try {
    if (p === "/admin/api/eval/candidates" && req.method === "GET") {
      const r = await engine.query<{ id: number; captured_at: string; tool_name: string; query: string; scrubbed: boolean; result_count: number }>(
        `SELECT c.id, c.captured_at::text AS captured_at, c.tool_name, c.query, c.scrubbed, c.result_count
           FROM eval_candidates c
          WHERE NOT EXISTS (SELECT 1 FROM eval_queries q WHERE q.candidate_id = c.id)
          ORDER BY c.captured_at DESC, c.id DESC
          LIMIT 100`,
      );
      const config = deps.storage.config();
      return json({
        candidates: r.rows.map((row) => ({ ...row, id: Number(row.id) })),
        labels: await labelCounts(engine),
        capture: { enabled: isEvalCaptureEnabled(config), scrub: isEvalScrubEnabled(config) },
      });
    }
    if (p === "/admin/api/eval/labels" && req.method === "GET") {
      const r = await engine.query<{ id: string; query: string; tags: string[] | null; lang: string | null; split: string | null; expected_doc_ids: string[]; captured_at: string }>(
        `SELECT id, query, tags, lang, split, expected_doc_ids, captured_at::text AS captured_at
           FROM eval_queries WHERE source = 'labelled' ORDER BY captured_at DESC LIMIT 500`,
      );
      return json({ labels: r.rows, counts: await labelCounts(engine) });
    }
    if (req.method !== "POST") return null;
    if (p === "/admin/api/eval/preview") {
      const b = await body(req);
      if (b instanceof Response) return b;
      const target = await resolveQuery(engine, b);
      if (target instanceof Response) return target;
      return json({ query: target.query, results: await preview(deps, target.query) });
    }
    if (p === "/admin/api/eval/label") {
      const b = await body(req);
      return b instanceof Response ? b : await label(engine, b);
    }
    if (p === "/admin/api/eval/dismiss") {
      const b = await body(req);
      if (b instanceof Response) return b;
      const id = positiveId(b.candidate_id);
      if (id === null) return bad("candidate_id must be a positive integer");
      const r = await engine.query(`DELETE FROM eval_candidates WHERE id = $1 RETURNING id`, [id]);
      return json({ ok: true, dismissed: r.rows.length });
    }
    if (p === "/admin/api/eval/labels/delete") {
      const b = await body(req);
      if (b instanceof Response) return b;
      if (typeof b.id !== "string" || !b.id.startsWith("lbl-")) return bad("id must name a label made on this screen");
      const r = await engine.query(`DELETE FROM eval_queries WHERE id = $1 AND source = 'labelled' RETURNING id`, [b.id]);
      return json({ ok: true, deleted: r.rows.length });
    }
  } catch (e) {
    console.error(`[admin-api] eval: ${e instanceof Error ? e.message : String(e)}`);
    return json({ error: "Internal error" }, 500);
  }
  return null;
}
