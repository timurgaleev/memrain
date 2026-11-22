/**
 * `memrain search <query> [--k N] [--explain]` — hybrid retrieve from the CLI.
 *
 * Outputs JSON to stdout so it pipes cleanly into jq. `--explain` stamps
 * per-signal ranking attribution on every hit (JSON `explain` field) and
 * prints the human-readable breakdown to stderr.
 * The JSON carries the search `meta`; an empty result also gets a one-line
 * reason on stderr, so "nothing matched" and "the vector arm was down" read
 * differently.
 */
import { Storage } from "../core/storage.ts";
import { withStorage } from "./with-storage.ts";
import { hybridSearch } from "../core/search/index.ts";
import { formatExplainList } from "../core/search/explain.ts";
import { formatDegradedNotice, type SearchMeta } from "../core/search/search-meta.ts";
import { loadConfig } from "../core/config.ts";
import { federatedReadScope } from "../core/sources.ts";

export interface SearchCommandOptions {
  query: string;
  k?: number;
  explain?: boolean;
  configPath?: string;
}

export async function runSearch(
  opts: SearchCommandOptions,
): Promise<void> {
  if (!opts.query || !opts.query.trim()) {
    throw new Error("memrain search: <query> is required");
  }
  const config = loadConfig(opts.configPath);
  const storage = new Storage(config);
  return withStorage(storage, async () => {
    let meta: SearchMeta | undefined;
    // An unqualified search reads the default and federated sources only.
    const sourceIds = await federatedReadScope(storage.engine(), undefined);
    const hits = await hybridSearch(storage, opts.query, {
      ...(opts.k ? { k: opts.k } : {}),
      ...(sourceIds ? { sourceIds } : {}),
      ...(opts.explain ? { explain: true } : {}),
      onMeta: (m) => {
        meta = m;
      },
    });
    console.log(JSON.stringify({ ok: true, hits, ...(meta ? { meta } : {}) }, null, 2));
    if (opts.explain) {
      // Human-readable attribution on stderr — stdout stays pipeable JSON.
      process.stderr.write(formatExplainList(hits));
    }
    if (hits.length === 0 && meta) {
      process.stderr.write(`${formatDegradedNotice(meta)}\n`);
    }
  });
}
