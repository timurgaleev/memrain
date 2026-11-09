import { Storage } from "../core/storage.ts";
import { loadConfig } from "../core/config.ts";
import { planAtomRetirement, applyAtomRetirement } from "../core/synthesis/atoms-lifecycle.ts";
import { withStorage } from "./with-storage.ts";

export interface AtomsRetireOptions {
  sourceRef: string;
  completedHash: string;
  apply?: boolean;
  planHash?: string;
  storage?: Storage;
}

export async function runAtomsRetire(opts: AtomsRetireOptions): Promise<number> {
  if (!opts.sourceRef?.trim() || opts.sourceRef.length > 500 || !/^[a-f0-9]{16}$/.test(opts.completedHash ?? "")) {
    throw new Error("atoms-retire: --source-ref and a 16-character --completed-hash are required");
  }
  if (opts.apply && !opts.planHash) throw new Error("atoms-retire: plan hash is required for apply");
  if (opts.planHash !== undefined && (!opts.apply || !/^[a-f0-9]{64}$/.test(opts.planHash))) {
    throw new Error("atoms-retire: --plan-hash requires --apply and a 64-character hash");
  }
  const storage = opts.storage ?? new Storage(loadConfig());
  return withStorage(storage, async () => {
    const plan = await planAtomRetirement(storage.engine(), opts.sourceRef, opts.completedHash);
    if (!opts.apply) {
      console.log(JSON.stringify({ ok: true, dry_run: true, ...plan }));
      return 0;
    }
    if (plan.plan_hash !== opts.planHash) throw new Error("atoms-retire: stale plan hash; preview again");
    const result = await applyAtomRetirement(storage, plan);
    const complete = result.held === 0 && !plan.truncated;
    console.log(JSON.stringify({ ok: complete, dry_run: false, source: plan.source, plan_hash: plan.plan_hash,
      ...result, truncated: plan.truncated }));
    return complete ? 0 : 1;
  }, { owned: !opts.storage, migrate: false });
}
