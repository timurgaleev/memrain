/**
 * Junk entity names — the one gate every entity-creation path shares.
 *
 * Extractors and frontmatter hand us names like "team", "meeting", "unknown",
 * "the user", "N/A", "42" or "x". None of them names a real person or company,
 * but written through they mint an entity page (or resolve onto one someone
 * already created) and every later mention hangs another edge on it, until one
 * placeholder is the best-connected node in the graph and drags unrelated
 * pages together in traversal and relational recall.
 *
 * The gate is an EXACT-NAME check, not a substring one: "Team Rocket" and
 * "Acme Meeting Rooms" pass. Names that are real words but also real names
 * ("Mark", "Grace") are not junk here — whether prose may auto-link them is
 * the gazetteer's own call.
 */

/** Longer inputs are sentences, not placeholder names; bounding the input also
 *  bounds every scan below. */
const MAX_NAME_LEN = 120;

/** Normalized (lowercase, single-spaced) names that never identify an entity. */
const JUNK_NAMES: ReadonlySet<string> = new Set([
  // placeholders for "we don't know who"
  "unknown", "unnamed", "untitled", "anonymous", "anon", "someone", "somebody",
  "anyone", "anybody", "everyone", "everybody", "nobody", "no one", "none",
  "null", "nil", "undefined", "n/a", "na", "tbd", "tba", "todo", "other",
  "others", "misc", "various", "etc", "placeholder",
  // roles and pronouns standing in for a name
  "user", "users", "guest", "guests", "speaker", "participant", "participants",
  "attendee", "attendees", "member", "members", "customer", "customers",
  "client", "clients", "admin", "author", "owner", "me", "myself", "i", "you",
  "we", "us", "they", "them", "he", "she", "it", "self", "all",
  // generic nouns an extractor echoes back as the "entity"
  "team", "teams", "meeting", "meetings", "group", "person", "people",
  "company", "companies", "organization", "org", "project", "task", "event",
  "note", "page", "idea", "draft", "inbox", "test", "today",
]);

/** Junk words that are also common acronyms — "US" the country, "IT" the
 *  department, "NA" North America, "ME" Maine. Written in capitals they name
 *  something real; a slug has lost its case, so there they are never junk. */
const ACRONYM_LOOKALIKES: ReadonlySet<string> = new Set([
  "us", "it", "me", "na", "i", "he", "she", "we", "all", "other",
]);

const LEADING_ARTICLE = /^(?:the|a|an) /;

/** Lowercase, strip markdown/quote/sentence punctuation (the same characters
 *  the slugifier drops, so "Team!" and "@team" judge as the "team" they
 *  become), fold `-`/`_` and whitespace runs to one space. `/`, `+`, `#` and
 *  `&` stay: they carry meaning in "n/a", "C++", "C#" and "AT&T". */
function normalizeName(raw: string): string {
  return raw
    .slice(0, MAX_NAME_LEN)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[*`"'[\](){}<>!?.,:;@~^|\\=$%]/g, "")
    .replace(/[-_\s]+/g, " ")
    .trim();
}

/** Two or more letters, none of them lowercase: an acronym, not a pronoun. */
function isAllCaps(raw: string): boolean {
  const letters = raw.replace(/\P{L}/gu, "");
  return [...letters].length >= 2 && letters === letters.toUpperCase() && letters !== letters.toLowerCase();
}

function isJunkKey(key: string, allowAcronyms: boolean): boolean {
  if (!key) return true;
  // Pure numbers, punctuation, "???", "---": nothing a name is made of.
  if (!/\p{L}/u.test(key)) return true;
  if ([...key.replace(/ /g, "")].length <= 1) return true;
  const listed = (k: string) => JUNK_NAMES.has(k) && !(allowAcronyms && ACRONYM_LOOKALIKES.has(k));
  if (listed(key)) return true;
  const bare = key.replace(LEADING_ARTICLE, "");
  return bare !== key && listed(bare);
}

/**
 * True when `raw` (a display name or a slug) is a placeholder rather than an
 * entity. A slug is judged by its last segment too, so `people/unknown` is
 * junk while `people/unknown-mortal-orchestra` is not.
 */
export function isJunkEntityName(raw: string | null | undefined): boolean {
  if (typeof raw !== "string") return true;
  if (raw.length > MAX_NAME_LEN) return false;
  const key = normalizeName(raw);
  const acronym = isAllCaps(raw);
  if (isJunkKey(key, acronym)) return true;
  const slash = key.lastIndexOf("/");
  // "n/a" is judged whole above; only a real path has a tail worth judging.
  if (slash > 0 && slash < key.length - 1) {
    return isJunkKey(key.slice(slash + 1).trim(), acronym);
  }
  return false;
}

/**
 * True when a resolved or slugified entity slug lands on a placeholder page.
 * The resolver can map a decorated or partial name onto `people/team`, so the
 * input check alone does not cover the slug a write ends up using. A slug has
 * no case left, so the acronym lookalikes are let through: `companies/us` may
 * well be the United States.
 */
export function isJunkEntitySlug(slug: string | null | undefined): boolean {
  if (typeof slug !== "string") return true;
  if (slug.length > MAX_NAME_LEN) return false;
  const key = normalizeName(slug);
  if (isJunkKey(key, true)) return true;
  const slash = key.lastIndexOf("/");
  if (slash > 0 && slash < key.length - 1) {
    return isJunkKey(key.slice(slash + 1).trim(), true);
  }
  return false;
}

/** Junk entity names that are real topics: a note can be about meetings or
 *  customers, but no person or company is called that. */
const TOPIC_NOUNS: ReadonlySet<string> = new Set([
  "meeting", "meetings", "customer", "customers", "client", "clients", "user", "users",
  "team", "teams", "project", "task", "event", "idea",
]);

/**
 * True when a concept slug is a placeholder ("organization", "unknown", "n/a")
 * rather than a topic. The entity gate refuses the topic nouns above as names;
 * as concepts they stand.
 */
export function isJunkConceptSlug(slug: string | null | undefined): boolean {
  return isJunkEntitySlug(slug) && !isTopicNoun(slug!);
}

/** The display-name side of isJunkConceptSlug. */
export function isJunkConceptName(raw: string | null | undefined): boolean {
  return isJunkEntityName(raw) && !isTopicNoun(raw!);
}

function isTopicNoun(raw: string): boolean {
  const key = normalizeName(raw);
  return TOPIC_NOUNS.has(key.slice(key.lastIndexOf("/") + 1).trim());
}
