import { describe, expect, it } from "bun:test";
import { fenceBounds, fenceMarkers } from "../src/core/fence-shared.ts";
import { parseFactsFence, renderFactsFence } from "../src/core/facts-fence.ts";
import { parseTakesFence, upsertTakeRow } from "../src/core/synthesis/takes-fence.ts";

const fact = (claim: string, brand: "memrain" | "memex" = "memrain") => renderFactsFence([
  { rowNum: 1, claim, confidence: 1, active: true },
], brand);
const take = (claim: string) => `<!--- memrain:takes:begin -->\n| # | claim | kind | holder | weight | date | source |\n| 1 | ${claim} | take | world | 0.8 | 2026-01 | notes |\n<!--- memrain:takes:end -->`;

describe("fence marker locations", () => {
  it("ignores a quoted other brand instead of freezing the real projection", () => {
    const body = "```markdown\n" + fact("quoted", "memex") + "\n```\n" + fact("real");
    expect(fenceBounds(body, "facts")).toEqual({ brand: "memrain", ...fenceMarkers("facts", "memrain") });
    expect(parseFactsFence(body).map(f => f.claim)).toEqual(["real"]);
  });

  it("parses the real same-brand fence instead of an earlier code example", () => {
    for (const opener of ["```markdown", "~~~~", "````"]) {
      const closer = opener.startsWith("~") ? "~~~~" : opener.startsWith("````") ? "````" : "```";
      expect(parseFactsFence(`${opener}\n${fact("quoted")}\n${closer}\n${fact("real")}`).map(f => f.claim)).toEqual(["real"]);
      expect(parseTakesFence(`${opener}\n${take("quoted")}\n${closer}\n${take("real")}`).takes.map(t => t.claim)).toEqual(["real"]);
    }
  });

  it("does not treat a marker substring as a fence", () => {
    for (const kind of ["facts", "takes"] as const) {
      const body = `See ${fenceMarkers(kind, "memrain").begin} in the documentation.`;
      expect(fenceBounds(body, kind)).toBeNull();
    }
  });

  it("does not close a code block with a shorter or different-character fence", () => {
    expect(fenceBounds(`~~~~\n~~~\n${fact("quoted")}\n\x60\x60\x60\n${fact("also quoted")}`, "facts")).toBeNull();
  });

  it("edits only the real takes fence, leaving its quoted example intact", () => {
    const example = `\x60\x60\x60\n${take("quoted")}\n\x60\x60\x60\n`;
    const r = upsertTakeRow(example + take("real"), { claim: "new", kind: "take", holder: "world", weight: 0.7, active: true });
    expect(r.body.startsWith(example)).toBe(true);
    expect(parseTakesFence(r.body).takes.map(t => t.claim)).toEqual(["real", "new"]);
  });

  it("creates a real takes fence after a complete quoted example", () => {
    const example = `\x60\x60\x60\n${take("quoted")}\n\x60\x60\x60\n`;
    expect(parseTakesFence(example).takes).toEqual([]);
    const r = upsertTakeRow(example, { claim: "new", kind: "take", holder: "world", weight: 0.7, active: true });
    expect(r.body.startsWith(example)).toBe(true);
    expect(parseTakesFence(r.body).takes.map(t => t.claim)).toEqual(["new"]);
  });

  it("scans a megabyte of quoted markers without restarting at each opener", () => {
    const body = "````\n" + ("```\n" + fact("quoted") + "\n").repeat(8000) + "````\n" + fact("real");
    const start = performance.now();
    expect(parseFactsFence(body).map(f => f.claim)).toEqual(["real"]);
    expect(performance.now() - start).toBeLessThan(1500);
  });
});
