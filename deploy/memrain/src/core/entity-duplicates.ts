/**
 * Duplicate people and companies: read-only groups of person or company pages
 * that are likely one entity, each with its evidence and a class. Nothing here
 * merges; `memrain dedupe confirm` hands a pair to entity-merge.ts, and
 * `memrain dedupe reject` records a pair as different for good.
 *
 * Keys, read from each page's compiled truth: email (and email-shaped
 * aliases), phone, X handle, LinkedIn, GitHub, a company's domain or website,
 * and declared ids (registry fields such as `wikidata` or `company_number`,
 * plus any the operator names). A placeholder value is never a key; a role
 * mailbox (info@, team@ ...) is not a key for a person; a free-mail domain is
 * not a company's domain. A value more than CROWDED_LIMIT pages of one source
 * carry is only counted.
 *
 * Groups form inside one source (a merge never crosses sources), one per set
 * of pages that share a key value; a set holding a rejected pair is judged
 * pair by pair without it. Classes:
 *
 *   conflict  the pages share a key but their names differ, or two of them
 *             carry different LinkedIn, GitHub or declared ids and they share
 *             none of those;
 *   clean     one exact name, a shared LinkedIn, GitHub or declared id that no
 *             page outside the group carries, no differing id of that kind and
 *             no two different domains;
 *   likely    everything else.
 *
 * Evidence names key types, never their values. A rejected pair stays apart
 * in its source by its slugs, and by its two fingerprints (kind, name without
 * titles or company suffixes, strong key values), so a rename does not bring it
 * back.
 */
import { createHash } from "node:crypto";
import type { Engine } from "./engine/interface.ts";
import { andSourceScope } from "./source-scope.ts";
import { liveEndpointSql } from "./links.ts";

export const DEDUPE_PREVIEW_SCHEMA_VERSION = 1 as const;
/** A key value carried by more pages than this in one source is counted, never a key. */
export const CROWDED_LIMIT = 5;
/** Pages read per scan; past it the result says `truncated`. */
const MAX_PAGES = 20_000;
const MAX_VALUE_CHARS = 320;
const MIN_PHONE_DIGITS = 7;

export type EntityKind = "person" | "company";
export type DuplicateClass = "clean" | "likely" | "conflict";
export type KeyType = "email" | "phone" | "x_handle" | "linkedin" | "github" | "domain" | "declared_id";
export type KeyClass = "exclusive" | "contact" | "handle";

export interface PageKey { key: KeyType; field: string; key_class: KeyClass; values: Set<string> }
export interface EntityPage {
  source_id: string;
  slug: string;
  title: string;
  kind: EntityKind;
  /** Every name word, folded. */
  strict: string;
  /** strict without leading titles and, for a company, trailing corporate suffixes. */
  variant: string;
  /** Usable key values by `<key>:<field>`; placeholders and crowded values are gone. */
  keys: Map<string, PageKey>;
  fingerprint: string | null;
  /** Slugs the page itself declares a different entity (`distinct_from`). */
  distinctFrom?: ReadonlySet<string>;
}

export interface DuplicateEvidence {
  rule: "shared_key" | "key_differs" | "name_differs";
  key?: KeyType;
  field?: string;
  key_class?: KeyClass;
  /** On a shared email: one of the shared addresses is a role mailbox. */
  role_address?: boolean;
  /** On a shared contact or handle key: pages outside the group carrying a shared value. */
  other_pages?: number;
  /** On a differing LinkedIn, GitHub or declared id. */
  veto?: boolean;
}
export interface DuplicateGroup {
  id: string;
  source_id: string;
  kind: EntityKind;
  class: DuplicateClass;
  members: string[];
  evidence: DuplicateEvidence[];
}
export interface DuplicateResult {
  schema_version: typeof DEDUPE_PREVIEW_SCHEMA_VERSION;
  groups: DuplicateGroup[];
  counts: { by_class: Record<DuplicateClass, number>; crowded_key_values: number; pages_scanned: number; truncated: boolean };
  /** The declared id fields read; part of every group id, so a confirm must read the same ones. */
  id_fields: string[];
}

