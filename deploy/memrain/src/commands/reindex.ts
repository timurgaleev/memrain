/**
 * `memrain reindex [--source vault|code|all] [--all] [--vault PATH] [--paths CSV]`
 *
 * Manual sweep trigger.
 *
 * Use cases:
 *   - first-time bootstrap of a markdown tree (or a full re-index via `--all`)
 *   - after schema changes that invalidate stored chunks
 *   - debugging
 *   - re-indexing the code corpus after `git pull` on the host repo
 *     bind-mount (`--source code [--all]`)
 *
 * Without `--all`, this is an incremental sweep: only re-index files newer
 * than their last_indexed_mtime.
 *
 * `--source` defaults to `vault` for backward compatibility. `--paths`
 * (CSV) overrides `MEMRAIN_CODE_PATHS` for the code sweep.
 *
 * `--reconcile-deletes` (default OFF) additionally soft-deletes vault
 * documents whose file was removed from disk since the last index, so a
 * deleted note stops surfacing as stale evidence. Scoped to the swept vault
 * root only; never applied to the code sweep (a partial `--paths` subset must
 * not be read as "everything else was deleted").
 *
 * `--contextual` runs a DIFFERENT job: a whole-corpus, from-DB re-embed that
 * applies the contextual-retrieval wrapper to every embeddable chunk
 * (`core/contextual-reembed.ts`). It ignores `--source`/`--vault`/`--paths`
 * (there is no file sweep) and does NOT read `MEMRAIN_CONTEXTUAL_RETRIEVAL` —
 * running it IS the intent. `--force` re-embeds even already-wrapped chunks;
 * `--dry-run` counts the workload; `--limit N` caps chunks per run. Turn the
 * env flag on first so future index-time embeds stay consistent, then run this
 * once to backfill the existing corpus (including `page://` docs with no file).
 */
import { Storage } from "../core/storage.ts";
import { withStorage } from "./with-storage.ts";
import { sweepVault, type SweepResult } from "../core/sweep.ts";
import { sweepCodeRoots, type SweepCodeResult } from "../core/sweep-code.ts";
import { loadConfig } from "../core/config.ts";
import {
  contextualReembed,
  type ContextualReembedResult,
} from "../core/contextual-reembed.ts";

export interface ReindexCommandOptions {
  all?: boolean;
  vault?: string;
  source?: "vault" | "code" | "all";
  /** CSV of code roots; overrides MEMRAIN_CODE_PATHS env var. */
  codePaths?: string;
  /**
   * Also re-index documents whose chunker_version is below current (mig 052),
   * re-chunking + re-embedding the stale set on top of the normal mtime-due
   * sweep. Auto-remediates a chunker constant bump without the full-corpus
   * re-embed `--all` triggers. Applies to BOTH sweeps, each against its own
   * chunker namespace: the vault sweep drains MARKDOWN_CHUNKER_VERSION stale
   * docs (re-chunk + re-embed), the code sweep drains CODE_CHUNKER_VERSION
   * stale docs (re-chunk only — the code path is graph-only, no Titan).
   */
  rechunkStale?: boolean;
  /**
   * Soft-delete vault documents whose file no longer exists on disk (deletion-
   * reconcile). Default OFF. Applies to the VAULT sweep only — the code sweep
   * is left untouched because its `--paths` set can be a partial subset, where
   * "missing on disk" would wrongly retire everything outside the subset.
   */
  reconcileDeletes?: boolean;
  /** Let `--reconcile-deletes` retire more than 50 documents, or more than 25% of the vault. */
  allowMassDelete?: boolean;
  /**
   * Run the whole-corpus contextual re-embed instead of a file sweep
   * (`core/contextual-reembed.ts`). Mutually exclusive with the sweep modes —
   * when set, `--source`/`--vault`/`--paths` are ignored.
   */
  contextual?: boolean;
  /** Contextual re-embed: re-embed even chunks already marked. Default OFF. */
  force?: boolean;
  /** Contextual re-embed: count the workload only, never write. Default OFF. */
  dryRun?: boolean;
  /** Contextual re-embed: cap chunks re-embedded this run (document-atomic). */
  limit?: number;
}

interface VaultReindexResult {
  kind: "vault";
  vault: string;
  result: SweepResult;
}

interface CodeReindexResult {
  kind: "code";
  paths: string[];
  result: SweepCodeResult;
}

function parseCodePaths(opts: ReindexCommandOptions): string[] {
  const explicit = opts.codePaths ?? process.env.MEMRAIN_CODE_PATHS;
  if (!explicit || explicit.length === 0) return [];
  return explicit
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
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

interface ContextualReindexResult {
  kind: "contextual";
  result: ContextualReembedResult;
}

export async function runReindex(
  opts: ReindexCommandOptions,
): Promise<void> {
  const config = loadConfig();
  const source = opts.source ?? "vault";
  const storage = new Storage(config);
  return withStorage(storage, async () => {
    // Contextual re-embed is a standalone job — no file sweep runs alongside it.
    if (opts.contextual) {
      const result = await contextualReembed(storage, {
        force: opts.force ?? false,
        dryRun: opts.dryRun ?? false,
        ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      });
      const out: ContextualReindexResult = { kind: "contextual", result };
      console.log(JSON.stringify({ ok: true, runs: [out] }, null, 2));
      return;
    }

    const out: (VaultReindexResult | CodeReindexResult)[] = [];

    if (source === "vault" || source === "all") {
      const vault = resolveVaultPath(config, opts.vault);
      if (!vault && source === "vault") {
        throw new Error(
          "memrain reindex: vault path is required (--vault PATH, $MEMRAIN_VAULT_PATH, or storage.vault in config.json)",
        );
      }
      if (vault) {
        const result = await sweepVault(storage, {
          vault,
          force: opts.all ?? false,
          forceStaleChunker: opts.rechunkStale ?? false,
          reconcileDeletes: opts.reconcileDeletes ?? false,
          allowMassDelete: opts.allowMassDelete ?? false,
        });
        out.push({ kind: "vault", vault, result });
      }
    }

    if (source === "code" || source === "all") {
      const paths = parseCodePaths(opts);
      if (paths.length === 0) {
        if (source === "code") {
          throw new Error(
            "memrain reindex --source code: no paths configured (set --paths CSV or MEMRAIN_CODE_PATHS)",
          );
        }
      } else {
        const result = await sweepCodeRoots(storage, {
          paths,
          force: opts.all ?? false,
          forceStaleChunker: opts.rechunkStale ?? false,
        });
        out.push({ kind: "code", paths, result });
      }
    }

    console.log(JSON.stringify({ ok: true, runs: out }, null, 2));
  });
}
