/**
 * `memrain code prune` / `memrain code restore` — the operator side of the code
 * sweep's prune of deleted files (core/code-prune.ts).
 *
 *   code prune [--paths CSV] [--apply] [--allow-mass-delete]
 *       Dry run by default: per root, the live code documents, how many have no
 *       file, and whether the valve would withhold them. `--apply` retires them;
 *       `--allow-mass-delete` is the only way past the valve. Also prunes the
 *       documents an operator restored before, which the automatic pass skips.
 *   code restore <doc-id> | --sweep <id>
 *       Makes a pruned document, or every document of one pass, live again.
 *   code restore [--limit N]
 *       Lists the most recent prune passes and their sweep ids.
 */
import { Storage } from "../core/storage.ts";
import { loadConfig } from "../core/config.ts";
import { listCodePruneRuns, pruneCodeRoots, restoreCodePrunes } from "../core/code-prune.ts";
import { walkCodeRoot } from "../core/sweep-code.ts";
import { withStorage } from "./with-storage.ts";

function csv(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

export interface CodePruneCommandOptions {
  paths?: string;
  apply?: boolean;
  allowMassDelete?: boolean;
  storage?: Storage;
}

export async function runCodePrune(opts: CodePruneCommandOptions): Promise<number> {
  const paths = csv(opts.paths ?? process.env.MEMRAIN_CODE_PATHS);
  if (paths.length === 0) {
    throw new Error("code prune: no code roots (pass --paths CSV or set MEMRAIN_CODE_PATHS)");
  }
  if (opts.allowMassDelete && !opts.apply) {
    throw new Error("code prune: --allow-mass-delete only goes with --apply");
  }
  const storage = opts.storage ?? new Storage(loadConfig());
  return withStorage(storage, async () => {
    const evidence = paths.map((p) => walkCodeRoot(p));
    const r = await pruneCodeRoots(storage.engine(), evidence, {
      trigger: "cli",
      apply: opts.apply === true,
      allowMassDelete: opts.allowMassDelete === true,
      includeHeld: true,
    });
    console.log(JSON.stringify({ ok: true, dry_run: opts.apply !== true, ...r }, null, 2));
    return 0;
  }, { owned: !opts.storage });
}

export interface CodeRestoreCommandOptions {
  documentId?: string;
  sweepId?: string;
  limit?: number;
  storage?: Storage;
}

export async function runCodeRestore(opts: CodeRestoreCommandOptions): Promise<number> {
  if (opts.documentId && opts.sweepId) {
    throw new Error("code restore: name a document id or --sweep <id>, not both");
  }
  const storage = opts.storage ?? new Storage(loadConfig());
  return withStorage(storage, async () => {
    const engine = storage.engine();
    if (!opts.documentId && !opts.sweepId) {
      console.log(JSON.stringify({ ok: true, runs: await listCodePruneRuns(engine, opts.limit ?? 20) }, null, 2));
      return 0;
    }
    const target = opts.sweepId ? { sweepId: opts.sweepId } : { documentId: opts.documentId! };
    const r = await restoreCodePrunes(engine, target, "cli");
    const found = r.restored.length + r.purged.length + r.superseded.length;
    console.log(JSON.stringify({ ok: found > 0, ...target, ...r }, null, 2));
    return found > 0 ? 0 : 1;
  }, { owned: !opts.storage });
}
