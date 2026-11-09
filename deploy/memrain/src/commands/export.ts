/**
 * `memrain export [--dir DIR] [--source ID...]` — dump every live page to markdown
 * files (frontmatter + body), mirroring the slug directory structure. memrain's
 * substrate is DB-only, so this is the portability / backup escape hatch: an RDS
 * snapshot is not user-readable, a markdown tree is. `--source` scopes the dump
 * to one or more tenants, which doubles as a per-tenant data export.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { Storage } from "../core/storage.ts";
import { withStorage } from "./with-storage.ts";
import { loadConfig } from "../core/config.ts";
import { normalizeSourceFilterParam } from "../core/source-scope.ts";

export interface ExportCmdOptions {
  /** Output directory (default: ./export). */
  dir?: string;
  /** Restrict to these source ids (default: all tenants). */
  sourceIds?: string[];
  /** @internal Injected Storage for hermetic tests (caller owns lifecycle). */
  storage?: Storage;
}

interface PageRow {
  slug: string;
  type: string;
  title: string | null;
  markdown_body: string | null;
  source_id: string | null;
}

/** YAML-ish header with the values that round-trip a page: title + type. Titles
 *  with structural characters are JSON-quoted so the header stays valid. */
function frontmatterBlock(row: PageRow): string {
  const title = row.title ?? row.slug;
  const needsQuote = /[\n\r:"'#[\]{}|>&*!?,]/.test(title);
  return (
    `---\n` +
    `title: ${needsQuote ? JSON.stringify(title) : title}\n` +
    `type: ${row.type}\n` +
    `---\n`
  );
}

export async function runExport(opts: ExportCmdOptions = {}): Promise<void> {
  const injected = opts.storage;
  const storage = injected ?? new Storage(loadConfig());
  const outDir = resolve(opts.dir ?? "./export");
  return withStorage(storage, async () => {
    const sourceIds = normalizeSourceFilterParam(opts.sourceIds);
    const scoped = sourceIds !== undefined;
    const r = await storage.engine().query<PageRow>(
      `SELECT slug, type, title, markdown_body, source_id
         FROM pages
        WHERE deleted_at IS NULL${scoped ? ` AND source_id = ANY($1::text[])` : ""}
        ORDER BY slug`,
      scoped ? [sourceIds] : [],
    );
    let written = 0;
    for (const row of r.rows) {
      // Slug segments become nested dirs; guard against a `..` escaping outDir.
      const rel = `${row.slug}.md`.replace(/\\/g, "/");
      if (rel.split("/").includes("..")) continue;
      const target = join(outDir, rel);
      // Belt-and-suspenders: the resolved path must stay under outDir regardless
      // of any future slug shape the segment check above doesn't anticipate.
      if (target !== outDir && !resolve(target).startsWith(outDir + "/")) continue;
      mkdirSync(dirname(target), { recursive: true });
      const body = row.markdown_body ?? "";
      writeFileSync(target, frontmatterBlock(row) + "\n" + body + "\n", { mode: 0o644 });
      written += 1;
    }
    console.log(
      JSON.stringify(
        { ok: true, dir: outDir, pages: written, scoped: scoped ? opts.sourceIds : "all" },
        null,
        2,
      ),
    );
  }, { owned: !injected });
}
