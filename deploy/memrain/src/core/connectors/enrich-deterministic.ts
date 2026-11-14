/**
 * Deterministic enrichment of a connector page: who it involves and when it
 * happened, without a model and without spending anything.
 *
 *   - Each participant is resolved to an existing `people/` page through its
 *     declared aliases (email first, then display name), only within the
 *     sources the caller names. A resolved person gets a link from the
 *     connector page: `attended` for events and meetings, `corresponded_with`
 *     for mail and chat. The account's own addresses are skipped.
 *   - A named participant nobody knows becomes a wanted entry
 *     (`people/<name>`), never a page: mailing lists and one-off senders would
 *     otherwise flood the brain with people.
 *   - An event or meeting gets one chronicle event on its own page, keyed by
 *     account and item, so a re-run never duplicates it and a reschedule moves
 *     it. A cancelled event drops it.
 *   - Bulk mail (List-Unsubscribe, no-reply senders, promotions) gets nothing.
 *
 * Every row written here hangs off the connector page (links and wanted rows
 * by source slug, the event by slug), so deleting the page removes them.
 * The enrichment owns its links by `origin_slug` = the page and replaces them
 * on every run. Call it after the page's wikilink sync: that sync replaces the
 * page's wanted rows wholesale.
 */
import type { Storage } from "../storage.ts";
import { addLink, slugifyTarget } from "../links.ts";
import { addTimelineEvent } from "../timeline.ts";
import { normalizeAlias, resolveAliasUnique } from "../page-aliases.ts";
import { neutralizeOutsideText } from "../neutralize-outside-text.ts";
import { PageNotFoundError } from "../operation-error.ts";
import { guardSecrets } from "../secret-scan.ts";
import { shortHash, type Person } from "./model.ts";
import type { RenderedConnectorPage } from "./render.ts";

export interface EnrichInput {
  page: Pick<RenderedConnectorPage, "slug" | "kind" | "title" | "externalId" | "occurredAt" | "participants" | "bulk" | "truth">;
  /** The connector account's source; it must own the page. */
  sourceId: string;
  /** The account's own addresses (and send-as aliases); never linked. */
  ownAddresses: readonly string[];
  /** Sources whose people pages may be linked. */
  peopleSourceIds: readonly string[];
  writtenByPrincipal?: string;
}

export interface EnrichResult {
  linked: string[];
  wanted: number;
  timeline: boolean;
}

const PEOPLE_PREFIX = "people/";
const MAX_PARTICIPANTS = 200;
const MAX_WANTED_SURFACE = 200;

function linkType(kind: RenderedConnectorPage["kind"]): string {
  return kind === "calendar" || kind === "meeting" ? "attended" : "corresponded_with";
}

/** The chronicle key of one item of one account, free of item text. */
export function connectorEventKey(account: string, externalId: string): string {
  return `connector:${account}:${shortHash(`item:${externalId}`)}`;
}

function uniqueParticipants(people: readonly Person[], own: ReadonlySet<string>): Person[] {
  const seen = new Set<string>();
  const out: Person[] = [];
  for (const p of people) {
    const email = p.email?.trim().toLowerCase() || null;
    if (email !== null && own.has(email)) continue;
    const key = email ?? `name:${normalizeAlias(p.name)}`;
    if (key === "name:" || seen.has(key)) continue;
    seen.add(key);
    out.push({ name: p.name?.trim() || null, email });
    if (out.length >= MAX_PARTICIPANTS) break;
  }
  return out;
}

async function resolvePerson(storage: Storage, p: Person, slug: string, scope: string[]): Promise<string | null> {
  for (const alias of [p.email, p.name]) {
    if (!alias) continue;
    const hit = await resolveAliasUnique(storage, normalizeAlias(alias), slug, scope);
    if (hit?.startsWith(PEOPLE_PREFIX)) return hit;
  }
  return null;
}

