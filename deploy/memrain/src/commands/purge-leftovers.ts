import { Storage } from "../core/storage.ts";
import { loadConfig } from "../core/config.ts";
import { planDerivedCleanup } from "../core/derived-cleanup.ts";
import { applyPurgeLeftovers, restorePurgeLeftovers } from "../core/purge-leftovers.ts";
import { clearPageTombstones } from "../core/pages-purge.ts";
import { withStorage } from "./with-storage.ts";

/** What to run when some page could not be mirrored back into search right away. */
function mirrorNext(failed: readonly string[]): { next?: string } {
  return failed.length > 0 ? { next: "the hourly housekeeping of memrain serve re-mirrors them" } : {};
}

export interface PurgeLeftoversOptions {
  sub?: "restore";
  apply?: boolean;
  planHash?: string;
  exportPath?: string;
  from?: string;
  storage?: Storage;
}

/** Dry run by default: prints the frozen plan. `--apply` needs its hash and an export path; `restore` undoes an apply. */
export async function runPurgeLeftovers(opts: PurgeLeftoversOptions): Promise<number> {
  if (opts.sub === "restore") {
    if (!opts.from) throw new Error("purge-leftovers restore: --from EXPORT is required");
  } else if (opts.apply) {
    if (!/^[a-f0-9]{64}$/.test(opts.planHash ?? "")) throw new Error("purge-leftovers: --apply needs the 64-character --plan-hash from the preview");
    if (!opts.exportPath) throw new Error("purge-leftovers: --apply needs --export FILE (a new file) for the rows it changes");
  } else if (opts.planHash !== undefined || opts.exportPath !== undefined) {
    throw new Error("purge-leftovers: --plan-hash and --export are only valid with --apply");
  }
  const storage = opts.storage ?? new Storage(loadConfig());
  return withStorage(storage, async () => {
    const engine = storage.engine();
    if (opts.sub === "restore") {
      const restored = await restorePurgeLeftovers(engine, opts.from!, { storage });
      console.log(JSON.stringify({ ok: true, restored, ...mirrorNext(restored.mirrors.failed) }));
      return 0;
    }
    if (!opts.apply) {
      console.log(JSON.stringify({ ok: true, dry_run: true, ...await planDerivedCleanup(engine, { orphans: true }) }));
      return 0;
    }
    const r = await applyPurgeLeftovers(engine, { planHash: opts.planHash!, exportPath: opts.exportPath!, storage });
    console.log(JSON.stringify({ ok: true, dry_run: false, plan_hash: r.plan.plan_hash, summary: r.plan.summary,
      result: r.result, export_path: r.export_path, purge_id: r.purge_id, mirrors: r.mirrors, ...mirrorNext(r.mirrors.failed) }));
    return 0;
  }, { owned: !opts.storage, migrate: false });
}

export async function runUnpurge(opts: { slug: string; source?: string; storage?: Storage }): Promise<number> {
  if (!opts.slug?.trim()) throw new Error("unpurge: name the purged page's slug");
  const storage = opts.storage ?? new Storage(loadConfig());
  return withStorage(storage, async () => {
    const cleared = await clearPageTombstones(storage.engine(), opts.slug, opts.source ?? "default");
    console.log(JSON.stringify({ ok: true, slug: opts.slug, source_id: opts.source ?? "default", cleared }));
    return 0;
  }, { owned: !opts.storage, migrate: false });
}
