/**
 * Search-result feedback switches and limits. Everything is off unless
 * MEMRAIN_FEEDBACK is on: no rating is accepted, no implicit signal is kept
 * and search never reads a weight.
 */

/** Ratings one principal may give in an hour, explicit and implicit together. */
export const FEEDBACK_MAX_PER_HOUR = 60;
/** Raw ratings older than this are deleted; the page's weight row keeps their effect. */
export const FEEDBACK_RETENTION_DAYS = 180;
/** A vote counts half as much after this many days. */
export const FEEDBACK_HALF_LIFE_DAYS = 90;
/** A page read this soon after the search that returned it counts as an implicit vote. */
export const IMPLICIT_WINDOW_MS = 5 * 60_000;

function flagOn(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

export function feedbackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env["MEMRAIN_FEEDBACK"]);
}
