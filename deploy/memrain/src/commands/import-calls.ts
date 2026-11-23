/**
 * `memrain import --calls --dir D --source S [--apply --plan-hash H]`: exported
 * call and meeting transcripts (.txt and .md files) imported as one page each,
 * `calls/<date>-<title>`.
 *
 *   - The date is the file name's leading YYYY-MM-DD, else the first date on
 *     the first line, else the file's modified day in MEMRAIN_TIMEZONE (UTC
 *     when unset); the title is the rest of a
 *     dated file name, else the first line, else the file name.
 *   - The words are kept as written, after the transcript lane's credential
 *     redaction over the text, the title and the file path (one dictionary, so
 *     a token seen once is swept from all three), with lines that would read as
 *     page structure neutralized. Nothing unredacted is stored or printed.
 *   - The page is outside text (trust tier external) and opts out of automatic
 *     fact extraction (`facts_extraction: false`), so the import starts no paid
 *     call beyond the indexing every page write gets (embeddings, and the
 *     contextual tier only where the operator switched it on). A page whose
 *     indexing failed is indexed again by the cycle's mirror-pages phase.
 *   - Each file imports once: its identity is a digest of the import folder's
 *     real path and the file's path under it (`call_import.path_digest`); a
 *     rerun from that folder or any folder above it finds the page and reports
 *     it unchanged, or kept when the file changed since, and never writes it
 *     again; one whose page was deleted is reported deleted and not brought
 *     back. A slug another page holds gets a `-2` (then `-3` …) suffix.
 *   - A file is opened without following a symbolic link, and no message
 *     about a file names its path.
 *   - A run without --apply is a dry run: it prints the plan and its
 *     plan_hash and writes nothing; --apply recomputes the plan against the
 *     live brain and refuses unless the hash still matches.
 */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { Storage } from "../core/storage.ts";
import { loadConfig } from "../core/config.ts";
import type { EmbedFn } from "../core/indexer.ts";
import { putPage, validateSlug } from "../core/pages.ts";
import { mirrorPage } from "../core/page-index.ts";
import { neutralizeOutsideText } from "../core/neutralize-outside-text.ts";
import { auditSecrets, guardEchoes, guardSecrets, withSecretDisposition, type EchoDictionary, type SecretFinding } from "../core/secret-scan.ts";
import { dayInZone, thinkTimeZone } from "../core/temporal.ts";
import { withStorage } from "./with-storage.ts";

export const CALL_FILE_RE = /\.(txt|md)$/i;
export const CALL_PREFIX = "calls";
export const CALL_PAGE_TYPE = "meeting";
const WRITTEN_BY = "import-calls";
const MAX_FILE = 1024 * 1024;
const MAX_FILES = 10_000;
const MAX_SUFFIX = 99;
const LEADING_DATE_RE = /^(\d{4}-\d{2}-\d{2})(?=[\s_.-]|$)/;
const LEADING_SEPARATORS_RE = /^[\s_.-]+/;
const TITLE_EDGE = new Set([..." \t\n\r:|,.-"]);
const ANY_DATE_RE = /\b(\d{4}-\d{2}-\d{2})\b/;
const MARKER_SPLIT_RE = /(\[REDACTED:[^\]]*\])/;

export interface CallPage {
  /** The relative path as stored and printed: redacted like the title and body. */
  file: string;
  slug: string;
  title: string;
  date: string;
  date_from: "file_name" | "first_line" | "modified";
  /** The page body: the opt-out frontmatter, then the redacted, neutralized transcript. */
  body: string;
  redactions: number;
  /** Of the title and transcript as stored: a later run compares it to tell a changed file. */
  hash: string;
  findings: SecretFinding[];
}

export interface CallPlanEntry {
  file: string;
  slug: string;
  /** `deleted`: the file's page was imported and later deleted; it is not imported again. */
  status: "new" | "unchanged" | "kept" | "deleted" | "error";
  date_from?: CallPage["date_from"];
  redactions?: number;
  hash?: string;
  error?: string;
}

/** .txt and .md files under `dir`, sorted; dot entries and symbolic links are skipped. */
export function listCallFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number): void => {
    if (depth > 32) throw new Error("import --calls: directory depth exceeds 32");
    for (const name of readdirSync(d).sort()) {
      if (name.startsWith(".")) continue;
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(p, depth + 1);
      else if (st.isFile() && CALL_FILE_RE.test(name)) out.push(p);
      if (out.length > MAX_FILES) throw new Error(`import --calls: more than ${MAX_FILES} call files; split the folder`);
    }
  };
  walk(dir, 0);
  return out;
}

