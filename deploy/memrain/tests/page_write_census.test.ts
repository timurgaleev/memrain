import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { walkFiles } from "../src/core/walk.ts";

function writes(text: string): Record<string, number> {
  return [...text.matchAll(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(pages|page_versions|entity_facts)\b/gi)]
    .reduce<Record<string, number>>((counts, match) => {
      const table = match[1]!.toLowerCase();
      return { ...counts, [table]: (counts[table] ?? 0) + 1 };
    }, {});
}

const audited = {
  "core/cycle/consolidate-facts.ts": { entity_facts: 2, reason: "Consolidation state and retirement" },
  "core/cycle/embed-facts.ts": { entity_facts: 1, reason: "Deferred embedding only" },
  "core/cycle/recompute-salience.ts": { pages: 1, reason: "Derived salience only" },
  "core/entity-merge.ts": { entity_facts: 5, pages: 1, page_versions: 1, reason: "Locked merge, collision tombstones and audit history" },
  "core/fact-withdrawals.ts": { entity_facts: 1, reason: "Claim withdrawal sweep" },
  "core/facts-recall.ts": { entity_facts: 2, reason: "Forget and duplicate withdrawal" },
  "core/facts-reconcile.ts": { entity_facts: 3, reason: "Scoped projection preserving unchanged rows" },
  "core/facts-replace.ts": { entity_facts: 1, reason: "Retire replaced facts" },
  "core/facts.ts": { entity_facts: 5, reason: "Validated append, dedup and attribution" },
  "core/generation.ts": { pages: 1, reason: "Derived generation counter only" },
  "core/last-retrieved.ts": { pages: 1, reason: "Retrieval metadata only" },
  "core/links.ts": { pages: 2, reason: "Inbound link count only" },
  "core/ontology-facts.ts": { entity_facts: 5, reason: "Validated dimensional writes and supersession" },
  "core/page-retype.ts": { pages: 1, reason: "Explicit type change" },
  "core/pages-purge.ts": { pages: 2, entity_facts: 1, reason: "Expired soft-delete purge with transaction retry; retires the purged page's facts with a receipt" },
  "core/pages.ts": { pages: 6, page_versions: 6, entity_facts: 2, reason: "Canonical page mutations under slug locks" },
  "core/transcripts/origin-repair.ts": { entity_facts: 1, reason: "Operator-gated attribution repair by exact source/session evidence; collisions roll back" },
  "eval/chronicle-harness.ts": { entity_facts: 1, reason: "Eval fixture seeding" },
};

describe("direct page and fact writers", () => {
  it("detects SQL variants without matching similarly named tables or reads", () => {
    expect(writes("insert\ninto pages(x); UPDATE page_versions; delete from entity_facts; UPDATE pages_archive; SELECT * FROM pages"))
      .toEqual({ pages: 1, page_versions: 1, entity_facts: 1 });
    expect(writes("UPDATE pages; DELETE FROM pages")).toEqual({ pages: 2 });
  });

  it("requires an audit for every new writer and every changed write count", () => {
    const root = new URL("../src/", import.meta.url).pathname;
    const actual = Object.fromEntries([...walkFiles(root, { extensions: [".ts"], ignore: new Set() })]
      .map(file => [relative(root, file.path), writes(readFileSync(file.path, "utf8"))] as const)
      .filter(([, counts]) => Object.keys(counts).length > 0));
    const expected = Object.fromEntries(Object.entries(audited).map(([file, { reason, ...counts }]) => {
      expect(reason.length).toBeGreaterThan(0);
      return [file, counts];
    }));
    expect(actual).toEqual(expected);
  });
});
