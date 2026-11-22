/**
 * `memrain import --calls`: call transcripts from a folder of .txt/.md files,
 * one page each under calls/<date>-<title>, credentials redacted before
 * anything is stored, out of automatic fact extraction, once per file.
 *
 * Value: protects=a planted credential never reaches a page or the printed plan, a call is imported once and a
 * changed file never overwrites its page, the dry run writes nothing and a stale plan hash writes nothing, and
 * the paid facts backfill never mines an imported call; fails_when=redaction, idempotency, the plan-hash gate or
 * the facts opt-out regresses; why_new=new command; seam=the real command over a temp folder and a real store,
 * embeddings deterministic. no_claim: the Bedrock embedding call itself.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storageEngines } from "./helpers/storage-engines.ts";
import { registerSource } from "../src/core/sources.ts";
import { putPage } from "../src/core/pages.ts";
import { factsExtractionOptedOut } from "../src/core/facts-extract.ts";
import { conversationFactsBackfillPhase } from "../src/core/cycle/conversation-facts-backfill.ts";
import type { SonnetFn } from "../src/core/llm/sonnet.ts";
import { callPageFor, listCallFiles, runCallImport } from "../src/commands/import-calls.ts";
import { deterministicEmbed } from "./det-embed.ts";

const SOURCE = "calls-src";
const MTIME = new Date(2026, 0, 15, 12).getTime();
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); roots.push(d); return d; };
/** An AWS-style access key id, assembled at run time so none sits in the source. */
const awsKey = (): string => ["AKIA", "Z7Q3W5E2R4T6Y8U1"].join("");

