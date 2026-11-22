/**
 * The pack honesty lint: every tool a skill declares and every `memex`
 * command it tells an agent to run must exist — and the shipped pack passes.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { lintAndShape, validateSkill } from "../src/core/skillify.ts";
import { extractCliReferences, extractToolCalls, lintSkillpack } from "../src/core/skillpack/lint.ts";

const MEMRAIN_DIR = resolve(import.meta.dir, "..");
const PACK_DIR = resolve(MEMRAIN_DIR, "..", "skills");
const FENCE = "```";

function skill(name: string, tools: string, body: string): string {
  return `---\nname: ${name}\ndescription: d\ntriggers:\n  - "run ${name}"\ntools: ${tools}\n---\n\n# ${name}\n\n${body}\n`;
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

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "skillpack-lint-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("lintSkillpack", () => {
  it("names the skill and the tool that does not exist", () => {
    const dir = writePack("tools", {
      "alpha/SKILL.md": skill("alpha", "[page_get, not_a_tool]", "Body."),
    });
    const r = lintSkillpack(dir);
    expect(r.ok).toBe(false);
    expect(r.skills).toBe(1);
    expect(r.issues).toEqual([
      { slug: "alpha", rule: "unknown-tool", detail: "not_a_tool", line: 6 },
    ]);
  });

  it("flags a dead subcommand and a dead command", () => {
    const dir = writePack("cli", {
      "beta/SKILL.md": skill(
        "beta",
        "[page_get]",
        `Run \`memex skillpack frobnicate\` first.\n\n${FENCE}bash\nmemex frobnicate --all\n${FENCE}`,
      ),
    });
    const rules = lintSkillpack(dir).issues.map((i) => `${i.rule} ${i.detail} @${i.line}`);
    expect(rules).toEqual([
      "unknown-cli-subcommand memrain skillpack frobnicate @11",
      "unknown-cli-command memrain frobnicate @14",
    ]);
  });

  it("accepts real commands, flags, placeholders and prose mentions", () => {
    const dir = writePack("clean", {
      "gamma/SKILL.md": skill(
        "gamma",
        "[search, page_get]",
        [
          "Use `memex doctor --json`, `memex search modes`, `memex <cmd>`.",
          "`memex search \"what do we know\"` and `memex jobs submit <kind>`.",
          "In prose, memex frobnicate is not a command to run.",
          `${FENCE}bash`,
          "memex eval gate --max-drop 0.02   # memex bogus in a comment",
          "/opt/memex/bin/memex status",
          `${FENCE}`,
          "Fix: `memex doctor`, then continue.",
        ].join("\n"),
      ),
    });
    expect(lintSkillpack(dir)).toEqual({ ok: true, skills: 1, issues: [] });
  });

  it("checks name, frontmatter and scans shared docs for commands only", () => {
    const dir = writePack("shared", {
      "delta/SKILL.md": skill("not-delta", "[page_get]", "Body."),
      "epsilon/SKILL.md": "# no frontmatter\n",
      "_rules.md": "Run `memex skillpack harvest`.\n",
      "conventions/c.md": "---\ntools: [not_a_tool]\n---\nRun `memex eval skillopt x`.\n",
      "flat.md": skill("flat", "[page_get]", "Body."),
    });
    const r = lintSkillpack(dir);
    expect(r.skills).toBe(3);
    expect(r.issues.map((i) => `${i.slug} ${i.rule}`)).toEqual([
      "_rules.md unknown-cli-subcommand",
      "conventions/c.md unknown-cli-subcommand",
      "delta name-mismatch",
      "epsilon frontmatter-missing",
    ]);
  });

  it("checks a tools list written at column 0", () => {
    const dir = writePack("column-zero", {
      "zeta/SKILL.md": "---\nname: zeta\ndescription: d\ntriggers:\n- \"t\"\ntools:\n- page_get\n- not_a_tool\n---\n\n# zeta\n\nBody.\n",
    });
    expect(lintSkillpack(dir).issues).toEqual([
      { slug: "zeta", rule: "unknown-tool", detail: "not_a_tool", line: 6 },
    ]);
  });

  it("passes a skill drafted by memex skillify", () => {
    const draft = "---\ntitle: drifted\ndescription: Recap recent workouts.\ntags: [fitness]\ntools: [search, not_a_tool]\n---\n\n# Recap\n\nRun `memex search workout` and summarise the hits.\n";
    const shaped = lintAndShape(draft, "workout-recap", "recap my workouts");
    const scaffolded = lintAndShape("nothing useful", "empty-draft", "summarise workouts");
    const dir = writePack("skillify", {
      "workout-recap.md": shaped.markdown,
      "empty-draft.md": scaffolded.markdown,
    });
    expect(lintSkillpack(dir)).toEqual({ ok: true, skills: 2, issues: [] });
    expect(validateSkill(shaped.markdown, "workout-recap").issues).toEqual([]);
  });

  it("flags undeclared argument keys in tool-call examples", () => {
    const dir = writePack("tool-args", {
      "iota/SKILL.md": skill(
        "iota",
        "[search, page_put]",
        [
          `${FENCE}`,
          `search  {"q": "x", "limit": 5}     # "limit" is not a search param`,
          `page_put {"slug": "a/b", "compiled_truth": {"content": 1}, "content": [...]}`,
          `${FENCE}`,
          "Or inline: `search {\"query\": \"x\"}`.",
          `${FENCE}bash`,
          `memex call search '{"q":"x","k":5,"limt":5}'`,
          "memex call not_a_tool '{}'",
          `${FENCE}`,
        ].join("\n"),
      ),
    });
    const rules = lintSkillpack(dir).issues.map((i) => `${i.rule} ${i.detail} @${i.line}`);
    expect(rules).toEqual([
      "unknown-tool-arg search limit @12",
      "unknown-tool-arg page_put content @13",
      "unknown-tool-arg search query @15",
      "unknown-tool-arg search limt @17",
      "unknown-call-tool memrain call not_a_tool @18",
    ]);
  });

  it("accepts declared keys, placeholders and non-call braces", () => {
    const dir = writePack("tool-args-clean", {
      "kappa/SKILL.md": skill(
        "kappa",
        "[jobs_submit, jobs_get]",
        [
          `${FENCE}`,
          `jobs_submit {"kind":"<registered kind>","payload":{"anything":1}}`,
          `jobs_get    {"id":ID}`,
          `memex call jobs_get '{...}'`,
          `memex call <tool> '<args>'`,
          `const x = {"not": "a call"};`,
          `${FENCE}`,
        ].join("\n"),
      ),
    });
    // jobs_* are operator-only; that warning is covered on its own below.
    expect(lintSkillpack(dir, { operatorOnlyTools: new Set() })).toEqual({ ok: true, skills: 1, issues: [] });
  });

  it("reads commands under the current and the pre-rename CLI name", () => {
    const dir = writePack("both-words", {
      "nu/SKILL.md": skill(
        "nu",
        "[page_get]",
        [
          "Run `memrain doctor` or, on a stored page, `memex doctor`.",
          `${FENCE}bash`,
          "memrain nosuchcmd",
          "memrain call not_a_tool '{}'",
          "memrain call page_get '{\"slug\":\"a\",\"bogus\":1}'",
          `${FENCE}`,
        ].join("\n"),
      ),
    });
    const issues = lintSkillpack(dir).issues.map((i) => `${i.rule} @${i.line}`);
    expect(issues).toEqual([
      "unknown-cli-command @13",
      "unknown-call-tool @14",
      "unknown-tool-arg @15",
    ]);
    expect(extractCliReferences("`memrain doctor` then `memex status` then `memrain jobs list`")).toEqual([
      { command: "doctor", subcommand: null, flags: [], line: 1 },
      { command: "status", subcommand: null, flags: [], line: 1 },
      { command: "jobs", subcommand: "list", flags: [], line: 1 },
    ]);
    expect(extractCliReferences("`xmemrain doctor` and `memraindoctor`")).toEqual([]);
  });

  it("flags a CLI flag the command does not read, and only that", () => {
    const dir = writePack("flags", {
      "nu/SKILL.md": skill(
        "nu",
        "[page_get]",
        [
          "Run `memex reindex --stale` and `memrain reindex --dryrun` now.",
          `${FENCE}bash`,
          "memrain search --k 5 --frobnicate \"q\" | head --lines 3   # memrain doctor --bogus",
          "memrain doctor --json && memrain status --per-source --verbos",
          `${FENCE}`,
          "`memrain call search --args '{\"query\": \"a --not-a-flag\"}'`",
          "`memrain jobs submit <kind> --payload '{}' --priority 1`",
          "`memrain capture --title=\"x\" --file <path> --<flag> --help`",
          "`memrain eval gate --max-drop=0.02` then `memrain version --json`",
        ].join("\n"),
      ),
    });
    const r = lintSkillpack(dir);
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => `${i.rule} ${i.detail} @${i.line}`)).toEqual([
      "unknown-cli-flag memrain reindex --stale @11",
      "unknown-cli-flag memrain reindex --dryrun (did you mean --dry-run?) @11",
      "unknown-cli-flag memrain search --frobnicate @13",
      "unknown-cli-flag memrain status --verbos @14",
    ]);
  });

  it("refuses a flag on a subcommand that does not read it, as the CLI does", () => {
    const dir = writePack("sub-flags", {
      "xi/SKILL.md": skill(
        "xi",
        "[page_get]",
        "Run `memrain skillpack check --fix --strict`, never `memrain skillpack lint --fix` or `memrain skillpack --strict`.",
      ),
    });
    expect(lintSkillpack(dir).issues.map((i) => `${i.rule} ${i.detail}`)).toEqual([
      "unknown-cli-flag memrain skillpack --fix (only 'skillpack check' reads it)",
      "unknown-cli-flag memrain skillpack --strict (only 'skillpack check' reads it)",
    ]);
  });

  it("reads flags only up to the next command on the line", () => {
    expect(extractCliReferences("`memrain doctor --json memrain status --per-source`")).toEqual([
      { command: "doctor", subcommand: null, flags: ["--json"], line: 1 },
      { command: "status", subcommand: null, flags: ["--per-source"], line: 1 },
    ]);
    expect(extractCliReferences("`memrain search 'it --is quoted' --k=5`")).toEqual([
      { command: "search", subcommand: null, flags: ["--k"], line: 1 },
    ]);
    expect(extractCliReferences("`memrain reindex --stale=\"x y\" \"--not-a-flag\"`")).toEqual([
      { command: "reindex", subcommand: null, flags: ["--stale"], line: 1 },
    ]);
  });

  // Value: protects=a flag on a continuation line is checked; fails_when=fenced lines are scanned one by one again.
  it("joins a fenced command continued with a backslash and reports it at its first line", () => {
    const md = [`${FENCE}bash`, "memrain transcripts push session.jsonl \\", "  --token-file t.txt --dry-run \\", "  --json   # comment", "memrain doctor", FENCE].join("\n");
    expect(extractCliReferences(md)).toEqual([
      { command: "transcripts", subcommand: "push", flags: ["--token-file", "--dry-run", "--json"], line: 2 },
      { command: "doctor", subcommand: null, flags: [], line: 5 },
    ]);
    // A dangling backslash never swallows the closing fence.
    expect(extractCliReferences([FENCE, "memrain doctor \\", FENCE, "`memrain status`"].join("\n"))).toEqual([
      { command: "doctor", subcommand: null, flags: [], line: 2 },
      { command: "status", subcommand: null, flags: [], line: 4 },
    ]);
  });

  // Value: protects=list_skills stays small; fails_when=a description grows past the cap unnoticed.
  it("caps the frontmatter description at 1024 bytes", () => {
    const withDescription = (name: string, d: string) =>
      `---\nname: ${name}\ndescription: ${d}\ntriggers:\n  - "run ${name}"\ntools: [page_get]\n---\n\n# ${name}\n`;
    const pack = writePack("desc-cap", {
      "long/SKILL.md": withDescription("long", "d".repeat(1025)),
      "fits/SKILL.md": withDescription("fits", "d".repeat(1024)),
    });
    expect(lintSkillpack(pack).issues).toEqual([
      { slug: "long", rule: "skill-description-too-large", detail: "description is 1025 bytes, over the 1024-byte cap; move detail into the body", line: 3 },
    ]);
  });

  it("caps a skill at 16 KB unless skill-budgets.tsv gives it a ceiling", () => {
    const big = (name: string, bytes: number): string => {
      const head = skill(name, "[page_get]", "");
      return head + "x".repeat(bytes - Buffer.byteLength(head));
    };
    const over = writePack("size-over", { "big/SKILL.md": big("big", 16_385) });
    expect(lintSkillpack(over).issues).toEqual([
      { slug: "big", rule: "skill-too-large", detail: "16385 bytes, over the 16384-byte cap (no row in skill-budgets.tsv)", line: 1 },
    ]);
    const capped = writePack("size-row", {
      "big/SKILL.md": big("big", 17_000),
      "huge/SKILL.md": big("huge", 18_001),
      "small/SKILL.md": big("small", 2_000),
      "skill-budgets.tsv": "# skill\tmax_bytes\tnote\nbig\t17000\tseeded\nhuge\t18000\tseeded\nsmall\t20000\told\ngone\t20000\told\nbad row\nbig\t17500\tagain\n",
    });
    const r = lintSkillpack(capped);
    expect(r.ok).toBe(false);
    expect(r.issues).toEqual([
      { slug: "skill-budgets.tsv", rule: "skill-budget-invalid", detail: "expected <skill> TAB <max bytes> TAB <note>", line: 6 },
      { slug: "skill-budgets.tsv", rule: "skill-budget-invalid", detail: "big has a row already", line: 7 },
      { slug: "huge", rule: "skill-too-large", detail: "18001 bytes, over its 18000-byte ceiling in skill-budgets.tsv", line: 1 },
      { slug: "skill-budgets.tsv", rule: "skill-budget-stale", detail: "small is 2000 bytes, under the 16384-byte cap: delete its row", line: 4, severity: "warn" },
      { slug: "skill-budgets.tsv", rule: "skill-budget-stale", detail: "gone names no skill: delete its row", line: 5, severity: "warn" },
    ]);
  });

  it("reports a SKILL.md it cannot read instead of skipping it", () => {
    const dir = writePack("unreadable", {
      "lambda/SKILL.md/placeholder": "x",
      "mu/SKILL.md": skill("mu", "[page_get]", "Body."),
    });
    const r = lintSkillpack(dir);
    expect(r.ok).toBe(false);
    expect(r.skills).toBe(2);
    expect(r.issues).toEqual([{ slug: "lambda", rule: "unreadable", detail: "EISDIR", line: 1 }]);
  });

  it("passes on the shipped pack", () => {
    const r = lintSkillpack(PACK_DIR);
    expect(r.issues.filter((i) => i.severity !== "warn")).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.skills).toBeGreaterThan(40);
    // Warnings are only the two advisory rules, never a silenced error.
    expect(new Set(r.issues.map((i) => i.rule))).toEqual(new Set(["trigger-overlap", "operator-only-tool"]));
  });

  it("fails on a trigger two skills share, however it is spelled", () => {
    const dir = writePack("trigger-dup", {
      "omicron/SKILL.md": "---\nname: omicron\ndescription: d\ntriggers:\n  - \"Brain Health\"\ntools: [page_get]\n---\nBody.\n",
      "pi/SKILL.md": "---\nname: pi\ndescription: d\ntriggers:\n  - \"brain-health!\"\n  - \"pi only\"\ntools: [page_get]\n---\nBody.\n",
    });
    const r = lintSkillpack(dir);
    expect(r.ok).toBe(false);
    expect(r.issues).toEqual([
      { slug: "pi", rule: "trigger-overlap", detail: "\"brain health\" is also a trigger of omicron", line: 4 },
    ]);
  });

  it("warns, without failing, when one skill's trigger sits inside another's", () => {
    const dir = writePack("trigger-sub", {
      "rho/SKILL.md": "---\nname: rho\ndescription: d\ntriggers:\n  - \"enrich\"\ntools: [page_get]\n---\nBody.\n",
      "sigma/SKILL.md": "---\nname: sigma\ndescription: d\ntriggers:\n  - \"enrich this article\"\n  - \"enriching\"\ntools: [page_get]\n---\nBody.\n",
    });
    const r = lintSkillpack(dir);
    expect(r.ok).toBe(true);
    // "enriching" is not the word "enrich", so only the whole-word run counts.
    expect(r.issues).toEqual([
      {
        slug: "sigma",
        rule: "trigger-overlap",
        detail: "\"enrich this article\" contains \"enrich\", a trigger of rho",
        line: 4,
        severity: "warn",
      },
    ]);
  });

  it("warns when a skill declares a tool tenants are never granted", () => {
    const dir = writePack("operator-only", {
      "tau/SKILL.md": skill("tau", "[page_get, run_doctor]", "Body."),
    });
    const r = lintSkillpack(dir);
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([
      { slug: "tau", rule: "operator-only-tool", detail: "run_doctor", line: 6, severity: "warn" },
    ]);
  });
});

describe("extractCliReferences cost", () => {
  function best(text: string): number {
    const runs = [0, 1, 2].map(() => {
      const started = performance.now();
      extractCliReferences(text);
      return performance.now() - started;
    });
    return Math.min(...runs);
  }

  it("stays linear on repeated backtick-memex fragments", () => {
    const build = (k: number): string => "`memex ".repeat(2 ** k);
    const small = best(build(16));
    const large = best(build(18));
    expect(large / Math.max(small, 0.05)).toBeLessThan(10);
  }, 60_000);

  it("stays linear on interleaved current and pre-rename fragments", () => {
    const build = (k: number): string => "`memrain `memex ".repeat(2 ** k);
    const small = best(build(15));
    const large = best(build(17));
    expect(large / Math.max(small, 0.05)).toBeLessThan(10);
  }, 60_000);

  it("stays linear on chained command lines full of flags, quotes and placeholders", () => {
    const build = (k: number): string => `\`${"memrain doctor --json 'a memrain b' <x> --y=\"z ".repeat(2 ** k)}\``;
    const small = best(build(13));
    const large = best(build(15));
    expect(large / Math.max(small, 0.05)).toBeLessThan(10);
  }, 60_000);

  it("stays linear on backtick runs of mixed lengths that never pair", () => {
    const build = (n: number): string =>
      Array.from({ length: n }, (_, i) => `${"`".repeat((i % 50) + 1)}memex doctor `).join("");
    const small = best(build(10_000));
    const large = best(build(40_000));
    expect(large / Math.max(small, 0.05)).toBeLessThan(10);
  }, 60_000);
});

describe("extractToolCalls cost", () => {
  const ops = new Set(["search"]);
  function best(text: string): number {
    const runs = [0, 1, 2].map(() => {
      const started = performance.now();
      extractToolCalls(`${FENCE}\n${text}\n${FENCE}`, ops);
      return performance.now() - started;
    });
    return Math.min(...runs);
  }

  it("stays linear on nested tool-call objects that never close", () => {
    const build = (k: number): string => "search {\"q\": ".repeat(2 ** k);
    const small = best(build(14));
    const large = best(build(16));
    expect(large / Math.max(small, 0.05)).toBeLessThan(10);
  }, 60_000);

  it("stays linear on memrain call fragments far from any memex one", () => {
    const build = (k: number): string => `${"memrain call search '{ \"q\" ".repeat(2 ** k)}memex call`;
    const small = best(build(14));
    const large = best(build(16));
    expect(large / Math.max(small, 0.05)).toBeLessThan(10);
  }, 60_000);

  it("stays linear on braces separated by whitespace and memex call fragments", () => {
    const build = (k: number): string => "memex call search '{ \"q\" ".repeat(2 ** k);
    const small = best(build(14));
    const large = best(build(16));
    expect(large / Math.max(small, 0.05)).toBeLessThan(10);
  }, 60_000);
});

describe("memrain skillpack lint (CLI)", () => {
  function run(dir: string, json: boolean): { status: number | null; stdout: string } {
    const args = ["run", "src/cli.ts", "skillpack", "lint", "--dir", dir];
    if (json) args.push("--json");
    const r = spawnSync("bun", args, { cwd: MEMRAIN_DIR, encoding: "utf8" });
    return { status: r.status, stdout: r.stdout };
  }

  it("exits 1 with parseable JSON on a bad pack and 0 on a clean one", () => {
    const bad = writePack("cli-bad", {
      "zeta/SKILL.md": skill("zeta", "[not_a_tool]", "Run `memex skillpack frobnicate`."),
    });
    const clean = writePack("cli-clean", {
      "eta/SKILL.md": skill("eta", "[page_get]", "Run `memex doctor`."),
    });

    const failing = run(bad, true);
    expect(failing.status).toBe(1);
    const parsed = JSON.parse(failing.stdout) as { ok: boolean; issues: { rule: string }[] };
    expect(parsed.ok).toBe(false);
    expect(parsed.issues.map((i) => i.rule).sort()).toEqual([
      "unknown-cli-subcommand",
      "unknown-tool",
    ]);

    const passing = run(clean, false);
    expect(passing.status).toBe(0);
    expect(passing.stdout).toContain("no issues");
  }, 60_000);
});
