import { afterEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBrainSkill, listSkillCatalog, listBrainSkillpacks } from "../src/core/skillpack/brain-resident.ts";
import { lintSkillpack } from "../src/core/skillpack/lint.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const fixture = () => { const dir = mkdtempSync(join(tmpdir(), "skill-bounds-")); dirs.push(dir); return dir; };
const skill = "---\nname: safe\ndescription: safe skill\ntriggers: [safe]\ntools: [page_get]\nmutating: false\n---\n";

it("refuses symlinks escaping the pack in direct reads, discovery and lint", () => {
  const dir = fixture();
  const outside = fixture();
  writeFileSync(join(outside, "secret.md"), skill.replace("safe skill", "private secret"));
  symlinkSync(join(outside, "secret.md"), join(dir, "escape.md"));
  symlinkSync(outside, join(dir, "conventions"));
  expect(getBrainSkill("escape", { skillsDir: dir })).toBeNull();
  expect(getBrainSkill("conventions/secret", { skillsDir: dir })).toBeNull();
  expect(listSkillCatalog({ skillsDir: dir }).skills).toEqual([]);
  expect(listBrainSkillpacks({ skillsDir: dir }).skills).toEqual([]);
  const lint = lintSkillpack(dir);
  expect(lint.ok).toBe(false);
  expect(lint.issues.some(i => i.rule === "unreadable")).toBe(true);
  expect(JSON.stringify(lint)).not.toContain("private secret");
});

it("bounds UTF-8 bytes, rejects directories, and permits links within a symlinked root", () => {
  const dir = fixture();
  writeFileSync(join(dir, "safe.md"), skill);
  writeFileSync(join(dir, "large.md"), skill + "я".repeat(131072));
  mkdirSync(join(dir, "directory.md"));
  symlinkSync(join(dir, "safe.md"), join(dir, "inside.md"));
  const parent = fixture();
  symlinkSync(dir, join(parent, "pack"));
  const opts = { skillsDir: join(parent, "pack") };
  expect(getBrainSkill("large", opts) === null).toBe(true);
  expect(getBrainSkill("directory", opts)).toBeNull();
  expect(getBrainSkill("inside", opts)?.body).toBe(skill);
  expect(listSkillCatalog(opts).skills.map(s => s.slug)).toEqual(["inside", "safe"]);
  expect(lintSkillpack(opts.skillsDir).issues.filter(i => i.rule === "unreadable").map(i => i.slug).sort()).toEqual(["directory", "large"]);
});
