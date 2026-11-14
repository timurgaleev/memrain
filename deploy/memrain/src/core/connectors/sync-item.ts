/**
 * A rendered connector page as the sync engine's item. Kept apart from the
 * runtime so a provider adapter can build items without importing the wiring
 * that registers it.
 */
import type { RenderedConnectorPage } from "./render.ts";
import type { RenderedSyncItem } from "./sync-engine.ts";

/**
 * `version` is the provider's item version. With `enrich`, its participants
 * are linked to known people and its time put on the chronicle once it is
 * stored (enrich-deterministic.ts).
 */
export function syncItemFromPage(page: RenderedConnectorPage, version: string | null, opts: { enrich?: boolean } = {}): RenderedSyncItem {
  const dedupe = page.truth["dedupe_key"];
  return {
    externalId: page.externalId,
    version,
    slug: page.slug,
    type: page.type,
    title: page.title,
    body: page.body,
    truth: page.truth,
    dedupeKey: typeof dedupe === "string" ? dedupe : null,
    ...(opts.enrich ? { enrich: { kind: page.kind, occurredAt: page.occurredAt, participants: page.participants, bulk: page.bulk } } : {}),
  };
}