export interface EntityScan {
  pages: EntityPage[];
  byKey: Map<string, EntityPage>;
  /** `<source>\n<keyId>\n<value>` -> the pages carrying it (crowded values removed). */
  carriers: Map<string, EntityPage[]>;
  crowded: number;
  /** Declared id fields read, sorted. */
  idFields: string[];
  truncated: boolean;
}

export interface Rejection {
  source_id: string;
  a_slug: string;
  b_slug: string;
  a_fingerprint: string | null;
  b_fingerprint: string | null;
}

const PLACEHOLDER_WORDS = new Set(["unknown", "none", "null", "n/a", "na", "tbd", "todo", "-", "?"]);
export const ROLE_MAILBOXES: ReadonlySet<string> = new Set(["team", "support", "info", "hello", "contact", "office", "admin", "sales",
  "help", "hr", "billing", "accounts", "family", "home", "household", "reception", "frontdesk", "enquiries", "inquiries", "press", "jobs",
  "careers", "ops", "noreply", "no-reply", "mail"]);
export const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com",
  "msn.com", "yahoo.com", "ymail.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "gmx.de",
  "web.de", "mail.com", "yandex.com", "yandex.ru", "mail.ru", "qq.com", "163.com", "126.com", "zoho.com", "fastmail.com", "hey.com"]);
/** Registry and account id fields read as declared ids on any person or company page. */
export const DEFAULT_ID_FIELDS: readonly string[] = ["wikidata", "crunchbase", "company_number", "lei", "orcid"];
/**
 * Names that are not a GitHub account: the first path segments github.com
 * serves its own pages at, names it answers with no page at all, and `ghost`,
 * the placeholder account deleted users' content is moved to. A value equal to
 * one names no person or company.
 */
const GITHUB_RESERVED: ReadonlySet<string> = new Set([
  "300", "302", "400", "401", "402", "403", "404", "405", "406", "407", "408", "409", "410", "411", "412", "413",
  "414", "415", "416", "417", "418", "419", "420", "421", "422", "423", "424", "425", "426", "427", "428", "429",
  "430", "431", "500", "501", "502", "503", "504", "505", "506", "507", "508", "509", "510", "511", "693", "694",
  "695", "900", "about", "account", "admin", "advisories", "anonymous", "any", "api", "apps", "attributes", "auth",
  "billing", "blob", "blog", "bounty", "branches", "business", "businesses", "c", "cache", "careers", "case-studies",
  "categories", "central", "certification", "changelog", "chat", "cla", "cloud", "codereview", "codespaces",
  "collection", "collections", "comments", "commit", "commits", "companies", "compare", "contact", "contributing",
  "cookbook", "copilot", "coupons", "customer", "customer-stories", "customers", "dashboard", "dashboard-feed",
  "dashboards", "design", "develop", "developer", "diff", "discover", "discussions", "downloads", "downtime",
  "editor", "editors", "edu", "education", "enterprise", "enterprises", "events", "explore", "featured", "features",
  "feed", "files", "fixtures", "forked", "garage", "ghost", "gist", "gists", "git-guides", "github-copilot", "graphs",
  "groups", "guide", "guides", "help", "help-wanted", "home", "hooks", "hosting", "hovercards", "identity", "images",
  "individual", "info", "integration", "interfaces", "introduction", "invalid-email-address", "investors", "issues",
  "jobs", "join", "journal", "journals", "lab", "labs", "languages", "launch", "layouts", "learn", "legal", "library",
  "linux", "listings", "lists", "login", "logos", "logout", "mac", "maintenance", "malware", "man", "marketplace",
  "mcp", "mention", "mentioned", "mentioning", "mentions", "migrating", "milestones", "mine", "mirrors", "mobile",
  "navigation", "network", "new", "news", "newsletter", "newsroom", "none", "nonprofit", "nonprofits", "notices",
  "notifications", "oauth", "offer", "open-source", "organisations", "organizations", "orgs", "pages", "partners",
  "payments", "personal", "plans", "plugins", "popular", "popularity", "posts", "press", "preview", "pricing",
  "professional", "projects", "pulls", "raw", "readme", "recommendations", "redeem", "releases", "render", "reply",
  "repos", "repositories", "resources", "restore", "revert", "save-net-neutrality", "saved", "scraping", "search",
  "security", "services", "sessions", "settings", "shareholders", "showcases", "signin", "signup", "site",
  "site-policy", "sitemap", "social-impact", "socials", "spam", "sponsors", "ssh", "staff", "starred", "stars",
  "static", "status", "statuses", "storage", "store", "stories", "styleguide", "subscriptions", "suggest",
  "suggestion", "suggestions", "support", "suspended", "talks", "teach", "teacher", "teachers", "teaching", "team",
  "teams", "ten", "terms", "timeline", "topic", "topics", "tos", "tour", "train", "training", "translations", "tree",
  "trending", "undefined", "updates", "user-attachments", "username", "users", "visualization", "w", "watching",
  "why-github", "wiki", "wikis", "windows", "works-with", "www0", "www1", "www2", "www3", "www4", "www5", "www6",
  "www7", "www8", "www9",
]);
/**
 * Honorifics and roles written in front of a name ("Dr. Alice Example", "CEO
 * Alice Example"). Words that are also common names (king, judge, chief) are
 * left out.
 */
