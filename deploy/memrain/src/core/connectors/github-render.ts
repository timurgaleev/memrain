/**
 * Render a GitHub issue or pull request as a brain page. Pure.
 *
 * Slugs: `github/<owner>/<repo>/issues/<n>` and `.../pulls/<n>`. The title and
 * body go through the secret scanner before anything is rendered, so under the
 * `reject` disposition the item is refused whole.
 *
 * `#n` references become `[[github/<owner>/<repo>/issues/<n>|#n]]` wiki links,
 * which the ordinary wikilink extractor turns into edges. GitHub numbers issues
 * and pull requests from one sequence, so a reference cannot tell which one it
 * names; every pull-request page declares its `issues/<n>` slug as an alias,
 * and the link resolver lands a reference to a pull request on the right page.
 * `Closes/Fixes/Resolves #n` are also listed as the item's closing references.
 *
 * The reference scanner is indexOf plus a bounded digit run and a bounded
 * look-back for the keyword, so it is linear in the body.
 */
import { createHash } from "node:crypto";
import { guardSecrets, type SecretFinding } from "../secret-scan.ts";
import { neutralizeOutsideText } from "../neutralize-outside-text.ts";

export interface GithubItem {
  number: number;
  title: string;
  body: string;
  state: string;
  author: string | null;
  labels: string[];
  created_at: string | null;
  updated_at: string;
  closed_at: string | null;
  is_pull_request: boolean;
  merged_at: string | null;
}

export interface RenderedItem {
  slug: string;
  type: string;
  title: string;
  body: string;
  truth: Record<string, unknown>;
  findings: SecretFinding[];
}

export const GITHUB_ISSUE_PAGE_TYPE = "github-issue";
export const GITHUB_PULL_PAGE_TYPE = "github-pull-request";

/** Longest `#n` treated as a reference; a longer digit run is an id or a hash. */
const MAX_REF_DIGITS = 9;
const CLOSING_KEYWORDS = new Set(["close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved"]);
const MAX_KEYWORD_LEN = 8;
/** Spaces and colons allowed between a keyword and its `#n` (`Closes: #4`). */
const MAX_KEYWORD_GAP = 4;
const FENCE = "```";

const SEGMENT_HASH_LEN = 8;

function isSlugChar(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "0" && c <= "9");
}

function isHex(c: string): boolean {
  return (c >= "0" && c <= "9") || (c >= "a" && c <= "f");
}

/** Lowercase letters and digits in single-hyphen-separated runs. */
function isPlainSegment(s: string): boolean {
  if (s === "" || !isSlugChar(s[0]!) || !isSlugChar(s[s.length - 1]!)) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (isSlugChar(c)) continue;
    if (c !== "-" || s[i - 1] === "-") return false;
  }
  return true;
}

/** Ends in `-` plus SEGMENT_HASH_LEN hex digits: the shape of a folded segment. */
function looksFolded(s: string): boolean {
  const tail = s.length - SEGMENT_HASH_LEN - 1;
  if (tail < 1 || s[tail] !== "-") return false;
  for (let i = tail + 1; i < s.length; i++) if (!isHex(s[i]!)) return false;
  return true;
}

/**
 * A GitHub owner or repository name as a slug segment, one-to-one: GitHub lets
 * `foo.bar`, `foo_bar` and `foo-bar` sit side by side, and the slug grammar has
 * only letters, digits and `-`. A plain name maps to itself; any other name is
 * folded and suffixed with a hash of the lowercased name, and so is a plain
 * name that already ends in such a suffix, so no two names share a segment.
 * Names compare case-insensitively on GitHub, so case is folded first.
 */
export function slugSegment(name: string): string {
  const lower = name.toLowerCase();
  if (isPlainSegment(lower) && !looksFolded(lower)) return lower;
  let out = "";
  for (const ch of lower) {
    if (isSlugChar(ch)) out += ch;
    else if (!out.endsWith("-")) out += "-";
  }
  while (out.startsWith("-")) out = out.slice(1);
  while (out.endsWith("-")) out = out.slice(0, -1);
  const hash = createHash("sha256").update(lower).digest("hex").slice(0, SEGMENT_HASH_LEN);
  return out === "" ? hash : `${out}-${hash}`;
}

