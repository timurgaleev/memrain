/**
 * A Slack channel that turned private: the days already stored become private.
 *
 * The days inside the lookback are read again and re-rendered by the adapter
 * as usual (the channel's privacy is part of a day's fingerprint), but a day
 * older than that is never read again, and Slack may no longer return it at
 * all (a free plan's retention). So every run of a private channel re-stamps
 * its stored days that are not marked private yet from their stored copy,
 * without asking Slack: the page gains `private: true` in its compiled truth
 * and the renderer's "Private chat" header, and is written back through the
 * engine like any item. A day whose item is held (a write that kept failing)
 * is skipped, so it cannot stall the days behind it. At most RESTAMP_PER_RUN days a run; the rest are
 * found again by the next run's query, so a channel with many stored days
 * finishes over several runs, and a run that fails part-way loses nothing.
 *
 * Privacy here is a label. What a caller may read is decided per source
 * (`owner_only`), so a private channel stored in a source other callers read
 * stays readable by them; `connectors status` says so
 * (privateChatPagesInSharedSources).
 */
import type { Engine } from "../../engine/interface.ts";
import { markChatDayPrivate } from "../render.ts";
import type { RenderedSyncItem, SyncAccount } from "../sync-engine.ts";

/** Stored days re-stamped per channel per run, at most. */
export const RESTAMP_PER_RUN = 200;

interface StoredDay {
  external_id: string;
  external_version: string | null;
  slug: string;
  title: string;
  type: string;
  markdown_body: string;
  compiled_truth: Record<string, unknown> | string | null;
}

const truthOf = (raw: StoredDay["compiled_truth"]): Record<string, unknown> =>
  raw === null ? {} : typeof raw === "string" ? JSON.parse(raw) as Record<string, unknown> : raw;

/**
 * The stored days of `channelId` this account wrote that are not private yet,
 * newest first, as items carrying their stored text re-marked private. A day
 * stored across part pages comes back whole (its parts joined in order), so
 * the engine splits it again exactly as before.
 */
export async function restampItems(engine: Engine, account: Pick<SyncAccount, "id" | "sourceId">, channelId: string, limit: number = RESTAMP_PER_RUN): Promise<RenderedSyncItem[]> {
  const max = Math.min(limit, RESTAMP_PER_RUN);
  if (max <= 0) return [];
  const prefix = `${channelId}:`;
  const rows = (await engine.query<StoredDay>(
    `SELECT ci.external_id, ci.external_version, p.slug, p.title, p.type, p.markdown_body, p.compiled_truth
       FROM connector_items ci
       JOIN pages p ON p.slug = ci.page_slug AND p.source_id = $2
      WHERE ci.account_id = $1 AND left(ci.external_id, $4) = $3
        AND ci.deleted_upstream_at IS NULL AND ci.held_reason IS NULL AND p.deleted_at IS NULL
        AND p.compiled_truth->>'origin' = 'connector'
        AND (p.compiled_truth->>'private') IS DISTINCT FROM 'true'
      ORDER BY p.slug DESC
      LIMIT $5`,
    [account.id, account.sourceId, prefix, prefix.length, max],
  )).rows;
  const items: RenderedSyncItem[] = [];
  for (const row of rows) {
    const parts = (await engine.query<{ markdown_body: string }>(
      `SELECT markdown_body FROM pages
        WHERE source_id = $1 AND deleted_at IS NULL AND compiled_truth->>'part_of' = $2
        ORDER BY (compiled_truth->>'part')::int`,
      [account.sourceId, row.slug],
    )).rows;
    const body = parts.length > 0 ? parts.map(p => p.markdown_body).join("") : row.markdown_body;
    items.push({
      externalId: row.external_id,
      // Not the stored version, which the engine would skip as unchanged; the
      // next read of the day compares its own version and renders it again.
      version: `${row.external_version ?? ""}+private`,
      slug: row.slug,
      type: row.type,
      title: row.title,
      body: markChatDayPrivate(body),
      truth: { ...truthOf(row.compiled_truth), private: true },
    });
  }
  return items;
}

/**
 * Per account, how many of its stored pages are marked private while its
 * source is not owner-only: there the label hides nothing from the callers
 * that read the source.
 */
export async function privateChatPagesInSharedSources(engine: Engine): Promise<Map<string, number>> {
  // scope: operator-only the connectors status covers every account and its source
  const r = await engine.query<{ account_id: string; n: number | string }>(
    `SELECT ca.id::text AS account_id, count(*)::int AS n
       FROM connector_accounts ca
       JOIN sources s ON s.id = ca.source_id
       JOIN connector_items ci ON ci.account_id = ca.id
       JOIN pages p ON p.slug = ci.page_slug AND p.source_id = ca.source_id
      WHERE NOT s.owner_only AND p.deleted_at IS NULL AND p.compiled_truth->>'private' = 'true'
      GROUP BY ca.id`,
  );
  return new Map(r.rows.map(row => [row.account_id, Number(row.n)]));
}