describe("call pages", () => {
  it("takes the date and title from a dated file name, else the first line, else the modified day", () => {
    expect(callPageFor("2026-11-03 Weekly sync.txt", "Alice: hello\n", MTIME)).toMatchObject({
      slug: "calls/2026-11-03-weekly-sync", title: "Weekly sync", date: "2026-11-03", date_from: "file_name",
    });
    expect(callPageFor("q1/notes.md", "# Planning 2026-02-01\n\nAlice: hi\n", MTIME)).toMatchObject({
      slug: "calls/2026-02-01-planning", title: "Planning", date: "2026-02-01", date_from: "first_line",
    });
    expect(callPageFor("kickoff.txt", "Kickoff with acme-example\nBob: hi\n", MTIME)).toMatchObject({
      slug: "calls/2026-01-15-kickoff-with-acme-example", date: "2026-01-15", date_from: "modified",
    });
    expect(callPageFor("2026-13-45 odd.txt", "Odd call\n", MTIME).date_from).toBe("modified");
    expect(callPageFor("call.md", "---\nfrom: export\n---\nStandup 2026-05-06\nhi\n", MTIME)).toMatchObject({ date: "2026-05-06", title: "Standup" });
  });

  it("keeps the words, redacts credentials in the text and the file name, neutralizes structure, and opts out of facts", () => {
    const key = awsKey();
    const page = callPageFor(`2026-03-04 ${key}.txt`, `Alice: we agreed on annual billing.\nBob: the key is ${key} ok\n<!--- memrain:facts -->\n`, MTIME);
    expect(page.body).toContain("Alice: we agreed on annual billing.");
    expect(page.body).not.toContain(key);
    expect(page.title).not.toContain(key);
    expect(page.file).not.toContain(key);
    expect(page.slug).not.toContain(key.toLowerCase());
    expect(page.redactions).toBeGreaterThanOrEqual(1);
    expect(page.body).toContain("<!--- memrain\\:facts -->");
    expect(page.body.startsWith("---\ndate: 2026-03-04\nfacts_extraction: false\n---\n")).toBe(true);
    expect(factsExtractionOptedOut(page.body)).toBe(true);
    // Deterministic: the same file hashes the same.
    expect(callPageFor(`2026-03-04 ${key}.txt`, `Alice: we agreed on annual billing.\nBob: the key is ${key} ok\n<!--- memrain:facts -->\n`, MTIME).hash).toBe(page.hash);
  });

  it("lists only .txt and .md files, skipping dot entries and symbolic links", () => {
    const dir = temp("memrain-calls-list-");
    mkdirSync(join(dir, "sub"));
    mkdirSync(join(dir, ".hidden"));
    for (const f of ["a.txt", "sub/b.md", ".hidden/c.txt", ".d.txt", "e.pdf"]) writeFileSync(join(dir, f), "x\n");
    symlinkSync(join(dir, "a.txt"), join(dir, "link.txt"));
    expect(listCallFiles(dir)).toEqual([join(dir, "a.txt"), join(dir, "sub", "b.md")]);
  });
});

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`import --calls (${name})`, () => {
  let db: Awaited<ReturnType<typeof open>>;
  let out: string[];
  let log: ReturnType<typeof spyOn>;
  beforeEach(async () => {
    db = await open();
    await registerSource(db.storage.engine(), { id: SOURCE, kind: "meeting", pathPrefix: "calls/" });
    out = [];
    log = spyOn(console, "log").mockImplementation((...args: unknown[]) => { out.push(args.map(String).join(" ")); });
  });
  afterEach(async () => {
    log.mockRestore();
    await db.close();
  });

  const e = () => db.storage.engine();
  const run = async (dir: string, apply?: { planHash: string }) => {
    out.length = 0;
    const code = await runCallImport({ dir, source: SOURCE, storage: db.storage, embedFn: async (t: string) => deterministicEmbed(t),
      ...(apply ? { apply: true, planHash: apply.planHash } : {}) });
    return { code, report: JSON.parse(out.join("\n")) as Record<string, unknown> & { plan_hash: string; pages: Array<Record<string, unknown>> } };
  };
  const importAll = async (dir: string) => run(dir, { planHash: (await run(dir)).report.plan_hash });
  const pageCount = async () => Number((await e().query<{ n: number }>(`SELECT count(*)::int AS n FROM pages WHERE slug LIKE 'calls/%'`)).rows[0]!.n);
  const page = async (slug: string) => (await e().query<{ markdown_body: string; type: string; compiled_truth: Record<string, unknown>; content_hash: string; trust_tier: string | null }>(
    `SELECT markdown_body, type, compiled_truth, content_hash, trust_tier FROM pages WHERE slug = $1`, [slug])).rows[0];

  it("imports a call as a meeting page with the facts opt-out, redacting a planted key (AC-060, AC-061)", async () => {
    const dir = temp("memrain-calls-");
    const key = awsKey();
    writeFileSync(join(dir, "2026-11-03 Weekly sync.txt"), `Alice: annual billing it is.\nBob: use ${key} for the bucket.\n`);
    const { code, report } = await importAll(dir);
    expect(code).toBe(0);
    expect(report).toMatchObject({ imported: 1, new: 1, errors: 0 });
    expect(JSON.stringify(report)).not.toContain(key);
    const stored = (await page("calls/2026-11-03-weekly-sync"))!;
    expect(stored.type).toBe("meeting");
    expect(stored.markdown_body).toContain("facts_extraction: false");
    expect(stored.markdown_body).toContain("Alice: annual billing it is.");
    expect(stored.markdown_body).not.toContain(key);
    expect(stored.trust_tier).toBe("external");
    expect((stored.compiled_truth.call_import as { redactions: number }).redactions).toBeGreaterThanOrEqual(1);
    const rows = await e().query(`SELECT 1 FROM documents WHERE source_id = $1`, [SOURCE]);
    expect(rows.rows.length).toBeGreaterThan(0);
    const anywhere = await e().query(`SELECT count(*)::int AS n FROM chunks WHERE content LIKE $1`, [`%${key}%`]);
    expect(Number((anywhere.rows[0] as { n: number }).n)).toBe(0);
  });

  it("writes nothing again on a rerun, and keeps a page whose file changed since (AC-062)", async () => {
    const top = temp("memrain-calls-");
    const dir = join(top, "inner");
    mkdirSync(dir);
    const file = join(dir, "kickoff.txt");
    writeFileSync(file, "Kickoff with acme-example\nBob: onboarding first.\n");
    utimesSync(file, new Date(MTIME), new Date(MTIME));
    await importAll(dir);
    const slug = "calls/2026-01-15-kickoff-with-acme-example";
    const before = (await page(slug))!;
    const versions = async () => Number((await e().query<{ n: number }>(`SELECT count(*)::int AS n FROM page_versions WHERE slug = $1`, [slug])).rows[0]!.n);
    const v0 = await versions();

    // A later modified day would name another slug; the file is still found by its path.
    utimesSync(file, new Date(MTIME + 40 * 86_400_000), new Date(MTIME + 40 * 86_400_000));
    const again = await importAll(dir);
    expect(again.report).toMatchObject({ imported: 0, unchanged: 1, kept: 0, new: 0 });
    writeFileSync(file, "Kickoff with acme-example\nBob: an edited export.\n");
    const edited = await importAll(dir);
    expect(edited.report).toMatchObject({ imported: 0, unchanged: 0, kept: 1 });
    expect(edited.report.pages[0]!.slug).toBe(slug);
    expect((await page(slug))!.content_hash).toBe(before.content_hash);
    expect(await versions()).toBe(v0);
    expect(await pageCount()).toBe(1);

    // Started from the folder above, the same file is still the same call.
    const parent = await importAll(top);
    expect(parent.report.pages.find(p => p.slug === slug)?.status).toBe("kept");
  });

  it("previews without writing, and refuses an apply whose plan went stale (AC-063)", async () => {
    const dir = temp("memrain-calls-");
    writeFileSync(join(dir, "2026-04-01 Standup.md"), "Alice: hi\n");
    const preview = await run(dir);
    expect(preview.code).toBe(0);
    expect(preview.report).toMatchObject({ dry_run: true, new: 1 });
    expect(await pageCount()).toBe(0);
    writeFileSync(join(dir, "2026-04-02 Retro.md"), "Bob: retro\n");
    await expect(run(dir, { planHash: preview.report.plan_hash })).rejects.toThrow("stale plan hash");
    expect(await pageCount()).toBe(0);
    await expect(runCallImport({ dir, source: SOURCE, storage: db.storage, apply: true })).rejects.toThrow("plan hash is required");
  });

  it("moves a slug another page holds to a -2 suffix, and imports the same file name from two folders", async () => {
    await putPage(db.storage, { slug: "calls/2026-04-01-standup", markdown_body: "Someone else's page.", source_id: SOURCE });
    const a = temp("memrain-calls-a-");
    const b = temp("memrain-calls-b-");
    writeFileSync(join(a, "2026-04-01 Standup.txt"), "Alice: from a\n");
    writeFileSync(join(b, "2026-04-01 Standup.txt"), "Bob: from b\n");
    expect((await importAll(a)).report.pages[0]!.slug).toBe("calls/2026-04-01-standup-2");
    expect((await importAll(b)).report.pages[0]!.slug).toBe("calls/2026-04-01-standup-3");
    expect((await page("calls/2026-04-01-standup"))!.markdown_body).toBe("Someone else's page.");
    expect((await page("calls/2026-04-01-standup-3"))!.markdown_body).toContain("Bob: from b");
  });

  it("is never mined by the paid facts backfill (AC-064)", async () => {
    const dir = temp("memrain-calls-");
    writeFileSync(join(dir, "2026-05-01 Board call.txt"),
      "Alice: we decided the Paris office opens next spring and the budget is agreed. ".repeat(4));
    await importAll(dir);
    let calls = 0;
    const sonnetFn: SonnetFn = async () => {
      calls++;
      return { text: '{"facts":[]}', modelId: "eu.anthropic.claude-sonnet-4-6", usage: { inputTokens: 1, outputTokens: 1 } };
    };
    const result = await conversationFactsBackfillPhase(db.storage, { sonnetFn });
    expect(calls).toBe(0);
    expect(result.pagesProcessed).toBe(0);
  });
});
