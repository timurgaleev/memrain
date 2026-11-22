/**
 * `memrain skillpack check`: the pack as a routing tree. Every skill is in the
 * resolver and owns a route, no trigger has two owners, the routing-eval cases
 * land where they say, and skills point at shared rules instead of copying
 * them; `--fix` rewrites only the copies that are safe to rewrite.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkSkillTree } from "../src/core/skillpack/tree-check.ts";
import { findDryIssues, loadSharedDocs, normalizeProse } from "../src/core/skillpack/dry-check.ts";

const MEMRAIN_DIR = resolve(import.meta.dir, "..");
const PACK_DIR = resolve(MEMRAIN_DIR, "..", "skills");

const QUALITY = [
  "# Quality Convention",
  "",
  "## Back-Linking (MANDATORY)",
  "",
  "Every mention of a person or company WITH a brain page MUST create a back-link",
  "FROM that entity's page TO the page mentioning them. An unlinked mention is a broken brain.",
  "",
  "## Notability Gate",
  "",
  "When in doubt, do not create a page for someone who is not notable at all.",
  "",
].join("\n");

const COPY = "Every mention of a person or company with a brain page MUST create a back-link\nFROM that entity's page TO the page mentioning them. An unlinked mention is a\nbroken brain.";

function skill(name: string, triggers: string[], body = "Body."): string {
  const list = triggers.map((t) => `  - "${t}"`).join("\n");
  return `---\nname: ${name}\ndescription: d\ntriggers:\n${list}\ntools: [page_get]\n---\n\n# ${name}\n\n${body}\n`;
}

function resolver(slugs: string[]): string {
  const rows = slugs.map((s) => `| \`${s}\` | d | "t" | no | brain |`).join("\n");
  return `# Skill Resolver\n\n<!-- BEGIN GENERATED: skill table, from frontmatter by scripts/generate-plugin-tree.ts -->\n\n| Skill | Use it for | Triggers | Writes | Ships in |\n|---|---|---|---|---|\n${rows}\n\n| Slug | Rule |\n|---|---|\n| \`conventions/quality\` | Quality |\n\n<!-- END GENERATED: skill table -->\n`;
}

let root: string;

function writePack(dir: string, files: Record<string, string>): string {
  const packDir = join(root, dir);
  for (const [rel, text] of Object.entries(files)) {
    const file = join(packDir, rel);
    mkdirSync(resolve(file, ".."), { recursive: true });
    writeFileSync(file, text);
  }
  return packDir;
}

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

function commitAll(dir: string): void {
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "pack");
}

const THREE = (p: string): string[] => [`${p} one`, `${p} two`, `${p} three`];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "skill-tree-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("checkSkillTree", () => {
  it("passes a pack where every skill is listed, reachable and distinct", () => {
    const dir = writePack("clean", {
      "_resolver.md": resolver(["alpha", "beta"]),
      "alpha/SKILL.md": skill("alpha", THREE("alpha")),
      "beta/SKILL.md": skill("beta", THREE("beta")),
    });
    const r = checkSkillTree(dir);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.summary).toEqual({
      reachable: 2,
      unreachable: 0,
      overlaps: 0,
      gaps: 0,
      routing: { total: 0, correct: 0, accuracy: 0 },
    });
  });

  it("reports a missing resolver, an unlisted skill and a row for no skill", () => {
    const none = writePack("no-resolver", { "alpha/SKILL.md": skill("alpha", THREE("alpha")) });
    expect(checkSkillTree(none).errors.map((i) => i.rule)).toEqual(["missing-resolver"]);

    const drift = writePack("resolver-drift", {
      "_resolver.md": resolver(["alpha", "ghost"]),
      "alpha/SKILL.md": skill("alpha", THREE("alpha")),
      "beta/SKILL.md": skill("beta", THREE("beta")),
    });
    const r = checkSkillTree(drift);
    expect(r.ok).toBe(false);
    expect(r.errors.map((i) => `${i.rule} ${i.slug}`)).toEqual(["not-in-resolver beta", "resolver-orphan ghost"]);
  });

  it("calls a skill unreachable when no trigger of its own routes to it alone", () => {
    const dir = writePack("unreachable", {
      "_resolver.md": resolver(["alpha", "beta", "gamma"]),
      "alpha/SKILL.md": skill("alpha", ["shared phrase", "alpha two", "alpha three"]),
      "beta/SKILL.md": skill("beta", ["Shared-Phrase!"]),
      "gamma/SKILL.md": "---\nname: gamma\ndescription: d\ntools: [page_get]\n---\nBody.\n",
    });
    const r = checkSkillTree(dir);
    expect(r.errors.map((i) => `${i.rule} ${i.slug}`)).toEqual([
      "mece-overlap alpha, beta",
      "unreachable beta",
      "unreachable gamma",
    ]);
    expect(r.warnings.map((i) => `${i.rule} ${i.slug}`)).toEqual(["mece-gap beta", "mece-gap gamma"]);
    expect(r.summary).toMatchObject({ reachable: 1, unreachable: 2, overlaps: 1, gaps: 2 });
  });

  it("turns routing-eval failures and bad fixtures into warnings, and --strict fails on them", () => {
    const dir = writePack("routing", {
      "_resolver.md": resolver(["alpha", "beta"]),
      "alpha/SKILL.md": skill("alpha", THREE("alpha")),
      "beta/SKILL.md": skill("beta", THREE("beta")),
      "alpha/routing-eval.jsonl": [
        JSON.stringify({ intent: "please alpha one now", expected_skill: "alpha" }),
        JSON.stringify({ intent: "nothing covers this", expected_skill: "alpha" }),
        JSON.stringify({ intent: "beta two please", expected_skill: "alpha" }),
        JSON.stringify({ intent: "alpha three", expected_skill: null }),
        JSON.stringify({ intent: "alpha one", expected_skill: "alpha", ambiguous_with: ["ghost"] }),
        "not json",
      ].join("\n"),
    });
    const r = checkSkillTree(dir);
    expect(r.ok).toBe(true);
    // Cases come back in the benchmark's split order, so compare as a set.
    expect(r.warnings.map((i) => i.rule).sort()).toEqual([
      "routing-false-positive",
      "routing-fixture",
      "routing-fixture",
      "routing-miss",
      "routing-wrong",
    ]);
    expect(r.summary.routing).toMatchObject({ total: 5, correct: 2 });
    expect(checkSkillTree(dir, { strict: true }).ok).toBe(false);
  });

  it("passes on the shipped pack, routing every case", () => {
    const r = checkSkillTree(PACK_DIR);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.summary.unreachable).toBe(0);
    expect(r.summary.routing.correct).toBe(r.summary.routing.total);
    // What is left is advisory: the always-on and deprecated skills carry one
    // trigger on purpose.
    expect(r.warnings.map((i) => `${i.rule} ${i.slug}`)).toEqual([
      "mece-gap brain-ops",
      "mece-gap install",
      "mece-gap signal-detector",
    ]);
  });
});

describe("shared rules copied into skills", () => {
  it("finds a copy, ignoring pointer sentences, markdown and fenced examples", () => {
    const dir = writePack("dry-find", { "conventions/quality.md": QUALITY });
    const docs = loadSharedDocs(dir, ["conventions/quality.md"]);
    const text = [
      "---", "name: x", "---", "",
      "## Rules", "",
      `${COPY} See \`conventions/quality.md\` for format.`, "",
      "```", COPY.replace(/\n/g, " "), "```", "",
      "> **Convention:** see conventions/quality.md for back-links. Every mention of a person or company with a brain page MUST create a back-link.",
      "",
      "Every mention of a person matters to someone.",
    ].join("\n");
    const found = findDryIssues(text, docs);
    expect(found.map((f) => `${f.kind} ${f.line} ${f.doc} ${f.label}`)).toEqual([
      "copy 7 conventions/quality Back-Linking",
    ]);
    expect(normalizeProse("**MUST** `create` a back-link!")).toBe("must create a back link");
  });

  it("flags a named rule with no pointer nearby, and not one with a pointer", () => {
    const docs = loadSharedDocs(writePack("dry-named", { "conventions/quality.md": QUALITY }), ["conventions/quality.md"]);
    const far = ["---", "name: x", "---", "", "Check the notability gate first.", ...Array.from({ length: 50 }, () => "filler"), "See `conventions/quality.md`."].join("\n");
    expect(findDryIssues(far, docs).map((f) => `${f.kind} ${f.line} ${f.label}`)).toEqual([
      "named-rule 5 the notability gate",
    ]);
    const near = ["---", "name: x", "---", "", "Check the notability gate first (`get_skill conventions/quality`)."].join("\n");
    expect(findDryIssues(near, docs)).toEqual([]);
  });

  it("reports copies as warnings in the tree check", () => {
    const dir = writePack("dry-tree", {
      "_resolver.md": resolver(["alpha"]),
      "conventions/quality.md": QUALITY,
      "alpha/SKILL.md": skill("alpha", THREE("alpha"), `## Back-links\n\n${COPY}`),
    });
    const r = checkSkillTree(dir);
    expect(r.ok).toBe(true);
    expect(r.warnings.map((i) => `${i.rule} ${i.slug}:${i.line}`)).toEqual(["dry-copy alpha:15"]);
    expect(r.fixes).toEqual([]);
  });
});

describe("skillpack check --fix", () => {
  function pack(name: string, alphaBody: string): string {
    return writePack(name, {
      "_resolver.md": resolver(["alpha"]),
      "conventions/quality.md": QUALITY,
      "alpha/SKILL.md": skill("alpha", THREE("alpha"), alphaBody),
    });
  }

  it("replaces a committed, unmodified copy with a pointer, and leaves the rest alone", () => {
    const dir = pack("fix-apply", `## Back-links\n\n${COPY}\n\n## Next\n\nKeep me.`);
    commitAll(dir);
    const r = checkSkillTree(dir, { fix: true });
    expect(r.fixes.map((f) => `${f.status} ${f.line}`)).toEqual(["applied 15"]);
    const text = readFileSync(join(dir, "alpha", "SKILL.md"), "utf8");
    expect(text).toContain("## Back-links\n\n> **Convention:** see `conventions/quality.md` (via `get_skill conventions/quality`) for Back-Linking.\n\n## Next\n\nKeep me.\n");
    expect(text).not.toContain("An unlinked mention");
    // Idempotent: nothing left to fix.
    expect(checkSkillTree(dir, { fix: true }).fixes).toEqual([]);
  });

  it("never runs the checked repository's fsmonitor hook", () => {
    const dir = pack("fix-fsmonitor", `## Back-links\n\n${COPY}`);
    commitAll(dir);
    const marker = join(root, "fsmonitor-ran");
    const hook = join(root, "fsmonitor-hook.sh");
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    git(dir, "config", "core.fsmonitor", hook);
    expect(checkSkillTree(dir, { fix: true }).fixes.map((f) => f.status)).toEqual(["applied"]);
    expect(existsSync(marker)).toBe(false);
  });

  it("drops a copy that sits right under a pointer to the same doc", () => {
    const dir = pack("fix-under-pointer", `> **Convention:** see \`conventions/quality.md\` for back-links.\n\n${COPY}\n\n## Next`);
    commitAll(dir);
    const r = checkSkillTree(dir, { fix: true });
    expect(r.fixes.map((f) => f.status)).toEqual(["applied"]);
    expect(readFileSync(join(dir, "alpha", "SKILL.md"), "utf8")).toContain("for back-links.\n\n## Next\n");
  });

  it("refuses a modified file, an untracked file, a symlinked file, two copies and a list item", () => {
    const modified = pack("fix-modified", `${COPY}\n`);
    commitAll(modified);
    writeFileSync(join(modified, "alpha", "SKILL.md"), `${readFileSync(join(modified, "alpha", "SKILL.md"), "utf8")}\nlocal edit\n`);
    expect(checkSkillTree(modified, { fix: true }).fixes.map((f) => f.reason)).toEqual(["modified"]);

    const untracked = pack("fix-untracked", `${COPY}\n`);
    commitAll(untracked);
    writePack("fix-untracked", { "beta/SKILL.md": skill("beta", THREE("beta"), COPY), "_resolver.md": resolver(["alpha", "beta"]) });
    git(untracked, "add", "_resolver.md");
    git(untracked, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "r");
    const u = checkSkillTree(untracked, { fix: true }).fixes;
    expect(u.map((f) => `${f.slug} ${f.status} ${f.reason ?? ""}`)).toEqual(["alpha applied ", "beta skipped untracked"]);

    const linked = writePack("fix-symlink", {
      "_resolver.md": resolver(["alpha"]),
      "conventions/quality.md": QUALITY,
      "real/alpha.md": skill("alpha", THREE("alpha"), COPY),
    });
    mkdirSync(join(linked, "alpha"));
    symlinkSync(join(linked, "real", "alpha.md"), join(linked, "alpha", "SKILL.md"));
    commitAll(linked);
    expect(checkSkillTree(linked, { fix: true }).fixes.map((f) => f.reason)).toEqual(["symlink"]);

    const twice = pack("fix-twice", `${COPY}\n\n## Again\n\n${COPY}`);
    commitAll(twice);
    expect(checkSkillTree(twice, { fix: true }).fixes.map((f) => f.reason)).toEqual([
      "several copies of one doc; edit by hand",
      "several copies of one doc; edit by hand",
    ]);

    // A pointer sentence that only says where to look may go with the copy;
    // one that adds an exception may not.
    const bare = pack("fix-bare-pointer", `${COPY} See \`conventions/quality.md\` for format.`);
    commitAll(bare);
    expect(checkSkillTree(bare, { fix: true }).fixes.map((f) => f.status)).toEqual(["applied"]);
    const more = pack("fix-says-more", `${COPY} See \`conventions/quality.md\`, except for drafts.`);
    commitAll(more);
    expect(checkSkillTree(more, { fix: true }).fixes.map((f) => f.reason)).toEqual([
      "the block says more than the copy; edit by hand",
    ]);
    expect(readFileSync(join(more, "alpha", "SKILL.md"), "utf8")).toContain("except for drafts");

    const listed = pack("fix-list", `- ${COPY.replace(/\n/g, "\n  ")}\n- another item`);
    commitAll(listed);
    expect(checkSkillTree(listed, { fix: true }).fixes.map((f) => f.reason)).toEqual(["list item; edit by hand"]);
    expect(readFileSync(join(listed, "alpha", "SKILL.md"), "utf8")).toContain("- another item");
  });
});

describe("memrain skillpack check (CLI)", () => {
  function run(...args: string[]): { status: number | null; stdout: string; stderr: string } {
    const r = spawnSync("bun", ["run", "src/cli.ts", "skillpack", ...args], { cwd: MEMRAIN_DIR, encoding: "utf8" });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  it("exits 1 with parseable JSON on a broken tree and 0 on a clean one", () => {
    const bad = writePack("cli-bad", { "_resolver.md": resolver([]), "alpha/SKILL.md": skill("alpha", THREE("alpha")) });
    const clean = writePack("cli-clean", { "_resolver.md": resolver(["alpha"]), "alpha/SKILL.md": skill("alpha", THREE("alpha")) });
    const failing = run("check", "--dir", bad, "--json");
    expect(failing.status).toBe(1);
    const parsed = JSON.parse(failing.stdout) as { ok: boolean; errors: { rule: string }[] };
    expect(parsed.ok).toBe(false);
    expect(parsed.errors.map((e) => e.rule)).toEqual(["not-in-resolver"]);
    const passing = run("check", "--dir", clean);
    expect(passing.status).toBe(0);
    expect(passing.stdout).toContain("0 error(s), 0 warning(s)");
  }, 60_000);

  it("refuses --fix and --strict outside check", () => {
    const clean = writePack("cli-refuse", { "_resolver.md": resolver(["alpha"]), "alpha/SKILL.md": skill("alpha", THREE("alpha")) });
    const lint = run("lint", "--dir", clean, "--fix");
    expect(lint.status).toBe(1);
    expect(lint.stderr).toContain("only read by 'skillpack check'");
    expect(run("lint", "--dir", clean, "--strict").status).toBe(1);
    expect(run("--strict").status).toBe(1);
    // ...and check itself takes both.
    expect(run("check", "--dir", clean, "--strict", "--fix").status).toBe(0);
  }, 60_000);
});
