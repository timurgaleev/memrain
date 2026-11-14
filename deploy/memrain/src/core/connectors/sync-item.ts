/**
 * A rendered connector page as the sync engine's item. Kept apart from the
 * runtime so a provider adapter can build items without importing the wiring
 * that registers it.
 */
import type { RenderedConnectorPage } from "./render.ts";
import type { RenderedSyncItem } from "./sync-engine.ts";

/** `version` is the provider's item version; the participants travel along for enrichment. */
export function syncItemFromPage(page: RenderedConnectorPage, version: string | null): RenderedSyncItem {
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
    enrich: { kind: page.kind, occurredAt: page.occurredAt, participants: page.participants, bulk: page.bulk },
  };
}
