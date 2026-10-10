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

/** Speaker labels a first-party importer gives the operator. */
const OWNER_SPEAKER_RE = /^(?:user|me)$/i;

/** True for the label a first-party transcript gives the brain's owner. */
export function isOwnerSpeaker(speaker: string | null | undefined): boolean {
  return typeof speaker === "string" && OWNER_SPEAKER_RE.test(speaker.trim());
}
