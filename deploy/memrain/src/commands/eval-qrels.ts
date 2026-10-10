/**
 * `memrain eval qrels build` — turn the captured eval set into a qrels file.
 *
 *   eval qrels build --out PATH.local.json [--sealed-fraction 0.3] [--seed 42]
 *                    [--expected-top1 id,id,...]
 *
 * Every eval_queries row that names a live expected document becomes one qrel
 * whose expected path is that document's source_path. A query lands in the
 * sealed split when sha256("<seed>:<id>") falls below the fraction, so the
 * split is stable across rebuilds and a query never moves between dev and
 * sealed as the set grows.
 *
 * The file is built from the operator's own queries, so it is written 0600
 * and must be named *.local.json, which git ignores.
 */
import { chmodSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { Storage } from "../core/storage.ts";
import { withStorage } from "./with-storage.ts";
import { loadConfig } from "../core/config.ts";
import type { Qrel, Qrels } from "./eval.ts";

export interface CapturedQuery {
  id: string;
  query: string;
  source_path: string;
}

export interface QrelsBuildOptions {
  sealedFraction: number;
  seed: number;
  expectedTop1?: ReadonlySet<string>;
}

/** Deterministic split membership; the seed is a salt so another seed draws another split. */
export function isSealed(id: string, seed: number, fraction: number): boolean {
  const h = createHash("sha256").update(`${seed}:${id}`).digest();
  return h.readUInt32BE(0) / 2 ** 32 < fraction;
}

export function buildQrels(rows: readonly CapturedQuery[], opts: QrelsBuildOptions): Qrels {
  const queries: Qrel[] = [...rows]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((r) => ({
      id: r.id,
      query: r.query,
      expected_paths: [r.source_path],
      split: isSealed(r.id, opts.seed, opts.sealedFraction) ? "sealed" : "dev",
      ...(opts.expectedTop1?.has(r.id) ? { expected_top1: true as const } : {}),
    }));
  return { queries };
}

export interface EvalQrelsBuildOptions {
  out: string;
  sealedFraction?: number;
  seed?: number;
  expectedTop1?: string[];
  configPath?: string;
}

export async function runEvalQrelsBuild(opts: EvalQrelsBuildOptions): Promise<number> {
  if (!opts.out.endsWith(".local.json")) {
    console.error("memrain eval qrels build: --out must end in .local.json (kept out of git)");
    return 1;
  }
  const sealedFraction = opts.sealedFraction ?? 0.3;
  const seed = opts.seed ?? 42;
  const storage = new Storage(loadConfig(opts.configPath));
  const rows = await withStorage(storage, async () => {
    const r = await storage.engine().query<CapturedQuery>(
      `SELECT q.id, q.query, d.source_path
         FROM eval_queries q
         JOIN documents d ON d.id = q.expected_doc_id AND d.deleted_at IS NULL
        WHERE q.expected_doc_id IS NOT NULL
        ORDER BY q.id`,
    );
    return r.rows;
  });
  const top1 = new Set(opts.expectedTop1 ?? []);
  const known = new Set(rows.map((r) => r.id));
  const unknown = [...top1].filter((id) => !known.has(id));
  if (unknown.length > 0) {
    console.error(
      `memrain eval qrels build: --expected-top1 names queries with no live expected document: ${unknown.join(", ")}`,
    );
    return 1;
  }
  const qrels = buildQrels(rows, { sealedFraction, seed, expectedTop1: top1 });
  if (qrels.queries.length === 0) {
    console.error("memrain eval qrels build: no captured query names a live expected document");
    return 1;
  }
  mkdirSync(dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, JSON.stringify(qrels, null, 2) + "\n", { mode: 0o600 });
  // `mode` applies only when the file is created; a rebuild keeps the old one.
  chmodSync(opts.out, 0o600);
  const sealed = qrels.queries.filter((q) => q.split === "sealed").length;
  console.log(
    JSON.stringify(
      {
        ok: true,
        out: opts.out,
        queries: qrels.queries.length,
        dev: qrels.queries.length - sealed,
        sealed,
        expected_top1: top1.size,
        sealed_fraction: sealedFraction,
        seed,
      },
      null,
      2,
    ),
  );
  return 0;
}
