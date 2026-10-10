/**
 * Eval-miss shapes — hermetic reproductions of the two document shapes an eval
 * run scored as hit@5 misses, plus the guards on the fix.
 *
 * Content here is synthetic: it reproduces the SHAPE of each miss (a page whose
 * proper noun lives only in its title/slug; a long multilingual voice-note
 * transcript with timestamps and speaker labels, questioned by an English
 * paraphrase), never the corpus text.
 *
 * SHAPE A — the query NAMES a page.
 *   Neither retrieval arm indexes `documents.title` or `documents.source_path`:
 *   the keyword arm ranks `chunks.search_vector` (chunk body + code symbol
 *   columns, migration 030) and the vector arm ranks chunk embeddings. A page
 *   whose distinguishing name never appears in its own body therefore cannot
 *   enter the candidate set at all — and the title boost (title-match.ts) and
 *   exact-slug boost (intent-weights.ts) run POST-fusion, so for this shape
 *   they were boosts with nothing to boost. FIXED by the identifier arm
 *   (title-arm.ts); the tests below assert both the fix and its precision
 *   guards, and the arm-off A/B that proves the arm is what moved the hit.
 *
 * SHAPE B — an English paraphrase over a long German transcript.
 *   Not a ranking bug and deliberately NOT "fixed" here. Two measured causes,
 *   both on the corpus/indexing side:
 *     1. content-date asymmetry: `updated_at` is stamped NOW() on every index
 *        (indexer-tx.ts), and the read path decays on
 *        COALESCE(effective_date, updated_at) — so a voice-note dated by its
 *        filename carries its true age while an undated note always reads as
 *        brand new. The uniform-date control below shows the answering chunk
 *        returning to the window once both sides are dated alike.
 *     2. chunk grain: the same transcript chunked per utterance ranks its
 *        answering chunk well above the 4000-char slab the markdown chunker
 *        produces for a wall-of-text voice note.
 *   Fixing either by tilting ranking would be an unsupported tweak, so the
 *   tests here pin the CAUSES (which stay true regardless of future ranking
 *   work) rather than the miss.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { writeDocumentTransaction, type ChunkWrite } from "../src/core/indexer-tx.ts";
import { chunkMarkdown } from "../src/core/chunkers/index.ts";
import { hybridSearch, type SearchHit } from "../src/core/search/index.ts";
import { knobsCacheSuffix } from "../src/core/search/hybrid.ts";
import { keywordSearch } from "../src/core/search/keyword.ts";
import { vectorSearch } from "../src/core/search/vector.ts";
import {
  identifierCandidates,
  isNameLikeIdentifier,
  titleArmChunkIds,
  titleArmEnabled,
} from "../src/core/search/title-arm.ts";
import type { Engine } from "../src/core/engine/interface.ts";

const K = 10;

// ---------------------------------------------------------------------------
// Deterministic cross-lingual embedder. Same construction as det-embed.ts (FNV
// token → dimension, L2-normalized), with a German→English bridge table
// det-embed's car/maintenance synonyms cannot express. The bridge is what makes
// the vector arm — and ONLY the vector arm — able to reach a German transcript
// from an English question, which is the whole point of shape B. L2
// normalization also models chunk-length dilution faithfully: a term in a
// 600-token chunk carries 1/sqrt(600) of its weight.
// ---------------------------------------------------------------------------
const DIM = 1024;
const BRIDGE: Record<string, string> = {
  suchindex: "indexing",
  datenbank: "database",
  passwort: "password",
  authentifizierung: "authentication",
  fehlgeschlagen: "failing",
};

function tokenDim(token: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % DIM;
}

function tokenize(text: string): string[] {
  return text.toLowerCase().normalize("NFKC").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function bridgeEmbed(text: string): number[] {
  const v = new Array<number>(DIM).fill(0);
  for (const t of tokenize(text)) {
    const di = tokenDim(BRIDGE[t] ?? t);
    v[di] = (v[di] ?? 0) + 1;
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm === 0) {
    v[0] = 1;
    return v;
  }
  for (let i = 0; i < DIM; i++) v[i] = (v[i] ?? 0) / norm;
  return v;
}

async function bridgeEmbedQuery(text: string): Promise<number[]> {
  return bridgeEmbed(text);
}

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

/** Meeting-transcript filler — the noise the answering passage is buried in. */
const FILLER = [
  "also ich glaube wir muessen das nochmal in ruhe durchgehen und dann entscheiden",
  "genau und der Kunde hat gesagt der Termin naechste Woche passt ihm eigentlich gut",
  "ok dann machen wir das so wie besprochen und ich schicke dir nachher die Notizen",
  "ja das Angebot liegt seit Montag bei denen aber es kam noch nichts zurueck",
  "ich hab mit dem Team geredet die brauchen noch zwei Tage fuer den Entwurf",
  "wir sollten die Rechnung erst rausschicken wenn die Abnahme wirklich durch ist",
  "der Kollege war krank deswegen ist da zwei Wochen lang gar nichts passiert",
  "das Meeting am Donnerstag verschieben wir lieber auf Freitag vormittag",
  "die Praesentation ist fertig ich muss nur noch die Zahlen aktualisieren",
  "kannst du bitte nochmal nachhaken wegen dem Vertrag der liegt da seit Wochen",
];

