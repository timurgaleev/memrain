/**
 * Tests for the skillify pipeline. The Bedrock client is stubbed so
 * the test runs offline and is deterministic.
 *
 * Coverage:
 *   - slugify: basic + edge cases
 *   - lintAndShape: clean draft, missing frontmatter, drifted fields,
 *     short body, oversized description, legacy tags, unknown tools
 *   - skillify(): wires the stub through draftSkill → lintAndShape
 */
import { describe, expect, it } from "bun:test";
import {
  slugify,
  lintAndShape,
  skillify,
  validateSkill,
} from "../src/core/skillify.ts";

function stubClient(text: string) {
  return {
    send: async () => ({
      output: { message: { content: [{ text }] } },
    }),
  } as unknown as import("@aws-sdk/client-bedrock-runtime").BedrockRuntimeClient;
}

describe("slugify", () => {
  it("converts a sentence to kebab-case", () => {
    expect(slugify("Skill that summarises my last 5 workouts")).toBe(
      "skill-that-summarises-my-last-5-workouts",
    );
  });

  it("strips punctuation and trailing dashes", () => {
    expect(slugify("Find !!! all   broken — links!")).toBe(
      "find-all-broken-links",
    );
  });

  it("falls back to 'skill' on empty input", () => {
    expect(slugify("")).toBe("skill");
    expect(slugify("!!!")).toBe("skill");
  });

  it("caps at 60 chars", () => {
    const out = slugify("a".repeat(200));
    expect(out.length).toBeLessThanOrEqual(60);
  });
});

describe("lintAndShape", () => {
  const cleanDraft = `---
name: clean-skill
description: Use this when X happens — runs the canonical pipeline.
triggers:
  - "run the canonical pipeline"
tools: [search]
---

# Clean Skill — Canonical Path

Body paragraph that's long enough to pass the body-too-short check.

## When to use

- A
- B
- C
`;

  it("passes a clean draft through with no issues", () => {
    const r = lintAndShape(cleanDraft, "clean-skill", "use this when X");
    expect(r.issues).toEqual([]);
    expect(r.markdown.startsWith(
      '---\nname: clean-skill\ndescription: Use this when X happens — runs the canonical pipeline.\ntriggers:\n  - "run the canonical pipeline"\ntools:\n  - search\n---\n\n# Clean Skill',
    )).toBe(true);
  });

  it("rebuilds frontmatter when missing", () => {
    const r = lintAndShape("# Body only\n\nNo frontmatter here.", "my-slug", "do thing");
    expect(r.issues).toContain("frontmatter-missing");
    expect(r.markdown.startsWith("---\nname: my-slug\n")).toBe(true);
    expect(r.markdown).toContain('triggers:\n  - "do thing"\n');
    expect(r.markdown).not.toContain("tools:");
  });

  it("corrects a drifted name or legacy title to the requested slug", () => {
    const drifted = cleanDraft.replace("clean-skill", "wrong-name");
    const r = lintAndShape(drifted, "clean-skill", "use this");
    expect(r.issues).toContain("name-mismatch-corrected");
    expect(r.markdown).toContain("name: clean-skill\n");
    const legacy = lintAndShape(cleanDraft.replace("name: clean-skill", "title: old"), "clean-skill", "u");
    expect(legacy.issues).toContain("name-mismatch-corrected");
    expect(legacy.markdown).not.toContain("title:");
  });

  it("truncates oversized descriptions", () => {
    const long =
      `---\ntitle: x\ndescription: ${"y".repeat(300)}\ntags: [a]\n---\n\n# x\n\n` +
      "long enough body to bypass the short-body branch";
    const r = lintAndShape(long, "x", "fallback");
    expect(r.issues).toContain("description-truncated");
    // Should land at the cap
    const desc = /description: (.*)/.exec(r.markdown)?.[1] ?? "";
    expect(desc.length).toBeLessThanOrEqual(160);
  });

  it("falls back to the prompt as trigger when the draft only has legacy tags", () => {
    const legacy =
      `---\ntitle: x\ndescription: d\ntags: [a, b]\n---\n\n# x\n\n` +
      "long enough body to bypass the short-body branch";
    const r = lintAndShape(legacy, "x", "recap my \"week\"");
    expect(r.issues).toContain("triggers-fallback");
    expect(r.markdown).toContain('triggers:\n  - "recap my week"\n');
    expect(r.markdown).not.toContain("tags:");
  });

  it("drops tools that are not MCP operations", () => {
    const r = lintAndShape(cleanDraft.replace("tools: [search]", "tools: [search, not_a_tool]"), "clean-skill", "u");
    expect(r.issues).toEqual(["tools-unknown-dropped"]);
    expect(r.markdown).toContain("tools:\n  - search\n---");
  });

  it("scaffolds a body when the model returns nothing useful", () => {
    const empty = `---\ntitle: x\ndescription: d\ntags: [a]\n---\n\n`;
    const r = lintAndShape(empty, "x", "summarise workouts");
    expect(r.issues).toContain("body-too-short");
    expect(r.markdown).toContain("TODO: summarise workouts");
    expect(r.markdown).toContain("## When to use");
  });
});

