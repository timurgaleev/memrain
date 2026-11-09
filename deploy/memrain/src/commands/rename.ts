import { Storage } from "../core/storage.ts";
import { loadConfig } from "../core/config.ts";
import { renamePage } from "../core/pages.ts";
import { withStorage } from "./with-storage.ts";

export async function runRename(opts: { from: string; to: string; expectedVersion: number; sourceId?: string }): Promise<number> {
  const storage = new Storage(loadConfig());
  return withStorage(storage, async () => {
    const result = await renamePage(storage, opts.from, opts.to, {
      expectedVersion: opts.expectedVersion,
      source_id: opts.sourceId,
      written_by: "rename",
      writtenByPrincipal: "operator",
      manual: true,
    });
    console.log(JSON.stringify({ ok: result.renamed, ...result }, null, 2));
    return result.renamed ? 0 : 1;
  });
}
