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
 * Idempotent — a re-run only embeds what is still missing. Exits non-zero
 * only on TOTAL failure (candidates existed, none embedded), so a cron can
 * detect a fully-broken Bedrock path while tolerating the occasional skip.
 */
import { Storage } from "../core/storage.ts";
import { withStorage } from "./with-storage.ts";
import { loadConfig } from "../core/config.ts";
import { runEmbedBackfill } from "../core/embed-backfill.ts";

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
  /** Test seam — config file path. */
  configPath?: string;
  /** Test seam — embedder; production embeds with Titan. */
  embed?: (text: string) => Promise<number[]>;
}

export async function runEmbed(opts: EmbedCmdOptions = {}): Promise<number> {
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
      ...(opts.embed ? { embed: opts.embed } : {}),
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
