/**
 * A small fixed code-retrieval eval over this repository's own source.
 *
 * Each question describes a function in plain words and names the file and
 * exported symbol that answers it. A run asks the real hybridSearch, takes the
 * distinct files in rank order and scores hit@k on the expected path; it runs
 * every question several times and reports how many kept the same first file.
 *
 * A question counts only when the code graph knows its symbol at that path
 * (a code_def lookup): an unindexed answer is a stale question or a partial
 * index, not a retrieval miss. And nothing is scored unless the code index
 * reports `ready` — on any other state zero hits mean "unknown".
 */
import type { Storage } from "../core/storage.ts";
import { hybridSearch } from "../core/search/hybrid.ts";
import { codeDefs, codeIndexReadiness, type CodeIndexState } from "../core/code-graph.ts";
import { distinctInOrder } from "../core/search/metrics.ts";

export interface CodeRetrievalQuestion {
  id: string;
  query: string;
  /** Path of the answering file, relative to deploy/memrain. */
  path: string;
  /** Exported function defined in that file. */
  symbol: string;
}

export const CODE_RETRIEVAL_QUESTIONS: readonly CodeRetrievalQuestion[] = [
  { id: "c01", query: "price the worst case cost of a paid Bedrock call before it is sent", path: "src/core/budget.ts", symbol: "worstCaseUsd" },
  { id: "c02", query: "per million token price lookup by model family substring", path: "src/core/budget.ts", symbol: "priceFor" },
  { id: "c03", query: "frontmatter marker that keeps a page out of embedding but keyword searchable", path: "src/core/embed-skip.ts", symbol: "isEmbedSkipped" },
  { id: "c04", query: "embed one text string with Titan into a vector", path: "src/core/embedding.ts", symbol: "embedText" },
  { id: "c05", query: "reciprocal rank fusion of ranked result lists", path: "src/core/rrf.ts", symbol: "reciprocalRankFusion" },
  { id: "c06", query: "build the context prefix with title and synopsis before embedding a chunk", path: "src/core/search/contextual-embed.ts", symbol: "buildContextualPrefix" },
  { id: "c07", query: "strip the takes fence from a page body before chunking", path: "src/core/synthesis/takes-fence.ts", symbol: "stripTakesFence" },
  { id: "c08", query: "remove the facts fence block from markdown", path: "src/core/facts-fence.ts", symbol: "stripFactsFence" },
  { id: "c09", query: "split markdown into overlapping chunks", path: "src/core/chunkers/recursive.ts", symbol: "chunkMarkdown" },
  { id: "c10", query: "resolve the Bedrock model id for a tier from env override", path: "src/core/llm/resolve-model.ts", symbol: "resolveModel" },
  { id: "c11", query: "call Sonnet through Bedrock Converse and return token usage", path: "src/core/llm/sonnet.ts", symbol: "callSonnet" },
  { id: "c12", query: "is the code index built, indexing or ready", path: "src/core/code-graph.ts", symbol: "codeIndexReadiness" },
  { id: "c13", query: "why is a page missing from search: index state and repair hint", path: "src/core/page-index-state.ts", symbol: "diagnosePageIndex" },
  { id: "c14", query: "open storage, run a command body, always close it", path: "src/commands/with-storage.ts", symbol: "withStorage" },
  { id: "c15", query: "parse command line arguments into flags values and positionals", path: "src/cli-args.ts", symbol: "parseArgs" },
  { id: "c16", query: "refuse an unknown or misplaced command line flag", path: "src/cli-args.ts", symbol: "validateFlags" },
  { id: "c17", query: "doctor check for chunks waiting for a vector", path: "src/core/doctor-embed.ts", symbol: "checkEmbedBacklog" },
  { id: "c18", query: "pages vector search cannot return with state and reason", path: "src/core/vector-visibility.ts", symbol: "vectorInvisiblePages" },
  { id: "c19", query: "recall at k over expected paths", path: "src/core/search/metrics.ts", symbol: "recallAtK" },
];

export interface CodeRetrievalQuestionResult extends CodeRetrievalQuestion {
  /** The code graph knows `symbol` in a file at `path`. */
  indexed: boolean;
  /** `path` was among the first k distinct files on the first run. */
  hit: boolean;
  /** 1-based position of `path` among the distinct files, or null. */
  rank: number | null;
  /** First file of each run. */
  top1: (string | null)[];
}

export interface CodeRetrievalReport {
  /** "unknown" when the code index is not ready: nothing was searched. */
  state: "scored" | "unknown";
  readiness: CodeIndexState;
  k: number;
  runs: number;
  questions: CodeRetrievalQuestionResult[];
  /** Questions whose answer the code graph knows — the denominator. */
  scored: number;
  /** Share of scored questions hit within k, or null when none could be scored. */
  hit_at_k: number | null;
  /** Scored questions whose first file was the same on every run. */
  top1_stable: number;
}

export interface CodeRetrievalOptions {
  questions?: readonly CodeRetrievalQuestion[];
  k?: number;
  runs?: number;
  /** Deterministic query embedder for offline tests; production embeds with Titan. */
  embedQuery?: (text: string) => Promise<number[]>;
}

/** A stored code path is absolute on the indexing host; match it by suffix. */
export function pathMatches(sourcePath: string, expected: string): boolean {
  return sourcePath === expected || sourcePath.endsWith(`/${expected}`);
}

export async function runCodeRetrievalEval(
  storage: Storage,
  opts: CodeRetrievalOptions = {},
): Promise<CodeRetrievalReport> {
  const questions = opts.questions ?? CODE_RETRIEVAL_QUESTIONS;
  const k = opts.k ?? 5;
  const runs = opts.runs ?? 3;
  const engine = storage.engine();
  const readiness = (await codeIndexReadiness(engine)).state;
  if (readiness !== "ready") {
    return { state: "unknown", readiness, k, runs, questions: [], scored: 0, hit_at_k: null, top1_stable: 0 };
  }

  const results: CodeRetrievalQuestionResult[] = [];
  for (const q of questions) {
    const defs = await codeDefs(engine, q.symbol);
    const indexed = defs.mentions.some((m) => pathMatches(m.source_path, q.path));
    const top1: (string | null)[] = [];
    let rank: number | null = null;
    for (let run = 0; run < runs; run++) {
      const hits = await hybridSearch(storage, q.query, {
        k: Math.max(k * 4, 20),
        noCache: true,
        noTelemetry: true,
        ...(opts.embedQuery ? { embedQuery: opts.embedQuery } : {}),
      });
      const paths = distinctInOrder(hits.map((h) => h.sourcePath));
      top1.push(paths[0] ?? null);
      if (run === 0) {
        const at = paths.slice(0, k).findIndex((p) => pathMatches(p, q.path));
        rank = at === -1 ? null : at + 1;
      }
    }
    results.push({ ...q, indexed, hit: rank !== null, rank, top1 });
  }

  const scored = results.filter((r) => r.indexed);
  return {
    state: "scored",
    readiness,
    k,
    runs,
    questions: results,
    scored: scored.length,
    hit_at_k: scored.length === 0 ? null : scored.filter((r) => r.hit).length / scored.length,
    top1_stable: scored.filter((r) => r.top1.every((p) => p === r.top1[0])).length,
  };
}
