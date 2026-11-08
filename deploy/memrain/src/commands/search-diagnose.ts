/**
 * `memrain search diagnose ["<query>"] --target <slug> [--source <id>] [--json]`
 * — arm-by-arm retrieval debugger.
 *
 * Traces WHERE a target page surfaces (or fails to) across the pipeline so an
 * operator can pin the responsible layer:
 *
 *   keyword — rank of the target in the FTS arm (ts_rank path)
 *   vector  — rank in the ANN arm (skipped when the query embed fails)
 *   alias   — is the normalized query a registered page_aliases alias of it?
 *   hybrid  — final rank + fused score + evidence + which boosts fired
 *             (explain-mode search, so the attribution is always stamped)
 *
 * memrain adaptation: the raw arms return chunk ids without scores, so the
 * layer probes report ranks only; the hybrid layer carries the scores.
 */
import { Storage } from "../core/storage.ts";
import { withStorage } from "./with-storage.ts";
import { loadConfig } from "../core/config.ts";
import type { Engine } from "../core/engine/interface.ts";
import { keywordSearch } from "../core/search/keyword.ts";
import { vectorSearch } from "../core/search/vector.ts";
import { hybridSearch } from "../core/search/hybrid.ts";
import { slugCandidatesForPath } from "../core/search/page-slug.ts";
import { normalizeAlias, resolveAliasCandidates } from "../core/page-aliases.ts";
import { diagnosePageIndex } from "../core/page-index-state.ts";
import { embedText } from "../core/embedding.ts";

const PROBE_LIMIT = 50;

interface LayerProbe {
  rank: number | null;
  top: string | null;
  note?: string;
}

interface HydratedChunk {
  chunkId: string;
  sourcePath: string;
  sourceId: string | null;
}

/** True when a document source_path plausibly denotes the target slug/path. */
export function pathMatchesTarget(
  sourcePath: string,
  sourceId: string | null | undefined,
  target: string,
): boolean {
  if (sourcePath === target) return true;
  return slugCandidatesForPath(sourcePath, sourceId ?? null).includes(target);
}

async function hydrateChunkPaths(
  engine: Engine,
  chunkIds: readonly string[],
): Promise<HydratedChunk[]> {
  if (chunkIds.length === 0) return [];
  const r = await engine.query<{ id: string; source_path: string; source_id: string | null }>(
    `SELECT c.id, d.source_path, d.source_id
       FROM chunks c JOIN documents d ON d.id = c.document_id
      WHERE c.id = ANY($1::text[])`,
    [chunkIds as string[]],
  );
  const byId = new Map(r.rows.map((row) => [row.id, row]));
  const out: HydratedChunk[] = [];
  for (const id of chunkIds) {
    const row = byId.get(id);
    if (row) out.push({ chunkId: id, sourcePath: row.source_path, sourceId: row.source_id });
  }
  return out;
}

/** Doc-level rank (1-based) of the first chunk whose doc matches the target. */
function docRankOf(chunks: readonly HydratedChunk[], target: string): number | null {
  const seenDocs = new Set<string>();
  let rank = 0;
  for (const c of chunks) {
    if (!seenDocs.has(c.sourcePath)) {
      seenDocs.add(c.sourcePath);
      rank++;
      if (pathMatchesTarget(c.sourcePath, c.sourceId, target)) return rank;
    }
  }
  return null;
}

export interface SearchDiagnoseOptions {
  query: string;
  target: string;
  sourceId?: string;
  json?: boolean;
  configPath?: string;
  /** Test seam — deterministic query embedder (no Bedrock). */
  embedQueryFn?: (text: string) => Promise<number[]>;
}