const validDay = (day: string | undefined): string | null => {
  if (!day) return null;
  const t = Date.parse(`${day}T00:00:00Z`);
  return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== day ? null : day;
};

/** The calendar day of `ms` in the brain's zone (MEMRAIN_TIMEZONE, else UTC). */
const brainDay = (ms: number): string => dayInZone(new Date(ms), thinkTimeZone());

/**
 * One call file's bytes and modified time. Opened without following a link,
 * through real folders only, and measured on the open handle, so a file or a
 * folder swapped for a link after the listing is refused instead of read.
 */
export function readCallFile(abs: string): { bytes: Buffer; mtimeMs: number } {
  // The listing walked real folders; a folder on the way swapped for a link since is refused too.
  if (realpathSync(abs) !== abs) throw new CallFileError("reached through a symbolic link; not followed");
  const fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new CallFileError("not a regular file");
    // Checked again once open: a folder swapped for a link and back in between would have to land
    // exactly inside this window. (Node has no per-component no-follow open to close it fully.)
    const now = lstatSync(abs);
    if (realpathSync(abs) !== abs || now.ino !== st.ino || now.dev !== st.dev) throw new CallFileError("changed while it was read; import again");
    if (st.size > MAX_FILE) throw new CallFileError("larger than 1 MiB; split the transcript");
    return { bytes: readFileSync(fd), mtimeMs: st.mtimeMs };
  } finally {
    closeSync(fd);
  }
}

/** A refusal whose message names no path, so it can be printed as it is. */
class CallFileError extends Error {}

/** What went wrong with one file, in words that never carry its path (which may hold a credential). */
function callFileProblem(err: unknown): string {
  if (err instanceof CallFileError) return err.message;
  if (err instanceof TypeError) return "not UTF-8 text";
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "ELOOP" || code === "EMLINK") return "a symbolic link; not followed";
  if (typeof code === "string" && /^E[A-Z]{2,15}$/.test(code)) return `could not be read (${code})`;
  return "could not be read";
}

/** The first non-empty line of the text, past a leading frontmatter block, without heading marks. */
function firstLine(text: string): string {
  let lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
    if (end > 0) lines = lines.slice(end + 1);
  }
  return (lines.find(l => l.trim()) ?? "").trim().replace(/^#+\s*/, "");
}

/** `s` without the spaces and punctuation at either end that a title line carries around its date. */
function trimEdges(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && TITLE_EDGE.has(s[start]!)) start++;
  while (end > start && TITLE_EDGE.has(s[end - 1]!)) end--;
  return s.slice(start, end);
}

/** A slug segment from a title: lowercase letters and digits of any script, runs of anything else one hyphen. */
function slugSegment(title: string): string {
  // Every run of other characters is one hyphen already, so each end holds at most one.
  const s = title.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-");
  const cut = (s.startsWith("-") ? s.slice(1) : s).slice(0, 80);
  return cut.endsWith("-") ? cut.slice(0, -1) : cut;
}

/**
 * The page one call file becomes. `rel` is the file's path under the import
 * folder; credentials in it, in the title and in the text are redacted before
 * any of them is used.
 */
export function callPageFor(rel: string, text: string, mtimeMs: number): CallPage {
  return withSecretDisposition("redact", () => {
    const findings: SecretFinding[] = [];
    const echo: EchoDictionary = new Map();
    const guard = (s: string, where: string): string => {
      const r = guardSecrets(s, where, { echo, transcriptRules: true });
      findings.push(...r.findings);
      return r.text;
    };
    const sweep = (s: string): string => guardEchoes(s, echo, findings);
    const guardedFile = guard(rel, "call import file name");
    const guardedText = guard(text, "call import transcript");
    const file = sweep(guardedFile);
    const transcript = sweep(guardedText);

    const name = basename(file).replace(CALL_FILE_RE, "");
    const lead = LEADING_DATE_RE.exec(name);
    const afterDate = lead ? name.slice(lead[1]!.length).replace(LEADING_SEPARATORS_RE, "") : "";
    const line = firstLine(transcript);
    const fromName = validDay(lead?.[1]);
    const fromLine = fromName ? null : validDay(ANY_DATE_RE.exec(line)?.[1]);
    const date = fromName ?? fromLine ?? brainDay(mtimeMs);
    // Separators in a file name read as spaces, except inside a redaction marker.
    const nameTitle = (fromName ? afterDate : name).split(MARKER_SPLIT_RE).map((part, i) => i % 2 ? part : part.replace(/[_-]+/g, " ")).join("").trim();
    const lineTitle = trimEdges(line.replace(ANY_DATE_RE, ""));
    const title = sweep(((fromName ? nameTitle || lineTitle : lineTitle || nameTitle) || "call").slice(0, 120));
    const content = neutralizeOutsideText(transcript).trimEnd();
    const body = `---\ndate: ${date}\nfacts_extraction: false\n---\n${content}\n`;
    // Of what the file says, not of the date its modified time may have chosen.
    const hash = createHash("sha256").update(`${title}\u0000${content}`).digest("hex").slice(0, 16);
    return {
      file, slug: `${CALL_PREFIX}/${date}-${slugSegment(title) || "call"}`, title, date,
      date_from: fromName ? "file_name" : fromLine ? "first_line" : "modified",
      body, redactions: findings.length, hash, findings,
    };
  });
}

