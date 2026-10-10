/**
 * The link-extraction watermark's second input: when the extractor switches
 * last changed.
 *
 * A page whose `links_extracted_at` predates the watermark reads stale for
 * extraction. The code half of the watermark is LINK_EXTRACTOR_VERSION_TS
 * (links.ts); this module adds the time the gazetteer / typed-link / verb
 * inference switches last changed, kept in the `config` table under
 * {@link LINK_FLAGS_GENERATION_KEY}. Turning one of them on or off therefore
 * re-extracts every page once and the graph converges to what the current
 * settings derive, instead of only pages edited after the change.
 *
 * The row's value is a hash of the switches; its `updated_at` is the
 * generation. The `links-stale` cycle phase rewrites the row when the hash no
 * longer matches the running process. The first record of a brain is dated at
 * the code watermark so installing this marks nothing stale on its own.
 *
 * Only the server's own cycle loop records: a one-shot `memrain cycle` run
 * from a shell whose switches differ would otherwise flip the generation on
 * every alternation with the loop and re-stale the whole corpus each time. It
 * compares and warns instead.
 */
import { createHash } from "node:crypto";
import type { Engine } from "./engine/interface.ts";
import { gazetteerEnabled } from "./gazetteer.ts";
import { typedLinksEnabled } from "./typed-links.ts";

export const LINK_FLAGS_GENERATION_KEY = "links.flags_generation";

type Env = Record<string, string | undefined>;

let recorder = false;

/** Called by `serve` when it starts the cycle loop: this process's switches are the brain's. */
export function markLinkFlagsRecorder(): void {
  recorder = true;
}

/** The extractor switches that change which edges a page derives. */
export function linkFlagsHash(env: Env = process.env): string {
  const flags = {
    gazetteer: gazetteerEnabled(env["MEMRAIN_GAZETTEER"]),
    typed_links: typedLinksEnabled(env["MEMRAIN_TYPED_LINKS"]),
    verb_infer: env["MEMRAIN_LINK_VERB_INFER"] === "1",
  };
  return createHash("sha256").update(JSON.stringify(flags)).digest("hex").slice(0, 16);
}

/**
 * Record the running switches. Returns `changed: true` when they differ from
 * the recorded ones, which moves the generation to now and makes every page
 * stale for extraction once. `codeWatermark` dates a brain's first record.
 * With `record` false nothing is written; a differing hash is only logged.
 */
export async function syncLinkFlagsGeneration(
  engine: Engine,
  codeWatermark: string,
  env: Env = process.env,
  record: boolean = recorder,
): Promise<{ changed: boolean }> {
  const hash = linkFlagsHash(env);
  const r = await engine.query<{ value: string }>(
    `SELECT value FROM config WHERE key = $1`,
    [LINK_FLAGS_GENERATION_KEY],
  );
  const prior = r.rows[0]?.value;
  if (prior === hash) return { changed: false };
  if (!record) {
    if (prior !== undefined) {
      console.warn(
        `[memrain] link switches (MEMRAIN_GAZETTEER / MEMRAIN_TYPED_LINKS / MEMRAIN_LINK_VERB_INFER) differ from the server's; this run extracts with its own and leaves the recorded generation alone`,
      );
    }
    return { changed: false };
  }
  if (prior === undefined) {
    await engine.query(
      `INSERT INTO config (key, value, updated_at) VALUES ($1, $2, $3::timestamptz)
       ON CONFLICT (key) DO NOTHING`,
      [LINK_FLAGS_GENERATION_KEY, hash, codeWatermark],
    );
    return { changed: false };
  }
  await engine.query(
    `UPDATE config SET value = $2, updated_at = now() WHERE key = $1`,
    [LINK_FLAGS_GENERATION_KEY, hash],
  );
  return { changed: true };
}

/**
 * SQL for the effective watermark: the later of the code version (bound at
 * `versionParam`, e.g. `$1`) and the switches' generation.
 */
export function linkWatermarkSql(versionParam: string): string {
  if (!/^\$\d+$/.test(versionParam)) throw new Error(`bad parameter ref ${versionParam}`);
  return `GREATEST(${versionParam}::timestamptz,
                   COALESCE((SELECT updated_at FROM config WHERE key = '${LINK_FLAGS_GENERATION_KEY}'),
                            ${versionParam}::timestamptz))`;
}
