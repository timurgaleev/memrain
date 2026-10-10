/**
 * The skill catalog an agent routes from: triggers, tools and mutating are
 * served, and each skill's tools are split into what THIS caller can call
 * and what it cannot — by the same predicate tools/list uses.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AuthInfo } from "../src/core/auth-info.ts";
import {
  getBrainSkill,
  getSkillDetail,
  listBrainSkillpacks,
  listSkillCatalog,
} from "../src/core/skillpack/brain-resident.ts";
import { visibleToolDefs } from "../src/mcp/visibility.ts";

const PACK_DIR = resolve(import.meta.dir, "..", "..", "skills");
let dir: string;

function readToken(): (name: string) => boolean {
  const auth: AuthInfo = { token: "t", clientId: "c", scopes: ["read"], sourceId: "s", isPublic: false };
  const names = new Set(visibleToolDefs({ isPublic: false, authInfo: auth }, () => false).map((t) => t.name));
  return (name) => names.has(name);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "memrain-catalog-"));
  mkdirSync(join(dir, "writer"));
  writeFileSync(
    join(dir, "writer", "SKILL.md"),
    "---\nname: writer\ndescription: Files notes.\ntriggers:\n  - \"file this note\"\ntools: [search, page_put, not_on_this_server]\nmutating: true\nwrites_to: [notes/]\n---\n# writer\n",
  );
  writeFileSync(join(dir, "bare.md"), "# bare\nno frontmatter\n");
  writeFileSync(join(dir, "_rules.md"), "shared rules\n");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("listSkillCatalog", () => {
  it("serves the routing contract with the catalog envelope", () => {
    const c = listSkillCatalog({ skillsDir: dir });
    expect(c.schema_version).toBe(1);
    expect(c.pack).toBe("memrain-skillpack");
    expect(c.count).toBe(2);
    expect(c.instructions.fetch_op).toBe("get_skill");
    expect(c.instructions.how_to_use.length).toBeGreaterThan(0);
    expect(c.skills).toEqual([
      {
        slug: "bare",
        description: "(no description)",
        triggers: [],
        tools: [],
        usable_tools: [],
        unavailable_tools: [],
        mutating: false,
        requires: [],
        writes_to: [],
      },
      {
        slug: "writer",
        description: "Files notes.",
        triggers: ["file this note"],
        tools: ["search", "page_put", "not_on_this_server"],
        usable_tools: ["search", "page_put"],
        unavailable_tools: ["not_on_this_server"],
        mutating: true,
        requires: [],
        writes_to: ["notes/"],
      },
    ]);
  });

  it("marks every tool unavailable when the caller can call nothing", () => {
    const writer = listSkillCatalog({ skillsDir: dir, callable: () => false }).skills.find((s) => s.slug === "writer")!;
    expect(writer.usable_tools).toEqual([]);
    expect(writer.unavailable_tools).toEqual(["search", "page_put", "not_on_this_server"]);
  });

  it("splits by the caller's grant: a read token cannot use page_put", () => {
    const writer = listSkillCatalog({ skillsDir: dir, callable: readToken() }).skills.find((s) => s.slug === "writer")!;
    expect(writer.usable_tools).toEqual(["search"]);
    expect(writer.unavailable_tools).toEqual(["page_put", "not_on_this_server"]);
  });

  it("lists the same skills as the old listing, which keeps its shape", () => {
    const old = listBrainSkillpacks({ skillsDir: PACK_DIR });
    const catalog = listSkillCatalog({ skillsDir: PACK_DIR });
    expect(catalog.skills.map((s) => [s.slug, s.description])).toEqual(old.skills.map((s) => [s.slug, s.description]));
    expect(Object.keys(old).sort()).toEqual(["count", "pack", "skills"]);
    expect(Object.keys(old.skills[0]!).sort()).toEqual(["description", "slug"]);
    // The shipped pack declares tools for every skill and they all exist.
    for (const s of catalog.skills) expect(s.unavailable_tools).toEqual([]);
    expect(catalog.skills.every((s) => s.triggers.length > 0)).toBe(true);
  });

  it("is empty, not an error, for a missing dir", () => {
    const c = listSkillCatalog({ skillsDir: join(dir, "nope") });
    expect(c.count).toBe(0);
    expect(c.skills).toEqual([]);
  });
});

describe("getSkillDetail", () => {
  it("projects the frontmatter and splits tools for the caller", () => {
    const d = getSkillDetail("writer", { skillsDir: dir, callable: readToken() })!;
    expect(d.slug).toBe("writer");
    expect(d.body).toContain("# writer");
    expect(d.frontmatter).toEqual({
      name: "writer",
      description: "Files notes.",
      triggers: ["file this note"],
      tools: ["search", "page_put", "not_on_this_server"],
      mutating: true,
      requires: [],
      writes_to: ["notes/"],
    });
    expect(d.usable_tools).toEqual(["search"]);
    expect(d.unavailable_tools).toEqual(["page_put", "not_on_this_server"]);
  });

  it("serves shared docs without frontmatter and refuses escaping slugs", () => {
    const rules = getSkillDetail("_rules", { skillsDir: dir })!;
    expect(rules.frontmatter).toBeNull();
    expect(rules.body).toBe("shared rules\n");
    expect(getSkillDetail("../etc/passwd", { skillsDir: dir })).toBeNull();
    expect(getSkillDetail("missing", { skillsDir: dir })).toBeNull();
  });

  it("returns the same body and description as getBrainSkill", () => {
    const old = getBrainSkill("writer", { skillsDir: dir })!;
    const d = getSkillDetail("writer", { skillsDir: dir })!;
    expect({ slug: d.slug, description: d.description, body: d.body }).toEqual(old);
  });
});
