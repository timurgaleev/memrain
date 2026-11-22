/**
 * `memrain embed [<slug>] [--slugs a,b] [--all] [--stale] [--source <id>]
 *              [--limit N] [--dry-run]`
 * — embedding backfill + surgical re-embed (see `core/embed-backfill.ts`).
 *
 * Default (no targeting flags): backfill non-code chunks that are MISSING a
 * vector — the operator remedy when `memrain status` / `doctor` report
 * embed_coverage below 100%.
 *
 * Targeting:
 *   <slug> / --slugs a,b  re-embed exactly these pages (drops their existing
 *                         vectors first) — the after-an-edit / provider-hiccup
 *                         surgical path. Slugs match the raw source_path, the
 *                         page:// / page-truth:// mirrors, or the .md file twin.
 *   --all                 re-embed the whole embeddable corpus (drops existing
 *                         vectors first; combine with --source to bound it)
 *   --stale               also re-embed rows whose embedding_signature no
 *                         longer matches the current model/dimensions
 *   --source <id>         restrict any of the above to one source (tenant)
 *
 *   --dry-run             count what would be embedded, write nothing
 *   --limit N             embed at most N this run (cap cost; re-run resumes)
 *
 * Code (`memrain embed --code [--source <id>] [--limit N]`): give code chunks
 * that have no vector one. A dry run unless `--apply`, and `--apply` needs
 * `--max-usd X`: the run reserves each call's worst case against X and stops
 * cleanly at the first that would cross it (`capReached`); a re-run continues
 * with the chunks still missing. A chunk the model refuses is tried once and
 * then skipped until its file changes. The dry run prints the count, the input
 * bytes, a typical cost and the worst-case bound — a cap at the bound finishes
 * in one run — and the vector index now and after the run next to the
 * database's shared_buffers. On a Postgres server a run whose index would not
 * fit shared_buffers is refused before any call; `--limit` can size it down.
 *
 * Idempotent — a re-run only embeds what is still missing. Exits non-zero
 * only on TOTAL failure (candidates existed, none embedded), so a cron can
 * detect a fully-broken Bedrock path while tolerating the occasional skip.
 */
import { Storage } from "../core/storage.ts";
import { withStorage } from "./with-storage.ts";
import { loadConfig } from "../core/config.ts";
import { runEmbedBackfill } from "../core/embed-backfill.ts";
import { CODE_EMBED_MAX_FAILURES } from "../core/code-embed.ts";

export interface EmbedCmdOptions {
  limit?: number;
  dryRun?: boolean;
  /** Re-embed exactly these slugs/paths (implies dropping their vectors). */
  slugs?: string[];
  /** Re-embed the whole embeddable corpus (scoped by `sourceId` when set). */
  all?: boolean;
  /** Also invalidate embeddings whose stored signature is stale. */
  stale?: boolean;
  /** Restrict to one source id. */
  sourceId?: string;
  /** Embed code chunks instead of the prose corpus (a dry run unless `apply`). */
  code?: boolean;
  /** Code only: really embed, under `maxUsd`. */
  apply?: boolean;
  /** Code only: the run's dollar cap, required with `apply`. */
  maxUsd?: number;
  /** Test seam — config file path. */
  configPath?: string;
  /** Test seam — embedder; production embeds with Titan. */
  embed?: (text: string) => Promise<number[]>;
}

/** Why a `--code` / `--apply` / `--max-usd` combination is refused, or null. */
function codeFlagsError(opts: EmbedCmdOptions): string | null {
  if (!opts.code) {
    return opts.apply || opts.maxUsd !== undefined ? "--apply and --max-usd go with --code" : null;
  }
  if (opts.all || opts.stale || (opts.slugs && opts.slugs.length > 0)) {
    return "--code only fills code chunks that have no vector; drop --all, --stale and slugs";
  }
  if (opts.apply && opts.dryRun) return "--apply and --dry-run are mutually exclusive";
  if (opts.maxUsd !== undefined && !(Number.isFinite(opts.maxUsd) && opts.maxUsd > 0)) {
    return "--max-usd must be a positive number";
  }
  if (opts.apply && opts.maxUsd === undefined) {
    return "--code --apply needs --max-usd X; run without --apply first to see the cost";
  }
  return null;
}

