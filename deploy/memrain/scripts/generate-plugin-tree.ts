/**
 * Regenerate what is derived from deploy/skills: the plugin's skills folder,
 * the resolver page and the lock file.
 *
 *   bun scripts/generate-plugin-tree.ts           # write
 *   bun scripts/generate-plugin-tree.ts --check   # exit 1 and list drift
 *
 * Run it after editing a skill or plugin-lanes.json.
 * tests/skillpack_plugin_tree.test.ts fails until the committed copies match.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  LOCK_FILE,
  RESOLVER_FILE,
  diffPluginTree,
  readPluginLanes,
  renderLock,
  renderResolver,
  validateLanes,
  writePluginTree,
} from "../src/core/skillpack/plugin-tree.ts";

const pack = resolve(import.meta.dir, "..", "..", "skills");
const plugin = resolve(import.meta.dir, "..", "..", "..", "plugins", "memrain", "skills");
const check = process.argv.includes("--check");

function current(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

const lanes = readPluginLanes(pack);
const errors = validateLanes(lanes, pack);
if (errors.length > 0) {
  for (const e of errors) console.error(`plugin-lanes.json: ${e}`);
  process.exit(1);
}

const resolverPath = join(pack, RESOLVER_FILE);
const resolver = renderResolver(pack, lanes);
if (check) {
  const drift = diffPluginTree(pack, plugin).map((p) => `plugins/memrain/skills/${p}`);
  if (current(resolverPath) !== resolver) drift.push(`deploy/skills/${RESOLVER_FILE}`);
  if (current(join(pack, LOCK_FILE)) !== renderLock(pack)) drift.push(`deploy/skills/${LOCK_FILE}`);
  if (drift.length > 0) {
    for (const p of drift) console.error(`out of date: ${p}`);
    console.error("run: bun scripts/generate-plugin-tree.ts");
    process.exit(1);
  }
  console.log("plugin tree, resolver and lock are up to date");
} else {
  // The resolver is a pack file, so it is written before the lock hashes it.
  writeFileSync(resolverPath, resolver);
  const changed = writePluginTree(pack, plugin);
  writeFileSync(join(pack, LOCK_FILE), renderLock(pack));
  console.log(`wrote ${RESOLVER_FILE}, ${LOCK_FILE}; plugin files changed: ${changed.length}`);
}
