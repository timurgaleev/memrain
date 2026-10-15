/**
 * Tests for `friction propose-fix`.
 *
 * Coverage:
 *   - findTopFrictionSkills aggregates by extra->>'skill' and orders by count
 *   - proposeForSkill parses the model JSON and surfaces rationale + suggestion
 *   - proposeFixes (top mode) reads the right skill files and skips missing ones
 *   - proposeFixes (skill mode) targets a single slug
 *   - tolerates code-fence wrapping around the JSON output
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { logFriction } from "../src/core/friction.ts";
import {
  findTopFrictionSkills,
  proposeForSkill,
  proposeFixes,
} from "../src/core/friction-propose.ts";

let tmp: string;
let skillsDir: string;
let storage: Storage;

function stubClient(text: string) {
  return {
    send: async () => ({
      output: { message: { content: [{ text }] } },
    }),
  } as unknown as import("@aws-sdk/client-bedrock-runtime").BedrockRuntimeClient;
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-fric-"));
  skillsDir = join(tmp, "skills");
  mkdirSync(skillsDir, { recursive: true });
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("findTopFrictionSkills", () => {
  it("groups by extra.skill and orders by count desc", async () => {
    const e = storage.engine();
    for (let i = 0; i < 3; i++) {
      await logFriction(e, {
        kind: "wrong-answer",
        query: `q${i}`,
        extra: { skill: "brain-recall" },
      });
    }
    await logFriction(e, {
      kind: "search-miss",
      query: "alpha",
      extra: { skill: "notes-recall" },
    });
    // No skill tag — should be excluded.
    await logFriction(e, { kind: "tool-error", query: "stray" });

    const top = await findTopFrictionSkills(e, 5);
    expect(top.map((t) => t.skill)).toEqual(["brain-recall", "notes-recall"]);
    expect(top[0]?.count).toBe(3);
    expect(top[0]?.examples.length).toBe(3);
    expect(top[1]?.count).toBe(1);
  });

  it("rejects out-of-range topN", async () => {
    await expect(findTopFrictionSkills(storage.engine(), 0)).rejects.toThrow();
    await expect(findTopFrictionSkills(storage.engine(), 51)).rejects.toThrow();
  });
});

describe("proposeForSkill", () => {
  it("returns rationale + suggestion from a clean JSON response", async () => {
    const out = JSON.stringify({
      rationale: "The 'how' section never tells the agent what to do on miss.",
      suggestion: "---\ntitle: x\n---\n# revised body",
    });
    const proposal = await proposeForSkill(
      "x",
      "/skills/x.md",
      "---\ntitle: x\n---\n# original",
      [{ capturedAt: "t", kind: "search-miss", query: "q", reason: null, sourcePath: null }],
      1,
      { client: stubClient(out) },
    );
    expect(proposal.rationale).toContain("how");
    expect(proposal.suggestion).toContain("revised body");
    expect(proposal.frictionCount).toBe(1);
  });

  it("strips a stray ```json code fence around the response", async () => {
    const out =
      "```json\n" +
      JSON.stringify({ rationale: "r", suggestion: "s" }) +
      "\n```";
    const proposal = await proposeForSkill(
      "x",
      "/skills/x.md",
      "body",
      [],
      0,
      { client: stubClient(out) },
    );
    expect(proposal.rationale).toBe("r");
    expect(proposal.suggestion).toBe("s");
  });

  it("asks the utility-tier model when SKILLIFY_MODEL_ID is unset", async () => {
    const saved = { utility: process.env.MEMRAIN_UTILITY_MODEL, skillify: process.env.SKILLIFY_MODEL_ID };
    let seen = "";
    const client = {
      send: async (cmd: { input: { modelId: string } }) => {
        seen = cmd.input.modelId;
        return { output: { message: { content: [{ text: JSON.stringify({ rationale: "r", suggestion: "s" }) }] } } };
      },
    } as unknown as import("@aws-sdk/client-bedrock-runtime").BedrockRuntimeClient;
    try {
      process.env.MEMRAIN_UTILITY_MODEL = "utility-model";
      delete process.env.SKILLIFY_MODEL_ID;
      await proposeForSkill("x", "/p", "b", [], 0, { client });
    } finally {
      for (const [k, v] of [["MEMRAIN_UTILITY_MODEL", saved.utility], ["SKILLIFY_MODEL_ID", saved.skillify]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    expect(seen).toBe("utility-model");
  });

  it("throws on empty response", async () => {
    await expect(
      proposeForSkill("x", "/p", "b", [], 0, { client: stubClient("") }),
    ).rejects.toThrow();
  });

  it("throws on missing rationale or suggestion fields", async () => {
    await expect(
      proposeForSkill("x", "/p", "b", [], 0, {
        client: stubClient(JSON.stringify({ rationale: "ok" })),
      }),
    ).rejects.toThrow();
  });
});

describe("proposeFixes (integration with skills dir)", () => {
  it("loads top-N skills and runs the model per skill", async () => {
    const e = storage.engine();
    writeFileSync(
      join(skillsDir, "alpha.md"),
      "---\ntitle: alpha\n---\n# alpha body",
    );
    writeFileSync(
      join(skillsDir, "beta.md"),
      "---\ntitle: beta\n---\n# beta body",
    );
    for (let i = 0; i < 4; i++) {
      await logFriction(e, {
        kind: "wrong-answer",
        query: `aq${i}`,
        extra: { skill: "alpha" },
      });
    }
    for (let i = 0; i < 2; i++) {
      await logFriction(e, {
        kind: "search-miss",
        query: `bq${i}`,
        extra: { skill: "beta" },
      });
    }
    const stub = stubClient(
      JSON.stringify({ rationale: "r", suggestion: "s" }),
    );
    const proposals = await proposeFixes(
      e,
      { mode: "top", topSkills: 5 },
      { client: stub, skillsDir },
    );
    expect(proposals.map((p) => p.skill)).toEqual(["alpha", "beta"]);
    expect(proposals[0]?.frictionCount).toBe(4);
    expect(proposals[0]?.suggestion).toBe("s");
    expect(proposals[1]?.frictionCount).toBe(2);
  });

  it("returns a stub proposal when the skill file is missing", async () => {
    const e = storage.engine();
    await logFriction(e, {
      kind: "wrong-answer",
      query: "ghost",
      extra: { skill: "ghost" },
    });
    const stub = stubClient(
      JSON.stringify({ rationale: "r", suggestion: "s" }),
    );
    const proposals = await proposeFixes(
      e,
      { mode: "top", topSkills: 3 },
      { client: stub, skillsDir },
    );
    expect(proposals.length).toBe(1);
    expect(proposals[0]?.skill).toBe("ghost");
    expect(proposals[0]?.suggestion).toBe("");
    expect(proposals[0]?.rationale).toContain("not found");
  });

  it("targets a single skill in skill-mode regardless of friction rank", async () => {
    const e = storage.engine();
    writeFileSync(
      join(skillsDir, "target.md"),
      "---\ntitle: target\n---\n# target body",
    );
    // Other skills with more friction shouldn't matter.
    for (let i = 0; i < 5; i++) {
      await logFriction(e, {
        kind: "wrong-answer",
        query: `nope${i}`,
        extra: { skill: "noisy" },
      });
    }
    await logFriction(e, {
      kind: "tool-error",
      query: "x",
      extra: { skill: "target" },
    });
    const stub = stubClient(
      JSON.stringify({ rationale: "r", suggestion: "s" }),
    );
    const proposals = await proposeFixes(
      e,
      { mode: "skill", skill: "target" },
      { client: stub, skillsDir },
    );
    expect(proposals.length).toBe(1);
    expect(proposals[0]?.skill).toBe("target");
  });
});
