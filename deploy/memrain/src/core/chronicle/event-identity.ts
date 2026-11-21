/**
 * Same-day event identity. An event page is slugged
 * `life/events/<day>-<hash8>` with the hash over who, what, the depth page and
 * the source, so two events of one page sharing who, what and day (a "Call
 * with alice" at 10:00 and another at 15:00) get one base slug, and the second
 * write would replace the first. This resolves each such group:
 *
 *   - a member's discriminator is its instant (`when`, normalized), `where`
 *     and `kind`, the fields twins can differ in;
 *   - one member keeps the bare base slug, every other distinct member gets
 *     `<base>-<hash6>` (the hash of its discriminator), and identical copies
 *     past the first get `-2`, `-3` when they name a time of day (copies of a
 *     bare day are one event and share the page);
 *   - assignment reads the pages already at the candidate slugs, so it holds
 *     across reordered judge output and re-runs: the member whose
 *     discriminator the base page holds keeps the base, a member whose
 *     suffixed slug already exists (live or retired) keeps it, and only then
 *     does the earliest remaining member take a free base.
 *
 * A group of one never changes slug, so every event written before this keeps
 * its page.
 */
import { createHash } from "node:crypto";
import type { Storage } from "../storage.ts";

export interface IdentityFields {
  when?: unknown;
  where?: unknown;
  kind?: unknown;
}

export interface SluggedEvent {
  slug: string;
  fields: IdentityFields;
}

function normalizedWhen(when: unknown): string {
  const text = typeof when === "string" ? when : when instanceof Date ? when.toISOString() : "";
  const at = Date.parse(text);
  return Number.isNaN(at) ? text : new Date(at).toISOString();
}

function hasTimeOfDay(when: unknown): boolean {
  return typeof when === "string" && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(when.trim());
}

export function eventDiscriminator(fields: IdentityFields | null | undefined): string {
  return JSON.stringify([
    normalizedWhen(fields?.when),
    typeof fields?.where === "string" ? fields.where : "",
    String(fields?.kind ?? ""),
  ]);
}

export function suffixedEventSlug(base: string, discriminator: string): string {
  return `${base}-${createHash("sha256").update(discriminator, "utf8").digest("hex").slice(0, 6)}`;
}

/**
 * Final slugs for one extraction, in input order. `existing` maps a slug
 * already in the brain (any state) to the discriminator of the event it holds.
 */
export function assignChronicleEventSlugs(events: SluggedEvent[], existing: ReadonlyMap<string, string>): string[] {
  const keys = events.map((ev) => eventDiscriminator(ev.fields));
  const instants = keys.map((key) => Date.parse(JSON.parse(key)[0]) || 0);
  const order = events.map((_, i) => i).sort((a, b) => instants[a]! - instants[b]! || keys[a]!.localeCompare(keys[b]!));
  const groups = new Map<string, number[]>();
  for (const i of order) groups.set(events[i]!.slug, [...(groups.get(events[i]!.slug) ?? []), i]);

  const assigned: string[] = [];
  for (const [base, members] of groups) {
    const distinct = [...new Set(members.map((i) => keys[i]!))];
    const slugOf = new Map<string, string>();
    const holder = distinct.find((key) => existing.get(base) === key);
    if (holder !== undefined) slugOf.set(holder, base);
    for (const key of distinct) {
      if (!slugOf.has(key) && existing.has(suffixedEventSlug(base, key))) slugOf.set(key, suffixedEventSlug(base, key));
    }
    for (const key of distinct) {
      if (slugOf.has(key)) continue;
      slugOf.set(key, [...slugOf.values()].includes(base) ? suffixedEventSlug(base, key) : base);
    }
    const copies = new Map<string, number>();
    for (const i of members) {
      const slug = slugOf.get(keys[i]!)!;
      // Two copies at one clock time can be two calls; two copies of a bare
      // day are one event the judge listed twice, so they share the page.
      if (!hasTimeOfDay(events[i]!.fields.when)) {
        assigned[i] = slug;
        continue;
      }
      const n = (copies.get(slug) ?? 0) + 1;
      copies.set(slug, n);
      assigned[i] = n === 1 ? slug : `${slug}-${n}`;
    }
  }
  return assigned;
}

/** Read the pages at every candidate slug of the extraction, then assign. */
export async function resolveChronicleEventSlugs(storage: Storage, sourceId: string, events: SluggedEvent[]): Promise<string[]> {
  if (events.length === 0) return [];
  const candidates = new Set(events.flatMap((ev) => [ev.slug, suffixedEventSlug(ev.slug, eventDiscriminator(ev.fields))]));
  const { rows } = await storage.engine().query<{ slug: string; when: string | null; where: string | null; kind: string | null }>(
    `SELECT slug, compiled_truth->'event'->>'when' AS "when", compiled_truth->'event'->>'where' AS "where",
            compiled_truth->'event'->>'kind' AS kind
       FROM pages WHERE source_id = $1 AND slug = ANY($2::text[])`,
    [sourceId, [...candidates]],
  );
  return assignChronicleEventSlugs(events, new Map(rows.map((r) => [r.slug, eventDiscriminator(r)])));
}
