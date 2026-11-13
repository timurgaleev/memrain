/**
 * `memrain search invisible [--source <id>] [--limit N] [--json]` — list the
 * pages vector search can never return, with the state and reason for each.
 * Read-only; at most --limit pages (default 100, max 1000) per run.
 */
import { Storage } from "../core/storage.ts";
import { withStorage } from "./with-storage.ts";
import { loadConfig } from "../core/config.ts";
import { VECTOR_VISIBILITY_MAX_LIMIT, vectorInvisiblePages } from "../core/vector-visibility.ts";

export interface SearchInvisibleOptions {
  sourceId?: string;
  limit?: number;
  json?: boolean;
  configPath?: string;
  /** An open Storage the caller owns. */
  storage?: Storage;
}

const DEFAULT_LIMIT = 100;

export async function runSearchInvisible(opts: SearchInvisibleOptions): Promise<number> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > VECTOR_VISIBILITY_MAX_LIMIT) {
    console.error(`memrain search invisible: --limit must be an integer from 1 to ${VECTOR_VISIBILITY_MAX_LIMIT}`);
    return 2;
  }
  const storage = opts.storage ?? new Storage(loadConfig(opts.configPath));
  return withStorage(storage, async () => {
    const report = await vectorInvisiblePages(storage.engine(), {
      limit,
      ...(opts.sourceId ? { sourceId: opts.sourceId } : {}),
    });
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
      return 0;
    }
    const c = report.counts;
    console.log(
      `Vector-invisible pages (${report.source_id ?? "all sources"}): ` +
        `empty=${c.empty} skip=${c.skip} failed=${c.failed} chunkless_healable=${c.chunkless_healable}; ` +
        `embedded=${c.embedded}${report.truncated ? `; list cut at ${report.limit}` : ""}`,
    );
    for (const p of report.pages) {
      console.log(`  ${p.source_id}:${p.slug}  ${p.state} — ${p.reason}`);
    }
    return 0;
  }, { owned: opts.storage === undefined });
}
