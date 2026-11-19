/**
 * The scale bench's corpus: a deterministic synthetic brain of any size, and
 * the fixed query mix that is run against it.
 *
 * Nothing here touches a database or a model. The corpus is a pure function of
 * its seed, so two runs with one seed load byte-identical chunks and vectors —
 * `digest` is the proof, and the report carries it so two reports can be told
 * apart from two machines.
 *
 * VOCABULARY. Words are built from fixed-length consonant-vowel syllables, so
 * every word is one `simple` tsvector token and no two syllable sequences spell
 * the same word. Ranks follow a Zipf law: the head of the list is in most
 * chunks, the tail in a handful. That is what makes keyword selectivity a real
 * axis here — a one-word query on a head term ranks tens of thousands of rows,
 * a tail term a few. A second, Cyrillic vocabulary goes into a share of the
 * chunks, because the brain holds Russian and English side by side.
 *
 * VECTORS. 1024 dimensions, Gaussian components from a PRNG seeded by
 * (seed, chunk id), normalized. They carry no meaning; the bench measures
 * latency and connections, never retrieval quality. Random high-dimensional
 * vectors are, if anything, harder for HNSW than real ones. The model name is
 * `BENCH_EMBED_MODEL` so a row like this can never pass for a real embedding.
 */
import { createHash } from "node:crypto";

export const BENCH_EMBED_MODEL = "bench:fake:1024";
export const BENCH_EMBED_DIMS = 1024;
/** The one source every bench row belongs to. */
export const BENCH_SOURCE_ID = "bench";

const LATIN_CONSONANTS = "bdfgklmnprstvz";
const LATIN_VOWELS = "aeiou";
const CYRILLIC_CONSONANTS = "бвгдклмнпрстз";
const CYRILLIC_VOWELS = "аеиоу";

/** Latin vocabulary size; the rank bands below are cut out of it. */
export const LATIN_VOCAB = 20_000;
export const CYRILLIC_VOCAB = 5_000;
const ZIPF_EXPONENT = 1.05;

/** Rank bands the query mix draws from — head, middle and tail of the Zipf curve. */
export const BANDS = {
  frequent: [0, 50],
  medium: [500, 3_000],
  rare: [12_000, LATIN_VOCAB],
} as const;

/** Share of chunks that carry Cyrillic words. */
const CYRILLIC_CHUNK_SHARE = 0.15;
export const CHUNKS_PER_DOC = 10;
const MIN_WORDS = 60;
const MAX_WORDS = 160;

function syllables(consonants: string, vowels: string): string[] {
  const out: string[] = [];
  for (const c of consonants) for (const v of vowels) out.push(c + v);
  return out;
}

const LATIN_SYLLABLES = syllables(LATIN_CONSONANTS, LATIN_VOWELS);
const CYRILLIC_SYLLABLES = syllables(CYRILLIC_CONSONANTS, CYRILLIC_VOWELS);

/**
 * The word at `rank`: two syllables for the first S² ranks, three after that,
 * four after that. Every syllable is one consonant and one vowel, so a word
 * splits back into its syllables one way only and two ranks never collide.
 */
function wordAt(rank: number, syl: readonly string[]): string {
  const s = syl.length;
  let r = rank;
  let len = 2;
  let span = s * s;
  while (r >= span) {
    r -= span;
    len++;
    span *= s;
  }
  let w = "";
  for (let i = 0; i < len; i++) {
    w += syl[r % s];
    r = Math.floor(r / s);
  }
  return w;
}

function buildVocab(size: number, syl: readonly string[]): string[] {
  return Array.from({ length: size }, (_, i) => wordAt(i, syl));
}

const LATIN_WORDS = buildVocab(LATIN_VOCAB, LATIN_SYLLABLES);
const CYRILLIC_WORDS = buildVocab(CYRILLIC_VOCAB, CYRILLIC_SYLLABLES);

/** A word no chunk ever contains: past the end of the generated vocabulary. */
function absentWord(i: number): string {
  return wordAt(LATIN_SYLLABLES.length ** 3 + LATIN_SYLLABLES.length ** 2 + i * 7919, LATIN_SYLLABLES);
}

