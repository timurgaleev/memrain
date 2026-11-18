// Run after `vite build -c vite.app.config.ts`: the member app must carry
// none of the operator's panel. Every file of dist-app is checked for an
// operator route, and the manifest for a module from outside the shared
// chat components, the member app's own code and the shared helpers.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = fileURLToPath(new URL("../dist-app/", import.meta.url));

/** A route of the operator's panel; nothing in the member app may name one. */
// "#spend" is left out: the shared Ask page links it after a budget refusal, and
// the member app routes an unknown hash to its start page.
export const OPERATOR_MARKERS = ["/admin/", "#overview", "#credentials", "#office", "#security", "#autonomy"];
/** Source modules the member app may bundle. */
const ALLOWED_SRC = /^(app\.html|src\/(app|chat|components|lib)\/|src\/hooks\.ts|src\/index\.css|src\/assets\/|node_modules\/)/;
/** Operator modules that live in the shared folders but are not the member's. */
const OPERATOR_SRC = /^src\/(api\.ts|api-automation\.ts|App\.tsx|main\.tsx|pages\/|office\/|lib\/(automation|passkey-ceremony|notifications)\.ts|components\/(CommandPalette|RadialGraph|SetupChecklist|RecoveryCodes)\.tsx)/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const full = join(dir, n);
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}

export function problemsIn(dist: string): string[] {
  const problems: string[] = [];
  for (const f of files(dist)) {
    const rel = relative(dist, f);
    if (rel === join(".vite", "manifest.json")) continue;
    const text = readFileSync(f, "utf8");
    for (const m of OPERATOR_MARKERS) if (text.includes(m)) problems.push(`${rel} names ${m}`);
  }
  const manifest = JSON.parse(readFileSync(join(dist, ".vite", "manifest.json"), "utf8")) as Record<string, { src?: string }>;
  for (const [key, chunk] of Object.entries(manifest)) {
    const src = chunk.src ?? key;
    if (src.startsWith("_")) continue;
    if (!ALLOWED_SRC.test(src) || OPERATOR_SRC.test(src)) problems.push(`manifest bundles ${src}`);
  }
  return problems;
}

if (import.meta.main) {
  const problems = problemsIn(DIST);
  if (problems.length > 0) {
    console.error(`member app bundle carries operator code:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log("member app bundle: no operator routes or modules");
}