export function repoSlugBase(owner: string, repo: string): string {
  return `github/${slugSegment(owner)}/${slugSegment(repo)}`;
}

export function issueSlug(base: string, n: number): string {
  return `${base}/issues/${n}`;
}

export function pullSlug(base: string, n: number): string {
  return `${base}/pulls/${n}`;
}

export function itemSlug(owner: string, repo: string, item: Pick<GithubItem, "number" | "is_pull_request">): string {
  const base = repoSlugBase(owner, repo);
  return item.is_pull_request ? pullSlug(base, item.number) : issueSlug(base, item.number);
}

export interface IssueRef {
  number: number;
  /** Preceded by a closing keyword (`Closes #n`). */
  closing: boolean;
  start: number;
  end: number;
}

function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}

function isLetter(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

/** A character that glues a `#` to what precedes it: `abc#1`, `a/b#1`, `&#1`. */
function blocksRefBefore(c: number): boolean {
  return isLetter(c) || isDigit(c) || c === 95 /* _ */ || c === 47 /* / */ || c === 38 /* & */ || c === 35 /* # */;
}

function blocksRefAfter(c: number): boolean {
  return isLetter(c) || isDigit(c) || c === 95;
}

function closingKeywordBefore(text: string, hash: number): boolean {
  let i = hash;
  let gap = 0;
  while (i > 0 && gap < MAX_KEYWORD_GAP && (text[i - 1] === " " || text[i - 1] === ":")) {
    i--;
    gap++;
  }
  if (gap === 0) return false;
  const end = i;
  while (i > 0 && end - i < MAX_KEYWORD_LEN && isLetter(text.charCodeAt(i - 1))) i--;
  if (i > 0 && isLetter(text.charCodeAt(i - 1))) return false;
  return CLOSING_KEYWORDS.has(text.slice(i, end).toLowerCase());
}

/** `[start, end)` spans of fenced code blocks; an unclosed fence runs to the end. */
function fencedRanges(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let from = 0;
  for (;;) {
    const open = text.indexOf(FENCE, from);
    if (open === -1) return out;
    const close = text.indexOf(FENCE, open + FENCE.length);
    const end = close === -1 ? text.length : close + FENCE.length;
    out.push([open, end]);
    from = end;
  }
}

/** Every `#n` reference outside fenced code, in order. */
export function findIssueRefs(text: string): IssueRef[] {
  const out: IssueRef[] = [];
  const fences = fencedRanges(text);
  let fence = 0;
  let from = 0;
  for (;;) {
    const hash = text.indexOf("#", from);
    if (hash === -1) return out;
    from = hash + 1;
    while (fence < fences.length && fences[fence]![1] <= hash) fence++;
    if (fence < fences.length && fences[fence]![0] <= hash) {
      from = fences[fence]![1];
      continue;
    }
    if (hash > 0 && blocksRefBefore(text.charCodeAt(hash - 1))) continue;
    let end = hash + 1;
    while (end < text.length && isDigit(text.charCodeAt(end))) end++;
    const digits = end - hash - 1;
    if (digits === 0) continue;
    from = end;
    if (digits > MAX_REF_DIGITS) continue;
    if (end < text.length && blocksRefAfter(text.charCodeAt(end))) continue;
    const n = Number(text.slice(hash + 1, end));
    if (n === 0) continue;
    out.push({ number: n, closing: closingKeywordBefore(text, hash), start: hash, end });
  }
}

/** Rewrite every reference in `text` as a wiki link to its issue slug. */
export function linkIssueRefs(text: string, base: string, refs: readonly IssueRef[]): string {
  let out = "";
  let from = 0;
  for (const ref of refs) {
    out += `${text.slice(from, ref.start)}[[${issueSlug(base, ref.number)}|#${ref.number}]]`;
    from = ref.end;
  }
  return out + text.slice(from);
}

/** Read one element of the `/issues` list, or null when it is not an issue. */
export function parseGithubItem(raw: unknown): GithubItem | null {
  if (raw === null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const n = o["number"];
  const updated = o["updated_at"];
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) return null;
  if (typeof updated !== "string" || !Number.isFinite(Date.parse(updated))) return null;
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const user = o["user"] as Record<string, unknown> | null | undefined;
  const pr = o["pull_request"] as Record<string, unknown> | null | undefined;
  const labels = Array.isArray(o["labels"])
    ? (o["labels"] as unknown[])
        .map((l) => (typeof l === "string" ? l : str((l as Record<string, unknown> | null)?.["name"])))
        .filter((l): l is string => l !== null && l.length > 0)
    : [];
  return {
    number: n,
    title: str(o["title"]) ?? "",
    body: str(o["body"]) ?? "",
    state: str(o["state"]) ?? "unknown",
    author: str(user?.["login"]),
    labels,
    created_at: str(o["created_at"]),
    updated_at: updated,
    closed_at: str(o["closed_at"]),
    is_pull_request: pr !== null && pr !== undefined && typeof pr === "object",
    merged_at: str(pr?.["merged_at"]),
  };
}

function day(iso: string | null): string {
  return iso === null ? "n/a" : iso.slice(0, 10);
}

/**
 * Render one item. Throws SecretRejectedError under the `reject` disposition
 * when the title, body, a label or the author carries a credential.
 */
export function renderItem(owner: string, repo: string, item: GithubItem): RenderedItem {
  const base = repoSlugBase(owner, repo);
  const slug = itemSlug(owner, repo, item);
  const where = `github item '${slug}'`;
  const title = guardSecrets(item.title, where);
  const body = guardSecrets(item.body, where);
  const findings = [...title.findings, ...body.findings];
  // Labels and the author reach the page too; scanning them here refuses the
  // item once, instead of putPage refusing it on every re-fetch.
  const labels = item.labels.map((l) => {
    const r = guardSecrets(l, where);
    findings.push(...r.findings);
    return neutralizeOutsideText(r.text);
  });
  let author = item.author;
  if (author !== null) {
    const r = guardSecrets(author, where);
    findings.push(...r.findings);
    author = r.text;
  }

  // Titles, bodies and labels are written by whoever can open an item; they
  // must not read as a fence, a citation or a timeline row of this page.
  const titleText = neutralizeOutsideText(title.text);
  const bodyText = neutralizeOutsideText(body.text);
  const refs = findIssueRefs(bodyText);
  const closes = item.is_pull_request
    ? [...new Set(refs.filter((r) => r.closing && r.number !== item.number).map((r) => r.number))]
    : [];
  const state = item.is_pull_request && item.merged_at !== null ? "merged" : item.state;
  const kind = item.is_pull_request ? "Pull request" : "Issue";
  const url = `https://github.com/${owner}/${repo}/${item.is_pull_request ? "pull" : "issues"}/${item.number}`;
  const heading = titleText.trim() === "" ? `${kind} #${item.number}` : titleText.trim();

  const lines = [
    `# ${heading}`,
    "",
    `${kind} ${owner}/${repo}#${item.number} · ${state}` +
      (author ? ` · opened by @${author}` : "") +
      ` on ${day(item.created_at)}`,
    "",
  ];
  if (labels.length > 0) lines.push(`- Labels: ${labels.join(", ")}`);
  lines.push(`- Updated: ${item.updated_at}`);
  if (item.merged_at !== null) lines.push(`- Merged: ${item.merged_at}`);
  else if (item.closed_at !== null) lines.push(`- Closed: ${item.closed_at}`);
  if (closes.length > 0) {
    lines.push(`- Closes: ${closes.map((n) => `[[${issueSlug(base, n)}|#${n}]]`).join(", ")}`);
  }
  lines.push(`- Link: ${url}`, "");
  lines.push(bodyText.trim() === "" ? "_No description._" : linkIssueRefs(bodyText, base, refs));

  const truth: Record<string, unknown> = {
    provider: "github",
    repo: `${owner}/${repo}`,
    number: item.number,
    kind: item.is_pull_request ? "pull_request" : "issue",
    state,
    author,
    labels,
    created_at: item.created_at,
    updated_at: item.updated_at,
    closed_at: item.closed_at,
    merged_at: item.merged_at,
    url,
    closes,
  };
  if (item.is_pull_request) truth["aliases"] = [issueSlug(base, item.number)];

  return {
    slug,
    type: item.is_pull_request ? GITHUB_PULL_PAGE_TYPE : GITHUB_ISSUE_PAGE_TYPE,
    title: `${heading} (${owner}/${repo}#${item.number})`,
    body: `${lines.join("\n")}\n`,
    truth,
    findings,
  };
}
