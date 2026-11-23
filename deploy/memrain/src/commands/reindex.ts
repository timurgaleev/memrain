/**
 * `memrain reindex [--all] [--vault PATH] [--reconcile-deletes] [--allow-mass-delete]`
 *
 * Manual sweep of the markdown vault.
 *
 * Use cases:
 *   - first-time bootstrap of a markdown tree (or a full re-index via `--all`)
 *   - after schema changes that invalidate stored chunks
 *   - debugging
 *
 * Without `--all`, this is an incremental sweep: only re-index files newer
 * than their last_indexed_mtime.
 *
 * `--reconcile-deletes` (default OFF) additionally soft-deletes vault
 * documents whose file was removed from disk since the last index, so a
 * deleted note stops surfacing as stale evidence. Scoped to the swept vault
 * root only.
 */
import { Storage } from "../core/storage.ts";
import { withStorage } from "./with-storage.ts";
import { sweepVault, type SweepResult } from "../core/sweep.ts";
import { loadConfig } from "../core/config.ts";

export interface ReindexCommandOptions {
  all?: boolean;
  vault?: string;
  /**
   * Soft-delete vault documents whose file no longer exists on disk (deletion-
   * reconcile). Default OFF.
   */
  reconcileDeletes?: boolean;
  /** Let `--reconcile-deletes` retire more than 50 documents, or more than 25% of the vault. */
  allowMassDelete?: boolean;
}

interface VaultReindexResult {
  kind: "vault";
  vault: string;
  result: SweepResult;
}

function resolveVaultPath(
  config: ReturnType<typeof loadConfig>,
  override: string | undefined,
): string | null {
  return (
    override ??
    process.env.MEMRAIN_VAULT_PATH ??
    config.storage.vault ??
    null
  );
}

export async function runReindex(
  opts: ReindexCommandOptions,
): Promise<void> {
  const config = loadConfig();
  const vault = resolveVaultPath(config, opts.vault);
  if (!vault) {
    throw new Error(
      "memrain reindex: vault path is required (--vault PATH, $MEMRAIN_VAULT_PATH, or storage.vault in config.json)",
    );
  }
  const storage = new Storage(config);
  return withStorage(storage, async () => {
    const result = await sweepVault(storage, {
      vault,
      force: opts.all ?? false,
      forceStaleChunker: false,
      reconcileDeletes: opts.reconcileDeletes ?? false,
      allowMassDelete: opts.allowMassDelete ?? false,
    });
    const out: VaultReindexResult[] = [{ kind: "vault", vault, result }];
    console.log(JSON.stringify({ ok: true, runs: out }, null, 2));
  });
}