/** The only utterance that answers the paraphrase query. */
const ANSWER =
  "und dann ist uns der Suchindex komplett weggebrochen der hat einfach nichts mehr " +
  "gefunden und gleichzeitig kam beim Verbinden staendig ein Fehler weil die " +
  "Authentifizierung mit dem Passwort fuer die Datenbank fehlgeschlagen ist";

/** A wall-of-text voice note: timestamps + speaker labels, no headings. */
function transcript(): string {
  const lines: string[] = [];
  let sec = 0;
  const stamp = (): string => {
    sec += 47;
    return `[00:${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}]`;
  };
  for (let i = 0; i < 40; i++) {
    lines.push(`${stamp()} ${i % 2 === 0 ? "Sprecher A" : "Sprecher B"}: ${FILLER[i % FILLER.length]}`);
    if (i === 22) lines.push(`${stamp()} Sprecher A: ${ANSWER}`);
  }
  return lines.join(" ");
}

interface Doc {
  id: string;
  path: string;
  title: string;
  chunks: string[];
}

const DOCS: Doc[] = [
  // Shape A: the proper noun lives in the title + slug, never in the body.
  {
    id: "doc_quandalore",
    path: "projects/quandalore",
    title: "Quandalore",
    chunks: [
      "Die Plattform vermietet Werkzeuge an Handwerksbetriebe. Der Betreiber wollte eine Uebersicht ueber die laufenden Vertraege und eine einfache Rueckgabe per QR Code.",
    ],
  },
  // A dated report page — the multi-token identifier case.
  {
    id: "doc_flowforge_audit",
    path: "projects/flowforge/full-audit-2026-07-02",
    title: "Full audit 2026-07-02",
    chunks: [
      "Findings for the automation instance. The worker queue runs unbounded, credentials sit in plaintext inside the exported workflow definitions, and there is no retention policy on the execution log.",
    ],
  },
  {
    id: "doc_flowforge_notes",
    path: "projects/flowforge/notes",
    title: "Notes",
    chunks: ["flowforge upgrade notes: flowforge 1.42 changed the webhook path, flowforge credentials must be re-entered"],
  },
  {
    id: "doc_flowforge_intro",
    path: "projects/flowforge/intro",
    title: "Intro",
    chunks: ["flowforge is the automation tool we run for the client, flowforge workflows replaced the old cron jobs"],
  },
  {
    id: "doc_audit_checklist",
    path: "notes/audit-checklist",
    title: "Audit checklist",
    chunks: ["audit checklist: run the audit quarterly, record every audit finding, close each audit item"],
  },
  {
    id: "doc_vendor_audit",
    path: "notes/vendor-audit",
    title: "Vendor audit",
    chunks: ["vendor audit findings and the audit trail for each vendor audit round"],
  },
  // A two-character slug leaf — below the identifier arm's single-token floor.
  {
    id: "doc_qa",
    path: "notes/qa",
    title: "QA",
    chunks: ["release testing rota and who signs off before a deploy goes out"],
  },
  // Shape B competitors: short English chunks carrying the query's vocabulary.
  {
    id: "doc_pg_conn",
    path: "notes/postgres-connection",
    title: "Postgres connection",
    chunks: ["database password rotation checklist and the connection string format"],
  },
  {
    id: "doc_auth_notes",
    path: "notes/auth-notes",
    title: "Auth notes",
    chunks: ["authentication failing after the token expiry, password reset flow, database of sessions"],
  },
  {
    id: "doc_indexing_notes",
    path: "notes/indexing-notes",
    title: "Indexing notes",
    chunks: ["indexing throughput notes, the indexing job and its database batch size"],
  },
  {
    id: "doc_filler_1",
    path: "notes/filler-1",
    title: "Filler one",
    chunks: ["lorem ipsum dolor sit amet placeholder prose with no relevant vocabulary at all"],
  },
];