/** The import folder's identity in a page: a short digest of its real path. */
export const callRootId = (root: string): string => createHash("sha256").update(root).digest("hex").slice(0, 12);

/** call_import.path_digest: the file's identity, a digest of the import folder's real path and the path under it. */
export const callPathDigest = (root: string, rel: string): string => createHash("sha256").update(`${root}\u0000${rel}`).digest("hex").slice(0, 32);

/** Every digest the file `abs` has had: one per folder above it that an import could have started from. */
function callPathDigests(abs: string): string[] {
  const out: string[] = [];
  for (let dir = dirname(abs); ; dir = dirname(dir)) {
    out.push(callPathDigest(dir, relative(dir, abs)));
    if (dirname(dir) === dir) return out;
  }
}

interface PlannedPage { entry: CallPlanEntry; page?: CallPage; pathDigest?: string }

interface CallPlan { root: string; rootId: string; pages: PlannedPage[]; planHash: string }

async function planCalls(storage: Storage, dir: string, source: string): Promise<CallPlan> {
  const root = realpathSync(resolve(dir));
  if (!lstatSync(root).isDirectory()) throw new Error("import --calls: --dir must name a folder");
  const rootId = callRootId(root);
  const files = listCallFiles(root);
  const e = storage.engine();
  // scope: upstream every read below is narrowed to the target source, or names slugs, which are global
  // Deleted pages too: a call deliberately deleted is not brought back by the next import.
  const prior = (await e.query<{ slug: string; path: string | null; hash: string | null; deleted: boolean }>(
    `SELECT slug, compiled_truth->'call_import'->>'path_digest' AS path, compiled_truth->'call_import'->>'hash' AS hash,
            deleted_at IS NOT NULL AS deleted
       FROM pages
      WHERE source_id = $1 AND left(slug, $3) = $2
        AND compiled_truth->'call_import'->>'path_digest' IS NOT NULL`,
    [source, `${CALL_PREFIX}/`, CALL_PREFIX.length + 1],
  )).rows;
  const byPath = new Map(prior.map(r => [r.path!, r]));

  const built: PlannedPage[] = [];
  for (const abs of files) {
    const rel = relative(root, abs);
    let page: CallPage;
    try {
      const { bytes, mtimeMs } = readCallFile(abs);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      page = callPageFor(rel, text, mtimeMs);
    } catch (err) {
      built.push({ entry: { file: callPageFor(rel, "", 0).file, slug: "", status: "error", error: callFileProblem(err) } });
      continue;
    }
    try {
      validateSlug(page.slug);
    } catch {
      built.push({ entry: { file: page.file, slug: "", status: "error", error: "no valid page name could be made from its date and title; rename the file" } });
      continue;
    }
    const base = { file: page.file, date_from: page.date_from, redactions: page.redactions, hash: page.hash };
    const found = callPathDigests(abs).map(d => byPath.get(d)).find(r => r !== undefined);
    if (found) {
      built.push({ entry: { ...base, slug: found.slug, status: found.deleted ? "deleted" : found.hash === page.hash ? "unchanged" : "kept" } });
      continue;
    }
    built.push({ entry: { ...base, slug: page.slug, status: "new" }, page, pathDigest: callPathDigest(root, rel) });
  }

  // A slug is the page's key across every source: one already taken, or claimed
  // earlier in this run, moves to the first free suffix.
  const taken = new Set((await e.query<{ slug: string }>(
    `SELECT slug FROM pages WHERE left(slug, $2) = $1`, [`${CALL_PREFIX}/`, CALL_PREFIX.length + 1],
  )).rows.map(r => r.slug));
  for (const b of built) {
    if (b.entry.status !== "new") continue;
    const base = b.entry.slug;
    let slug = base;
    for (let n = 2; taken.has(slug) && n <= MAX_SUFFIX; n++) slug = `${base}-${n}`;
    if (taken.has(slug)) {
      b.entry = { ...b.entry, status: "error", error: `${base} and its suffixes up to -${MAX_SUFFIX} are taken; rename the file` };
      delete b.page;
      continue;
    }
    taken.add(slug);
    b.entry = { ...b.entry, slug };
  }

  const manifest = built.map(b => b.entry);
  const planHash = createHash("sha256").update(JSON.stringify({ version: 1, source, root: rootId, manifest })).digest("hex");
  return { root, rootId, pages: built, planHash };
}

