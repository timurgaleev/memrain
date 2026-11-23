/**
 * Which speaker on a conversation page is the brain's owner, as the importer
 * that wrote the page knew it. The importer stamps `speaker_owner` into the
 * page's compiled truth: the owner's speaker label, the signal it rests on
 * (`basis`), how many turns carry that label and, when the importer knows it,
 * the member the import ran for. Only an importer that can show the turns are
 * the owner's own stamps it; every other page stays speaker-unknown.
 *
 * Compiled truth is something any writer can set, so the marker is honored
 * only at read time and only when:
 *   - its shape is valid (a known basis, a short single-line label, a whole
 *     turn count);
 *   - the page's live version was written by a trusted internal importer (the
 *     transcripts import or a connector sync), never through a credential: a
 *     remote or operator write records its principal in written_by_principal;
 *   - its member is the member the page's source belongs to (the member whose
 *     personal source it is, else the brain's owner member, or no member on a
 *     brain without one). A marker with no member stands for the brain's owner
 *     and is refused on another member's personal source.
 */
import type { Engine } from "./engine/interface.ts";
import { ownerMemberId } from "./caller-access.ts";

export const SPEAKER_OWNER_KEY = "speaker_owner";
export const SPEAKER_OWNER_BASES = ["is_from_me", "gmail_sent", "session_user", "export_user"] as const;
export type SpeakerOwnerBasis = typeof SPEAKER_OWNER_BASES[number];
export const SPEAKER_LABEL_MAX_CHARS = 80;

export interface SpeakerOwnerMarker {
  label: string;
  basis: SpeakerOwnerBasis;
  turns: number;
  member?: string;
}

/** page_versions.written_by values of the importers trusted to stamp the marker. */
export const SPEAKER_OWNER_WRITERS: readonly string[] = ["transcripts-ingest"];
/** Connector syncs write as `connector-<provider>`. */
export const SPEAKER_OWNER_CONNECTOR_PREFIX = "connector-";

const MEMBER_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

/** A speaker label as the page body spells it, or null when it cannot be one. */
export function speakerOwnerLabel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const label = raw.trim();
  if (!label || [...label].length > SPEAKER_LABEL_MAX_CHARS) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F*():]/.test(label)) return null;
  return label;
}

/** The marker, or null when the value is not a valid one. */
export function parseSpeakerOwner(value: unknown): SpeakerOwnerMarker | null {
  const v = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown; } catch { return null; } })() : value;
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const record = v as Record<string, unknown>;
  const label = speakerOwnerLabel(record.label);
  const basis = SPEAKER_OWNER_BASES.find((b) => b === record.basis);
  const turns = record.turns;
  if (!label || !basis || typeof turns !== "number" || !Number.isSafeInteger(turns) || turns < 1) return null;
  if (record.member !== undefined && (typeof record.member !== "string" || !MEMBER_RE.test(record.member))) return null;
  return { label, basis, turns, ...(typeof record.member === "string" ? { member: record.member } : {}) };
}

/** The marker an importer stamps, or null when the owner spoke no turn under a usable label. */
export function buildSpeakerOwner(label: unknown, basis: SpeakerOwnerBasis, turns: number, member: string | null): SpeakerOwnerMarker | null {
  return parseSpeakerOwner({ label, basis, turns, ...(member ? { member } : {}) });
}

/**
 * The marker for one page's turns, in page order: each turn's rendered speaker
 * label and whether the source shows the owner wrote it. Every owner turn must
 * render under one label and no other turn under that label; anything else is
 * speaker-unknown.
 */
export function speakerOwnerFromTurns(
  turns: ReadonlyArray<{ label: string; owner: boolean }>,
  basis: SpeakerOwnerBasis,
  member: string | null,
): SpeakerOwnerMarker | null {
  const owned = turns.filter((t) => t.owner);
  const labels = new Set(owned.map((t) => t.label));
  if (labels.size !== 1) return null;
  const [label] = labels;
  if (turns.some((t) => !t.owner && t.label === label)) return null;
  return buildSpeakerOwner(label, basis, owned.length, member);
}

export type SpeakerOwnerStatus = "trusted" | "absent" | "invalid" | "untrusted_writer" | "member_mismatch";
export interface SpeakerOwnerRead { slug: string; source_id: string; status: SpeakerOwnerStatus; marker: SpeakerOwnerMarker | null }

/**
 * The speaker-owner marker of one live page, with why it is or is not
 * honored. Only a `trusted` read carries a marker; every other status means
 * the page is speaker-unknown. Null when the page is not live.
 */
export async function readSpeakerOwner(engine: Pick<Engine, "query">, page: { slug: string; source_id: string }): Promise<SpeakerOwnerRead | null> {
  const r = await engine.query<{ marker: unknown; written_by: string | null; principal: string | null; holder: string | null }>(
    // scope: upstream the caller already read this page within its own scope
    `SELECT p.compiled_truth->'${SPEAKER_OWNER_KEY}' AS marker, v.written_by, v.written_by_principal AS principal,
            (SELECT m.id FROM members m WHERE m.personal_source_id = p.source_id AND m.status <> 'removed' ORDER BY m.id LIMIT 1) AS holder
       FROM pages p
       LEFT JOIN LATERAL (SELECT pv.written_by, pv.written_by_principal FROM page_versions pv
                           WHERE pv.slug = p.slug ORDER BY pv.version_n DESC LIMIT 1) v ON true
      WHERE p.slug = $1 AND p.source_id = $2 AND p.deleted_at IS NULL`,
    [page.slug, page.source_id],
  );
  const row = r.rows[0];
  if (!row) return null;
  const read = (status: SpeakerOwnerStatus, marker: SpeakerOwnerMarker | null = null): SpeakerOwnerRead =>
    ({ slug: page.slug, source_id: page.source_id, status, marker });
  if (row.marker === null || row.marker === undefined) return read("absent");
  const marker = parseSpeakerOwner(row.marker);
  if (!marker) return read("invalid");
  const writer = row.written_by ?? "";
  const trustedWriter = row.principal === null &&
    (SPEAKER_OWNER_WRITERS.includes(writer) || writer.startsWith(SPEAKER_OWNER_CONNECTOR_PREFIX));
  if (!trustedWriter) return read("untrusted_writer");
  const expected = row.holder ?? await ownerMemberId(engine);
  const member = marker.member ?? null;
  if (row.holder !== null ? member !== row.holder : member !== null && member !== expected) return read("member_mismatch");
  return read("trusted", marker);
}
