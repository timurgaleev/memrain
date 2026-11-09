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
import { buildRechunkPlan } from "../core/rechunk-plan.ts";
import { applyRechunkPlan } from "../core/rechunk-apply.ts";
import { setSpendLedgerEngine } from "../core/budget.ts";
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
   * Preview only documents below their current chunker version. A planHash
   * applies that exact bounded selection; it does not run an incremental sweep
   * alongside it. Source all includes canonical body/truth mirrors. Code stays
   * graph-only; Markdown embedding calls share maxCostUsd.
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
  /** Preview contextual work or a selected rechunk batch without writes. */
  dryRun?: boolean;
  /** Rechunk document cap, or contextual chunk cap (document-atomic). */
  limit?: number;
  /** Required to apply an exact reviewed rechunk selection; omitted means preview. */
  planHash?: string;
  /** Whole rechunk-run ceiling, including failed embedding calls. Defaults to zero. */
  maxCostUsd?: number;
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
  if (opts.rechunkStale && (opts.contextual || opts.all || opts.force || opts.reconcileDeletes || opts.allowMassDelete)) {
    throw new Error("--rechunk-stale cannot combine with --contextual, --all, --force or deletion reconciliation");
  }
  if (!opts.rechunkStale && (opts.planHash !== undefined || opts.maxCostUsd !== undefined ||
    (!opts.contextual && (opts.dryRun || opts.limit !== undefined)))) {
    throw new Error("--dry-run/--limit require --rechunk-stale or --contextual; --plan-hash/--max-cost-usd require --rechunk-stale");
  }
  if (opts.planHash !== undefined && (!/^[a-f0-9]{64}$/.test(opts.planHash) || opts.dryRun)) {
    throw new Error("--plan-hash must be a reviewed 64-character hash and cannot combine with --dry-run");
  }
  const config = loadConfig();
  const source = opts.source ?? "vault";
  const storage = new Storage(config);
  if (opts.rechunkStale) {
    return withStorage(storage, async () => {
      const vault = resolveVaultPath(config, opts.vault);
      const codePaths = parseCodePaths(opts);
      if (source === "vault" && !vault) throw new Error("rechunk --source vault requires --vault or a configured vault");
      if (source === "code" && codePaths.length === 0) throw new Error("rechunk --source code requires --paths or configured code roots");
      const selection = { source, ...(vault ? { vault } : {}), codePaths,
        ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
        ...(opts.maxCostUsd !== undefined ? { maxCostUsd: opts.maxCostUsd } : {}) };
      if (!opts.planHash) {
        const plan = await buildRechunkPlan(storage, selection);
        console.log(JSON.stringify({ ok: true, dry_run: true, ...plan }, null, 2));
      } else {
        setSpendLedgerEngine(storage.engine());
        const result = await applyRechunkPlan(storage, selection, opts.planHash);
        console.log(JSON.stringify({ dry_run: false, ...result }, null, 2));
        if (!result.ok) process.exitCode = 1;
      }
    }, { migrate: false });
  }
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
