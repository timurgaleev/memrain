/**
 * Every skill that fetches or imports text the operator did not write cites
 * the untrusted-content convention in its Contract, and the convention
 * resolves through get_skill.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { VALID_FRICTION_KINDS } from "../src/core/friction.ts";
import { getBrainSkill } from "../src/core/skillpack/brain-resident.ts";

const PACK_DIR = resolve(import.meta.dir, "..", "..", "skills");

const SKILLS = [
  "ingest",
  "idea-ingest",
  "media-ingest",
  "meeting-ingestion",
  "voice-note-ingest",
  "capture",
  "webhook-transforms",
  "archive-crawler",
  "article-enrichment",
  "academic-verify",
  "book-mirror",
  "brain-pdf",
  "data-research",
  "perplexity-research",
  "strategic-reading",
  "conversation-archive",
];

describe("untrusted-content convention", () => {
  it("the convention exists and states the rule", () => {
    const doc = readFileSync(join(PACK_DIR, "conventions", "untrusted-content.md"), "utf-8");
    expect(doc).toMatch(/never (chooses|selects) a tool call/i);
    expect(doc).toContain("log_friction");
  });

  it("every log_friction kind it names is one the tool accepts", () => {
    const doc = readFileSync(join(PACK_DIR, "conventions", "untrusted-content.md"), "utf-8");
    const kinds = [...doc.matchAll(/kind: "([^"]+)"/g)].map((m) => m[1]!);
    expect(kinds.length).toBeGreaterThan(0);
    for (const kind of kinds) expect([...VALID_FRICTION_KINDS] as string[]).toContain(kind);
  });

  it.each(SKILLS)("%s cites it in its Contract", (name) => {
    const body = readFileSync(join(PACK_DIR, name, "SKILL.md"), "utf-8");
    const contract = body.split("## Contract")[1]!.split("\n## ")[0]!;
    expect(contract).toContain("conventions/untrusted-content");
  });

  it("get_skill resolves it", () => {
    expect(getBrainSkill("conventions/untrusted-content", { skillsDir: PACK_DIR })).not.toBeNull();
  });
});
