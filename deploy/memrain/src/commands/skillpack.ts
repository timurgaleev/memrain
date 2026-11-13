/**
 * `memrain skillpack [--out PATH]` — bundle a `deploy/skills/`
 * directory as a tar.gz so it can be shared / installed by a
 * downstream agent that consumes skill packs.
 *
 * Looks at deploy/skills/ in the repo (resolved relative to the
 * memrain package). Writes a tarball with an embedded manifest.json
 * naming each skill + a sha256 of its contents (so the receiver can
 * verify). Every file under the directory is packed: both skill
 * layouts (flat `<slug>.md` and `<slug>/SKILL.md` with its siblings),
 * the underscore shared-rules files and `conventions/`. `skillpack
 * lint` checks the same directory separately.
 *
 * Implementation uses Bun's child_process spawn of `tar` so we don't
 * pull a tar npm dep; tar is in alpine + AL2023 base image, container
 * has it, dev hosts virtually always have it.
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lintSkillpack } from "../core/skillpack/lint.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SKILLS_DIR = resolve(__dirname, "..", "..", "..", "skills");

export interface SkillpackOptions {
  /** Override the source skills directory. Default `deploy/skills`. */
  skillsDir?: string;
  /** Output tarball path. Default `./skillpack-<timestamp>.tar.gz`. */
  out?: string;
}

interface ManifestEntry {
  name: string;
  sha256: string;
  size: number;
}

export async function runSkillpack(opts: SkillpackOptions = {}): Promise<void> {
  const skillsDir = opts.skillsDir ?? DEFAULT_SKILLS_DIR;
  if (!existsSync(skillsDir)) {
    throw new Error(`skillpack: skills directory not found at ${skillsDir}`);
  }
  const outPath =
    opts.out ?? `./skillpack-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz`;

  // Collect pack files across both layouts: flat <slug>.md, directory
  // <slug>/SKILL.md (+ siblings), the underscore shared-rules layer, and
  // conventions/. Paths in the manifest/tarball are skillsDir-relative.
  const files: string[] = [];
  const collect = (rel: string): void => {
    for (const name of readdirSync(join(skillsDir, rel), { withFileTypes: true })) {
      if (name.name.startsWith(".")) continue;
      const relPath = rel ? `${rel}/${name.name}` : name.name;
      if (name.isDirectory()) {
        collect(relPath);
      } else {
        files.push(relPath);
      }
    }
  };
  collect("");
  files.sort();
  if (files.length === 0) {
    throw new Error(`skillpack: no files in ${skillsDir}`);
  }

  // Build the manifest.
  const entries: ManifestEntry[] = [];
  for (const f of files) {
    const buf = readFileSync(join(skillsDir, f));
    entries.push({
      name: f,
      sha256: createHash("sha256").update(buf).digest("hex"),
      size: buf.byteLength,
    });
  }
  const manifest = {
    name: "memrain-skillpack",
    version: "0.1.0",
    generated_at: new Date().toISOString(),
    skills: entries,
  };
  const manifestPath = join(skillsDir, ".manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // Run tar with the manifest + every .md file. -C cwd so paths in the
  // archive are flat (no parent dirs leak into the bundle).
  const tar = spawnSync(
    "tar",
    [
      "-czf",
      outPath,
      "-C",
      skillsDir,
      ".manifest.json",
      ...files,
    ],
    { stdio: "inherit" },
  );
  if (tar.status !== 0) {
    throw new Error(`skillpack: tar exited ${tar.status}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        out: outPath,
        skills: entries.length,
        bytes: entries.reduce((s, e) => s + e.size, 0),
      },
      null,
      2,
    ),
  );
}

export interface SkillpackLintOptions {
  /** Pack to lint. Default MEMRAIN_SKILLS_DIR (the pack the server serves), then deploy/skills. */
  dir?: string;
  json?: boolean;
}

/**
 * `memrain skillpack lint [--json] [--dir PATH]` — check that every MCP tool and
 * `memrain` command the pack names exists. Returns the exit code: 1 on any issue.
 */
export function runSkillpackLint(opts: SkillpackLintOptions = {}): number {
  const envDir = process.env.MEMRAIN_SKILLS_DIR?.trim();
  const dir = opts.dir ?? (envDir || DEFAULT_SKILLS_DIR);
  const result = lintSkillpack(dir);
  if (opts.json) {
    console.log(JSON.stringify(result));
  } else {
    for (const i of result.issues) {
      console.log(`${i.slug}:${i.line}  ${i.rule}  ${i.detail}`);
    }
    console.log(
      result.ok
        ? `skillpack lint: ${result.skills} skills, no issues`
        : `skillpack lint: ${result.skills} skills, ${result.issues.length} issue(s)`,
    );
  }
  return result.ok ? 0 : 1;
}
