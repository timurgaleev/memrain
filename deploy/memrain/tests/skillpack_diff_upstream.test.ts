/**
 * scripts/skillpack-diff-upstream.ts: the maintainer's drift report between
 * this pack and an upstream skills folder. Skills on one side only are listed;
 * for a skill on both sides it names the triggers, tools and steps upstream
 * added or removed, and leaves out a skill that did not change.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffSkillpacks, formatSkillpackDiff, skillsDirOf } from "../scripts/skillpack-diff-upstream.ts";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function pack(skills: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "diff-upstream-"));
  roots.push(root);
  for (const [slug, text] of Object.entries(skills)) {
    mkdirSync(join(root, slug), { recursive: true });
    writeFileSync(join(root, slug, "SKILL.md"), text);
  }
  return root;
}

const skill = (name: string, triggers: string[], tools: string[], body: string) =>
  `---\nname: ${name}\ndescription: ${name}\ntriggers:\n${triggers.map((t) => `  - "${t}"`).join("\n")}\ntools:\n${tools.map((t) => `  - ${t}`).join("\n")}\n---\n\n${body}`;

describe("skillpack diff-upstream", () => {
  it("lists one-sided skills and names what upstream added and removed in a shared one", () => {
    const local = pack({
      query: skill("query", ["look up", "who is"], ["search", "page_get"], "## Phases\n\n1. **Search** the brain\n2. Read the page\n"),
      same: skill("same", ["same"], ["search"], "1. Do it\n"),
      ours: skill("ours", ["ours"], ["search"], ""),
    });
    const upstream = pack({
      query: skill("query", ["look up", "background on"], ["search", "get_page"], "## Phases\n\n1. Search the brain\n2. Cite every claim\n   1. nested detail\n"),
      same: skill("same", ["same"], ["search"], "1. Do it\n"),
      theirs: skill("theirs", ["theirs"], ["search"], ""),
    });

    const diff = diffSkillpacks(local, upstream);
    expect(diff.onlyLocal).toEqual(["ours"]);
    expect(diff.onlyUpstream).toEqual(["theirs"]);
    expect(diff.changed).toEqual([{
      slug: "query",
      triggers: { added: ["background on"], removed: ["who is"] },
      tools: { added: ["get_page"], removed: ["page_get"] },
      steps: { added: ["Cite every claim"], removed: ["Read the page"] },
    }]);

    const text = formatSkillpackDiff(diff);
    expect(text).toContain("only here: ours");
    expect(text).toContain("only upstream: theirs");
    expect(text).toContain("query\n  triggers: + background on; - who is");
    expect(text).toContain("  steps: + Cite every claim; - Read the page");
    expect(text).not.toContain("same");
  });

  it("reads a skill without frontmatter as steps only", () => {
    const local = pack({ plain: skill("plain", ["x"], ["search"], "1. Old step\n") });
    const upstream = pack({ plain: "# Plain\n\n1. New step\n" });
    expect(diffSkillpacks(local, upstream).changed).toEqual([{
      slug: "plain",
      triggers: { added: [], removed: ["x"] },
      tools: { added: [], removed: ["search"] },
      steps: { added: ["New step"], removed: ["Old step"] },
    }]);
  });

  it("reads an upstream repository root through its skills folder", () => {
    const root = pack({});
    mkdirSync(join(root, "skills"));
    expect(skillsDirOf(root)).toBe(join(root, "skills"));
    expect(skillsDirOf(join(root, "skills"))).toBe(join(root, "skills"));
  });
});
