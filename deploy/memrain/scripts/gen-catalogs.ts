/**
 * Regenerate docs/ERRORS.md from the code.
 *
 *   bun scripts/gen-catalogs.ts
 *
 * Run it after adding or changing an error code (src/core/operation-error.ts
 * and its entry in src/core/operation-error-docs.ts).
 * tests/error_catalog.test.ts fails until the page matches a fresh render.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderErrorCatalog } from "../src/core/operation-error-docs.ts";

const docs = join(import.meta.dir, "..", "..", "..", "docs");

for (const [name, body] of [["ERRORS.md", renderErrorCatalog()]] as const) {
  writeFileSync(join(docs, name), body);
  console.log(`wrote docs/${name}`);
}
