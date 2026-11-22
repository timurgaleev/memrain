/**
 * Ended calendar invites into the chronicle without a model call.
 *
 * A calendar invite page (type `calendar-event`, or a slug under `calendar/`
 * or `cal/`) with a title and `start` and `end` in its compiled truth is fully
 * structured, so once its end has passed it projects to one event:
 *
 *   when = start, who = the page's attendees, where = location,
 *   kind = meeting, what = "Scheduled: <title>".
 *
 * An invite is not proof of attendance, so the summary says the meeting was
 * scheduled and the event page records `captured_via: life-chronicle:invite`.
 * The projection stands in for the judge inside runChronicleExtract: screening,
 * ownership, the source the event is written to and retirement are the judged
 * path's, and no budget is reserved. A structured invite that has not ended
 * yet is skipped without a call too: the judge only extracts what already
 * happened, so it would be paid to return nothing. Its job comes back on its
 * own once the meeting ends (`until`). A cancelled invite, or a
 * calendar page without a title, start and end, keeps the judged path.
 */
import type { ChronicleEventProposal } from "./extract-events.ts";

export const CHRONICLE_INVITE_CAPTURED_VIA = "life-chronicle:invite";
const SCHEDULED_PREFIX = "Scheduled: ";
const INVITE_SLUG_PREFIXES = ["calendar/", "cal/"];

function instant(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const d = new Date(value.trim());
  return Number.isNaN(d.getTime()) ? null : d;
}

export type InviteProjection = { proposal: ChronicleEventProposal; until: string } | { pending: true; until: string } | null;

/**
 * The one event an ended invite projects to, `pending` (with the end instant
 * as `until`) for a structured invite whose end is still ahead, or null when
 * the page is not a structured invite.
 */
export function inviteProjection(
  page: { slug: string; type: string; title: string; truth: Record<string, unknown> },
  attendees: string[],
  now: Date,
): InviteProjection {
  const invite = page.type === "calendar-event" || INVITE_SLUG_PREFIXES.some((p) => page.slug.startsWith(p));
  if (!invite) return null;
  const status = typeof page.truth.status === "string" ? page.truth.status.trim().toLowerCase() : "";
  if (status === "cancelled" || status === "canceled") return null;
  const start = instant(page.truth.start);
  const end = instant(page.truth.end);
  const title = (page.title ?? "").replace(/\s+/g, " ").trim();
  if (!start || !end || !title || end.getTime() < start.getTime()) return null;
  if (end.getTime() > now.getTime()) return { pending: true, until: end.toISOString() };
  const location = typeof page.truth.location === "string" && page.truth.location.trim() ? page.truth.location.trim() : null;
  return {
    until: end.toISOString(),
    proposal: {
      when: (page.truth.start as string).trim(),
      who: attendees,
      what: `${SCHEDULED_PREFIX}${title}`,
      where: location,
      kind: "meeting",
    },
  };
}
