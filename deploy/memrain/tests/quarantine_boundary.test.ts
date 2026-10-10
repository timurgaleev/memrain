/**
 * The quarantine boundary beyond search: a document the content-sanity gate
 * hid must not resurface through chunk reads or synthesized takes, and the
 * write path must be able to tell its caller the page was hidden.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { registerSource } from "../src/core/sources.ts";
import { indexDocument } from "../src/core/indexer.ts";
import { mirrorPage, mirrorPageVerdict } from "../src/core/page-index.ts";
import { getChunksForPage, getChunksForSource } from "../src/core/chunks-read.ts";
import { readQuarantineVerdict } from "../src/core/quarantine.ts";
import {
  getTakesCalibration,
  getTakesScorecard,
  listTakes,
  searchTakes,
} from "../src/core/synthesis/reads.ts";
import { deterministicEmbed } from "./det-embed.ts";

const embedFn = (t: string) => Promise.resolve(deterministicEmbed(t));
const JUNK = "Checking your browser before accessing example.com. Cloudflare Ray ID: 8badf00d";
const CLEAN = "A perfectly normal note about the quarterly retrieval plan.";

const dbDir = mkdtempSync(join(tmpdir(), "memrain-quarantine-boundary-"));
let storage: Storage;

beforeAll(async () => {
  storage = new Storage({ dbPath: join(dbDir, "brain.pglite") });
  await storage.init();
  await registerSource(storage.engine(), { id: "tenantA", kind: "vault", pathPrefix: "/tenant-a" });
});

afterAll(async () => {
  await storage.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("indexDocument / mirrorPageVerdict report the gate's verdict", () => {
  it("returns quarantined for junk and nothing for a clean write", async () => {
    const junk = await indexDocument(storage, { sourcePath: "/b/junk.md", text: JUNK }, { embedFn });
    expect(junk.quarantined).toEqual({
      reason: "junk_pattern",
      detail: expect.stringContaining("cloudflare_ray_id"),
    });
    const clean = await indexDocument(storage, { sourcePath: "/b/clean.md", text: CLEAN }, { embedFn });
    expect(clean.quarantined).toBeUndefined();
  });

  it("mirrorPageVerdict carries the verdict while mirrorPage stays boolean", async () => {
    const page = { slug: "junk-page", title: "Junk page", markdown_body: JUNK };
    const verdict = await mirrorPageVerdict(storage, page, { remote: true, embedFn });
    expect(verdict.ok).toBe(true);
    expect(verdict.quarantined?.reason).toBe("junk_pattern");
    expect(await mirrorPage(storage, page, { remote: true, embedFn })).toBe(true);

    const clean = await mirrorPageVerdict(
      storage,
      { slug: "clean-page", title: "Clean page", markdown_body: CLEAN },
      { remote: true, embedFn },
    );
    expect(clean).toEqual({ ok: true });
  });

  it("readQuarantineVerdict reads a page's mirror for its owning source", async () => {
    await mirrorPageVerdict(
      storage,
      { slug: "tenant-junk", title: "Tenant junk", markdown_body: JUNK, source_id: "tenantA" },
      { remote: true, embedFn },
    );
    expect((await readQuarantineVerdict(storage.engine(), "junk-page", "default"))?.reason).toBe("junk_pattern");
    expect((await readQuarantineVerdict(storage.engine(), "junk-page", undefined))?.reason).toBe("junk_pattern");
    expect((await readQuarantineVerdict(storage.engine(), "tenant-junk", "tenantA"))?.reason).toBe("junk_pattern");
    expect(await readQuarantineVerdict(storage.engine(), "tenant-junk", "default")).toBeNull();
    expect(await readQuarantineVerdict(storage.engine(), "clean-page", "default")).toBeNull();
    expect(await readQuarantineVerdict(storage.engine(), "no-such-page", "default")).toBeNull();
  });
});

describe("chunk reads hide a quarantined document", () => {
  it("getChunksForSource returns nothing unless the caller opts in", async () => {
    expect(await getChunksForSource(storage, "/b/junk.md")).toEqual([]);
    const opted = await getChunksForSource(storage, "/b/junk.md", undefined, { includeQuarantined: true });
    expect(opted.length).toBeGreaterThan(0);
    expect((await getChunksForSource(storage, "/b/clean.md")).length).toBeGreaterThan(0);
  });

  it("getChunksForPage does the same through the page mirror", async () => {
    expect(await getChunksForPage(storage, "junk-page")).toEqual([]);
    const opted = await getChunksForPage(storage, "junk-page", undefined, { includeQuarantined: true });
    expect(opted.length).toBeGreaterThan(0);
    expect((await getChunksForPage(storage, "clean-page")).length).toBeGreaterThan(0);
  });
});

describe("takes distilled from a quarantined document stay out of reads", () => {
  async function docId(path: string): Promise<string> {
    const r = await storage
      .engine()
      .query<{ id: string }>("SELECT id FROM documents WHERE source_path = $1", [path]);
    return r.rows[0]!.id;
  }

  async function seedTake(key: string, sourceRef: string, verdict: "correct" | "incorrect") {
    const e = storage.engine();
    const r = await e.query<{ id: number }>(
      `INSERT INTO synth_takes (take_key, source_ref, source_hash, prompt_version, claim_text, kind, weight, status, model_id)
       VALUES ($1, $2, 'h', 'v1', $1, 'bet', 0.8, 'queued', 'fake') RETURNING id`,
      [key, sourceRef],
    );
    await e.query(
      `INSERT INTO synth_take_grades (take_id, prompt_version, evidence_signature, verdict, confidence, model_id)
       VALUES ($1, 'v1', $2, $3, 0.9, 'fake')`,
      [r.rows[0]!.id, `sig-${key}`, verdict],
    );
  }

  beforeAll(async () => {
    await seedTake("claim from junk source", await docId("/b/junk.md"), "incorrect");
    await seedTake("claim from clean source", await docId("/b/clean.md"), "correct");
    await seedTake("claim with no document", "not-a-document", "correct");
  });

  it("listTakes and searchTakes drop the junk-sourced take", async () => {
    const listed = (await listTakes(storage.engine())).map((t) => t.take_key).sort();
    expect(listed).toEqual(["claim from clean source", "claim with no document"]);
    const found = (await searchTakes(storage.engine(), { q: "claim from" })).map((t) => t.take_key);
    expect(found).toEqual(["claim from clean source"]);
  });

  it("scorecard and calibration do not count it", async () => {
    const card = await getTakesScorecard(storage.engine());
    expect(card.total_takes).toBe(2);
    expect(card.incorrect).toBe(0);
    const buckets = await getTakesCalibration(storage.engine());
    expect(buckets.reduce((n, b) => n + b.n, 0)).toBe(2);
  });
});