const TRANSCRIPT = transcript();

/**
 * Seed the corpus. `uniformDate` writes the SAME frontmatter content date on
 * every document — the control that removes the dated-vs-undated asymmetry
 * while changing nothing else.
 */
async function seed(storage: Storage, uniformDate: string | null): Promise<void> {
  const frontmatter = uniformDate ? { date: uniformDate } : {};
  for (const d of DOCS) {
    const chunks: ChunkWrite[] = d.chunks.map((text) => ({
      text,
      entities: [],
      embedding: bridgeEmbed(text),
    }));
    await writeDocumentTransaction(
      storage,
      { documentId: d.id, sourcePath: d.path, title: d.title, frontmatter, embeddingModel: "deterministic-test" },
      chunks,
    );
  }
  // The voice note as the production markdown chunker actually splits it.
  const coarse = chunkMarkdown(TRANSCRIPT, { overlapChars: 0 });
  await writeDocumentTransaction(
    storage,
    {
      documentId: "doc_transcript_coarse",
      sourcePath: "voicenotes/2026-06-11-standup",
      title: "Standup 2026-06-11",
      frontmatter,
      embeddingModel: "deterministic-test",
    },
    coarse.chunks.map((text) => ({ text, entities: [], embedding: bridgeEmbed(text) })),
  );
  // The SAME text at utterance grain — the chunk-grain control.
  const fine = TRANSCRIPT.split(/(?=\[00:)/).filter((s) => s.trim());
  await writeDocumentTransaction(
    storage,
    {
      documentId: "doc_transcript_fine",
      sourcePath: "voicenotes/2026-06-12-standup",
      title: "Standup 2026-06-12",
      frontmatter,
      embeddingModel: "deterministic-test",
    },
    fine.map((text) => ({ text, entities: [], embedding: bridgeEmbed(text) })),
  );
}

let tmpDated: string;
let tmpUniform: string;
/** Production shape: dated paths keep their age, undated docs read as new. */
let dated: Storage;
/** Control: every document carries the same content date. */
let uniform: Storage;

beforeAll(async () => {
  tmpDated = mkdtempSync(join(tmpdir(), "memrain-eval-miss-dated-"));
  tmpUniform = mkdtempSync(join(tmpdir(), "memrain-eval-miss-uniform-"));
  dated = new Storage({ dbPath: join(tmpDated, "db") });
  uniform = new Storage({ dbPath: join(tmpUniform, "db") });
  await dated.init();
  await uniform.init();
  await seed(dated, null);
  await seed(uniform, "2026-06-11");
});

afterAll(async () => {
  await dated.close();
  await uniform.close();
  rmSync(tmpDated, { recursive: true, force: true });
  rmSync(tmpUniform, { recursive: true, force: true });
});

const toDocId = (chunkId: string): string => chunkId.replace(/_c\d+$/, "");

async function withGate<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const name = "MEMRAIN_RANK_METADATA_GATE";
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

async function search(
  storage: Storage,
  query: string,
  extra: { titleArm?: boolean; explain?: boolean; k?: number } = {},
): Promise<SearchHit[]> {
  return hybridSearch(storage, query, {
    k: extra.k ?? K,
    intent: "topic",
    noExpansion: true,
    noCache: true,
    embedQuery: bridgeEmbedQuery,
    ...extra,
  });
}

/** Result doc ids in rank order, first occurrence per document. */
async function rankedDocs(
  storage: Storage,
  query: string,
  extra: { titleArm?: boolean; k?: number } = {},
): Promise<string[]> {
  const hits = await search(storage, query, extra);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of hits) {
    if (!seen.has(h.documentId)) {
      seen.add(h.documentId);
      out.push(h.documentId);
    }
  }
  return out;
}

