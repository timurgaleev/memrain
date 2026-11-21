/**
 * Remove online-meeting credentials from connector pages already stored.
 *
 * The renderers strip them from every new render (meeting-redact.ts), but a
 * stored page is rendered again only when its item changes upstream: the sync
 * skips an item whose provider version is unchanged, and mail is never listed
 * again. This walks the live connector mail, calendar, chat and meeting pages
 * of connector sources (the same kinds connector retention accepts), parts
 * included, and applies the same redaction to their title and body.
 *
 * Dry run by default: counts per source, nothing written. With `apply` each
 * changed page gets a new version through putPage, the versioned write path,
 * then a re-mirror that replaces its search chunks. The write names its
 * writer (`meeting-redact`) and a change reason, carries no principal, so
 * connector retention still treats the page as the connector's own and lets
 * it expire, and passes the version it read, so a sync write in between wins
 * and the page is left for the next run. Older version snapshots keep the
 * text they had; this never rewrites history.
 *
 * The stored body is already neutralized outside text, with any facts or takes
 * fence the brain added after it, so only the redaction is applied; its
 * markers are fixed text. A page not marked as neutralized is held, since
 * writing it as outside text would vouch for a body nothing checked.
 *
 * Nothing reported names a value, a line or a preview: counts and slugs only,
 * and a connector slug is a hash.
 */
import type { Storage } from "../storage.ts";
import { logIngest } from "../ingest-log.ts";
import { putPage, VersionConflictError } from "../pages.ts";
import { mirrorPage, type MirrorPageOptions } from "../page-index.ts";
import { withSecretDisposition } from "../secret-scan.ts";
import { OUTSIDE_NEUTRALIZED } from "../fence-carry.ts";
import { CONNECTOR_PAGE_TYPES } from "./render.ts";
import { SOURCE_KIND_FOR } from "./model.ts";
import { redactMeetingCredentials } from "./meeting-redact.ts";

export const MEETING_REDACT_WRITER = "meeting-redact";
export const MEETING_REDACT_REASON = "removed online-meeting credentials (ids, passcodes, PINs, join links)";

const BATCH = 200;
const PAGE_TYPES = [CONNECTOR_PAGE_TYPES.mail, CONNECTOR_PAGE_TYPES.calendar, CONNECTOR_PAGE_TYPES.chat, CONNECTOR_PAGE_TYPES.meeting];
const SOURCE_KINDS = [...new Set(Object.values(SOURCE_KIND_FOR))];

export interface MeetingRedactSweepOptions {
  /** Only this source's pages. */
  sourceId?: string;
  /** Write the redacted pages; default is a dry run. */
  apply?: boolean;
  /** Test seams for the re-mirror. */
  mirror?: Pick<MirrorPageOptions, "embedFn" | "contextualLlmFn">;
}

export interface MeetingRedactSourceCounts {
  pages_scanned: number;
  /** Pages with something to remove: would change on a dry run, changed on apply. */
  pages_changed: number;
  /** Credentials removed (or that would be). */
  removals: number;
}

export interface MeetingRedactSweepResult extends MeetingRedactSourceCounts {
  applied: boolean;
  by_source: Record<string, MeetingRedactSourceCounts>;
  /** Pages written with a new version (apply only). */
  rewritten: number;
  /** Written, but search still holds the old text until the cycle's mirror-pages phase re-indexes it. */
  mirror_failed: number;
  /** Pages a sync wrote between the read and the write; run again. */
  moved: number;
  errors: string[];
}

interface Row {
  slug: string;
  type: string;
  title: string | null;
  markdown_body: string;
  compiled_truth: unknown;
  source_id: string;
  version_n: number;
}

