/**
 * Chat grounding check: 20 questions over a fixture brain and 5 it cannot
 * answer, each asked as a full chat turn, scored without a judge:
 *
 *   citations_in_gather        share of the model's own citations that named gathered evidence
 *   grounded                   the answer's content words appear in the cited pages
 *   hit_rate                   the page that answers the question is cited
 *   refused_when_unanswerable  a question the fixture cannot answer is refused
 *
 * With the stub `extractiveModel` it runs in the test suite at no cost. A
 * live model can be run against it by hand; that spends money and is never
 * part of CI.
 */
import type { Storage } from "../core/storage.ts";
import type { SonnetFn } from "../core/llm/sonnet.ts";
import type { SearchOptions } from "../core/search/hybrid.ts";
import { getPage, putPage } from "../core/pages.ts";
import { indexPageIntoSearch } from "../core/page-index.ts";
import { operatorOwner, runChatTurn, type ChatStreamEvent } from "../core/chat/chat-service.ts";

interface Fact { slug: string; title: string; body: string; question: string }

const FACTS: Fact[] = [
  ["lighthouse", "Lighthouse keeper", "The lighthouse keeper rewinds the clockwork lens every evening at dusk.", "When does the lighthouse keeper rewind the clockwork lens?"],
  ["beekeeping", "Beekeeping", "The beekeeper harvests heather honey from twelve hives in late August.", "How many hives does the beekeeper harvest heather honey from?"],
  ["violin", "Violin repair", "The luthier replaces the violin soundpost with seasoned spruce.", "What wood does the luthier use for the violin soundpost?"],
  ["glacier", "Glacier survey", "The glacier survey measured forty metres of retreat across the moraine.", "How much retreat did the glacier survey measure?"],
  ["sourdough", "Sourdough starter", "The sourdough starter is fed rye flour twice daily in the pantry.", "What flour feeds the sourdough starter?"],
  ["telescope", "Telescope mirror", "The telescope mirror was ground from borosilicate glass by the astronomy club.", "What glass was the telescope mirror ground from?"],
  ["orchard", "Orchard grafting", "The orchard grafts pear scions onto quince rootstock each spring.", "Which rootstock does the orchard graft pear scions onto?"],
  ["sailing", "Sailing dinghy", "The sailing dinghy carries a red spinnaker for downwind regattas.", "What colour is the sailing dinghy spinnaker?"],
  ["pottery", "Pottery kiln", "The pottery kiln fires stoneware glazes at cone ten.", "At what cone does the pottery kiln fire stoneware glazes?"],
  ["chess", "Chess club", "The chess club meets on Thursdays in the library annex.", "Where does the chess club meet on Thursdays?"],
  ["falconry", "Falconry", "The falconer trains the kestrel with a leather lure in the meadow.", "What does the falconer train the kestrel with?"],
  ["printing", "Letterpress", "The letterpress studio sets Garamond type for wedding invitations.", "Which typeface does the letterpress studio set for invitations?"],
  ["cheese", "Cheese cave", "The cheese cave ages alpine wheels for eighteen months.", "How long does the cheese cave age alpine wheels?"],
  ["kayak", "Kayak route", "The kayak route crosses the estuary at slack tide near the ferry slipway.", "When does the kayak route cross the estuary?"],
  ["weaving", "Weaving loom", "The weaving loom threads indigo warp for the tapestry commission.", "What warp does the weaving loom thread for the tapestry?"],
  ["radio", "Radio mast", "The amateur radio mast was guyed with three steel cables after the storm.", "How many steel cables guy the amateur radio mast?"],
  ["vineyard", "Vineyard harvest", "The vineyard picks pinot noir grapes before sunrise in September.", "When does the vineyard pick pinot noir grapes?"],
  ["clocktower", "Clock tower", "The clock tower bells were recast in bronze by the foundry.", "What were the clock tower bells recast in?"],
  ["greenhouse", "Greenhouse", "The greenhouse heats the orchid benches with a paraffin stove in winter.", "What heats the greenhouse orchid benches in winter?"],
  ["bridge", "Footbridge", "The timber footbridge was rebuilt with oak planks by the parish volunteers.", "Who rebuilt the timber footbridge with oak planks?"],
].map(([slug, title, body, question]) => ({ slug: `facts/${slug}`, title: title!, body: body!, question: question! }));

/** No fixture page shares two content words with any of these. */
const UNANSWERABLE = [
  "What is the airspeed of an unladen swallow?",
  "Which planet has the largest volcano?",
  "Who composed the cello sonata premiered in Vienna?",
  "What is the boiling point of liquid nitrogen?",
  "Which bank account does the vendor payroll use?",
];

/** `expect` is the page that answers the question, or null when none does. */
export const CHAT_GROUNDING_QUESTIONS: ReadonlyArray<{ question: string; expect: string | null }> = [
  ...FACTS.map((f) => ({ question: f.question, expect: f.slug })),
  ...UNANSWERABLE.map((question) => ({ question, expect: null })),
];

/** Write the fixture pages and index them with the given query embedder. */
export async function seedChatGroundingFixture(storage: Storage, embedFn: (text: string) => Promise<number[]>): Promise<void> {
  for (const f of FACTS) {
    await putPage(storage, { slug: f.slug, markdown_body: f.body, title: f.title });
    await indexPageIntoSearch(storage, { slug: f.slug, markdown_body: f.body, title: f.title }, { embedFn });
  }
}