const Q_PARAPHRASE = "why does indexing keep failing and the database password authentication break";

describe("eval miss shape A — the query names a page", () => {
  it("neither retrieval arm can reach a page named only by its title/slug", async () => {
    // The name appears in `documents.title` and `documents.source_path`, which
    // no arm indexes; the body says "die Plattform".
    const kw = await keywordSearch(dated.engine(), "quandalore", 20);
    expect(kw).toEqual([]);
    const vec = await vectorSearch(dated.engine(), bridgeEmbed("quandalore"), 5, {});
    expect(vec).not.toContain("doc_quandalore_c0");
  });

  it("the identifier arm turns that miss into rank 1", async () => {
    const docs = await rankedDocs(dated, "quandalore");
    expect(docs[0]).toBe("doc_quandalore");
  });

  it("with the identifier arm off the page is unreachable (the A/B)", async () => {
    // Same corpus, same query, arm disabled — the page leaves the window
    // entirely, which is what proves the arm (not some other stage) moved it.
    const docs = await rankedDocs(dated, "quandalore", { titleArm: false });
    expect(docs).not.toContain("doc_quandalore");
  });

  it("the boost that had nothing to boost now fires on a real candidate", async () => {
    // The title boost was always ×1.25 for this query; it just never had a
    // candidate. Its presence in `explain` is the mechanism, not a side effect.
    const hits = await search(dated, "quandalore", { explain: true });
    const hit = hits.find((h) => h.documentId === "doc_quandalore");
    expect(hit?.explain?.title).toBe(1.25);
  });

  it("a question that names the page reaches it, mid-window", async () => {
    // Identifier-inside-query — the complement of the title boost's
    // query-inside-title direction. It buys CANDIDACY only: no post-fusion
    // boost fires (the query is not a phrase in the title and does not equal
    // the slug), so the page enters at roughly a single-arm rank-1 hit's
    // strength rather than at the head. Asserting the window, not the head, is
    // the honest contract.
    const docs = await rankedDocs(dated, "what is the current status of quandalore");
    expect(docs).toContain("doc_quandalore");
    expect(await rankedDocs(dated, "what is the current status of quandalore", { titleArm: false }))
      .not.toContain("doc_quandalore");
  });

  it("term overlap with the body is not a naming match", async () => {
    // Body words are not the page's name — the arm must stay silent, otherwise
    // it would be a second, weaker keyword arm.
    expect(await titleArmChunkIds(dated.engine(), "die plattform vermietet werkzeuge", {})).toEqual([]);
    // Nor is a prefix of the name: the match is on whole tokens.
    expect(await titleArmChunkIds(dated.engine(), "quandal", {})).toEqual([]);
  });
});

