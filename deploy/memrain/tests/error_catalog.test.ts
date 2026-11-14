/**
 * docs/ERRORS.md is generated from the error registry. A code added to
 * OPERATION_ERROR_CODES without a catalogue entry, a page edited by hand, or a
 * stale page after an entry changed — each fails here, so the link a CLI or
 * MCP error points at always names a real, current entry.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OPERATION_ERROR_CODES, operationErrorTraits } from "../src/core/operation-error.ts";
import { OPERATION_ERROR_DOCS, renderErrorCatalog } from "../src/core/operation-error-docs.ts";

const page = join(import.meta.dir, "..", "..", "..", "docs", "ERRORS.md");

function anchors(markdown: string): string[] {
  return [...markdown.matchAll(/^### (\S+)$/gm)].map((m) => m[1]!);
}

describe("error catalogue", () => {
  it("documents every registered code with a cause and a fix", () => {
    for (const code of OPERATION_ERROR_CODES) {
      const entry = OPERATION_ERROR_DOCS[code];
      expect(`${code}: ${entry?.title?.trim() ? "titled" : "untitled"}`).toBe(`${code}: titled`);
      expect(entry.cause.trim().length).toBeGreaterThan(0);
      expect(entry.fix.trim().length).toBeGreaterThan(0);
    }
  });

  it("gives every code exactly one anchor, and no anchor without a code", () => {
    const found = anchors(renderErrorCatalog());
    expect(found.sort()).toEqual([...OPERATION_ERROR_CODES].sort());
  });

  it("states each code's class and retryability from the registry", () => {
    const md = renderErrorCatalog();
    for (const code of OPERATION_ERROR_CODES) {
      const { errorClass, retryable } = operationErrorTraits(code);
      expect(md).toContain(`| [\`${code}\`](#${code}) | ${errorClass} | ${retryable ? "yes" : "no"} |`);
    }
  });

  it("keeps docs/ERRORS.md identical to a fresh render", () => {
    // Regenerate with: bun scripts/gen-catalogs.ts (in deploy/memrain)
    expect(readFileSync(page, "utf8")).toBe(renderErrorCatalog());
  });
});