const TITLE_WORDS: ReadonlySet<string> = new Set([
  "mr", "mrs", "ms", "mx", "miss", "dr", "doctor", "prof", "professor", "sir", "dame", "lord", "lady",
  "rev", "reverend", "hon", "honorable", "mayor", "senator", "sen", "rep", "representative",
  "congressman", "congresswoman", "gov", "governor", "president", "pres", "vp",
  "chancellor", "minister", "secretary", "ambassador", "councilmember", "councilman", "councilwoman",
  "magistrate", "commissioner", "sheriff", "ceo", "cfo", "cto", "coo", "cmo", "cpo", "founder", "cofounder",
  "chairman", "chairwoman", "col", "colonel", "capt", "captain", "lt", "sgt", "admiral",
]);
const CORPORATE_SUFFIXES: ReadonlySet<string> = new Set(["inc", "incorporated", "llc", "ltd", "limited", "corp", "corporation", "co", "company",
  "labs", "lab", "gmbh", "plc", "ag", "sa", "bv", "the"]);
/** Values written in a handle field when the handle is not known. */
const PLACEHOLDER_HANDLES: ReadonlySet<string> = new Set(["unknown", "none", "null", "nil", "na", "tbd", "todo", "unset", "undefined",
  "private", "redacted", "anonymous", "true", "false", "yes", "no"]);
/** Page types read as companies; with no schema of its own an organization page is one. */
const COMPANY_TYPES: ReadonlySet<string> = new Set(["company", "organization"]);
const STRONG_KEYS: ReadonlySet<KeyType> = new Set(["linkedin", "github", "domain", "declared_id"]);

interface KeySpec { key: KeyType; key_class: KeyClass; fields: readonly string[]; kinds: readonly EntityKind[]; norm: (raw: string, kind: EntityKind) => string | null }
const BOTH: readonly EntityKind[] = ["person", "company"];

function normEmail(raw: string, kind: EntityKind): string | null {
  const v = raw.toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return null;
  // A shared role mailbox says two people work in one place, not that they are one person.
  if (kind === "person" && ROLE_MAILBOXES.has(v.slice(0, v.indexOf("@")))) return null;
  return v;
}

