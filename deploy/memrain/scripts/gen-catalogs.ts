/**
 * Regenerate docs/ERRORS.md and docs/TOOLS.md from the code.
 *
 *   bun scripts/gen-catalogs.ts
 *
 * Run it after adding or changing an error code (src/core/operation-error.ts
 * and its entry in src/core/operation-error-docs.ts) or a tool
 * (src/mcp/operations.ts). tests/error_catalog.test.ts and
 * tests/tool_catalog.test.ts fail until the pages match a fresh render.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderErrorCatalog } from "../src/core/operation-error-docs.ts";
import { renderToolCatalog } from "../src/mcp/tool-catalog.ts";

const docs = join(import.meta.dir, "..", "..", "..", "docs");

for (const [name, body] of [["ERRORS.md", renderErrorCatalog()], ["TOOLS.md", renderToolCatalog()]] as const) {
  writeFileSync(join(docs, name), body);
  console.log(`wrote docs/${name}`);
}