function wantedTarget(name: string): string | null {
  const target = slugifyTarget(name.replace(/\//g, " "));
  return target === "unknown" || target === "" ? null : `${PEOPLE_PREFIX}${target}`;
}

async function syncLinks(storage: Storage, input: EnrichInput, people: Person[]): Promise<{ linked: string[]; wanted: Map<string, string> }> {
  const { page, sourceId } = input;
  const type = linkType(page.kind);
  const linked = new Set<string>();
  const wanted = new Map<string, string>();
  const scope = [...input.peopleSourceIds];
  if (!page.bulk && (page.kind !== "calendar" || page.truth["status"] !== "cancelled")) {
    for (const p of people) {
      const person = await resolvePerson(storage, p, page.slug, scope);
      if (person !== null) {
        linked.add(person);
        continue;
      }
      if (!p.name) continue;
      const surface = guardSecrets(p.name, `connector page '${page.slug}'`).text.slice(0, MAX_WANTED_SURFACE);
      const target = wantedTarget(surface);
      if (target !== null && !wanted.has(target)) wanted.set(target, surface);
    }
  }
  const targets = [...linked].sort();
  const engine = storage.engine();
  await engine.query(
    `DELETE FROM links WHERE source_slug = $1 AND source_id = $2 AND origin_slug = $1 AND type = $3
        AND link_source = 'manual' AND NOT (target_slug = ANY($4::text[]))`,
    [page.slug, sourceId, type, targets],
  );
  for (const target of targets) {
    await addLink(storage, {
      source_slug: page.slug, target_slug: target, type, allowAdHocType: true,
      source_id: sourceId, origin_slug: page.slug, link_kind: "plain",
    });
  }
  return { linked: targets, wanted };
}

async function syncWanted(storage: Storage, input: EnrichInput, wanted: Map<string, string>): Promise<number> {
  await storage.engine().query(
    `DELETE FROM wanted_links WHERE source_id = $1 AND from_slug = $2 AND target_slug LIKE '${PEOPLE_PREFIX}%'
        AND NOT (target_slug = ANY($3::text[]))`,
    [input.sourceId, input.page.slug, [...wanted.keys()]],
  );
  if (wanted.size === 0) return 0;
  const r = await storage.engine().query<{ n: number }>(
    `WITH ins AS (
       INSERT INTO wanted_links (source_id, from_slug, target_slug, surface)
       SELECT $1, $2, t.slug, t.surface FROM unnest($3::text[], $4::text[]) AS t(slug, surface)
        WHERE NOT EXISTS (SELECT 1 FROM pages p WHERE p.slug = t.slug AND p.deleted_at IS NULL)
       ON CONFLICT (source_id, from_slug, target_slug) DO NOTHING
       RETURNING 1)
     SELECT count(*)::int AS n FROM ins`,
    [input.sourceId, input.page.slug, [...wanted.keys()], [...wanted.values()]],
  );
  return r.rows[0]?.n ?? 0;
}

async function syncChronicle(storage: Storage, input: EnrichInput): Promise<boolean> {
  const { page, sourceId } = input;
  if (page.kind !== "calendar" && page.kind !== "meeting") return false;
  const account = String(page.truth["account"] ?? "");
  const key = connectorEventKey(account, page.externalId);
  const cancelled = page.kind === "calendar" && page.truth["status"] === "cancelled";
  const occurred = new Date(page.occurredAt).toISOString();
  await storage.engine().query(
    `DELETE FROM timeline_events WHERE slug = $1 AND source_id = $2 AND source_chunk_id = $3
        AND ($4::boolean OR occurred_at <> $5::timestamptz)`,
    [page.slug, sourceId, key, cancelled, occurred],
  );
  if (cancelled) return false;
  const title = neutralizeOutsideText(page.title).replace(/\s+/g, " ").trim().slice(0, 200) || "(untitled)";
  await addTimelineEvent(storage, {
    slug: page.slug,
    occurred_at: occurred,
    event: `${page.kind === "meeting" ? "Meeting" : "Event"}: ${title}`,
    source_label: `connector:${String(page.truth["connector"] ?? page.kind)}`,
    source_chunk_id: key,
    source_id: sourceId,
    ...(input.writtenByPrincipal ? { written_by_principal: input.writtenByPrincipal } : {}),
  });
  return true;
}

export async function enrichConnectorPage(storage: Storage, input: EnrichInput): Promise<EnrichResult> {
  const owns = await storage.engine().query(
    `SELECT 1 FROM pages WHERE slug = $1 AND source_id = $2 AND deleted_at IS NULL`,
    [input.page.slug, input.sourceId],
  );
  if (owns.rows.length === 0) throw new PageNotFoundError(input.page.slug);
  const own = new Set(input.ownAddresses.map(a => a.trim().toLowerCase()));
  const people = uniqueParticipants(input.page.participants, own);
  const { linked, wanted } = await syncLinks(storage, input, people);
  const wantedRows = await syncWanted(storage, input, wanted);
  const timeline = input.page.bulk ? false : await syncChronicle(storage, input);
  return { linked, wanted: wantedRows, timeline };
}
