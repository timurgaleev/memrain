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
  "core/connectors/retention.ts": { pages: 2, page_versions: 1, entity_facts: 2, reason: "Hard delete of one account's connector page under slug locks, with its facts and a text-free receipt; retention detaches a hand-edited page instead, as a new version under the same locks; an upstream deletion soft-deletes through softDeleteLockedPage and drops the page's fence facts, as page_delete does" },
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
  "core/ontology-facts.ts": { entity_facts: 6, reason: "Validated dimensional writes and supersession; a less trusted value is stored quarantined beside the current one" },
  "core/page-retype.ts": { pages: 1, reason: "Explicit type change" },
  "core/pages-purge.ts": { pages: 2, entity_facts: 1, reason: "Expired soft-delete purge with transaction retry; retires the purged page's facts with a receipt" },
  "core/pages.ts": { pages: 6, page_versions: 6, entity_facts: 2, reason: "Canonical page mutations under slug locks" },
  "core/purge-leftovers.ts": { pages: 1, page_versions: 1, entity_facts: 1, reason: "Restore from an operator's purge-leftovers export: earlier page text as a new version under slug locks, and un-retires exactly the exported purge facts" },
  "core/synthesis/derived-cleanup.ts": { pages: 1, page_versions: 1, entity_facts: 1, reason: "Purge cleanup of synthesis output under slug locks: a concept page rebuilt from its surviving atoms as a new version, and leftover facts retired with a receipt" },
  "core/transcripts/origin-repair.ts": { entity_facts: 1, reason: "Operator-gated attribution repair by exact source/session evidence; collisions roll back" },
  "core/trust-derived.ts": { pages: 3, reason: "Trust tier only: lowers a derived page to its least trusted input, never raises it" },
  "core/trust-proposals.ts": { entity_facts: 4, reason: "Owner decision on a trust proposal: accept applies the replacement, reject retires the less trusted fact" },
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