describe("identifier arm — precision guards", () => {
  it("a single-token identifier must clear the character floor", async () => {
    // `notes/qa` is a 2-char leaf: too generic to be a name, so a question
    // mentioning it must not pull the page in...
    const ids = await titleArmChunkIds(dated.engine(), "how do we run qa before a deploy", {});
    expect(ids).not.toContain("doc_qa_c0");
    // ...while a genuinely name-like identifier of the same shape does.
    expect(isNameLikeIdentifier("qa")).toBe(false);
    expect(isNameLikeIdentifier("n8n")).toBe(true);
    expect(isNameLikeIdentifier("audit checklist")).toBe(true);
  });

  it("multi-token names are matched as contiguous runs inside a longer query", async () => {
    const ids = await titleArmChunkIds(dated.engine(), "check the full audit 2026 07 02 report", {});
    expect(ids).toContain("doc_flowforge_audit_c0");
    // The n-gram set is what makes that reachable — a unigram-only candidate
    // set could never match a five-token title.
    expect(identifierCandidates("full audit 2026")).toContain("full audit 2026");
    expect(identifierCandidates("full audit 2026")).toContain("audit");
  });

  it("the more specific name ranks first inside the arm", async () => {
    // "full audit 2026 07 02" (5 tokens) is a stronger claim than "notes" (1).
    const ids = await titleArmChunkIds(dated.engine(), "the full audit 2026 07 02 notes", {});
    expect(ids.indexOf("doc_flowforge_audit_c0")).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf("doc_flowforge_notes_c0")).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf("doc_flowforge_audit_c0")).toBeLessThan(ids.indexOf("doc_flowforge_notes_c0"));
  });

  it("honours its limit", async () => {
    const ids = await titleArmChunkIds(dated.engine(), "the full audit 2026 07 02 notes", { limit: 1 });
    expect(ids).toHaveLength(1);
  });

  it("returns the page's HEAD chunk, not an arbitrary one", async () => {
    // A multi-chunk page named by the query must contribute the same
    // representative chunk alias-hop and the relational arm inject.
    const ids = await titleArmChunkIds(dated.engine(), "what did we say in the standup 2026 06 11", {});
    expect(ids).toContain("doc_transcript_coarse_c0");
    expect(ids).not.toContain("doc_transcript_coarse_c1");
  });

  it("never resurfaces a hidden page", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "memrain-eval-miss-hidden-"));
    const s = new Storage({ dbPath: join(tmp, "db") });
    try {
      await s.init();
      await writeDocumentTransaction(
        s,
        { documentId: "doc_gone", sourcePath: "projects/quandalore", title: "Quandalore", frontmatter: {} },
        [{ text: "die Plattform vermietet Werkzeuge", entities: [] }],
      );
      expect(await titleArmChunkIds(s.engine(), "quandalore", {})).toEqual(["doc_gone_c0"]);
      await s.engine().query(`UPDATE documents SET deleted_at = NOW() WHERE id = 'doc_gone'`, []);
      expect(await titleArmChunkIds(s.engine(), "quandalore", {})).toEqual([]);
    } finally {
      await s.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails open — a broken engine drops the arm instead of breaking search", async () => {
    const broken = {
      kind: "pglite",
      query: async () => {
        throw new Error("connection reset");
      },
    } as unknown as Engine;
    expect(await titleArmChunkIds(broken, "quandalore", {})).toEqual([]);
  });

  it("is ON by default and disabled by MEMRAIN_TITLE_ARM=0", () => {
    expect(titleArmEnabled(undefined)).toBe(true);
    expect(titleArmEnabled("")).toBe(true);
    expect(titleArmEnabled("0")).toBe(false);
  });

  it("re-keys the query cache, so an arm-off call can't serve an arm-on ranking", () => {
    const base = {
      rerankWanted: false,
      graphRerankOn: false,
      expansionEnabled: false,
      graphSignalsOn: false,
      cosineRescoreOn: false,
      relationalArmOn: false,
      backlinkBoostOn: true,
      tokenBudget: undefined,
    };
    expect(knobsCacheSuffix({ ...base, titleArmOn: true })).not.toBe(
      knobsCacheSuffix({ ...base, titleArmOn: false }),
    );
  });
});