const KEY_SPECS: readonly KeySpec[] = [
  { key: "email", key_class: "contact", fields: ["email", "emails"], kinds: BOTH, norm: normEmail },
  { key: "phone", key_class: "contact", fields: ["phone", "phones"], kinds: BOTH, norm: (raw) => {
    const digits = raw.replace(/\D/g, "");
    return digits.length < MIN_PHONE_DIGITS || /^0+$/.test(digits) ? null : digits;
  } },
  { key: "x_handle", key_class: "handle", fields: ["x_handle", "twitter", "twitter_handle", "x"], kinds: BOTH, norm: (raw) => {
    const url = /^(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/([^/?#\s]+)/i.exec(raw);
    const v = (url ? url[1]! : raw).replace(/^@/, "");
    return /^\w{1,15}$/.test(v) && !/^[\d_]+$/.test(v) && !PLACEHOLDER_HANDLES.has(v.toLowerCase()) ? v.toLowerCase() : null;
  } },
  { key: "linkedin", key_class: "exclusive", fields: ["linkedin", "linkedin_url"], kinds: BOTH, norm: (raw, kind) => {
    const v = raw.toLowerCase();
    const m = /(?:^|\/)(in|company|pub)\/([^/?#\s][^?#\s]*)/.exec(v);
    if (m) return `${m[1]}/${m[1] === "pub" ? m[2]!.replace(/\/+$/, "") : m[2]!.split("/")[0]}`;
    return /^[a-z0-9][\w%-]*$/.test(v) ? `${kind === "company" ? "company" : "in"}/${v}` : null;
  } },
  { key: "github", key_class: "exclusive", fields: ["github"], kinds: BOTH, norm: (raw) => {
    const v = raw.toLowerCase().replace(/^@/, "");
    const login = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/?#\s]+)/.exec(v)?.[1] ?? v;
    return /^[a-z0-9][a-z0-9-]{0,38}$/.test(login) && !GITHUB_RESERVED.has(login) ? login : null;
  } },
  { key: "domain", key_class: "contact", fields: ["domain", "website"], kinds: ["company"], norm: (raw) => {
    const host = raw.toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "").split(/[/?#:]/)[0]!.replace(/^www\./, "");
    return host.includes(".") && /^[a-z0-9.-]+$/.test(host) && !FREE_MAIL_DOMAINS.has(host) ? host : null;
  } },
];

const isPlaceholder = (v: string) => !v || /^0+$/.test(v) || PLACEHOLDER_WORDS.has(v.toLowerCase()) || v.length > MAX_VALUE_CHARS;

function rawValues(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value];
  return list.filter((v) => typeof v === "string" || typeof v === "number").map((v) => String(v).trim()).filter((v) => !isPlaceholder(v));
}

function nameWords(text: string): string[] {
  return (text ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Name words; for a company a run of single letters is one word, so "L.L.C." folds like "LLC". */
function foldWords(text: string, kind: EntityKind): string[] {
  if (kind !== "company") return nameWords(text);
  const out: string[] = [];
  let run = "";
  for (const w of [...nameWords(text), ""]) {
    if (w.length === 1 && /\p{L}/u.test(w)) { run += w; continue; }
    if (run) out.push(run);
    run = "";
    if (w) out.push(w);
  }
  return out;
}

export function strictNameFold(text: string, kind: EntityKind = "person"): string {
  return foldWords(text, kind).join(" ");
}

export function variantNameFold(text: string, kind: EntityKind = "person"): string {
  const words = foldWords(text, kind);
  let start = 0;
  while (start < words.length - 1 && TITLE_WORDS.has(words[start]!)) start++;
  let end = words.length;
  if (kind === "company") while (end - 1 > start && CORPORATE_SUFFIXES.has(words[end - 1]!)) end--;
  return words.slice(start, end).join(" ");
}

/**
 * 32 hex of sha256 over the page's kind, variant name and strong key values
 * (LinkedIn, GitHub, domain, declared ids); null without a strong key, since
 * a name alone would keep every namesake apart.
 */
export function pageFingerprint(kind: EntityKind, variant: string, keys: ReadonlyMap<string, PageKey>): string | null {
  const values = [...keys].filter(([, k]) => STRONG_KEYS.has(k.key)).flatMap(([id, k]) => [...k.values].map((v) => `${id}=${v}`)).sort();
  if (!values.length) return null;
  return createHash("sha256").update([kind, variant, ...values].join("\n")).digest("hex").slice(0, 32);
}

const pageKey = (sourceId: string, slug: string) => `${sourceId}\t${slug}`;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function toPage(row: { slug: string; source_id: string; type: string; title: string | null; keys: Record<string, unknown> | null }, idFields: readonly string[]): EntityPage {
  const kind: EntityKind = COMPANY_TYPES.has(row.type.trim().toLowerCase()) ? "company" : "person";
  const truth = row.keys ?? {};
  const keys = new Map<string, PageKey>();
  const add = (key: KeyType, field: string, key_class: KeyClass, value: string | null) => {
    if (!value) return;
    const id = `${key}:${field}`;
    const k = keys.get(id) ?? { key, field, key_class, values: new Set<string>() };
    k.values.add(value);
    keys.set(id, k);
  };
  for (const spec of KEY_SPECS) {
    if (!spec.kinds.includes(kind)) continue;
    for (const f of spec.fields) for (const raw of rawValues(truth[f])) add(spec.key, spec.key, spec.key_class, spec.norm(raw, kind));
  }
  for (const raw of rawValues(truth.aliases)) if (raw.includes("@")) add("email", "email", "contact", normEmail(raw, kind));
  for (const f of idFields) for (const raw of rawValues(truth[f])) add("declared_id", f, "exclusive", raw.toLowerCase());
  const title = row.title ?? "";
  const variant = variantNameFold(title, kind);
  const distinct = rawValues(truth.distinct_from);
  return {
    source_id: row.source_id, slug: row.slug, title, kind,
    strict: strictNameFold(title, kind), variant, keys,
    fingerprint: pageFingerprint(kind, variant, keys),
    ...(distinct.length > 0 ? { distinctFrom: new Set(distinct) } : {}),
  };
}

/** Read the live person and company pages of the given sources (all when omitted). */
export async function scanEntityPages(engine: Engine, opts: { sourceIds?: string[]; idFields?: readonly string[] } = {}): Promise<EntityScan> {
  const idFields = [...new Set([...DEFAULT_ID_FIELDS, ...(opts.idFields ?? [])].map((f) => f.trim()).filter(Boolean))].sort();
  const fields = [...new Set([...KEY_SPECS.flatMap((s) => s.fields), "aliases", "distinct_from", ...idFields])];
  const params: unknown[] = [fields];
  const scope = andSourceScope("p.source_id", opts.sourceIds, params);
  // scope: operator-only the dedupe finder is a trusted local CLI and reads every source it is given
  const { rows } = await engine.query<{ slug: string; source_id: string; type: string; title: string | null; keys: Record<string, unknown> | null }>(
    `SELECT p.slug, p.source_id, p.type, p.title,
            (SELECT jsonb_object_agg(e.key, e.value) FROM jsonb_each(COALESCE(p.compiled_truth, '{}'::jsonb)) AS e
              WHERE e.key = ANY($1::text[])) AS keys
       FROM pages p
      WHERE p.deleted_at IS NULL AND lower(btrim(p.type)) IN ('person', 'company', 'organization')
        AND p.slug NOT LIKE 'life/diary/%' AND ${liveEndpointSql("p.slug")}${scope}
      ORDER BY p.source_id COLLATE "C", p.slug COLLATE "C"
      LIMIT ${MAX_PAGES + 1}`,
    params,
  );
  const pages = rows.slice(0, MAX_PAGES).map((r) => toPage(r, idFields));
  const carriers = new Map<string, EntityPage[]>();
  for (const p of pages) for (const [id, k] of p.keys) for (const v of k.values) {
    const cv = `${p.source_id}\n${id}\n${v}`;
    carriers.set(cv, [...(carriers.get(cv) ?? []), p]);
  }
  let crowded = 0;
  for (const [cv, list] of carriers) {
    if (list.length <= CROWDED_LIMIT) continue;
    crowded++;
    const id = cv.split("\n")[1]!;
    const v = cv.slice(cv.indexOf("\n", cv.indexOf("\n") + 1) + 1);
    for (const p of list) {
      const k = p.keys.get(id);
      k?.values.delete(v);
      if (k && k.values.size === 0) p.keys.delete(id);
    }
    carriers.delete(cv);
  }
  return { pages, byKey: new Map(pages.map((p) => [pageKey(p.source_id, p.slug), p])), carriers, crowded, idFields, truncated: rows.length > MAX_PAGES };
}

/** The class and evidence of one set of pages (same source and kind). */
export function classifyGroup(members: EntityPage[], carriers: EntityScan["carriers"]): { cls: DuplicateClass; evidence: DuplicateEvidence[]; shared: number } {
  const evidence: DuplicateEvidence[] = [];
  const inGroup = new Set(members.map((m) => m.slug));
  let sharedExclusiveOnlyHere = false;
  let sharedExclusive = false;
  let veto = false;
  let domainsDiffer = false;
  let shared = 0;
  const ids = [...new Set(members.flatMap((m) => [...m.keys.keys()]))].sort();
  for (const id of ids) {
    const sets = members.map((m) => m.keys.get(id));
    const spec = sets.find(Boolean)!;
    const base = { key: spec.key, field: spec.field, key_class: spec.key_class };
    if (sets.every(Boolean)) {
      const common = [...sets[0]!.values].filter((v) => sets.every((s) => s!.values.has(v)));
      if (common.length) {
        shared++;
        const carrying = common.map((v) => carriers.get(`${members[0]!.source_id}\n${id}\n${v}`) ?? []);
        const others = new Set(carrying.flat().filter((p) => !inGroup.has(p.slug)).map((p) => p.slug)).size;
        if (spec.key_class === "exclusive") {
          sharedExclusive = true;
          if (carrying.some((list) => list.length === members.length)) sharedExclusiveOnlyHere = true;
        }
        evidence.push({
          rule: "shared_key", ...base,
          ...(spec.key === "email" ? { role_address: common.some((e) => ROLE_MAILBOXES.has(e.slice(0, e.indexOf("@")))) } : {}),
          ...(spec.key_class === "exclusive" ? {} : { other_pages: others }),
        });
      }
    }
    const present = sets.filter((s): s is PageKey => !!s);
    const differs = present.some((a, i) => present.slice(i + 1).some((b) => ![...a.values].some((v) => b.values.has(v))));
    if (differs) {
      const isVeto = spec.key_class === "exclusive";
      veto ||= isVeto;
      if (spec.key === "domain") domainsDiffer = true;
      evidence.push({ rule: "key_differs", ...base, veto: isVeto });
    }
  }
  const variants = new Set(members.map((m) => m.variant));
  if (variants.size > 1) evidence.push({ rule: "name_differs" });
  let cls: DuplicateClass;
  if (variants.size > 1 || (veto && !sharedExclusive)) cls = "conflict";
  else if (new Set(members.map((m) => m.strict)).size === 1 && members[0]!.strict && !veto && !domainsDiffer && sharedExclusiveOnlyHere) cls = "clean";
  else cls = "likely";
  return { cls, evidence, shared };
}

function rejectedChecker(rejections: readonly Rejection[]) {
  const bySlug = new Set(rejections.map((r) => `${r.source_id}\t${r.a_slug}\t${r.b_slug}`));
  // A decision belongs to its source: it never hides a pair in another one.
  const prints = new Set(rejections.filter((r) => r.a_fingerprint && r.b_fingerprint)
    .flatMap((r) => [`${r.source_id}\t${r.a_fingerprint}\t${r.b_fingerprint}`, `${r.source_id}\t${r.b_fingerprint}\t${r.a_fingerprint}`]));
  return (a: EntityPage, b: EntityPage): boolean => {
    // A page that names the other in its own `distinct_from` was declared apart on the page itself.
    if (a.distinctFrom?.has(b.slug) || b.distinctFrom?.has(a.slug)) return true;
    const [x, y] = cmp(a.slug, b.slug) <= 0 ? [a, b] : [b, a];
    if (bySlug.has(`${x.source_id}\t${x.slug}\t${y.slug}`)) return true;
    return !!a.fingerprint && !!b.fingerprint && prints.has(`${a.source_id}\t${a.fingerprint}\t${b.fingerprint}`);
  };
}

/** Group the scanned pages; groups holding a rejected pair are left out. */
export function findDuplicateGroups(scan: EntityScan, rejections: readonly Rejection[] = [], opts: { kind?: EntityKind } = {}): DuplicateResult {
  const rejected = rejectedChecker(rejections);
  const seen = new Set<string>();
  const groups: DuplicateGroup[] = [];
  for (const list of scan.carriers.values()) {
    const byKind = new Map<EntityKind, EntityPage[]>();
    for (const p of list) byKind.set(p.kind, [...(byKind.get(p.kind) ?? []), p]);
    for (const [kind, members] of byKind) {
      if (members.length < 2 || (opts.kind && opts.kind !== kind)) continue;
      const sorted = [...members].sort((a, b) => cmp(a.slug, b.slug));
      // A rejected pair inside a larger group leaves its other pairs to be judged one by one.
      const sets = sorted.some((a, i) => sorted.slice(i + 1).some((b) => rejected(a, b)))
        ? sorted.flatMap((a, i) => sorted.slice(i + 1).filter((b) => !rejected(a, b)).map((b) => [a, b]))
        : [sorted];
      for (const set of sets) {
        const setKey = `${set[0]!.source_id}\n${set.map((m) => m.slug).join("\n")}`;
        if (seen.has(setKey)) continue;
        seen.add(setKey);
        const { cls, evidence } = classifyGroup(set, scan.carriers);
        groups.push({
          id: `dedupe/${createHash("sha256").update(`${setKey}\n${scan.idFields.join(",")}`).digest("hex").slice(0, 16)}`,
          source_id: set[0]!.source_id, kind, class: cls, members: set.map((m) => m.slug), evidence,
        });
      }
    }
  }
  const rank: Record<DuplicateClass, number> = { clean: 0, likely: 1, conflict: 2 };
  groups.sort((a, b) => rank[a.class] - rank[b.class] || cmp(a.source_id, b.source_id) || cmp(a.id, b.id));
  const by_class: Record<DuplicateClass, number> = { clean: 0, likely: 0, conflict: 0 };
  for (const g of groups) by_class[g.class]++;
  return {
    schema_version: DEDUPE_PREVIEW_SCHEMA_VERSION, groups,
    counts: { by_class, crowded_key_values: scan.crowded, pages_scanned: scan.pages.length, truncated: scan.truncated },
    id_fields: scan.idFields,
  };
}

export async function readRejections(engine: Engine, sourceIds?: string[]): Promise<Rejection[]> {
  const params: unknown[] = [];
  const scope = andSourceScope("r.source_id", sourceIds, params);
  const { rows } = await engine.query<Rejection>(
    `SELECT r.source_id, r.a_slug, r.b_slug, r.a_fingerprint, r.b_fingerprint
       FROM entity_dedupe_rejections r WHERE TRUE${scope}`,
    params,
  );
  return rows;
}

/** Whether the pair is recorded as different (by slugs or fingerprints). */
export function isRejectedPair(rejections: readonly Rejection[], a: EntityPage, b: EntityPage): boolean {
  return rejectedChecker(rejections)(a, b);
}

/** Record that two pages of one source are different entities. Idempotent. */
export async function recordRejection(engine: Engine, a: EntityPage, b: EntityPage, decidedBy: string): Promise<void> {
  if (a.source_id !== b.source_id) throw new Error("dedupe reject: the two pages are in different sources");
  const [x, y] = cmp(a.slug, b.slug) <= 0 ? [a, b] : [b, a];
  if (x.slug === y.slug) throw new Error("dedupe reject: the two slugs are the same page");
  await engine.query(
    `INSERT INTO entity_dedupe_rejections (source_id, a_slug, b_slug, a_fingerprint, b_fingerprint, decided_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (source_id, a_slug, b_slug) DO UPDATE SET
       a_fingerprint = EXCLUDED.a_fingerprint, b_fingerprint = EXCLUDED.b_fingerprint,
       decided_by = EXCLUDED.decided_by, decided_at = now()`,
    [x.source_id, x.slug, y.slug, x.fingerprint, y.fingerprint, decidedBy],
  );
}

export function entityPageOf(scan: EntityScan, sourceId: string, slug: string): EntityPage | undefined {
  return scan.byKey.get(pageKey(sourceId, slug));
}