export async function runSearchDiagnose(
  opts: SearchDiagnoseOptions,
): Promise<number> {
  if (!opts.target) {
    console.error(
      'Usage: memrain search diagnose ["<query>"] --target <slug> [--source <id>] [--json]',
    );
    return 2;
  }
  const storage = new Storage(loadConfig(opts.configPath));
  return withStorage(storage, async () => {
    const engine = storage.engine();
    if (!opts.query.trim()) {
      const report = await diagnosePageIndex(engine, opts.target, opts.sourceId);
      console.log(opts.json ? JSON.stringify(report, null, 2) :
        `${opts.target}: ${report.verdict} — ${report.hint}\n` + report.sources.map(s =>
          `  ${s.source_id}: ${s.verdict}, chunks_without_vector=${s.chunks_without_vector}, last_mirror_failure=${s.last_mirror_failure_at ?? "none"}`).join("\n"));
      return 0;
    }
    const scope = opts.sourceId ? { sourceIds: [opts.sourceId] } : {};
    // Keyword arm.
    let keyword: LayerProbe;
    try {
      const kwIds = await keywordSearch(engine, opts.query, PROBE_LIMIT, scope);
      const kw = await hydrateChunkPaths(engine, kwIds);
      keyword = {
        rank: docRankOf(kw, opts.target),
        top: kw[0]?.sourcePath ?? null,
      };
    } catch (e) {
      keyword = { rank: null, top: null, note: `keyword probe failed: ${msg(e)}` };
    }

    // Vector arm (skipped when the embed fails — no Bedrock, throttled, ...).
    let vector: LayerProbe;
    try {
      const embed = opts.embedQueryFn ?? ((t: string) => embedText(t));
      const qvec = await embed(opts.query);
      const vecIds = await vectorSearch(engine, qvec, PROBE_LIMIT, scope);
      const vec = await hydrateChunkPaths(engine, vecIds);
      vector = { rank: docRankOf(vec, opts.target), top: vec[0]?.sourcePath ?? null };
    } catch (e) {
      vector = { rank: null, top: null, note: `vector probe skipped: ${msg(e)}` };
    }

    // Alias layer.
    const qNorm = normalizeAlias(opts.query);
    let aliasMatch = false;
    try {
      const candidates = await resolveAliasCandidates(
        storage,
        qNorm,
        opts.sourceId ? [opts.sourceId] : undefined,
      );
      aliasMatch = candidates.some((c) => c.slug === opts.target);
    } catch {
      // alias layer is best-effort in the probe
    }

    // Hybrid (production path). Explain mode: attribution always stamped;
    // explain also bypasses the query cache, which a diagnostic wants anyway.
    const hy = await hybridSearch(storage, opts.query, {
      k: PROBE_LIMIT,
      explain: true,
      noCache: true,
      ...(opts.embedQueryFn ? { embedQuery: opts.embedQueryFn } : {}),
      ...(opts.sourceId ? { sourceIds: [opts.sourceId] } : {}),
    });
    let hybridRank: number | null = null;
    const seenDocs = new Set<string>();
    let hyTarget: (typeof hy)[number] | null = null;
    for (const h of hy) {
      if (!seenDocs.has(h.sourcePath)) {
        seenDocs.add(h.sourcePath);
        if (
          hybridRank === null &&
          pathMatchesTarget(h.sourcePath, null, opts.target)
        ) {
          hybridRank = seenDocs.size;
          hyTarget = h;
        }
      }
    }
    const hybrid = {
      rank: hybridRank,
      score: hyTarget?.score ?? null,
      evidence: hyTarget?.evidence ?? null,
      create_safety: hyTarget?.create_safety ?? null,
      factors: hyTarget?.explain ?? null,
      top: hy[0]?.sourcePath ?? null,
    };

    const surfacing: string[] = [];
    if (keyword.rank === 1) surfacing.push("keyword");
    if (vector.rank === 1) surfacing.push("vector");
    if (aliasMatch) surfacing.push("alias");
    if (hybrid.rank === 1) surfacing.push("hybrid(final)");
    const verdict =
      hybrid.rank === 1
        ? `target is rank 1 in hybrid (via: ${surfacing.join(", ") || "unknown"})`
        : hybrid.rank
          ? `target is rank ${hybrid.rank} in hybrid — NOT rank 1. Strongest layer: ${surfacing.join(", ") || "none"}`
          : `target ABSENT from hybrid top-${PROBE_LIMIT}. keyword rank=${keyword.rank ?? "absent"}, vector rank=${vector.rank ?? "absent"}, alias=${aliasMatch}`;

    const report = {
      ok: true,
      query: opts.query,
      target: opts.target,
      source_id: opts.sourceId ?? "(unscoped)",
      keyword,
      vector,
      alias_match: aliasMatch,
      hybrid,
      verdict,
    };

    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
      return 0;
    }

    console.log(`Diagnose: "${opts.query}"  →  target ${opts.target}\n`);
    console.log(
      `  keyword:  rank=${keyword.rank ?? "absent"}  (top: ${keyword.top ?? "—"})${keyword.note ? `  [${keyword.note}]` : ""}`,
    );
    console.log(
      `  vector:   rank=${vector.rank ?? "absent"}  (top: ${vector.top ?? "—"})${vector.note ? `  [${vector.note}]` : ""}`,
    );
    console.log(
      `  alias:    ${aliasMatch ? "query IS a registered alias of the target" : "no alias match"}`,
    );
    console.log(
      `  hybrid:   rank=${hybrid.rank ?? "absent"}  score=${hybrid.score === null ? "—" : hybrid.score.toFixed(4)}  evidence=${hybrid.evidence ?? "—"}  create_safety=${hybrid.create_safety ?? "—"}`,
    );
    if (hybrid.factors) {
      const fired = Object.entries(hybrid.factors)
        .filter(
          ([k, v]) =>
            k !== "base" && k !== "final" && typeof v === "number" && v !== 1,
        )
        .map(([k, v]) => `${k}=${(v as number).toFixed(3)}`)
        .join(" ");
      console.log(`            boosts: ${fired || "(none fired)"}`);
    }
    console.log(`\n  VERDICT: ${verdict}`);
    return 0;
  });
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
