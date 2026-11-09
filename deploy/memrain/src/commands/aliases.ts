import { Storage } from "../core/storage.ts";
import { loadConfig } from "../core/config.ts";
import { suggestAliases } from "../core/person-identity.ts";
import { withStorage } from "./with-storage.ts";

export async function runAliasesSuggest(opts: { source?: string; limit?: number; json?: boolean }): Promise<number> {
  const storage = new Storage(loadConfig());
  return withStorage(storage, async () => {
    const report = await suggestAliases(storage.engine(), { ...(opts.source ? { sourceIds: [opts.source] } : {}), limit: opts.limit });
    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else {
      for (const row of report.candidates) console.log(`${row.source_id}:${row.slug} — ${row.alias}`);
      console.log(`${report.candidates.length} candidate(s)${report.truncated ? ' (truncated)' : ''}; review before adding to compiled_truth.aliases; no changes made`);
    }
    return 0;
  });
}
