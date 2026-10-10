/**
 * The brain owner's entity, for first-person claims in first-party transcripts.
 *
 * A Claude Code / Codex / ChatGPT export labels the operator `User`, which the
 * anonymous-speaker gate rightly refuses to treat as a name — so every "I
 * prefer…" and "I decided…" the operator said came back with no entity and was
 * dropped at write time. When the operator names their own entity page in
 * MEMRAIN_OWNER_ENTITY, a first-person user claim from a first-party source
 * lands there instead. The caller decides what counts as first-party; a
 * diarised "Speaker 2" never does.
 *
 * Unset (the default): nothing changes, byte for byte.
 */
import { validateSlug } from "./pages.ts";
import { isJunkEntitySlug } from "./entity-junk.ts";
import type { GazetteerEntry } from "./gazetteer.ts";
import { normalizeAlias } from "./page-aliases.ts";

let warnedFor: string | null = null;

/**
 * The validated owner slug, or null when unset or unusable. An unusable value
 * warns once per distinct value and is ignored — mapping claims onto a slug
 * the ledger would refuse, or onto a placeholder page, is worse than dropping
 * them as before.
 */
export function resolveOwnerEntity(
  env: string | undefined = process.env["MEMRAIN_OWNER_ENTITY"],
): string | null {
  const raw = (env ?? "").trim().toLowerCase();
  if (raw.length === 0) return null;
  let ok = !isJunkEntitySlug(raw);
  if (ok) {
    try {
      validateSlug(raw);
    } catch {
      ok = false;
    }
  }
  if (ok) return raw;
  if (warnedFor !== raw) {
    warnedFor = raw;
    process.stderr.write(
      `[facts-owner] WARN: MEMRAIN_OWNER_ENTITY=${JSON.stringify(raw.slice(0, 80))} ` +
        `is not a usable entity slug; first-person transcript claims stay unattributed\n`,
    );
  }
  return null;
}

/**
 * The entity a first-person claim is about when the claim opens with a known
 * person or company name, its grammatical subject ("Alice moved to Berlin"
 * said as `User`). A name further in ("I called Alice", "Met Alice") or a
 * possessive ("Alice's sister") leaves the claim the owner's: the speaker
 * acted, or the subject is someone else. The gazetteer already drops a name
 * two pages share, so a match is unambiguous.
 */
export function inferSubject(text: string, entries: GazetteerEntry[]): string | null {
  const claim = text.normalize("NFKC").trimStart();
  // A lowercase opening word is the common-word sense ("mark the date"), not a name.
  if (!/^\p{Lu}/u.test(claim)) return null;
  const norm = normalizeAlias(claim);
  let best: GazetteerEntry | null = null;
  for (const e of entries) {
    if (e.phrase.length === 0 || !norm.startsWith(e.phrase)) continue;
    if (best === null || e.phrase.length > best.phrase.length) best = e;
  }
  // Judged on the longest name only: "Alice Smith's" must not fall back to "Alice".
  if (best === null || /^[\p{L}\p{N}_'\u2019]/u.test(norm.slice(best.phrase.length))) return null;
  return best.slug;
}

/** Speaker labels a first-party importer gives the operator. */
const OWNER_SPEAKER_RE = /^(?:user|me)$/i;

/** True for the label a first-party transcript gives the brain's owner. */
export function isOwnerSpeaker(speaker: string | null | undefined): boolean {
  return typeof speaker === "string" && OWNER_SPEAKER_RE.test(speaker.trim());
}
