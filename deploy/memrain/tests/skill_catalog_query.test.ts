import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSkillCatalog } from "../src/core/skillpack/brain-resident.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import type { Storage } from "../src/core/storage.ts";

describe("queried skill catalog", () => {
  let skillsDir: string;
  beforeAll(() => {
    skillsDir = mkdtempSync(join(tmpdir(), "memrain-skill-query-"));
    for (const [slug, description, triggers] of [
      ["notes", "Direct route", "[]"], ["a-write", "notes writing", "[]"],
      ["b-write", "Direct route", "[notes writing]"], ["c-write", "writing", "[]"],
      ["d-write", "writing", "[]"], ["e-write", "writing", "[]"], ["f-write", "writing", "[]"],
    ]) writeFileSync(join(skillsDir, `${slug}.md`), `---\ndescription: ${description}\ntriggers: ${triggers}\ntools: [search, page_put]\n---\n`);
  });
  afterAll(() => rmSync(skillsDir, { recursive: true, force: true }));

  it("puts exact slug first, then token overlap, then catalog order", () => {
    expect(listSkillCatalog({ skillsDir, query: "NOTES" }).skills.map(s => s.slug)).toEqual(["notes", "a-write", "b-write"]);
    expect(listSkillCatalog({ skillsDir, query: "notes writing", limit: 3 }).skills.map(s => s.slug)).toEqual(["a-write", "b-write", "c-write"]);
    expect(listSkillCatalog({ skillsDir, query: "missing" }).skills).toEqual([]);
  });

  it("defaults to five matches and preserves permission projection and no-query ordering", () => {
    const result = listSkillCatalog({ skillsDir, query: "writing", callable: t => t === "search" });
    expect(result.count).toBe(5);
    expect(result.skills.every(s => s.usable_tools.join() === "search" && s.unavailable_tools.join() === "page_put")).toBe(true);
    const all = listSkillCatalog({ skillsDir });
    expect(all.count).toBe(7);
    expect(listSkillCatalog({ skillsDir, limit: 2 }).skills).toEqual(all.skills.slice(0, 2));
  });

  it("accepts query and limit at MCP and refuses overlong queries and out-of-range limits", async () => {
    const ok = await dispatchTool({} as Storage, { name: "list_skills", arguments: { query: "brain-ops", limit: 1 } });
    expect(ok.isError).toBeFalsy();
    expect(JSON.parse(ok.content[0]!.text).skills.map((s: { slug: string }) => s.slug)).toEqual(["brain-ops"]);
    for (const args of [{ query: "x".repeat(201) }, { limit: 51 }, { limit: -1 }]) {
      const error = await dispatchTool({} as Storage, { name: "list_skills", arguments: args });
      expect(error.isError).toBe(true);
      expect(JSON.parse(error.content[0]!.text).error).toBe("invalid_params");
    }
  });
});
