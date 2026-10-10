/**
 * `memrain spend [--days N]` — where the LLM money went over the last N days
 * (default 7): by model, by feature, by spender, by cycle phase and by job,
 * how the calls ended and how long they took, the calls the totals cannot
 * price, and today's spend against the brain-wide and cycle daily caps.
 */
import { spendReport } from "../core/spend-report.ts";
import { loadConfig } from "../core/config.ts";
import { Storage } from "../core/storage.ts";
import { withStorage } from "./with-storage.ts";

export async function runSpend(opts: { days?: number } = {}): Promise<void> {
  const storage = new Storage(loadConfig());
  await withStorage(storage, async () => {
    console.log(JSON.stringify(await spendReport(storage.engine(), opts), null, 2));
  });
}
