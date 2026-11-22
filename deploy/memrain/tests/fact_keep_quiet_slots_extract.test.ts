/**
 * Two things extraction adds to a fact without changing its text or the
 * extractor prompt: a claim the speaker asked to keep quiet is stored private,
 * and a fact about a live person page is tagged with a slot by a second, small
 * call that spends from the same per-write budget.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { extractFactsOnDemand } from "../src/core/facts-extract.ts";
import { forgetFact } from "../src/core/facts-recall.ts";
import { keepQuietClaims, keptQuiet, windowMessages } from "../src/core/fact-keep-quiet.ts";
import { SLOT_TAG_SYSTEM, tagSlots } from "../src/core/fact-slot-tagging.ts";
import type { SonnetFn } from "../src/core/llm/sonnet.ts";

const usage = { inputTokens: 10, outputTokens: 10 };
const reply = (text: string, stopReason?: string) => ({ text, modelId: "eu.anthropic.claude-sonnet-4-5-v1:0", usage, ...(stopReason ? { stopReason } : {}) });

describe("keep-quiet matching", () => {
  const said = (...lines: Array<[string, string]>) => lines.map(([speaker, text]) => ({ speaker, text }));
  const marks = (messages: Array<{ speaker: string; text: string }>, facts: string[]) => facts.filter((fact) => keptQuiet(fact, keepQuietClaims(messages)));

  it("a fact restating the keep-quiet claim is marked, and another claim in the same window is not", () => {
    const window = said(["user", "Got it. Keep this quiet for now, but Acme Example is merging with Beta Example. How often should I water basil?"]);
    expect(marks(window, ["Acme Example is merging with Beta Example.", "User asked that the Acme Example and Beta Example merger be kept quiet.",
      "User said work was busy and asked to keep the Acme Example merger with Beta Example quiet for now.", "User waters basil twice a week.", "Acme Example hired a new CFO."]))
      .toEqual(["Acme Example is merging with Beta Example.", "User asked that the Acme Example and Beta Example merger be kept quiet.",
        "User said work was busy and asked to keep the Acme Example merger with Beta Example quiet for now."]);
  });

  it("other cues mark their claim; an assistant message, an idiom and a trailing \"between us\" name none", () => {
    const SEED = "Acme Example closed its seed round.";
    expect(marks(said(["alice-example", "Between us, Acme Example closed its seed round."]), [SEED])).toHaveLength(1);
    expect(marks(said(["alice-example", "Between us. Acme Example closed its seed round."]), [SEED])).toHaveLength(1);
    expect(marks(said(["user", "Off the record, the Lisbon office opens in March."]), ["The Lisbon office opens in March."])).toHaveLength(1);
    expect(marks(said(["alice-example", "Thanks. Between us and the competition, Acme Example closed its seed round."]), [SEED])).toHaveLength(0);
    expect(marks(said(["alice-example", "Acme Example closed its seed round."], ["bob-example", "Don't mention it, Acme Example closed its seed round."]), [SEED])).toHaveLength(0);
    // A cue sentence with no claim of its own refers to the sentence before it.
    expect(marks(said(["user", "Acme Example closed its seed round. Please don't share this."]), [SEED])).toHaveLength(1);
    expect(marks(said(["user", "Acme Example closed its seed round. Keep this quiet."]), [SEED])).toHaveLength(1);
    expect(marks(said(["assistant", "Understood, I will keep that quiet. Basil likes a half-strength liquid feed every three weeks."]),
      ["Basil likes a half-strength liquid feed every three weeks."])).toHaveLength(0);
    expect(marks(said(["assistant", "Off the record, Acme Example closed its seed round."]), [SEED])).toHaveLength(0);
    expect(marks(said(["user", "I want our chats to stay friendly and respectful between us."]), ["User wants the chats to stay friendly and respectful."])).toHaveLength(0);
    expect(marks(said(["user", "Acme Example closed its seed round."]), [SEED])).toHaveLength(0);
  });

  // Value: protects=a request for secrecy in the words people use ("keep this secret", "this is confidential",
  // and the Russian forms) narrows the claim to private; fails_when=a cue is dropped from the list, or a near miss
  // ("secretary", a past-tense "told no one", a trailing "between us") marks an ordinary claim;
  // why_new=the original cue list knew none of these phrasings; seam=the pure matcher the extractors call.
  it("secrecy cues in English and Russian mark their claim, and near misses do not", () => {
    const JOIN = "Acme Example is joining Beta Example.";
    const hits = (text: string, fact = JOIN, speaker = "user") => marks(said([speaker, text]), [fact]).length;
    expect(hits("Please keep this secret: Acme Example is joining Beta Example.")).toBe(1);
    expect(hits("Keep it a secret, but Acme Example is joining Beta Example.")).toBe(1);
    expect(hits("This is confidential: Acme Example is joining Beta Example.")).toBe(1);
    expect(hits("Acme Example is joining Beta Example. It's confidential.")).toBe(1);
    expect(hits("Keep this secretary posted: Acme Example is joining Beta Example.")).toBe(0);
    expect(hits("Put the confidential info in the contract template for Acme Example and Beta Example.")).toBe(0);
    // The same request from the assistant names no claim.
    expect(hits("Please keep this secret: Acme Example is joining Beta Example.", JOIN, "assistant")).toBe(0);

    // "Ivan is moving to Yandex", Russian.
    const IVAN = "\u0418\u0432\u0430\u043D \u043F\u0435\u0440\u0435\u0445\u043E\u0434\u0438\u0442 \u0432 \u042F\u043D\u0434\u0435\u043A\u0441";
    const ru = (cue: string) => hits(cue.replace("{}", IVAN), `${IVAN}.`);
    // "Keep (this) secret: ..." / "Keep it secret" in the polite form.
    expect(ru("\u0414\u0435\u0440\u0436\u0438 \u0432 \u0441\u0435\u043A\u0440\u0435\u0442\u0435: {}.")).toBe(1);
    expect(ru("{}. \u0414\u0435\u0440\u0436\u0438\u0442\u0435 \u044D\u0442\u043E \u0432 \u0441\u0435\u043A\u0440\u0435\u0442\u0435.")).toBe(1);
    // "Don't tell anyone, ..." / "don't say to anyone".
    expect(ru("\u041D\u0438\u043A\u043E\u043C\u0443 \u043D\u0435 \u0433\u043E\u0432\u043E\u0440\u0438, {}.")).toBe(1);
    expect(ru("{}. \u041D\u0438\u043A\u043E\u043C\u0443 \u043D\u0435 \u0440\u0430\u0441\u0441\u043A\u0430\u0437\u044B\u0432\u0430\u0439\u0442\u0435.")).toBe(1);
    // "Between us, ..." opening the sentence.
    expect(ru("\u041C\u0435\u0436\u0434\u0443 \u043D\u0430\u043C\u0438, {}.")).toBe(1);
    // Near misses: "kept in the secretaire", "told no one" (past), "the difference between us".
    expect(ru("\u0414\u0435\u0440\u0436\u0438 \u0432 \u0441\u0435\u043A\u0440\u0435\u0442\u0435\u0440\u0435 \u043F\u0430\u043F\u043A\u0443: {}.")).toBe(0);
    expect(ru("\u041D\u0438\u043A\u043E\u043C\u0443 \u043D\u0435 \u0433\u043E\u0432\u043E\u0440\u0438\u043B, \u0447\u0442\u043E {}.")).toBe(0);
    expect(ru("{}, \u0438 \u0432 \u044D\u0442\u043E\u043C \u0440\u0430\u0437\u043D\u0438\u0446\u0430 \u043C\u0435\u0436\u0434\u0443 \u043D\u0430\u043C\u0438.")).toBe(0);
  });

  it("reads speaker turns from the transcript shapes the importers write", () => {
    expect(windowMessages("**Alice Example:** Hi there\n**assistant** (2026-03-10 9:03 AM): Noted.\nmore of it\nUser: Off the record, yes."))
      .toEqual([{ speaker: "Alice Example", text: "Hi there" }, { speaker: "assistant", text: "Noted.\nmore of it" }, { speaker: "User", text: "Off the record, yes." }]);
    expect(windowMessages("Alice (10:02): I got the offer (at Acme) but please keep it quiet"))
      .toEqual([{ speaker: "Alice", text: "I got the offer (at Acme) but please keep it quiet" }]);
    expect(windowMessages("Alice: I got the offer (at Acme) but please keep it quiet"))
      .toEqual([{ speaker: "Alice", text: "I got the offer (at Acme) but please keep it quiet" }]);
  });
});

describe("tagSlots", () => {
  const ALICE = "people/alice-example";
  it("sends one line per candidate and keeps each valid slot once, normalized", async () => {
    const seen: string[] = [];
    const fn: SonnetFn = async (input) => {
      seen.push(input.user);
      expect(input.system).toBe(SLOT_TAG_SYSTEM);
      return reply(JSON.stringify({ slots: [
        { i: 1, dimension: "location", value: " Lisbon " },
        { i: 2, dimension: "Company", value: "Acme Example" },
        { i: 2, dimension: "role", value: "head of design" },
        { i: 9, dimension: "location", value: "Porto" },
        { i: 1.5, dimension: "role", value: "x" },
      ] }));
    };
    const r = await tagSlots(fn, [
      { fact: "Alice Example moved to Lisbon.", person: "Alice Example", entity_slug: ALICE },
      { fact: "Alice Example joined Acme Example as head of design.", person: "Alice Example", entity_slug: ALICE },
      { fact: "Alice Example likes tea.", person: "Alice Example", entity_slug: ALICE },
    ]);
    expect(seen).toEqual(["1. [Alice Example] Alice Example moved to Lisbon.\n2. [Alice Example] Alice Example joined Acme Example as head of design.\n3. [Alice Example] Alice Example likes tea."]);
    expect(r.failed).toBe(false);
    expect(r.slots).toEqual([{ dimension: "location", value: "Lisbon" }, { dimension: "employer", value: "Acme Example" }, null]);
  });

  it("an unreadable or cut answer keeps the facts without slots", async () => {
    const c = [{ fact: "Alice Example moved to Lisbon.", person: "Alice Example", entity_slug: ALICE }];
    expect(await tagSlots(async () => reply("not json"), c)).toMatchObject({ failed: true, slots: [null] });
    expect(await tagSlots(async () => reply("{\"slots\":[{\"i\":1", "max_tokens"), c)).toMatchObject({ failed: true, slots: [null] });
  });
});

describe("extraction stores keep-quiet facts private and tags slots", () => {
  let tmp: string;
  let storage: Storage;
  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "memrain-kq-"));
    storage = new Storage({ dbPath: join(tmp, "db") });
    await storage.init();
    await putPage(storage, { slug: "people/alice-example", type: "person", title: "Alice Example" });
    await putPage(storage, { slug: "companies/acme-example", type: "company", title: "Acme Example" });
  });
  afterAll(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const FACTS = [
    { fact: "Alice Example moved to Lisbon", kind: "event", entity: "people/alice-example", confidence: 0.9, notability: "high" },
    { fact: "Acme Example closed its seed round", kind: "fact", entity: "companies/acme-example", confidence: 0.9, notability: "high" },
    { fact: "Alice Example sends the plan on Thursday", kind: "commitment", entity: "people/alice-example", confidence: 0.9, notability: "high" },
  ];

  it("a world batch keeps the keep-quiet claim private and tags the person's slot", async () => {
    const systems: string[] = [];
    const fn: SonnetFn = async (input) => {
      systems.push(input.system);
      return input.system === SLOT_TAG_SYSTEM
        ? reply(JSON.stringify({ slots: [{ i: 1, dimension: "location", value: "Lisbon" }] }))
        : reply(JSON.stringify({ facts: FACTS }));
    };
    const text = "**Alice Example:** I moved to Lisbon. Keep this quiet for now, but Acme Example closed its seed round.\n**Bob:** I send the plan Thursday.";
    const r = await extractFactsOnDemand(text, { sonnetFn: fn, persist: true, storage, visibility: "world" });
    expect(r.written).toBe(3);
    // One extraction call, one tagging call (only the event about a person is a candidate).
    expect(systems.filter((s) => s === SLOT_TAG_SYSTEM)).toHaveLength(1);
    const rows = (await storage.engine().query<{ fact: string; visibility: string; slot_dimension: string | null; slot_value: string | null }>(
      "SELECT fact, visibility, slot_dimension, slot_value FROM entity_facts ORDER BY id")).rows;
    expect(rows).toEqual([
      { fact: "Alice Example moved to Lisbon", visibility: "world", slot_dimension: "location", slot_value: "Lisbon" },
      { fact: "Acme Example closed its seed round", visibility: "private", slot_dimension: null, slot_value: null },
      { fact: "Alice Example sends the plan on Thursday", visibility: "world", slot_dimension: null, slot_value: null },
    ]);
  });

  // Value: protects=a user's "keep this secret" keeps that claim off a world-visible batch end to end, while the
  // same words from the assistant change nothing; fails_when=the new cue stops reaching the writer;
  // why_new=the cue list missed this phrasing; seam=the extract_facts persist path, model faked.
  it("a user's \"keep this secret\" stores the claim private on a world batch; the assistant's does not", async () => {
    const fact = { fact: "Zeta Example is joining Omega Example", kind: "fact", entity: "companies/acme-example", confidence: 0.9, notability: "high" };
    const fn: SonnetFn = async (input) => input.system === SLOT_TAG_SYSTEM ? reply("{\"slots\":[]}") : reply(JSON.stringify({ facts: [fact] }));
    await extractFactsOnDemand("assistant: Please keep this secret: Zeta Example is joining Omega Example.", { sonnetFn: fn, persist: true, storage, visibility: "world" });
    const byAssistant = (await storage.engine().query<{ visibility: string }>("SELECT visibility FROM entity_facts WHERE fact = $1", [fact.fact])).rows;
    expect(byAssistant).toEqual([{ visibility: "world" }]);
    await storage.engine().query("DELETE FROM entity_facts WHERE fact = $1", [fact.fact]);
    await extractFactsOnDemand("user: Please keep this secret: Zeta Example is joining Omega Example.", { sonnetFn: fn, persist: true, storage, visibility: "world" });
    const byUser = (await storage.engine().query<{ visibility: string }>("SELECT visibility FROM entity_facts WHERE fact = $1", [fact.fact])).rows;
    expect(byUser).toEqual([{ visibility: "private" }]);
  });

  it("a keep-quiet restatement of a claim already saved world narrows it to private", async () => {
    const fact = { fact: "Beta Example signs the lease in May", kind: "fact", entity: "companies/acme-example", confidence: 0.9, notability: "high" };
    const fn: SonnetFn = async (input) => input.system === SLOT_TAG_SYSTEM ? reply("{\"slots\":[]}") : reply(JSON.stringify({ facts: [fact] }));
    await extractFactsOnDemand("Bob: Beta Example signs the lease in May.", { sonnetFn: fn, persist: true, storage, visibility: "world" });
    await extractFactsOnDemand("Bob: Off the record, Beta Example signs the lease in May.", { sonnetFn: fn, persist: true, storage, visibility: "world" });
    const rows = (await storage.engine().query<{ visibility: string }>("SELECT visibility FROM entity_facts WHERE fact = $1", [fact.fact])).rows;
    expect(rows).toEqual([{ visibility: "private" }]);
  });

  it("a keep-quiet restatement of a claim forgotten while world-visible does not bring it back as private", async () => {
    const fact = { fact: "Gamma Example opens a Porto office", kind: "fact", entity: "companies/acme-example", confidence: 0.9, notability: "high" };
    const fn: SonnetFn = async (input) => input.system === SLOT_TAG_SYSTEM ? reply("{\"slots\":[]}") : reply(JSON.stringify({ facts: [fact] }));
    const first = await extractFactsOnDemand("Bob: Gamma Example opens a Porto office.", { sonnetFn: fn, persist: true, storage, visibility: "world" });
    expect((await forgetFact(storage, first.fact_ids![0]!, { reason: "wrong" })).forgotten).toBe(true);
    await extractFactsOnDemand("Bob: Between us, Gamma Example opens a Porto office.", { sonnetFn: fn, persist: true, storage, visibility: "world" });
    const live = (await storage.engine().query("SELECT visibility FROM entity_facts WHERE fact = $1 AND forgotten_at IS NULL", [fact.fact])).rows;
    expect(live).toEqual([]);
  });

  it("a keep-quiet restatement of a claim forgotten while private is not written world-visible either", async () => {
    const fact = { fact: "Delta Example cuts its prices", kind: "fact", entity: "companies/acme-example", confidence: 0.9, notability: "high" };
    const fn: SonnetFn = async (input) => input.system === SLOT_TAG_SYSTEM ? reply("{\"slots\":[]}") : reply(JSON.stringify({ facts: [fact] }));
    const first = await extractFactsOnDemand("Bob: Off the record, Delta Example cuts its prices.", { sonnetFn: fn, persist: true, storage, visibility: "world" });
    expect((await forgetFact(storage, first.fact_ids![0]!, { reason: "wrong" })).forgotten).toBe(true);
    await extractFactsOnDemand("Bob: Between us, Delta Example cuts its prices.", { sonnetFn: fn, persist: true, storage, visibility: "world" });
    const live = (await storage.engine().query("SELECT visibility FROM entity_facts WHERE fact = $1 AND forgotten_at IS NULL", [fact.fact])).rows;
    expect(live).toEqual([]);
  });

  it("a fact whose person was only guessed from a partial name is not slot-tagged", async () => {
    let tagCalls = 0;
    const guessed = { fact: "Alice moved to Berlin", kind: "event", entity: "Alice", confidence: 0.9, notability: "high" };
    const fn: SonnetFn = async (input) => {
      if (input.system === SLOT_TAG_SYSTEM) { tagCalls++; return reply(JSON.stringify({ slots: [{ i: 1, dimension: "location", value: "Berlin" }] })); }
      return reply(JSON.stringify({ facts: [guessed] }));
    };
    await extractFactsOnDemand("Bob: Alice moved to Berlin.", { sonnetFn: fn, persist: true, storage, visibility: "world" });
    const rows = (await storage.engine().query<{ entity_slug: string; slot_dimension: string | null }>(
      "SELECT entity_slug, slot_dimension FROM entity_facts WHERE fact = $1", [guessed.fact])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.slot_dimension).toBeNull();
    expect(tagCalls).toBe(0);
  });

  it("a budget with no room for the tagging call still writes the facts, without slots", async () => {
    let calls = 0;
    const fn: SonnetFn = async (input) => {
      calls++;
      return input.system === SLOT_TAG_SYSTEM ? reply("{\"slots\":[]}") : { ...reply(JSON.stringify({ facts: [{ ...FACTS[0]!, fact: "Alice Example moved to Porto" }] })), usage: { inputTokens: 4000, outputTokens: 4000 } };
    };
    // The extraction call spends nearly all of the cap, leaving no room for the tagging call.
    const r = await extractFactsOnDemand("Alice Example: I moved to Porto.", { sonnetFn: fn, persist: true, storage, maxBudgetUsd: 0.075 });
    expect(r.written).toBe(1);
    expect(calls).toBe(1);
  });
});
