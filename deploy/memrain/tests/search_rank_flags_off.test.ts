/**
 * With every MEMRAIN_RANK_* flag unset, search must return exactly what it
 * returned before the flags existed: same hits, same order, same scores, same
 * evidence, same explain record, and the same query-cache key. The golden file
 * was captured from the pipeline before any flag was wired in. Regenerate it
 * only for an intended ranking change (MEMRAIN_UPDATE_GOLDEN=1), never to make
 * a flag change pass.
 */
import { afterAll, beforeAll, describe, expect, it, setSystemTime } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  FIXED_NOW,
  RANK_FIXTURE_QUERIES,
  clearRankFlags,
  failingEmbed,
  openRankFixture,
  runSearch,
  type RankFixture,
} from "./rank-flags-fixture.ts";
import { knobsCacheSuffix, resolveSearchKnobs } from "../src/core/search/hybrid.ts";
import { queryCacheKey, rankingSignature } from "../src/core/search/query-cache.ts";
import type { SearchHit } from "../src/core/search/hybrid.ts";
import type { SearchMeta } from "../src/core/search/search-meta.ts";

const GOLDEN = join(import.meta.dir, "fixtures", "rank_flags_off_golden.json");

/** The meta fields that existed before the flags; later additions are not pinned here. */
const PINNED_META_KEYS = ["vectorEnabled", "intent", "mode", "cache", "degraded", "retrieved", "returned"] as const;

function pinMeta(meta: SearchMeta | undefined): Record<string, unknown> | null {
  if (!meta) return null;
  return Object.fromEntries(PINNED_META_KEYS.map((k) => [k, meta[k]]));
}

function pinHits(hits: SearchHit[]): unknown[] {
  return JSON.parse(JSON.stringify(hits));
}

let fx: RankFixture;

beforeAll(async () => {
  clearRankFlags();
  setSystemTime(FIXED_NOW);
  fx = await openRankFixture();
});

afterAll(async () => {
  setSystemTime();
  await fx.close();
});

async function capture(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const q of RANK_FIXTURE_QUERIES) {
    const plain = await runSearch(fx.storage, q);
    const kwOnly = await runSearch(fx.storage, q, { embedQuery: failingEmbed });
    const explained = await runSearch(fx.storage, q, { explain: true });
    const low = await runSearch(fx.storage, q, { detail: "low" });
    out[q] = {
      hits: pinHits(plain.hits),
      meta: pinMeta(plain.meta),
      keywordOnly: { hits: pinHits(kwOnly.hits), meta: pinMeta(kwOnly.meta) },
      explain: pinHits(explained.hits),
      detailLow: pinHits(low.hits),
    };
  }
  const sig = rankingSignature() + knobsCacheSuffix(resolveSearchKnobs({}));
  out["__cache__"] = {
    rankingSignature: rankingSignature(),
    key: queryCacheKey("zephyr rollout", 10, undefined, false, sig),
  };
  return out;
}

describe("ranking flags unset", () => {
  it("search output and cache keys match the pre-flag golden", async () => {
    const actual = await capture();
    if (process.env.MEMRAIN_UPDATE_GOLDEN === "1") {
      writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
    }
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
    expect(actual).toEqual(golden);
  });
});
