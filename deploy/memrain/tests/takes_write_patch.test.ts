import { describe, expect, it } from "bun:test";
import { patchTakeFence, type TakeFenceMutation } from "../src/core/synthesis/takes-write.ts";
import { parseTakesFence, upsertTakeRow } from "../src/core/synthesis/takes-fence.ts";

const actor = { principal: "client:writer", holderAllowList: ["world"], resolvedAt: "2026-11-09T12:00:00.000Z" };
const header = "| # | claim | kind | who | weight | since | source | unknown |";
const separator = "|---|---|---|---|---|---|---|---|";
const row = "| 1 | First | fact | world | 1 | 2026-01-01 | note | keep me |";
const broken = "| 8 | Malformed | nope | world | invalid | | | preserved |";
const body = ["Before", "<!--- memex:takes:begin -->", header, separator, row, "<!-- comment -->", broken,
  "<!--- memex:takes:end -->", "After"].join("\r\n");

describe("raw canonical takes patches", () => {
  it("appends above every numeric id without rewriting malformed neighbors, unknown columns or prose", () => {
    const result = patchTakeFence(body, { op: "add", claim: "Pipe | and \\ slash", kind: "take", holder: "world" }, actor);
    expect(result.rowNum).toBe(9);
    expect(result.changedRowNums).toEqual([9]);
    expect(result.body.replace(/^\| 9 .*\r\n/m, "")).toBe(body);
    expect(parseTakesFence(result.body).takes.find((t) => t.rowNum === 9)?.claim).toBe("Pipe | and \\ slash");
  });

  it("widens only header/separator and target on resolve, preserving exact value then clearing target resolution on claim change", () => {
    const resolved = patchTakeFence(body, { op: "resolve", rowNum: 1, quality: "correct", value: 12.34567, evidence: "A | B" }, actor);
    expect(resolved.body).toContain(broken + "\r\n");
    expect(resolved.body).toContain("<!-- comment -->\r\n");
    expect(parseTakesFence(resolved.body).takes[0]).toMatchObject({ resolvedValue: 12.34567, resolvedEvidence: "A | B", resolvedBy: actor.principal });
    const added = patchTakeFence(resolved.body, { op: "add", claim: "Next", kind: "hunch", holder: "world" }, actor);
    expect(parseTakesFence(added.body).takes[0]?.resolvedValue).toBe(12.34567);
    const changed = patchTakeFence(added.body, { op: "update", rowNum: 1, claim: "Revised" }, actor);
    expect(parseTakesFence(changed.body).takes[0]?.resolvedQuality).toBeUndefined();
    expect(changed.body).toContain("keep me");
  });

  it("creates one fence without changing existing prose or facts", () => {
    const original = "Prose\n<!--- memrain:facts:begin -->\nraw\n<!--- memrain:facts:end -->";
    const added = patchTakeFence(original, { op: "add", claim: "New", kind: "fact", holder: "world" }, actor);
    expect(added.body.startsWith(original)).toBe(true);
    expect(added.rowNum).toBe(1);
    expect(parseTakesFence(added.body).takes).toHaveLength(1);
  });

  for (const invalid of [body.replace("| 8 |", "| 1 |"), body.replace("| 8 |", "| 1junk |"),
    body.replace("memex:takes:end", "memrain:takes:end"), body.replace("<!--- memex:takes:end -->", ""),
    body + "\n<!--- memex:takes:begin -->\n<!--- memex:takes:end -->", body.replace("| claim |", "| unsupported |"), body.replace(broken, header)]) {
    it("refuses ambiguous rows or fence schemas", () => {
      expect(() => patchTakeFence(invalid, { op: "add", claim: "New", kind: "fact", holder: "world" }, actor)).toThrow();
    });
  }

  for (const mutation of [
    { op: "add", claim: "new\nrow", kind: "fact", holder: "world" },
    { op: "add", claim: "x".repeat(4001), kind: "fact", holder: "world" },
    { op: "add", claim: "<!--- memrain:facts:begin -->", kind: "fact", holder: "world" },
    { op: "add", claim: "New", kind: "fact", holder: "people/alice" },
    { op: "add", claim: "New", kind: "fact", holder: "world", weight: NaN },
    { op: "add", claim: "New", kind: "fact", holder: "world", since: "2026-02-30" },
    { op: "update", rowNum: 1 }, { op: "update", rowNum: 1, holder: "brain" },
    { op: "resolve", rowNum: 1, quality: "correct", value: Infinity },
    { op: "resolve", rowNum: 1, quality: "wrong" },
  ]) it("rejects invalid inputs and holder grants before patching", () => {
    expect(() => patchTakeFence(body, mutation as TakeFenceMutation, actor)).toThrow();
  });
  it("preserves resolution precision through the existing append utility", () => {
    const resolved = patchTakeFence(body, { op: "resolve", rowNum: 1, quality: "correct", value: 12.34567 }, actor);
    const appended = upsertTakeRow(resolved.body, { claim: "Another", kind: "take", holder: "world", weight: 0.5, active: true });
    expect(parseTakesFence(appended.body).takes[0]?.resolvedValue).toBe(12.34567);
  });

  it("keeps indentation on the original end-marker line", () => {
    const indented = body.replace("<!--- memex:takes:end -->", "   <!--- memex:takes:end -->");
    const result = patchTakeFence(indented, { op: "add", claim: "Next", kind: "take", holder: "world" }, actor);
    expect(result.body).toContain("\r\n   <!--- memex:takes:end -->");
    expect(result.body.replace(/^\| 9 .*\r\n/m, "")).toBe(indented);
  });

});
