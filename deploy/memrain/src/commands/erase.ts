import { Storage } from "../core/storage.ts";
import { loadConfig } from "../core/config.ts";
import { applyForgottenErasure, planForgottenErasure, type ErasureTargets } from "../core/forgotten-erasure.ts";
import { withStorage } from "./with-storage.ts";

export interface EraseOptions extends ErasureTargets { sub: string; apply?: boolean; planHash?: string; storage?: Storage }

export async function runErase(opts: EraseOptions): Promise<number> {
  if (opts.sub !== "forgotten") throw new Error("Use erase forgotten with explicit fact IDs or deleted pages");
  if (opts.apply && !opts.planHash) throw new Error("Erasure apply requires the exact preview plan hash");
  const storage = opts.storage ?? new Storage(loadConfig());
  return withStorage(storage, async () => {
    const result = opts.apply ? await applyForgottenErasure(storage.engine(), opts, opts.planHash!)
      : await planForgottenErasure(storage.engine(), opts);
    console.log(JSON.stringify({ ok: result.blockers.length === 0, dry_run: !opts.apply, ...result }, null, 2));
    return result.blockers.length === 0 ? 0 : 2;
  }, { owned: !opts.storage, migrate: false });
}
