/**
 * Filesystem walker — recursively yields files matching the given
 * extensions, skipping directories whose name appears in `ignore`.
 *
 * Extracted from sweep.ts so the markdown sweep and the code sweep
 * (sweep-code.ts) share one walk implementation. The walk is
 * intentionally synchronous (readdirSync) — vault sizes are O(thousands)
 * and code repos are O(thousands at most), not O(millions); async
 * iteration here just adds overhead given that downstream work
 * (embed roundtrips, tree-sitter parses, DB writes) dominates wall time.
 */
import { readdirSync, realpathSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";

export interface WalkedFile {
  /** Absolute path. */
  path: string;
  /** mtime in ms since epoch (floor of fs.Stats.mtimeMs). */
  mtimeMs: number;
}

export interface WalkOptions {
  /** Extensions to keep (with dot, lowercased — `.ts`, `.md`). */
  extensions: readonly string[];
  /** Directory basenames to skip. */
  ignore: ReadonlySet<string>;
  /**
   * Called for every directory or file the walk could not read. The walk still
   * skips it; a caller that acts on what the walk did NOT see (the code prune)
   * needs to know the walk was incomplete.
   */
  onError?: (path: string, err: unknown) => void;
}

/**
 * Recursively yield every file under `root` whose extension is in
 * `extensions` (case-insensitive). Directory entries whose basename
 * is in `ignore` are pruned without descending into them.
 *
 * Unreadable directories are silently skipped (typical cause: permission
 * denied on a stray symlink). Unreadable files inside an otherwise
 * readable directory are also skipped — we'd rather index 99 % of a
 * vault than abort on one fluke.
 */
export function* walkFiles(
  root: string,
  opts: WalkOptions,
): Generator<WalkedFile> {
  const exts = new Set(opts.extensions.map((e) => e.toLowerCase()));
  // `seen` tracks the canonical (realpath) of every directory we've
  // entered, so a symlink that points back into the tree (e.g.
  // vault/loop → vault/) doesn't trigger infinite recursion. The
  // closure shares this set across the recursive invocations below.
  const seen = new Set<string>();
  yield* walkInner(root, opts, exts, seen);
}

function* walkInner(
  root: string,
  opts: WalkOptions,
  exts: Set<string>,
  seen: Set<string>,
): Generator<WalkedFile> {
  let canonical: string;
  try {
    canonical = realpathSync(root);
  } catch (err) {
    opts.onError?.(root, err);
    return;
  }
  if (seen.has(canonical)) return;
  seen.add(canonical);

  let entries: Dirent[];
  try {
    // Bun's readdirSync overload returns Dirent<Buffer> by default; force the
    // string-name variant we want via the `encoding: "utf8"` option (no-op at
    // runtime, but keeps the type narrow for the `ent.name` string ops below).
    entries = readdirSync(root, { withFileTypes: true, encoding: "utf8" }) as Dirent[];
  } catch (err) {
    opts.onError?.(root, err);
    return;
  }
  // readdir order is the filesystem's (sorted on APFS, hash order on ext4), so
  // a walk cut short by a budget would stop at a different file per platform.
  // Name order makes the walk, and where a capped sweep resumes, the same.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const ent of entries) {
    const name = String(ent.name);
    if (opts.ignore.has(name)) continue;
    const full = join(root, name);
    if (ent.isDirectory()) {
      yield* walkInner(full, opts, exts, seen);
    } else if (ent.isFile()) {
      const dot = name.lastIndexOf(".");
      if (dot < 0) continue;
      const ext = name.slice(dot).toLowerCase();
      if (!exts.has(ext)) continue;
      try {
        const st = statSync(full);
        yield { path: full, mtimeMs: Math.floor(st.mtimeMs) };
      } catch (err) {
        opts.onError?.(full, err);
      }
    }
  }
}
