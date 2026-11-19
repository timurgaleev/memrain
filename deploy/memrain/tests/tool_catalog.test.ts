/**
 * docs/TOOLS.md is generated from the tool definitions agents receive in
 * tools/list. A new or changed tool without a regenerated page fails here, so
 * the public catalogue cannot drift from what the server advertises.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OPERATIONS } from "../src/mcp/operations.ts";
import { OPERATOR_ONLY_TOOLS } from "../src/mcp/visibility.ts";
import { renderToolCatalog } from "../src/mcp/tool-catalog.ts";

const page = join(import.meta.dir, "..", "..", "..", "docs", "TOOLS.md");

describe("tool catalogue", () => {
  const md = renderToolCatalog();

  it("has one section per tool, in no other number", () => {
    const sections = [...md.matchAll(/^### (\S+)$/gm)].map((m) => m[1]!);
    expect(sections.sort()).toEqual(OPERATIONS.map((o) => o.name).sort());
  });

  it("lists every declared parameter of every tool", () => {
    for (const op of OPERATIONS) {
      const start = md.indexOf(`\n### ${op.name}\n`);
      const next = md.indexOf("\n### ", start + 1);
      const section = md.slice(start, next === -1 ? undefined : next);
      for (const param of Object.keys(op.params)) {
        expect(`${op.name}.${param}: ${section.includes(`| \`${param}\` |`)}`).toBe(`${op.name}.${param}: true`);
      }
    }
  });

  it("marks the operator-only tools", () => {
    for (const name of OPERATOR_ONLY_TOOLS) {
      if (!OPERATIONS.some((o) => o.name === name)) continue;
      expect(md).toMatch(new RegExp(`\\| \\[\`${name}\`\\]\\(#${name}\\) \\|[^\\n]*\\| yes \\|`));
    }
  });

  it("keeps docs/TOOLS.md identical to a fresh render", () => {
    // Regenerate with: bun scripts/gen-catalogs.ts (in deploy/memrain)
    expect(readFileSync(page, "utf8")).toBe(md);
  });
});