describe("skillify (end-to-end with stub)", () => {
  it("returns final markdown using the slugified prompt", async () => {
    const draft = `---
name: skill-that-counts-workouts
description: Use to summarise the last 5 logged workouts.
triggers:
  - "recap my workouts"
---

# Skill That Counts Workouts — Recap

Pulls the most recent five logged workouts via memex.

## When to use

- User asks about recent training
- Weekly retro

## How

\`\`\`bash
/opt/memex/bin/memex search "workout" --k 5
\`\`\`

## Edge cases

- No workouts logged: tell the user
- Search fails: log friction
`;
    const r = await skillify("skill that counts workouts", {
      client: stubClient(draft),
    });
    expect(r.slug).toBe("skill-that-counts-workouts");
    expect(r.issues).toEqual([]);
    expect(r.markdown).toContain("name: skill-that-counts-workouts\n");
    expect(r.markdown).toContain("/opt/memex/bin/memex");
  });

  it("repairs a drifted draft and reports issues", async () => {
    const drifted = `# No frontmatter at all\n\nBody body body body body body.`;
    const r = await skillify("foo bar baz", {
      client: stubClient(drifted),
    });
    expect(r.slug).toBe("foo-bar-baz");
    expect(r.issues).toContain("frontmatter-missing");
    expect(r.markdown.startsWith("---\nname: foo-bar-baz")).toBe(true);
  });

  it("drafts on the utility-tier model unless SKILLIFY_MODEL_ID overrides it", async () => {
    const saved = { utility: process.env.MEMRAIN_UTILITY_MODEL, skillify: process.env.SKILLIFY_MODEL_ID };
    const seen: string[] = [];
    const client = {
      send: async (cmd: { input: { modelId: string } }) => {
        seen.push(cmd.input.modelId);
        return { output: { message: { content: [{ text: "# Draft\n\nBody body body." }] } } };
      },
    } as unknown as import("@aws-sdk/client-bedrock-runtime").BedrockRuntimeClient;
    try {
      process.env.MEMRAIN_UTILITY_MODEL = "utility-model";
      delete process.env.SKILLIFY_MODEL_ID;
      await skillify("foo bar", { client });
      process.env.SKILLIFY_MODEL_ID = "skillify-model";
      await skillify("foo bar", { client });
    } finally {
      for (const [k, v] of [["MEMRAIN_UTILITY_MODEL", saved.utility], ["SKILLIFY_MODEL_ID", saved.skillify]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    expect(seen).toEqual(["utility-model", "skillify-model"]);
  });

  it("rejects an empty prompt", async () => {
    await expect(
      skillify("   ", { client: stubClient("anything") }),
    ).rejects.toThrow();
  });

  it("rejects an empty model response", async () => {
    await expect(
      skillify("good prompt", { client: stubClient("") }),
    ).rejects.toThrow();
  });
});

describe("validateSkill", () => {
  const goodSkill = `---
title: my-skill
description: Use to do the thing in the right circumstances.
tags: [memory, retrieval]
---

# My Skill — Canonical Path

Body paragraph that's long enough to pass the body-too-short check.

## When to use

- A
- B
`;

  it("returns ok=true with no issues for a clean skill", () => {
    const r = validateSkill(goodSkill, "my-skill");
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it("emits frontmatter-missing as an error", () => {
    const r = validateSkill("# only body, no frontmatter", "x");
    expect(r.ok).toBe(false);
    expect(r.issues[0]?.rule).toBe("frontmatter-missing");
    expect(r.issues[0]?.severity).toBe("error");
  });

  it("emits name-mismatch when slug doesn't match (legacy title)", () => {
    const r = validateSkill(goodSkill, "different-slug");
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.rule === "name-mismatch")).toBe(true);
  });

  const packSkill = `---
name: my-skill
version: 1.0.0
description: |
  Use to do the thing in the right circumstances.
triggers:
  - "do the thing"
tools:
  - search
  - page_get
mutating: false
---

# My Skill — Canonical Path

Body paragraph that's long enough to pass the body-too-short check.
`;

  it("accepts the pack contract (name / triggers / tools)", () => {
    const r = validateSkill(packSkill, "my-skill");
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it("flags a pack-shaped name mismatch", () => {
    const r = validateSkill(packSkill, "other");
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.rule)).toEqual(["name-mismatch"]);
  });

  it("warns tools-unknown on an operation that does not exist", () => {
    const r = validateSkill(packSkill.replace("  - page_get", "  - not_a_tool"), "my-skill");
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([
      {
        rule: "tools-unknown",
        severity: "warning",
        message: "tools lists 'not_a_tool', which is not an MCP operation",
      },
    ]);
  });

  it("errors when neither triggers nor legacy tags are set", () => {
    const md = packSkill.replace('triggers:\n  - "do the thing"\n', "");
    const r = validateSkill(md, "my-skill");
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.rule)).toEqual(["triggers-missing"]);
  });

  it("reads triggers and tools written at column 0", () => {
    const md = packSkill
      .replace('triggers:\n  - "do the thing"', 'triggers:\n- "do the thing"')
      .replace("tools:\n  - search\n  - page_get", "tools:\n- search\n- not_a_tool");
    const r = validateSkill(md, "my-skill");
    expect(r.issues.map((i) => i.rule)).toEqual(["tools-unknown"]);
  });

  it("emits description-too-long as a warning, ok stays true", () => {
    const md = goodSkill.replace(
      /description: .*/,
      `description: ${"x".repeat(200)}`,
    );
    const r = validateSkill(md, "my-skill");
    expect(r.ok).toBe(true);
    expect(r.issues.find((i) => i.rule === "description-too-long")?.severity).toBe(
      "warning",
    );
  });

  it("emits tags-non-canonical as a warning when tags need normalisation", () => {
    const md = goodSkill.replace(
      /tags: .*/,
      "tags: [Memory, Retrieval]",
    );
    const r = validateSkill(md, "my-skill");
    expect(r.ok).toBe(true);
    expect(r.issues.some((i) => i.rule === "tags-non-canonical")).toBe(true);
  });

  it("emits body-too-short as a warning", () => {
    const md = `---\ntitle: x\ndescription: d\ntags: [a]\n---\n\nshort`;
    const r = validateSkill(md, "x");
    expect(r.issues.some((i) => i.rule === "body-too-short")).toBe(true);
  });
});
