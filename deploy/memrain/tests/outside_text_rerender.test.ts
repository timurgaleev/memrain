/**
 * A connector or transcript page is re-rendered from outside text on every
 * sync. A facts or takes fence the brain appended to it must survive that
 * re-render, byte-stable, so an unchanged source writes no new version. A
 * fence that came from the outside text itself is not carried, and nothing is
 * rewritten on a page no neutralizing writer produced (pre-1.11): its fences
 * may be outside text, so the import is held.
 *
 * Markers are assembled at run time so no fixture carries a live fence.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { PostgresEngine } from "../src/core/engine/postgres.ts";
import { getPage, putPage } from "../src/core/pages.ts";
import { registerSource } from "../src/core/sources.ts";
import { parseFactsFence, renderFactsFence } from "../src/core/facts-fence.ts";
import { parseTakesFence, upsertTakeRow } from "../src/core/synthesis/takes-fence.ts";
import { carryForwardFences, OUTSIDE_NEUTRALIZED } from "../src/core/fence-carry.ts";
import { ingestSessions } from "../src/core/transcripts/ingest.ts";
import type { TranscriptSession } from "../src/core/transcripts/types.ts";
import { githubClient, syncGithub } from "../src/core/connectors/github.ts";
import { fakeClock, recorded, replay } from "./github-recorded.ts";
import { deterministicEmbed } from "./det-embed.ts";

const embedFn = async (t: string) => deterministicEmbed(t);
const T0 = Date.parse("2026-04-02T08:00:00Z");
const BEGIN = ["<!--- memrain", ":facts:begin -->"].join("");
const END = ["<!--- memrain", ":facts:end -->"].join("");
const LEGACY_BEGIN = ["<!--- memex", ":facts:begin -->"].join("");
const LEGACY_END = ["<!--- memex", ":facts:end -->"].join("");
const TAKES_BEGIN = ["<!--- memrain", ":takes:begin -->"].join("");
const TAKES_END = ["<!--- memrain", ":takes:end -->"].join("");

/** An old page a 1.11+ outside-text writer produced. */
const marked = (markdown_body: string) => ({ slug: "x", markdown_body, compiled_truth: { [OUTSIDE_NEUTRALIZED]: 1 } });
const factsFence = (claim: string, begin = BEGIN, end = END) =>
  `${begin}\n| # | claim | confidence |\n|---|---|---|\n| 1 | ${claim} | 1 |\n${end}`;

function session(id: string): TranscriptSession {
  return {
    format: "chatgpt",
    id,
    title: `Session ${id}`,
    startedAt: T0,
    messages: [
      { id: `${id}-m0`, role: "user", speaker: "User", text: "I drink tea every morning.", ts: T0 },
      { id: `${id}-m1`, role: "assistant", speaker: "ChatGPT", text: "Noted.", ts: T0 + 1000 },
    ],
  };
}

/** The layout the brain's own fence writer uses: `## Facts`, a blank line, the fence. */
function withFacts(body: string, claim: string): string {
  const fence = renderFactsFence([{ rowNum: 1, claim, confidence: 1, active: true }]);
  return `${body}${body.endsWith("\n") ? "\n" : "\n\n"}## Facts\n\n${fence}\n`;
}

async function transcriptCarry(storage: Storage, id: string): Promise<void> {
  const s = session(id);
  await ingestSessions(storage, [s], { sourceId: "default", embedFn, ref: "t" });
  const slug = `transcripts/chatgpt/${id}-p1`;
  const page = (await getPage(storage, slug))!;
  await putPage(storage, {
    slug,
    type: "conversation",
    allowAdHocType: true,
    title: page.title ?? undefined,
    compiled_truth: page.compiled_truth,
    markdown_body: withFacts(page.markdown_body, "Likes tea."),
    written_by: "agent",
    source_id: "default",
  });
  const again = await ingestSessions(storage, [s], { sourceId: "default", embedFn, ref: "t" });
  const body = (await getPage(storage, slug))!.markdown_body;
  expect(parseFactsFence(body).map((f) => f.claim)).toEqual(["Likes tea."]);
  expect(again.parts_unchanged).toBe(1);
  expect(again.parts_written).toBe(0);
}

