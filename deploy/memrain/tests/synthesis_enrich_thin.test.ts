/**
 * Enrich-thin phase — hermetic (injected SonnetFn, no Bedrock). Covers the
 * insufficient-evidence skip, grounded stub → fuller-page rewrite, and the
 * sanitizeForPrompt `.text` unwrap regression guard ([object Object]).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage, getPage } from "../src/core/pages.ts";
import { enrichThinPhase } from "../src/core/synthesis/enrich-thin.ts";
import type { SonnetFn } from "../src/core/llm/sonnet.ts";
import { QUARANTINE_KEY } from "../src/core/quarantine.ts";

let tmp: string;
let storage: Storage;

let lastPrompt = "";
const fakeSonnet = (text: string): SonnetFn => async (input) => {
  lastPrompt = input.user;
  return {
    text,
    modelId: "eu.anthropic.claude-sonnet-4-6",
    usage: { inputTokens: 200, outputTokens: 120 },
  };
};

/** A quarantined search mirror for page `slug`, as the content gate leaves one. */
async function quarantineMirror(slug: string): Promise<void> {
  await storage.engine().query(
    `INSERT INTO documents (id, source_path, title, frontmatter) VALUES ($1, $2, 't', $3::text::jsonb)`,
    [`held-${slug}`, `page://${slug}`, JSON.stringify({ [QUARANTINE_KEY]: { patterns: ["test"] } })],
  );
}

async function link(source: string, target: string): Promise<void> {
  await storage.engine().query(
    `INSERT INTO links (source_slug, target_slug, type) VALUES ($1, $2, 'wikilink')`,
    [source, target],
  );
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-enrich-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.MEMRAIN_ENRICH_THIN;
  delete process.env.MEMRAIN_ENRICH_THIN_BUDGET_USD;
});

