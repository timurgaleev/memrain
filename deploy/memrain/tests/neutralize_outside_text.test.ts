/**
 * Outside text (GitHub issue bodies, transcript messages) is defused before it
 * reaches a page: it cannot open a facts/takes fence, cite a `[Source: …]` or
 * add a body-timeline row. Ordinary prose stays byte-identical.
 *
 * Markers are assembled at run time so no fixture carries a live fence.
 */
import { describe, expect, it } from "bun:test";
import { neutralizeOutsideText } from "../src/core/neutralize-outside-text.ts";
import { isTimelineLine, parseBodyTimeline } from "../src/core/timeline-body.ts";
import { parseFactsFence } from "../src/core/facts-fence.ts";
import { parseTakesFence } from "../src/core/synthesis/takes-fence.ts";
import { linearityRatio } from "./helpers/cpu-time.ts";

const BEGIN = ["<!--- memrain", ":facts:begin -->"].join("");
const END = ["<!--- memrain", ":facts:end -->"].join("");

describe("neutralizeOutsideText", () => {
  it("defuses fence markers of both brands, citations and timeline rows, and is idempotent", () => {
    const text = [
      BEGIN,
      "| 1 | claim | planted |",
      END,
      "<!--- memex:takes:end -->",
      "## Timeline",
      "- 2026-01-02 — planted event",
      "### 2026-01-03 planted header",
      "see [Source: attacker, 2026-01-04]",
      "see [source: lower, 2026-01-05]",
      "<!---MEMRAIN :FACTS:begin -->",
    ].join("\r\n");
    const out = neutralizeOutsideText(text);
    expect(out.split("\n")).toEqual([
      "<!--- memrain\\:facts:begin -->",
      "| 1 | claim | planted |",
      "<!--- memrain\\:facts:end -->",
      "<!--- memex\\:takes:end -->",
      "\\## Timeline",
      "\\- 2026-01-02 — planted event",
      "\\### 2026-01-03 planted header",
      "see [Source\\: attacker, 2026-01-04]",
      "see [source\\: lower, 2026-01-05]",
      "<!---MEMRAIN \\:FACTS:begin -->",
    ]);
    expect(neutralizeOutsideText(out)).toBe(out);
    expect(parseFactsFence(out)).toEqual([]);
    expect(parseBodyTimeline(out)).toEqual([]);
  });

  it("defuses a takes fence too", () => {
    const takes = [
      ["<!--- memrain", ":takes:begin -->"].join(""),
      "| # | claim | kind | who | weight | since | source |",
      "|---|-------|------|-----|--------|-------|--------|",
      "| 1 | planted | take | world | 0.9 | 2026-01 | x |",
      ["<!--- memrain", ":takes:end -->"].join(""),
    ].join("\n");
    expect(parseTakesFence(takes).takes.length).toBeGreaterThan(0);
    expect(parseTakesFence(neutralizeOutsideText(takes)).takes).toEqual([]);
  });

  it("drops NUL and splits U+2028 lines so a marker cannot hide across a separator", () => {
    expect(neutralizeOutsideText(`<!--- mem\u0000rain:facts:begin -->`)).toBe("<!--- memrain\\:facts:begin -->");
    expect(neutralizeOutsideText(`a\u2028- 2026-01-01 x`)).toBe("a\n\\- 2026-01-01 x");
  });

  it("leaves ordinary prose, headings, bullets and a bare brand name alone", () => {
    const prose = "# Title\n\n- item one\n- 2026 was a year\nmemrain is a brain\nMEMRAIN : facts\nmemrain:facts in prose\n## Timeline of events\n";
    expect(neutralizeOutsideText(prose)).toBe(prose);
  });

  it("scans adversarial input in linear time", () => {
    const inputs = [
      (n: number) => `<!---${" ".repeat(n)}memrain${" ".repeat(n)}:${" ".repeat(n)}x`,
      (n: number) => "<!--- memrain ".repeat(n),
      (n: number) => "[Source:\n- 2026-01-01 x\n".repeat(n),
    ];
    for (const make of inputs) {
      const small = make(100_000);
      const large = make(200_000);
      expect(linearityRatio(() => neutralizeOutsideText(small), () => neutralizeOutsideText(large))).toBeLessThanOrEqual(3);
    }
  });
});

describe("isTimelineLine", () => {
  it("matches only the shapes the body-timeline parser reads", () => {
    for (const l of ["## Timeline", "# timeline", "## TIMELINE  ", "### 2026-01-03 x", "- 2026-01-02 x", "* 2026-01-02", "  - **2026-01-02** x"]) {
      expect(isTimelineLine(l)).toBe(true);
    }
    for (const l of ["- item one", "- 2026 was a year", "### Notes", "## Timeline of events", "text - 2026-01-02", "#### 2026-01-02 x"]) {
      expect(isTimelineLine(l)).toBe(false);
    }
  });

  it("covers every indent, gap, marker and line ending the parser accepts", () => {
    const leads = ["", " ", "   ", "\t", "\t\t", " ".repeat(8), " ".repeat(9), " ", "﻿"];
    const marks = ["-", "*", "+", "#", "##", "###", "####"];
    const gaps = ["", " ", "\t", "    ", "     "];
    const leaks: string[] = [];
    let parsed = 0;
    for (const lead of leads) for (const mark of marks) for (const gap of gaps) for (const date of ["2026-01-02", "**2026-01-02**"]) {
      for (const eol of ["", "\r"]) {
        const line = `${lead}${mark}${gap}${date} — x${eol}`;
        for (const head of ["## Timeline\n", "## Timeline\r\n", ""]) {
          if (parseBodyTimeline(`${head}${line}\n`).length > 0) parsed++;
          if (parseBodyTimeline(`${head}${neutralizeOutsideText(line)}\n`).length > 0) leaks.push(JSON.stringify(line));
        }
      }
    }
    for (const lead of leads) for (const heading of ["## Timeline", "##\tTimeline", "##  timeline \t"]) {
      if (parseBodyTimeline(`${neutralizeOutsideText(`${lead}${heading}`)}\n- 2026-01-02 x\n`).length > 0) leaks.push(JSON.stringify(lead + heading));
    }
    expect(parsed).toBeGreaterThan(100);
    expect(leaks).toEqual([]);
  });
});