describe("eval miss shape B — English paraphrase over a German transcript", () => {
  it("the keyword arm cannot fire on a cross-language paraphrase", async () => {
    // No surface term is shared with the transcript — and `plainto_tsquery`
    // ANDs every term, so this question matches nothing at all.
    expect(await keywordSearch(dated.engine(), Q_PARAPHRASE, 20)).toEqual([]);
  });

  it("the vector arm DOES reach the answering utterance", async () => {
    // So the miss is not a retrieval-reach problem: the answering chunk is
    // inside the arm's top five before any post-fusion stage runs.
    const vec = await vectorSearch(dated.engine(), bridgeEmbed(Q_PARAPHRASE), 5, {});
    expect(vec).toContain("doc_transcript_fine_c23");
  });

  it("the identifier arm does not paper over this shape", async () => {
    // The question names no page. Reporting this miss as fixed would be the
    // dishonest outcome, so assert the arm stays silent.
    expect(await titleArmChunkIds(dated.engine(), Q_PARAPHRASE, {})).toEqual([]);
  });

  it("content-date parity restores the answering chunk to the window", async () => {
    // The ONLY difference between the two corpora is that every document in
    // `uniform` carries the same content date. In `dated` the voice note is
    // decayed by its filename date while the undated notes read as indexed-now,
    // and that alone is worth more rank positions than the whole fused score
    // band spans. The metadata gate skips that decay for this query, so it is
    // held off here to keep pinning the cause.
    const datedDocs = await withGate(undefined, () => rankedDocs(dated, Q_PARAPHRASE));
    expect(datedDocs.slice(0, 5)).not.toContain("doc_transcript_fine");
    const uniformDocs = await rankedDocs(uniform, Q_PARAPHRASE);
    expect(uniformDocs.slice(0, 5)).toContain("doc_transcript_fine");
  });

  it("the metadata gate keeps the dated answer in the window", async () => {
    // Only the vector arm answers the paraphrase, so with the gate on the
    // content-date decay never reorders it.
    const datedDocs = await withGate("1", () => rankedDocs(dated, Q_PARAPHRASE));
    expect(datedDocs.slice(0, 5)).toContain("doc_transcript_fine");
  });

  it("the decay penalises the document that declares a date, not the stale one", async () => {
    // Same corpus, one query, two hits: the dated report is multiplied down
    // while the undated note — whose `updated_at` is simply the index time —
    // stays neutral. That asymmetry is the cause above, stated directly.
    // Wide k on purpose: the dated report sinks further every real day the
    // fixture's 2026-07-02 recedes, and at the default window it eventually
    // drops out entirely. `?? 1` then read "absent" as "no decay" — the
    // assertion inverted its own meaning and the test rotted by the calendar.
    // Require the hit instead, so a future miss fails as a miss.
    const hits = await search(dated, "audit findings", { explain: true, k: 50 });
    const datedHit = hits.find((h) => h.documentId === "doc_flowforge_audit");
    const undatedHit = hits.find((h) => h.documentId === "doc_vendor_audit");
    expect(datedHit).toBeDefined();
    expect(undatedHit).toBeDefined();
    const datedFactor = datedHit!.explain!.recency;
    const undatedFactor = undatedHit!.explain!.recency;
    // The undated note is aged from its index time, i.e. seconds — effectively
    // neutral; the dated report carries weeks of decay for declaring its date.
    expect(undatedFactor).toBeGreaterThan(0.99);
    expect(datedFactor).toBeLessThan(0.95);
  });

  it("chunk grain, not ranking, decides where the answer lands", async () => {
    // Identical text, identical dates, identical ranking code: the utterance
    // chunk beats the 4000-char slab the markdown chunker emits for a
    // wall-of-text voice note. No ranking change can recover that gap — the
    // answering passage never forms a coherent chunk in the coarse document.
    const docs = await rankedDocs(uniform, Q_PARAPHRASE, { k: 20 });
    const fine = docs.indexOf("doc_transcript_fine");
    const coarse = docs.indexOf("doc_transcript_coarse");
    expect(fine).toBeGreaterThanOrEqual(0);
    expect(coarse).toBeGreaterThanOrEqual(0);
    expect(fine).toBeLessThan(coarse);
  });
});