function zipfCdf(size: number): Float64Array {
  const cdf = new Float64Array(size);
  let acc = 0;
  for (let i = 0; i < size; i++) {
    acc += 1 / (i + 1) ** ZIPF_EXPONENT;
    cdf[i] = acc;
  }
  for (let i = 0; i < size; i++) cdf[i] = cdf[i]! / acc;
  return cdf;
}

const LATIN_CDF = zipfCdf(LATIN_VOCAB);
const CYRILLIC_CDF = zipfCdf(CYRILLIC_VOCAB);

function sampleRank(cdf: Float64Array, u: number): number {
  let lo = 0;
  let hi = cdf.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cdf[mid]! < u) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** FNV-1a over the UTF-16 code units: a 32-bit seed from a string key. */
function hash32(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: small, fast, and identical on every JS engine. */
export function prng(key: string): () => number {
  let a = hash32(key);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A unit vector in pgvector's text form, fixed to four decimals so the text —
 * which is what is loaded and what the digest covers — is the same everywhere.
 */
export function benchVector(key: string): string {
  const rnd = prng(`vec:${key}`);
  const v = new Float64Array(BENCH_EMBED_DIMS);
  let norm = 0;
  for (let i = 0; i < BENCH_EMBED_DIMS; i += 2) {
    // Box-Muller: two Gaussian components per pair of uniforms.
    const u1 = Math.max(rnd(), 1e-12);
    const u2 = rnd();
    const r = Math.sqrt(-2 * Math.log(u1));
    v[i] = r * Math.cos(2 * Math.PI * u2);
    if (i + 1 < BENCH_EMBED_DIMS) v[i + 1] = r * Math.sin(2 * Math.PI * u2);
  }
  for (let i = 0; i < BENCH_EMBED_DIMS; i++) norm += v[i]! * v[i]!;
  const inv = 1 / Math.sqrt(norm);
  return `[${Array.from(v, (x) => (x * inv).toFixed(4)).join(",")}]`;
}

/** The query-side twin of `benchVector`: the embedder seam hands this to search. */
export function benchQueryVector(seed: string, text: string): number[] {
  return JSON.parse(benchVector(`${seed}:q:${text}`)) as number[];
}

export interface BenchChunk {
  id: string;
  documentId: string;
  chunkIndex: number;
  content: string;
  /** pgvector text literal. */
  vector: string;
}

export interface BenchDocument {
  id: string;
  sourcePath: string;
  title: string;
}

export interface CorpusBatch {
  documents: BenchDocument[];
  chunks: BenchChunk[];
}

function chunkText(rnd: () => number, heading: string | null): string {
  const n = MIN_WORDS + Math.floor(rnd() * (MAX_WORDS - MIN_WORDS + 1));
  const cyrillic = rnd() < CYRILLIC_CHUNK_SHARE;
  const words: string[] = [];
  for (let i = 0; i < n; i++) {
    if (cyrillic && rnd() < 0.3) words.push(CYRILLIC_WORDS[sampleRank(CYRILLIC_CDF, rnd())]!);
    else words.push(LATIN_WORDS[sampleRank(LATIN_CDF, rnd())]!);
  }
  // Sentence-sized lines, so the text reads like prose to the tokenizer.
  const lines: string[] = [];
  for (let i = 0; i < words.length; i += 12) lines.push(`${words.slice(i, i + 12).join(" ")}.`);
  return heading ? `# ${heading}\n\n${lines.join("\n")}` : lines.join("\n");
}

export interface CorpusSpec {
  /** Any string; numbers are stringified by the caller. */
  seed: string;
  chunks: number;
}

/**
 * The corpus in load-sized batches, generated lazily so 100k chunks never sit
 * in memory at once. Batches end on document boundaries.
 */
export function* corpusBatches(spec: CorpusSpec, docsPerBatch = 50): Generator<CorpusBatch> {
  if (!Number.isInteger(spec.chunks) || spec.chunks < 1) {
    throw new Error(`scale corpus: chunks must be a positive integer, got ${spec.chunks}`);
  }
  const docCount = Math.ceil(spec.chunks / CHUNKS_PER_DOC);
  let emitted = 0;
  for (let d0 = 0; d0 < docCount; d0 += docsPerBatch) {
    const batch: CorpusBatch = { documents: [], chunks: [] };
    for (let d = d0; d < Math.min(docCount, d0 + docsPerBatch); d++) {
      const docId = `bench-d${String(d).padStart(7, "0")}`;
      const rnd = prng(`${spec.seed}:doc:${d}`);
      const title = [0, 1, 2].map(() => LATIN_WORDS[sampleRank(LATIN_CDF, rnd())]!).join(" ");
      batch.documents.push({ id: docId, sourcePath: `bench/${d % 100}/${docId}.md`, title });
      for (let c = 0; c < CHUNKS_PER_DOC && emitted < spec.chunks; c++, emitted++) {
        const id = `${docId}_c${c}`;
        batch.chunks.push({
          id,
          documentId: docId,
          chunkIndex: c,
          content: chunkText(rnd, c === 0 ? title : null),
          vector: benchVector(`${spec.seed}:${id}`),
        });
      }
    }
    yield batch;
  }
}

/** SHA-256 over every document and chunk exactly as they would be loaded. */
export function corpusDigest(spec: CorpusSpec): string {
  const h = createHash("sha256");
  for (const b of corpusBatches(spec)) {
    for (const d of b.documents) h.update(`D\t${d.id}\t${d.sourcePath}\t${d.title}\n`);
    for (const c of b.chunks) h.update(`C\t${c.id}\t${c.chunkIndex}\t${c.content}\t${c.vector}\n`);
  }
  return h.digest("hex");
}

/** The query classes and their fixed shares of every query list. */
export const QUERY_MIX = [
  { kind: "short_frequent", share: 0.2, note: "1 head term — matches most chunks" },
  { kind: "short_medium", share: 0.2, note: "2 mid-band terms" },
  { kind: "short_rare", share: 0.2, note: "1 tail term — a handful of chunks" },
  { kind: "long_mixed", share: 0.2, note: "4-6 terms across the bands" },
  { kind: "cyrillic", share: 0.1, note: "1-2 Cyrillic head terms" },
  { kind: "no_hit", share: 0.1, note: "2 terms no chunk contains" },
] as const;

export type QueryKind = (typeof QUERY_MIX)[number]["kind"];

export interface BenchQuery {
  kind: QueryKind;
  text: string;
}

function bandWord(rnd: () => number, band: readonly [number, number]): string {
  return LATIN_WORDS[band[0] + Math.floor(rnd() * (band[1] - band[0]))]!;
}

function queryOf(kind: QueryKind, rnd: () => number, i: number): string {
  switch (kind) {
    case "short_frequent":
      return bandWord(rnd, BANDS.frequent);
    case "short_medium":
      return `${bandWord(rnd, BANDS.medium)} ${bandWord(rnd, BANDS.medium)}`;
    case "short_rare":
      return bandWord(rnd, BANDS.rare);
    case "long_mixed": {
      const n = 4 + Math.floor(rnd() * 3);
      const bands = [BANDS.frequent, BANDS.medium, BANDS.rare];
      return Array.from({ length: n }, (_, j) => bandWord(rnd, bands[j % 3]!)).join(" ");
    }
    case "cyrillic": {
      const n = 1 + Math.floor(rnd() * 2);
      return Array.from({ length: n }, () => CYRILLIC_WORDS[Math.floor(rnd() * 1_000)]!).join(" ");
    }
    case "no_hit":
      return `${absentWord(i)} ${absentWord(i + 1)}`;
  }
}

/**
 * `count` queries in the fixed mix. Shares are cut with largest-remainder
 * rounding so the counts always sum to `count`, then the list is interleaved
 * deterministically so a run's first queries are not all one class.
 */
export function queryList(seed: string, label: string, count: number): BenchQuery[] {
  const exact = QUERY_MIX.map((m) => m.share * count);
  const counts = exact.map(Math.floor);
  let left = count - counts.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let j = 0; left > 0; j++, left--) counts[order[j % order.length]!.i]!++;
  const rnd = prng(`${seed}:queries:${label}`);
  const out: BenchQuery[] = [];
  QUERY_MIX.forEach((m, mi) => {
    for (let n = 0; n < counts[mi]!; n++) out.push({ kind: m.kind, text: queryOf(m.kind, rnd, out.length) });
  });
  // Fisher-Yates with the same seeded stream.
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