/**
 * A stub model that answers from its evidence and nothing else: the first
 * sentence of the top-ranked page, cited by that page's ref, when that page
 * shares at least two content words with the question; otherwise it says
 * nothing gathered answers it.
 */
export function extractiveModel(modelId = "eu.anthropic.claude-haiku-5-5"): SonnetFn {
  return async (input) => {
    const m = /<page ref="([^"]+)" rank="1"[^>]*>\n([\s\S]*?)\n<\/page>/.exec(input.user);
    const asked = new Set(contentWords(/^Question: (.*)$/m.exec(input.user)?.[1] ?? ""));
    const shared = new Set(contentWords(m?.[2] ?? "").filter((w) => asked.has(w)));
    const ref = shared.size >= 2 ? m?.[1] : undefined;
    const sentence = (m?.[2] ?? "").split(/(?<=\.)\s/)[0]?.trim() ?? "";
    const text = ref
      ? JSON.stringify({ answer: `${sentence} [${ref}]`, citations: [{ ref, kind: "page" }], gaps: [] })
      : JSON.stringify({ answer: "Nothing gathered answers this.", citations: [], gaps: ["no evidence"] });
    return { text, modelId, usage: { inputTokens: Buffer.byteLength(input.system + input.user, "utf8"), outputTokens: 40 } };
  };
}

const STOP = new Set(["that", "this", "with", "from", "their", "there", "which", "what", "when", "were", "have", "each", "into", "over", "after", "before"]);

function contentWords(text: string): string[] {
  return (text.toLowerCase().replace(/\[\d+\]/g, " ").match(/[a-z]{4,}/g) ?? []).filter((w) => !STOP.has(w));
}

export interface ChatGroundingReport {
  questions: number;
  /** Share of the model's citations, before think drops unresolvable ones, that named gathered evidence. */
  citations_in_gather: number;
  /** Share of answerable questions whose answer's content words all appear in its cited pages. */
  grounded: number;
  /** Share of answerable questions whose answering page was cited. */
  hit_rate: number;
  /** Share of unanswerable questions that came back refused. */
  refused_when_unanswerable: number;
  /** Citations think dropped as unresolvable, summed over the run. */
  dropped_citations: number;
  failures: Array<{ question: string; reason: string }>;
}

export async function runChatGrounding(
  storage: Storage,
  opts: { model: SonnetFn; embedQuery?: SearchOptions["embedQuery"]; env?: NodeJS.ProcessEnv },
): Promise<ChatGroundingReport> {
  const env = opts.env ?? { MEMRAIN_CHAT: "1", MEMRAIN_DAILY_BUDGET_USD: "100", MEMRAIN_CHAT_USER_DAY_USD: "100" };
  let kept = 0;
  let grounded = 0;
  let hits = 0;
  let refused = 0;
  let dropped = 0;
  const failures: ChatGroundingReport["failures"] = [];
  for (const [i, q] of CHAT_GROUNDING_QUESTIONS.entries()) {
    const events: ChatStreamEvent[] = [];
    const owner = { ...operatorOwner(), key: `grounding-${i}` };
    const r = await runChatTurn(
      { storage, owner, env, sonnetFn: opts.model, embedFn: null, ...(opts.embedQuery ? { embedQuery: opts.embedQuery } : {}) },
      { message: q.question },
      (e) => events.push(e),
    );
    for (const e of events) {
      if (e.event !== "trace" || e.data.step !== "citations") continue;
      kept += e.data.count ?? 0;
      const m = /^citation_dropped:(\d+)$/.exec(e.data.note ?? "");
      if (m) dropped += Number(m[1]);
    }
    const pages = r.citations.filter((c) => c.kind === "page");
    if (q.expect === null) {
      if (r.status === "refused" && r.citations.length === 0) refused++;
      else failures.push({ question: q.question, reason: `answered without evidence: ${r.status}, cited ${pages.map((c) => c.slug).join(" ")}` });
      continue;
    }
    if (pages.some((c) => c.slug === q.expect)) hits++;
    else failures.push({ question: q.question, reason: `did not cite ${q.expect}` });
    const evidence = (await Promise.all(pages.map((c) => getPage(storage, c.slug))))
      .map((p) => `${p?.title ?? ""} ${p?.markdown_body ?? ""}`.toLowerCase())
      .join(" ");
    const words = contentWords(r.answer);
    const missing = words.filter((w) => !evidence.includes(w));
    if (r.status === "ok" && words.length > 0 && missing.length === 0) grounded++;
    else failures.push({ question: q.question, reason: `not grounded: ${r.status}, missing ${missing.slice(0, 5).join(" ")}` });
  }
  const answerable = CHAT_GROUNDING_QUESTIONS.filter((q) => q.expect !== null).length;
  const unanswerable = CHAT_GROUNDING_QUESTIONS.length - answerable;
  return {
    questions: CHAT_GROUNDING_QUESTIONS.length,
    citations_in_gather: kept + dropped === 0 ? 0 : kept / (kept + dropped),
    grounded: grounded / answerable,
    hit_rate: hits / answerable,
    refused_when_unanswerable: refused / unanswerable,
    dropped_citations: dropped,
    failures,
  };
}