function truthOf(value: unknown): Record<string, unknown> {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function errorTag(e: unknown): string {
  return e instanceof Error ? e.name : "error";
}

export async function sweepMeetingCredentials(storage: Storage, opts: MeetingRedactSweepOptions = {}): Promise<MeetingRedactSweepResult> {
  const engine = storage.engine();
  const result: MeetingRedactSweepResult = {
    applied: opts.apply === true, pages_scanned: 0, pages_changed: 0, removals: 0,
    by_source: {}, rewritten: 0, mirror_failed: 0, moved: 0, errors: [],
  };
  const changedSlugs = new Map<string, string[]>();
  let after = "";
  for (;;) {
    const params: unknown[] = [PAGE_TYPES, after, SOURCE_KINDS];
    const sourceFilter = opts.sourceId === undefined ? "" : `AND p.source_id = $${params.push(opts.sourceId)}`;
    params.push(BATCH);
    const rows = (await engine.query<Row>(
      // scope: operator-only the operator's CLI sweeps every source unless --source names one
      `SELECT p.slug, p.type, p.title, p.markdown_body, p.compiled_truth, p.source_id,
              (SELECT COALESCE(MAX(v.version_n), 0)::int FROM page_versions v WHERE v.slug = p.slug) AS version_n
         FROM pages p
         JOIN sources s ON s.id = p.source_id AND s.kind = ANY($3::text[])
        WHERE p.deleted_at IS NULL AND p.type = ANY($1::text[]) AND p.compiled_truth->>'origin' = 'connector'
          AND p.slug > $2 ${sourceFilter}
        ORDER BY p.slug
        LIMIT $${params.length}`,
      params,
    )).rows;
    for (const row of rows) {
      const counts = result.by_source[row.source_id] ??= { pages_scanned: 0, pages_changed: 0, removals: 0 };
      counts.pages_scanned++;
      result.pages_scanned++;
      const title = row.title === null ? { text: null, count: 0 } : redactMeetingCredentials(row.title);
      const body = redactMeetingCredentials(row.markdown_body);
      const removals = title.count + body.count;
      if (removals === 0) continue;
      if (truthOf(row.compiled_truth)[OUTSIDE_NEUTRALIZED] !== 1) {
        result.errors.push(`${row.slug}: held (not_neutralized)`);
        continue;
      }
      if (opts.apply === true) {
        const outcome = await rewrite(storage, row, title.text, body.text, opts, result);
        if (outcome !== "rewritten") continue;
        changedSlugs.set(row.source_id, [...(changedSlugs.get(row.source_id) ?? []), row.slug]);
      }
      counts.pages_changed++;
      counts.removals += removals;
      result.pages_changed++;
      result.removals += removals;
    }
    if (rows.length < BATCH) break;
    after = rows.at(-1)!.slug;
  }
  for (const [sourceId, slugs] of changedSlugs) {
    const c = result.by_source[sourceId]!;
    await logIngest(engine, {
      source_type: "connector-meeting-redact",
      source_ref: MEETING_REDACT_WRITER,
      pages_updated: slugs,
      summary: `${c.pages_changed} page(s), ${c.removals} meeting credential(s) removed`,
      source_id: sourceId,
    });
  }
  return result;
}

async function rewrite(
  storage: Storage,
  row: Row,
  title: string | null,
  body: string,
  opts: MeetingRedactSweepOptions,
  result: MeetingRedactSweepResult,
): Promise<"rewritten" | "moved" | "failed"> {
  try {
    // A credential the general scanner knows is redacted on the way in, as on every connector write.
    const put = await withSecretDisposition("redact", () => putPage(storage, {
      slug: row.slug,
      type: row.type,
      sealSecrets: false,
      allowAdHocType: true,
      ...(title === null ? {} : { title }),
      markdown_body: body,
      compiled_truth: truthOf(row.compiled_truth),
      source_id: row.source_id,
      outsideText: true,
      written_by: MEETING_REDACT_WRITER,
      change_reason: MEETING_REDACT_REASON,
      expectedVersion: row.version_n,
    }));
    if (put.held) {
      result.errors.push(`${row.slug}: held (${put.held})`);
      return "failed";
    }
    result.rewritten++;
    const mirrored = await mirrorPage(
      storage,
      { slug: row.slug, title, markdown_body: put.outside_body ?? body, content_hash: put.content_hash, source_id: row.source_id },
      { remote: true, timingLabel: MEETING_REDACT_WRITER, ...(opts.mirror ?? {}) },
    );
    if (!mirrored) result.mirror_failed++;
    return "rewritten";
  } catch (e) {
    if (e instanceof VersionConflictError) {
      result.moved++;
      return "moved";
    }
    result.errors.push(`${row.slug}: rewrite failed (${errorTag(e)})`);
    return "failed";
  }
}