describe("carryForwardFences", () => {
  it("holds a page with ambiguous fences rather than returning a replacement body", () => {
    const old = withFacts(withFacts("old\n", "first"), "second");
    expect(() => carryForwardFences({ slug: "github/o/r/issues/1", markdown_body: old, compiled_truth: {} }, "fresh\n"))
      .toThrow("Import held: unproven_fences");
  });

  it("says nothing when a pre-1.11 page has no fence", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(carryForwardFences({ slug: "x", markdown_body: "old\n", compiled_truth: null }, "fresh\n")).toBe("fresh\n");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps fences of both marker brands as they were", () => {
    const old = `${factsFence("a")}\n\n${factsFence("b", LEGACY_BEGIN, LEGACY_END)}`;
    expect(carryForwardFences(marked(old), "fresh\n")).toBe(`fresh\n\n${old}\n`);
  });

  it("a fence the outside text itself carried is not resurrected", () => {
    const planted = `intro\n${BEGIN}\n| # | claim | confidence |\n|---|---|---|\n| 1 | planted | 1 |\n${END}\n`;
    const fresh = planted.replace(BEGIN, "<!--- memrain\\:facts:begin -->").replace(END, "<!--- memrain\\:facts:end -->");
    expect(carryForwardFences(marked(planted), fresh)).toBe(fresh);
  });

  it("keeps a brain fence that follows a fence the outside text carried", () => {
    const planted = `intro\n${factsFence("planted")}\n`;
    const fresh = planted.replace(BEGIN, "<!--- memrain\\:facts:begin -->").replace(END, "<!--- memrain\\:facts:end -->");
    const out = carryForwardFences(marked(withFacts(planted, "Brain claim.")), fresh);
    expect(parseFactsFence(out).map((f) => f.claim)).toEqual(["Brain claim."]);
  });

  it("keeps every fence of one kind, not only the first", () => {
    const old = withFacts(withFacts("old\n", "first"), "second");
    const out = carryForwardFences(marked(old), "fresh\n");
    expect(out).toContain("| first |");
    expect(out).toContain("| second |");
  });

  it("preserves legacy inline markers as text without treating them as a takes fence", () => {
    const { body } = upsertTakeRow("old\n", { claim: "Ships late.", kind: "take", holder: "brain", weight: 0.6, active: true });
    const variant = body.replace(TAKES_BEGIN, `note: ${TAKES_BEGIN}`).replace(TAKES_END, `${TAKES_END} trailing`);
    expect(parseTakesFence(variant).takes).toEqual([]);
    const carried = carryForwardFences(marked(variant), "fresh\n");
    expect(carried).toContain(variant.slice(variant.indexOf("## Takes")));
    expect(parseTakesFence(carried).takes).toEqual([]);
  });

  it("keeps an indented facts fence the facts parser reads", () => {
    const old = `old\n\n## Facts\n\n  ${BEGIN}  \n| # | claim | confidence |\n|---|---|---|\n| 1 | spaced | 1 |\n\t${END}\n`;
    expect(parseFactsFence(old).map((f) => f.claim)).toEqual(["spaced"]);
    expect(parseFactsFence(carryForwardFences(marked(old), "fresh\n")).map((f) => f.claim)).toEqual(["spaced"]);
  });

  it("does not add a second fence when the fresh body already has one", () => {
    const old = withFacts("fresh\n", "old");
    const fresh = withFacts("fresh\n", "new");
    expect(carryForwardFences(marked(old), fresh)).toBe(fresh);
  });

  it("returns the fresh body when there is no old page", () => {
    expect(carryForwardFences(null, "fresh\n")).toBe("fresh\n");
  });
});

