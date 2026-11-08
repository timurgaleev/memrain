/**
 * Fence-derived fact rows are stamped `memrain:facts-fence`, and auto-resolved
 * takes `memrain:grade_takes`. Rows stamped with the pre-rename `memex:` values
 * stay as they are: the reconcile wipe goes by `source_markdown_slug`, and no
 * SQL, now or in the last pre-rename release, filters on either stamp.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { renderFactsFence, type ParsedFact } from "../src/core/facts-fence.ts";
import { FENCE_WRITERS, reconcileFactsForPage } from "../src/core/facts-reconcile.ts";

let tmp: string;
let storage: Storage;

beforeAll(async () => {
  delete process.env.MEMRAIN_FACTS_FENCE;
  tmp = mkdtempSync(join(tmpdir(), "memrain-fence-writer-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

const FACTS: ParsedFact[] = [
  { rowNum: 1, claim: "Founded Acme", confidence: 1, active: true },
  { rowNum: 2, claim: "Lives in Lisbon", confidence: 0.9, active: true },
  { rowNum: 3, claim: "Speaks Portuguese", confidence: 0.8, active: true },
];

async function putAndReconcile(slug: string, body: string) {
  const r = await putPage(storage, { slug, type: "person", markdown_body: body });
  return reconcileFactsForPage(storage, slug, r.content_hash);
}

async function writers(slug: string): Promise<string[]> {
  const r = await storage.engine().query<{ written_by: string }>(
    `SELECT written_by FROM entity_facts WHERE source_markdown_slug = $1 ORDER BY row_num`,
    [slug],
  );
  return r.rows.map((x) => x.written_by);
}

describe("the fence writer stamp", () => {
  it("lists the current stamp first and the pre-rename one after it", () => {
    expect(FENCE_WRITERS).toEqual(["memrain:facts-fence", "memex:facts-fence"]);
  });

  for (const brand of ["memex", "memrain"] as const) {
    it(`a prose edit keeps legacy stamps and a changed ${brand}: fence row gets the current stamp`, async () => {
      const slug = `people/writer-${brand}`;
      const body = `# Alice\n\n## Facts\n${renderFactsFence(FACTS, brand)}\n`;
      await putAndReconcile(slug, body);
      // What a pre-rename release left behind.
      await storage.engine().query(
        `UPDATE entity_facts SET written_by = 'memex:facts-fence' WHERE source_markdown_slug = $1`,
        [slug],
      );
      expect(await writers(slug)).toEqual(FACTS.map(() => "memex:facts-fence"));

      const r = await putAndReconcile(slug, `${body}\nAn unrelated prose edit.\n`);
      expect(r).toEqual({ removed: 0, added: 0, unchanged: FACTS.length });
      expect(await writers(slug)).toEqual(FACTS.map(() => "memex:facts-fence"));
      await putAndReconcile(slug, renderFactsFence(FACTS.map(f => f.rowNum === 1 ? { ...f, claim: "Founded another company" } : f), brand));
      expect(await writers(slug)).toEqual(["memrain:facts-fence", "memex:facts-fence", "memex:facts-fence"]);
    });
  }
});

/** Every file below `dir`, recursively. */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

// A comparison of either stamp column to a literal of one brand, in SQL or TS.
const BRAND_FILTER =
  /\b(?:written_by|resolved_by|writtenBy|resolvedBy)\s*(?:=|<>|!=|===|!==|==|I?LIKE|IN)\s*(?:\(\s*)?['"`](?:memex|memrain):/i;
const BRAND_FILTER_REVERSED = /['"`](?:memex|memrain):[\w-]+['"`]\s*(?:=|<>|!=|===|!==|==)\s*(?:written_by|resolved_by|writtenBy|resolvedBy)\b/i;

function isComment(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith("--") || t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

describe("no reader filters on one brand's stamp", () => {
  it("the scan pattern catches the shapes it is meant to", () => {
    for (const bad of [
      "WHERE written_by = 'memex:facts-fence'",
      "AND resolved_by <> 'memrain:grade_takes'",
      "written_by IN ('memex:facts-fence')",
      "if (row.writtenBy === \"memrain:facts-fence\")",
      "WHERE 'memex:grade_takes' = resolved_by",
    ]) {
      expect(BRAND_FILTER.test(bad) || BRAND_FILTER_REVERSED.test(bad)).toBe(true);
    }
    expect(BRAND_FILTER.test("written_by = $1")).toBe(false);
  });

  // src/ carries the current TypeScript plus migrations 001–119 exactly as the
  // last pre-rename release shipped them; the v1.163 test holds that release's
  // TypeScript SQL verbatim.
  it("src/ and the verbatim pre-rename SQL corpus", () => {
    const root = join(import.meta.dir, "..");
    const files = [
      ...walk(join(root, "src")).filter((f) => /\.(?:ts|sql)$/.test(f)),
      join(root, "tests", "v1163_paths_post_migration.test.ts"),
    ];
    expect(files.some((f) => f.includes(`${join("migrations", "001_")}`))).toBe(true);
    const hits: string[] = [];
    for (const f of files) {
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        if (isComment(line)) return;
        if (BRAND_FILTER.test(line) || BRAND_FILTER_REVERSED.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
