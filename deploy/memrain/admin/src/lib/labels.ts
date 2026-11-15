// Tag input on the labelling page. Kept free of DOM and React so the root test
// runner can load it.

/** Same grammar the server accepts: lowercase letters and digits, one optional colon. */
const TAG = /^[a-z0-9]+(?::[a-z0-9-]+)?$/;
export const MAX_TAGS = 16;

/** Split a comma or space separated list into tags, or say which one is wrong. */
export function parseTagInput(raw: string): { tags: string[]; error: string | null } {
  const tags = [...new Set(raw.split(/[\s,]+/).map((t) => t.trim().toLowerCase()).filter(Boolean))];
  const wrong = tags.find((t) => !TAG.test(t));
  if (wrong) return { tags, error: `"${wrong}" is not a tag: use letters, digits and one colon, like kind:alias` };
  if (tags.length > MAX_TAGS) return { tags, error: `at most ${MAX_TAGS} tags` };
  return { tags, error: null };
}