describe("re-rendered pages keep brain-added fences (PGLite)", () => {
  let tmp: string;
  let storage: Storage;
  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "memrain-rerender-"));
    storage = new Storage({ dbPath: join(tmp, "db") });
    await storage.init();
    await registerSource(storage.engine(), { id: "gh-acme", kind: "github", pathPrefix: "github/acme/widgets/" });
  });
  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("a facts fence the brain appended to a transcript part survives the next import of the same session", async () => {
    await transcriptCarry(storage, "rr");
  });

  it("a pre-1.11 transcript page holds a planted live fence for explicit review when the session changes", async () => {
    const s = session("pl");
    await ingestSessions(storage, [s], { sourceId: "default", embedFn, ref: "t" });
    const slug = "transcripts/chatgpt/pl-p1";
    const page = (await getPage(storage, slug))!;
    expect(page.compiled_truth[OUTSIDE_NEUTRALIZED]).toBe(1);
    const { [OUTSIDE_NEUTRALIZED]: _marker, ...preTruth } = page.compiled_truth;
    const planted = `${page.markdown_body}  ${factsFence("planted").split("\n").join("\n  ")}\n`;
    await putPage(storage, {
      slug,
      type: "conversation",
      allowAdHocType: true,
      title: page.title ?? undefined,
      compiled_truth: preTruth,
      markdown_body: planted,
      written_by: "agent",
      source_id: "default",
    });
    // Seed the historical state directly: a current metadata-only write now keeps its marker.
    await storage.engine().query("UPDATE pages SET compiled_truth=$2::text::jsonb WHERE slug=$1", [slug, JSON.stringify(preTruth)]);
    expect(parseFactsFence((await getPage(storage, slug))!.markdown_body).map((f) => f.claim)).toEqual(["planted"]);
    const edited: TranscriptSession = {
      ...s,
      messages: [...s.messages, { id: "pl-m2", role: "user", speaker: "User", text: "Edited later.", ts: T0 + 2000 }],
    };
    const result = await ingestSessions(storage, [edited], { sourceId: "default", embedFn, ref: "t" });
    expect(result.parts_written).toBe(0);
    expect(result.failed).toEqual([{ id: edited.id, code: "conflict", reason: "Import held: unproven_fences" }]);
    expect((await getPage(storage, slug))!.markdown_body).toBe(planted);
  });

  it("a github issue keeps its brain-added takes fence across a re-sync", async () => {
    const sync = async () => {
      const clock = fakeClock();
      return syncGithub(storage, {
        ref: { owner: "acme", repo: "widgets" },
        sourceId: "gh-acme",
        client: githubClient("fixture-token", { fetch: replay([recorded("issues-page-1"), recorded("issues-page-2")]).fetch, now: clock.now, sleep: clock.sleep }),
        now: clock.now,
        embedFn,
        full: true,
      });
    };
    await sync();
    const slug = "github/acme/widgets/issues/1";
    const page = (await getPage(storage, slug))!;
    const { body } = upsertTakeRow(page.markdown_body, { claim: "Ships late.", kind: "take", holder: "brain", weight: 0.6, active: true });
    await putPage(storage, {
      slug,
      type: page.type,
      allowAdHocType: true,
      title: page.title ?? undefined,
      compiled_truth: page.compiled_truth,
      markdown_body: body,
      written_by: "agent",
      source_id: "gh-acme",
    });
    const again = await sync();
    const after = (await getPage(storage, slug))!.markdown_body;
    expect(parseTakesFence(after).takes.map((t) => t.claim)).toEqual(["Ships late."]);
    expect(after).toBe(body);
    expect(again.counts.pages_written).toBe(0);
  });
});

const URL_ = process.env.MEMRAIN_TEST_POSTGRES_URL;
describe.skipIf(!URL_)("re-rendered pages keep brain-added fences (Postgres)", () => {
  it("a facts fence on a transcript part survives a re-import", async () => {
    const pg = new PostgresEngine({ url: URL_! });
    const storage = new Storage(pg);
    try {
      await storage.init();
      await transcriptCarry(storage, `rr-${Date.now()}`);
    } finally {
      await pg.close();
    }
  });
});
