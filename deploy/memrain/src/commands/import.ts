import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseDocument } from "yaml";
import { Storage } from "../core/storage.ts";
import { loadConfig } from "../core/config.ts";
import { putPage, validateSlug } from "../core/pages.ts";
import { withStorage } from "./with-storage.ts";

interface ImportOptions { dir: string; source: string; apply?: boolean; planHash?: string; storage?: Storage }
interface ImportPage { slug: string; title: string; type: string; markdown_body: string; file_hash: string }
const MAX_FILE = 1024 * 1024;
const MAX_TOTAL = 100 * 1024 * 1024;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

function readExport(dir: string): ImportPage[] {
  const root = realpathSync(resolve(dir));
  const pages: ImportPage[] = [];
  let bytes = 0;
  function walk(path: string, depth: number) {
    if (depth > 32) throw new Error("import: directory depth exceeds 32");
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(path, entry.name);
      if (entry.isSymbolicLink()) throw new Error("import: symbolic links are not accepted");
      if (entry.isDirectory()) { walk(file, depth + 1); continue; }
      if (!entry.name.endsWith(".md")) continue;
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.size > MAX_FILE) throw new Error("import: expected a regular markdown file of at most 1 MiB");
      bytes += stat.size;
      if (bytes > MAX_TOTAL || pages.length >= 10_000) throw new Error("import: export exceeds 100 MiB or 10,000 pages; split the export");
      const slug = relative(root, file).replace(/\\/g, "/").slice(0, -3);
      validateSlug(slug);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(file));
      const header = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
      if (!header) throw new Error(`import: ${slug} has no export frontmatter`);
      const document = parseDocument(header[1]!, { schema: "failsafe" });
      if (document.errors.length) throw new Error(`import: ${slug} has invalid frontmatter`);
      const meta = document.toJS({ maxAliasCount: 0 });
      if (!meta || typeof meta.title !== "string" || typeof meta.type !== "string") throw new Error(`import: ${slug} requires string title and type`);
      // export adds one separator and one trailing newline outside the body.
      const body = text.slice(header[0].length).replace(/^\r?\n/, "").replace(/\r?\n$/, "");
      pages.push({ slug, title: meta.title, type: meta.type, markdown_body: body, file_hash: hash(text) });
    }
  }
  walk(root, 0);
  if (new Set(pages.map(p => p.slug)).size !== pages.length) throw new Error("import: duplicate slugs in export");
  return pages;
}

export async function runImport(opts: ImportOptions): Promise<number> {
  if (!opts.dir || !opts.source) throw new Error("import: --dir and --source are required");
  const pages = readExport(opts.dir);
  const manifest = pages.map(p => ({ slug: p.slug, title: p.title, type: p.type,
    body_hash: hash(p.markdown_body), file_hash: p.file_hash }));
  const planHash = hash(JSON.stringify({ version: 1, source: opts.source, manifest }));
  if (opts.apply && !opts.planHash) throw new Error("import: plan hash is required for apply");
  if (opts.apply && opts.planHash !== planHash) throw new Error("import: stale plan hash; preview again");
  const storage = opts.storage ?? new Storage(loadConfig());
  return withStorage(storage, async () => {
    const e = storage.engine();
    if (!(await e.query("SELECT id FROM sources WHERE id = $1", [opts.source])).rows.length) throw new Error("import: register the target source first");
    const existing = await e.query<{ slug: string }>("SELECT slug FROM pages WHERE slug = ANY($1::text[])", [pages.map(p => p.slug)]);
    const report = { ok: existing.rows.length === 0, dry_run: !opts.apply, source: opts.source, plan_hash: planHash, manifest,
      candidates: pages.length, created: 0, conflicts: existing.rows.map(r => r.slug), facts_extraction: false,
      indexing: "deferred_to_reconcile", note: "Page content only; versions, facts, grants and other database state are not restored." };
    if (!report.ok || !opts.apply) { console.log(JSON.stringify(report, null, 2)); return report.ok ? 0 : 1; }
    const created: string[] = [];
    try {
      for (const page of pages) {
        // Core writes have no MCP extraction side effects. The version check is
        // under the slug lock, so a writer racing the preview wins safely.
        const { file_hash, ...input } = page;
        await putPage(storage, { ...input, source_id: opts.source, expectedVersion: 0, allowAdHocType: true, written_by: "import" });
        created.push(page.slug);
      }
    } catch (error) {
      console.log(JSON.stringify({ ...report, ok: false, created: created.length, created_slugs: created, error: "import_stopped", note: "Earlier creates remain; inspect conflicts before retrying." }, null, 2));
      throw error;
    }
    console.log(JSON.stringify({ ...report, created: created.length, created_slugs: created }, null, 2));
    return 0;
  }, { owned: !opts.storage, migrate: false });
}