export interface CallImportOptions {
  dir: string;
  source: string;
  apply?: boolean;
  planHash?: string;
  /** Test seams: production opens its own storage and embeds through the configured provider. */
  storage?: Storage;
  embedFn?: EmbedFn;
}

export async function runCallImport(opts: CallImportOptions): Promise<number> {
  if (!opts.dir || !opts.source) throw new Error("import --calls: --dir and --source are required");
  if (opts.apply && !opts.planHash) throw new Error("import --calls: plan hash is required for apply");
  const storage = opts.storage ?? new Storage(loadConfig());
  return withStorage(storage, async () => {
    const e = storage.engine();
    if (!(await e.query("SELECT id FROM sources WHERE id = $1", [opts.source])).rows.length) throw new Error("import --calls: register the target source first");
    const plan = await planCalls(storage, opts.dir, opts.source);
    const manifest = plan.pages.map(p => p.entry);
    const count = (s: CallPlanEntry["status"]) => manifest.filter(m => m.status === s).length;
    const report = {
      ok: count("error") === 0, dry_run: !opts.apply, mode: "calls", source: opts.source, prefix: CALL_PREFIX, plan_hash: plan.planHash,
      total_files: manifest.length, new: count("new"), unchanged: count("unchanged"), kept: count("kept"), deleted: count("deleted"), errors: count("error"),
      redactions: manifest.filter(m => m.status === "new").reduce((n, m) => n + (m.redactions ?? 0), 0),
      facts_extraction: false, pages: manifest,
    };
    if (!opts.apply) {
      console.log(JSON.stringify(report, null, 2));
      return report.ok ? 0 : 1;
    }
    if (opts.planHash !== plan.planHash) throw new Error("import --calls: stale plan hash; preview again");

    const imported: string[] = [];
    let mirrorFailures = 0;
    for (const p of plan.pages) {
      if (p.entry.status !== "new" || !p.page) continue;
      const truth = {
        date: p.page.date,
        call_import: { file: p.page.file, root: plan.rootId, path_digest: p.pathDigest!, hash: p.page.hash, redactions: p.page.redactions },
      };
      const put = await withSecretDisposition("redact", () => putPage(storage, {
        slug: p.entry.slug, type: CALL_PAGE_TYPE, allowAdHocType: true, title: p.page!.title, markdown_body: p.page!.body,
        compiled_truth: truth, source_id: opts.source, written_by: WRITTEN_BY, outsideText: true, trust_tier: "external",
        // Create only: a page that appeared at this slug since the preview stops the run.
        expectedVersion: 0,
      }));
      if (put.held) throw new Error(`import --calls: ${p.entry.slug} was held (${put.held}); nothing more was written`);
      imported.push(p.entry.slug);
      await auditSecrets(e, p.page.findings, p.entry.slug, opts.source);
      const ok = await mirrorPage(storage,
        { slug: p.entry.slug, title: p.page.title, markdown_body: put.outside_body ?? p.page.body, content_hash: put.content_hash, source_id: opts.source },
        { remote: false, timingLabel: "import_calls", ...(opts.embedFn ? { embedFn: opts.embedFn } : {}) });
      if (!ok) mirrorFailures++;
    }
    console.log(JSON.stringify({
      ...report, imported: imported.length, imported_slugs: imported, mirror_failures: mirrorFailures,
      ...(mirrorFailures > 0 ? { note: "Pages whose indexing failed are written; the cycle's mirror-pages phase indexes them." } : {}),
    }, null, 2));
    return report.ok && mirrorFailures === 0 ? 0 : 1;
  }, { owned: !opts.storage, migrate: false });
}