describe("enrichThinPhase", () => {
  it("takes no evidence from a neighbour the content gate quarantined", async () => {
    await putPage(storage, { slug: "people/dave", type: "person", title: "Dave", markdown_body: "stub", source_id: "default" });
    await putPage(storage, {
      slug: "notes/dave-held",
      type: "note",
      title: "Held",
      markdown_body: "Dave quarantined neighbour text that the gate hid from search and must not reach the model.",
      source_id: "default",
    });
    await link("people/dave", "notes/dave-held");
    await quarantineMirror("notes/dave-held");
    lastPrompt = "";
    const r = await enrichThinPhase(storage, { sonnetFn: fakeSonnet("{}") });
    expect(r.pagesEnriched).toBe(0);
    expect(lastPrompt).not.toContain("quarantined neighbour text");
  });

  it("skips a thin page with no neighbour evidence", async () => {
    await putPage(storage, { slug: "people/bob", type: "person", title: "Bob", markdown_body: "a short stub about Bob", source_id: "default" });
    const r = await enrichThinPhase(storage, { sonnetFn: fakeSonnet("{}") });
    expect(r.thinPagesConsidered).toBe(1);
    expect(r.pagesSkippedInsufficient).toBe(1);
    expect(r.pagesEnriched).toBe(0);
  });

  it("expands a stub from neighbour evidence and rewrites the page", async () => {
    await putPage(storage, { slug: "people/carol", type: "person", title: "Carol", markdown_body: "stub", source_id: "default" });
    await putPage(storage, {
      slug: "companies/acme",
      type: "company",
      title: "Acme Corp",
      markdown_body:
        "Acme Corp is a robotics company where Carol works as lead engineer. " +
        "The company builds autonomous mobile robots for warehouse logistics and " +
        "was founded in 2018. It has raised two rounds of venture funding and now " +
        "employs roughly two hundred people across engineering, sales, and support. " +
        "Carol leads the autonomy team and reports directly to the CTO.",
      source_id: "default",
    });
    await link("people/carol", "companies/acme");

    const payload = JSON.stringify({
      title: "Carol",
      markdown: "Carol is a lead engineer at [[companies/acme]], a robotics company. Her work centres on autonomy.",
    });
    const r = await enrichThinPhase(storage, { sonnetFn: fakeSonnet(payload) });
    expect(r.ran).toBe(true);
    expect(r.pagesEnriched).toBe(1);

    // Prompt must carry real neighbour content — regression guard for the
    // sanitizeForPrompt `.text` unwrap (a bare object renders "[object Object]").
    expect(lastPrompt).toContain("robotics company");
    expect(lastPrompt).not.toContain("[object Object]");

    const page = await getPage(storage, "people/carol");
    expect(page).not.toBeNull();
    expect(page!.markdown_body).toContain("[[companies/acme]]");
    expect(page!.markdown_body.length).toBeGreaterThan("stub".length);
  });

  it("spends nothing when MEMRAIN_ENRICH_THIN_BUDGET_USD=0 (no Sonnet call)", async () => {
    process.env.MEMRAIN_ENRICH_THIN_BUDGET_USD = "0";
    await putPage(storage, { slug: "people/erin", type: "person", title: "Erin", markdown_body: "stub", source_id: "default" });
    await putPage(storage, {
      slug: "notes/erin-context",
      type: "note",
      title: "Erin context",
      markdown_body: "Erin runs the platform team and owns the deployment pipeline for the whole org.",
      source_id: "default",
    });
    await link("people/erin", "notes/erin-context");

    let calls = 0;
    const counting: SonnetFn = async (input) => {
      calls += 1;
      return fakeSonnet("{}")(input);
    };
    const r = await enrichThinPhase(storage, { sonnetFn: counting });
    expect(calls).toBe(0);
    expect(r.budgetExhausted).toBe(true);
    expect(r.pagesEnriched).toBe(0);
    expect(r.spentUsd).toBe(0);
  });

  it("rejects an expansion that does not grow the stub", async () => {
    await putPage(storage, { slug: "people/dave", type: "person", title: "Dave", markdown_body: "a reasonably sized stub about Dave here", source_id: "default" });
    await putPage(storage, { slug: "notes/n1", type: "note", title: "N1", markdown_body: "Dave is mentioned in this note about the project kickoff.", source_id: "default" });
    await link("people/dave", "notes/n1");

    const r = await enrichThinPhase(storage, { sonnetFn: fakeSonnet(JSON.stringify({ markdown: "tiny" })) });
    expect(r.pagesEnriched).toBe(0);
    const page = await getPage(storage, "people/dave");
    expect(page!.markdown_body).toContain("reasonably sized stub");
  });

  /**
   * The draft parser pulls the widest brace-delimited span out of the model's
   * answer. Doing that with `/\{[\s\S]*\}/` restarted at every brace and
   * re-scanned the tail for a closing one, which a model that stalls mid-object
   * triggers directly: 57 ms at 12 K braces, 3.6 s at 100 K, ratio 4.0 on a
   * doubling. Taken by index instead it is the same span in one pass.
   *
   * The ceiling is loose on purpose — linear is sub-millisecond here and the
   * quadratic version needed minutes at this size.
   */
  it("parses a brace-only answer in linear time", async () => {
    await putPage(storage, { slug: "people/frank", type: "person", title: "Frank", markdown_body: "stub", source_id: "default" });
    await putPage(storage, { slug: "notes/n2", type: "note", title: "N2", markdown_body: "Frank shipped the ingest rewrite last quarter.", source_id: "default" });
    await link("people/frank", "notes/n2");

    const started = performance.now();
    const r = await enrichThinPhase(storage, { sonnetFn: fakeSonnet("{".repeat(1_000_000)) });
    const elapsed = performance.now() - started;

    // Unparseable, so nothing is written — the assertion that the parser ran
    // rather than the phase bailing before it.
    expect(r.pagesEnriched).toBe(0);
    expect(elapsed).toBeLessThan(15_000);
  }, 60_000);
});