export async function runEmbed(opts: EmbedCmdOptions = {}): Promise<number> {
  const codeError = codeFlagsError(opts);
  if (codeError) {
    console.error(`memrain embed: ${codeError}`);
    return 1;
  }
  if (opts.code) return runCodeEmbed(opts);
  if (opts.all && opts.slugs && opts.slugs.length > 0) {
    console.error("memrain embed: --all and <slug>/--slugs are mutually exclusive");
    return 1;
  }
  // --all force-deletes every vector up front, then re-embeds; a --limit would
  // cap the re-embed and leave the rest of the corpus permanently vectorless.
  // Reject the combination (a dry-run plans nothing destructive, so it's fine).
  if (opts.all && opts.limit !== undefined && !opts.dryRun) {
    console.error(
      "memrain embed: --all wipes and rebuilds the whole corpus — --limit would " +
        "leave the remainder unembedded. Drop --limit, or use --slugs/--source to scope.",
    );
    return 1;
  }
  const config = loadConfig(opts.configPath);
  const storage = new Storage(config);
  return withStorage(storage, async () => {
    const engine = storage.engine();
    const targeted = Boolean(opts.all || (opts.slugs && opts.slugs.length > 0));
    const result = await runEmbedBackfill(engine, {
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      ...(opts.dryRun ? { dryRun: true } : {}),
      ...(opts.slugs && opts.slugs.length > 0 ? { slugs: opts.slugs } : {}),
      ...(opts.sourceId ? { sourceId: opts.sourceId } : {}),
      ...(targeted ? { forceReembed: true } : {}),
      ...(opts.stale ? { reembedOnSignatureChange: true } : {}),
      onProgress: (done, total) =>
        console.error(`embed-backfill: ${done}/${total}`),
    });
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    // Total failure → non-zero so an unattended run is detectable. A row
    // skipped because a re-index changed it under the run is not a failure.
    if (!result.dryRun && result.candidates > 0 && result.embedded === 0 && result.stale < result.candidates) {
      return 1;
    }
    return 0;
  });
}

async function runCodeEmbed(opts: EmbedCmdOptions): Promise<number> {
  const config = loadConfig(opts.configPath);
  const storage = new Storage(config);
  return withStorage(storage, async () => {
    const apply = opts.apply === true;
    const result = await runEmbedBackfill(storage.engine(), {
      kind: "code",
      reembedOnSignatureChange: false,
      // A chunk the model refused is not tried again, so a --limit run never
      // stalls on the same refusals at the front of the id order.
      maxFailures: CODE_EMBED_MAX_FAILURES,
      ...(apply ? { maxUsd: opts.maxUsd! } : { dryRun: true }),
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      ...(opts.sourceId ? { sourceId: opts.sourceId } : {}),
      ...(opts.embed ? { embed: opts.embed } : {}),
      onProgress: (done, total) => console.error(`embed-backfill: ${done}/${total}`),
    });
    console.log(JSON.stringify({ ok: !result.indexFull, kind: "code", ...result }, null, 2));
    if (result.indexFull) {
      console.error(
        `memrain embed --code: refused, nothing embedded: ${result.indexFull}. ` +
          "Embed fewer chunks with --limit, or give the database more memory first.",
      );
      return 1;
    }
    if (!apply) {
      if (result.vectorIndex && !result.vectorIndex.fits) {
        console.error(
          `memrain embed --code: the vector index would grow to about ${result.vectorIndex.projectedMb} MB, ` +
            `past shared_buffers (${result.vectorIndex.sharedBuffersMb} MB); --apply would be refused. Use --limit to size the run down.`,
        );
      }
      console.error(
        "memrain embed --code: dry run. Run with --apply --max-usd X; a cap at " +
          "costUpperBoundUsd finishes in one run, a smaller one stops early and a re-run continues.",
      );
      return 0;
    }
    if (result.capReached) {
      console.error(
        `memrain embed --code: stopped at the $${opts.maxUsd} cap after ${result.embedded} chunk(s); ` +
          "run again to continue with the rest",
      );
      return result.embedded > 0 ? 0 : 1;
    }
    if (result.candidates > 0 && result.embedded === 0 && result.stale < result.candidates) return 1;
    return 0;
  });
}
