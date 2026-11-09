import { Storage } from "../core/storage.ts";
import { loadConfig } from "../core/config.ts";
import { buildMirrorAdoptionPlan, applyMirrorAdoptionPlan } from "../core/page-mirror-adoption.ts";
import { withStorage } from "./with-storage.ts";

export interface MirrorAdoptOptions { source: string; limit?: number; apply?: boolean; planHash?: string; storage?: Storage }

export async function runMirrorAdopt(opts: MirrorAdoptOptions): Promise<number> {
  if (opts.apply && !opts.planHash) throw new Error("mirror-adopt plan hash is required for apply");
  const storage = opts.storage ?? new Storage(loadConfig());
  return withStorage(storage, async () => {
    const result = opts.apply ? await applyMirrorAdoptionPlan(storage, opts, opts.planHash!)
      : await buildMirrorAdoptionPlan(storage.engine(), opts);
    console.log(JSON.stringify({ ok: true, dry_run: !opts.apply, ...result }, null, 2));
    return 0;
  }, { owned: !opts.storage, migrate: false });
}
