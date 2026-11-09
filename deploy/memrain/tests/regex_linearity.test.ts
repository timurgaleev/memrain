/**
 * Linearity guards for three scanners that were measured quadratic, each on a
 * path where nothing upstream caps the input. Companion to
 * links_scan_linearity.test.ts; same discipline — drive the real entry point,
 * not the bare pattern, with a long run of exactly the characters the offending
 * quantifier accepts and a suffix that makes the match fail.
 *
 * The ceilings are deliberately loose. Linear runs each of these in single-digit
 * milliseconds; the quadratic versions needed minutes at the same size. Nothing
 * a slow CI box does can manufacture a miss that wide.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listBrainSkillpacks } from "../src/core/skillpack/brain-resident.ts";
import { resolveIssuer } from "../src/http/oauth-metadata.ts";
import { parseFactsResponse } from "../src/core/facts-extract.ts";

const CEILING_MS = 15_000;
const RUN = 1_000_000;

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "memrain-relinear-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A skill file's frontmatter opener. With `\s*` between `---` and the newline,
 * the run and the lazy body could trade characters, so every split of the run
 * re-scanned the whole file for a closing fence that is not there: 9 ms at 6 K,
 * 611 ms at 50 K, ratio 4.0 on a doubling. Both a newline run and a space run
 * have to stay linear — narrowing the class to horizontal whitespace fixed only
 * the newline shape and was still measured at 3.9 on spaces.
 */
describe("skill frontmatter scan cost", () => {
  for (const [label, pad] of [
    ["newlines", "\n"],
    ["spaces", " "],
    ["tabs", "\t"],
  ] as const) {
    it(`stays linear on a 250 KiB run of ${label} after the opener`, () => {
      writeFileSync(join(dir, "a.md"), `---${pad.repeat(250 * 1024)}x`);

      const started = performance.now();
      const out = listBrainSkillpacks({ skillsDir: dir });
      const elapsed = performance.now() - started;

      // Never a valid frontmatter block — the assertion that the scan did the
      // work rather than bailing early.
      expect(out.skills.map((s) => s.description)).toEqual(["(no description)"]);
      expect(elapsed).toBeLessThan(CEILING_MS);
    }, 60_000);
  }

  it("still reads a description, block scalars and padded openers included", () => {
    const d = mkdtempSync(join(tmpdir(), "memrain-relinear-ok-"));
    writeFileSync(join(d, "a.md"), "---   \ndescription: plain one\n---\nbody\n");
    writeFileSync(join(d, "b.md"), '---\ndescription: "quoted one"\n---\nbody\n');
    writeFileSync(join(d, "c.md"), "---\ndescription: |\n  folded one\n  and two\n---\nbody\n");
    writeFileSync(join(d, "d.md"), "---\r\ndescription: crlf one\n---\nbody\n");
    expect(listBrainSkillpacks({ skillsDir: d }).skills.map((s) => s.description)).toEqual([
      "plain one",
      "quoted one",
      "folded one and two",
      "crlf one",
    ]);
    rmSync(d, { recursive: true, force: true });
  });
});

/**
 * The issuer's trailing-slash strip. `base` is operator-supplied
 * (`publicUrl` / MEMRAIN_PUBLIC_URL) with no length bound, and an unguarded
 * `\/+$` restarts at every slash of a run: 225 ms at 25 K, 15 s at 200 K, ratio
 * 4.0 on a doubling.
 */
describe("issuer trailing-slash strip cost", () => {
  const url = new URL("https://example.test/x");

  it("stays linear on a 1 MB slash run with a rejecting suffix", () => {
    const declared = `${"/".repeat(RUN)}x`;

    const started = performance.now();
    const out = resolveIssuer(url, declared);
    const elapsed = performance.now() - started;

    expect(out).toBe(declared);
    expect(elapsed).toBeLessThan(CEILING_MS);
  }, 60_000);

  it("stays linear when the slashes are spread across many short runs", () => {
    const declared = `${"a/".repeat(RUN / 2)}x`;

    const started = performance.now();
    resolveIssuer(url, declared);
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(CEILING_MS);
  }, 60_000);

  it("still strips exactly the trailing run and nothing else", () => {
    expect(resolveIssuer(url, "https://brain.example.test/")).toBe("https://brain.example.test");
    expect(resolveIssuer(url, "https://brain.example.test///")).toBe("https://brain.example.test");
    expect(resolveIssuer(url, "https://brain.example.test/a/")).toBe("https://brain.example.test/a");
    expect(resolveIssuer(url, "https://brain.example.test")).toBe("https://brain.example.test");
    expect(resolveIssuer(url)).toBe("https://example.test");
  });
});

/**
 * The ```json fence salvage in the facts extractor. The whitespace run between
 * the opener and the lazy body could trade characters with it, so a model answer
 * whose fence never closes re-scanned the tail once per split: 9.5 ms at 6 K,
 * 614 ms at 50 K, ratio 4.0 on a doubling.
 */
describe("facts fence salvage cost", () => {
  for (const [label, pad] of [
    ["newlines", "\n"],
    ["spaces", " "],
    ["backticks", "`"],
  ] as const) {
    it(`stays linear on a 250 KiB run of ${label} after an unclosed fence`, () => {
      const text = `\`\`\`${pad.repeat(RUN)}x`;

      const started = performance.now();
      const out = parseFactsResponse(text);
      const elapsed = performance.now() - started;

      expect(out.status).toBe("malformed");
      expect(elapsed).toBeLessThan(CEILING_MS);
    }, 60_000);
  }

  it("still salvages a fenced payload, padded or not", () => {
    const facts = '{"facts":[{"fact":"Alice works at Acme","entity":"alice","kind":"role"}]}';
    for (const wrapped of [
      `\`\`\`json\n${facts}\n\`\`\``,
      `\`\`\`json   \n${facts}\n\`\`\``,
      `\`\`\`\n${facts}\n\`\`\``,
      `Here are the facts:\n\`\`\`json\n${facts}\n\`\`\`\nDone.`,
      facts,
    ]) {
      expect(parseFactsResponse(wrapped).status).toBe("ok");
    }
  });
});
