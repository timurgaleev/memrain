/**
 * Shared path-confinement guard for any user-supplied `path` argument
 * that lands at `indexFile()` — the HTTP `/index` route and the MCP
 * `index` tool both go through this.
 *
 * Threat model: a public bearer holder with `MEMRAIN_PUBLIC_WRITE=1`
 * must NOT be able to coerce the daemon into reading
 * `/etc/passwd`, `/run/secrets/*`, `/home/bun/.aws/*`, etc.
 *
 * Defence in depth:
 *   1. Resolve both the user path and every allowed root via
 *      `fs.realpathSync` so symlinks (vault/escape → /etc/passwd) are
 *      followed BEFORE the containment check.
 *   2. Compare with `path.relative(root, resolved)`: a path is inside
 *      the root iff the relative form starts with neither `..` nor an
 *      absolute path separator. This avoids the `startsWith(root + "/")`
 *      pitfall on alternative path separators.
 *   3. Fail closed: if `MEMRAIN_VAULT_PATHS` and `MEMRAIN_CODE_PATHS` are
 *      both unset, every request is rejected with a distinct error so
 *      misconfiguration surfaces obviously.
 */
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export class PathGuardConfigError extends Error {
  constructor() {
    super(
      "MEMRAIN_VAULT_PATHS / MEMRAIN_CODE_PATHS not configured — " +
        "refusing all index requests until at least one root is set",
    );
    this.name = "PathGuardConfigError";
  }
}

// Even within an allowed root, certain filenames must never be indexed
// because they're either operator-private (.env, .git/*) or pointless
// to ingest as documents (.DS_Store). Once MEMRAIN_PUBLIC_WRITE=1 is on,
// a bearer-holder could otherwise pull `/vault/.env`, `/vault/.git/
// config`, etc. via /search after /index.
const DENIED_BASENAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".envrc",
  ".aws",
  ".ssh",
  ".npmrc",
  ".netrc",
  ".gitconfig",
  ".pypirc",
  ".docker",
  ".kube",
  "credentials",
  ".credentials",
  "id_rsa",
  "id_ed25519",
]);

export function isDeniedPath(canonical: string): boolean {
  // Walk every path component; reject anything that lands under a
  // .git/ subtree (any depth) or matches a denied basename.
  const parts = canonical.split(sep);
  for (const p of parts) {
    if (p === ".git" || p === ".obsidian") return true;
    if (DENIED_BASENAMES.has(p)) return true;
    // Catch .env.<anything> as a class.
    if (p.startsWith(".env") || p.startsWith(".credentials")) return true;
  }
  return false;
}

function configuredRoots(): string[] {
  return [
    ...(process.env.MEMRAIN_VAULT_PATHS ?? "").split(","),
    ...(process.env.MEMRAIN_CODE_PATHS ?? "").split(","),
  ]
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

export function loadAllowedRoots(): string[] {
  const parts = configuredRoots();
  // Deduplicate while preserving order. We resolve symlinks at root
  // load so `path.relative` can compare canonical-to-canonical.
  const resolved = new Set<string>();
  for (const p of parts) {
    try {
      resolved.add(realpathSync(resolve(p)));
    } catch {
      // Root configured but absent on disk — skip it. fail-closed is
      // handled by the caller when roots.length === 0.
    }
  }
  return [...resolved];
}

/**
 * Every spelling a document path under a configured root may carry: the
 * canonical root, and the root as configured (resolved but not realpath'd).
 * Rows store `resolve()`d paths, so when a root sits behind a symlink
 * (`/tmp` → `/private/tmp`) only the configured spelling matches them.
 */
export function loadAllowedRootSpellings(): string[] {
  const out = new Set(loadAllowedRoots());
  for (const p of configuredRoots()) out.add(resolve(p));
  return [...out];
}

/**
 * The path the kernel would actually open: symlinks and `..` resolved by
 * realpath, so `/vault/a/../b/x.md` through a symlinked `/vault/a` lands where
 * a read would. A missing file falls back to the lexical `resolve`.
 */
export function canonicalPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** True iff `canonical` is one of `roots` or sits below one. Both sides canonical. */
export function isUnderRoot(canonical: string, roots: readonly string[]): boolean {
  for (const root of roots) {
    const rel = relative(root, canonical);
    // "" when equal, "foo/bar" below; "../x" sideways, absolute across drives.
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return true;
  }
  return false;
}

/**
 * Returns true iff `filePath` resolves (with symlinks followed) to a
 * path inside one of the configured roots. Throws PathGuardConfigError
 * if no roots are configured at all — that's an operator config bug,
 * not a client error.
 */
export function isWithinAllowedRoot(filePath: string): boolean {
  if (typeof filePath !== "string" || filePath.length === 0) return false;
  const roots = loadAllowedRoots();
  if (roots.length === 0) throw new PathGuardConfigError();

  let canonical: string;
  try {
    canonical = realpathSync(resolve(filePath));
  } catch {
    // File doesn't exist — that's the caller's problem (they'll get a
    // clearer error from `statSync`), not a guard bypass.
    canonical = resolve(filePath);
  }

  // Reject denied filenames anywhere on the canonical path, even
  // inside an allowed root.
  if (isDeniedPath(canonical)) return false;

  for (const root of roots) {
    if (canonical === root) return true;
    const rel = relative(root, canonical);
    // path.relative returns:
    //   - "" when canonical === root
    //   - "foo/bar" when canonical is below root
    //   - "../something" when canonical is above or sideways
    //   - an absolute path on a different drive (Windows only)
    // We accept only the "" / "foo/bar" cases.
    if (
      rel === "" ||
      (!rel.startsWith("..") && !isAbsolute(rel) && !rel.startsWith(`..${sep}`))
    ) {
      return true;
    }
  }
  return false;
}
