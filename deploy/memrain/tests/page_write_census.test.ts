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
  "core/fact-withdrawals.ts": { entity_facts: 1, reason: "Claim withdrawal sweep" },
  "core/generation.ts": { pages: 1, reason: "Derived generation counter only" },
  "core/last-retrieved.ts": { pages: 1, reason: "Retrieval metadata only" },
  "core/pages-purge.ts": { pages: 2, entity_facts: 1, reason: "Expired soft-delete purge with transaction retry; retires the purged page's facts with a receipt" },
  "core/pages.ts": { pages: 6, page_versions: 6, entity_facts: 2, reason: "Canonical page mutations under slug locks" },
  "core/purge-leftovers.ts": { pages: 1, page_versions: 1, entity_facts: 1, reason: "Restore from an operator's purge-leftovers export: earlier page text as a new version under slug locks, and un-retires exactly the exported purge facts" },
  "mcp/dispatch.ts": { entity_facts: 1, reason: "page_delete drops the facts an earlier build projected from the deleted page's fence, as before" },
  "core/derived-cleanup.ts": { pages: 1, page_versions: 1, entity_facts: 1, reason: "Purge cleanup of synthesis output under slug locks: a concept page rebuilt from its surviving atoms as a new version, and leftover facts retired with a receipt" },
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
