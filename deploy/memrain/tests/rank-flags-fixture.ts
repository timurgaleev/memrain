/**
 * Shared corpus for the MEMRAIN_RANK_* flag tests. Each document exists to put
 * one ranking stage in play (a metadata boost on a vector-only query, a
 * compiled-truth mirror, an AND-miss the OR retry can recover, a tied keyword
 * arm, a page named only by its title). Every document carries a frontmatter
 * date so recency is computed against a fixed clock, never the wall clock.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { writeDocumentTransaction } from "../src/core/indexer-tx.ts";
import { hybridSearch, type SearchHit, type SearchOptions } from "../src/core/search/hybrid.ts";
import type { SearchMeta } from "../src/core/search/search-meta.ts";
import { RANKING_FLAG_ENV } from "../src/core/search/ranking-flags.ts";
import { deterministicEmbed, deterministicEmbedQuery } from "./det-embed.ts";

export const FIXED_NOW = new Date("2026-07-01T12:00:00Z");

interface FixtureDoc {
  id: string;
  path: string;
  title: string;
  frontmatter?: Record<string, unknown>;
  chunks: string[];
}

export const RANK_FIXTURE_DOCS: FixtureDoc[] = [
  // Vector-only voters: "automobile servicing" reaches these through the
  // embedder's synonym table and through no keyword or title.
  { id: "car_a", path: "notes/car-a", title: "Car log", chunks: ["car maintenance schedule"] },
  {
    id: "car_b",
    path: "notes/car-b",
    title: "Car tips",
    frontmatter: { weight: 2 },
    chunks: ["car maintenance tips for winter tires and the spare wheel kit"],
  },
  // A page and its compiled-truth mirror.
  {
    id: "zephyr_page",
    path: "page://projects/zephyr",
    title: "Zephyr",
    chunks: ["zephyr rollout plan for the edge fleet", "zephyr rollout risks and the rollback drill"],
  },
  {
    id: "zephyr_truth",
    path: "page-truth://projects/zephyr",
    title: "Zephyr",
    chunks: ["zephyr is the edge fleet rollout program"],
  },
  { id: "rollout_cal", path: "notes/rollout-calendar", title: "Rollout calendar", chunks: ["rollout calendar for the quarter"] },
  // No chunk holds all of "quokka habitat survey".
  { id: "quokka", path: "notes/quokka", title: "Island trip", chunks: ["quokka habitat notes from the island trip"] },
  { id: "survey", path: "notes/survey-archive", title: "Survey archive", chunks: ["survey results archive"] },
  // "vehicle repair": two keyword rows tied, a vector winner neither names.
  { id: "veh_v", path: "notes/garage", title: "Garage", chunks: ["car maintenance"] },
  { id: "veh_k1", path: "notes/invoice", title: "Invoice", chunks: ["vehicle repair invoice paper stack folder"] },
  { id: "veh_k2", path: "notes/receipt", title: "Receipt", chunks: ["vehicle repair receipt paper stack folder"] },
  // A page named only by its title, out-voted by bodies that repeat the name.
  { id: "quand", path: "notes/quandalore", title: "Quandalore", chunks: ["tool rental platform for craft businesses"] },
  { id: "quand_price", path: "notes/q-pricing", title: "Pricing", chunks: ["quandalore pricing notes quandalore quandalore"] },
  { id: "quand_onb", path: "notes/q-onboarding", title: "Onboarding", chunks: ["quandalore onboarding quandalore"] },
];

export const RANK_FIXTURE_QUERIES = [
  "automobile servicing",
  "tell me about zephyr",
  "zephyr rollout",
  "quokka habitat survey",
  "vehicle repair",
  "Quandalore",
  "car maintenance",
] as const;

export interface RankFixture {
  storage: Storage;
  close: () => Promise<void>;
}

export async function openRankFixture(
  extra: FixtureDoc[] = [],
): Promise<RankFixture> {
  const dir = mkdtempSync(join(tmpdir(), "memrain-rank-flags-"));
  const storage = new Storage({ dbPath: join(dir, "db") });
  await storage.init();
  for (const d of [...RANK_FIXTURE_DOCS, ...extra]) {
    await writeDocumentTransaction(
      storage,
      {
        documentId: d.id,
        sourcePath: d.path,
        title: d.title,
        frontmatter: { date: "2026-06-01", ...d.frontmatter },
        embeddingModel: "deterministic-test",
      },
      d.chunks.map((text) => ({ text, entities: [], embedding: deterministicEmbed(text) })),
    );
  }
  return {
    storage,
    close: async () => {
      await storage.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function clearRankFlags(): void {
  for (const name of RANKING_FLAG_ENV) delete process.env[name];
}

export async function withRankFlag<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env[name];
  process.env[name] = "1";
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

export async function failingEmbed(): Promise<number[]> {
  throw new Error("embedder down");
}

export async function runSearch(
  storage: Storage,
  query: string,
  opts: SearchOptions = {},
): Promise<{ hits: SearchHit[]; meta: SearchMeta | undefined }> {
  let meta: SearchMeta | undefined;
  const hits = await hybridSearch(storage, query, {
    k: 10,
    noExpansion: true,
    noCache: true,
    embedQuery: deterministicEmbedQuery,
    onMeta: (m) => {
      meta = m;
    },
    ...opts,
  });
  return { hits, meta };
}
