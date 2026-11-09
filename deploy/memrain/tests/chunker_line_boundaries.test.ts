import { describe, expect, it } from "bun:test";
import { chunkMarkdown } from "../src/core/chunkers/recursive.ts";

const chunks = (text: string, maxChars = 20) => chunkMarkdown(text, {
  maxChars, minChars: 0, overlapChars: 0,
}).chunks;

describe("markdown line boundaries", () => {
  it("keeps complete lines when a bounded cut can end on a newline", () => {
    const lines = ["a".repeat(15), "b".repeat(15), "c".repeat(15)];
    expect(chunks(lines.join("\n"))).toEqual(lines);
    expect(chunks(lines.join("\r\n"))).toEqual(lines);
  });

  it("still bounds a long line without losing characters", () => {
    const text = "x".repeat(45);
    const result = chunks(text);
    expect(result.map(s => s.length)).toEqual([20, 20, 5]);
    expect(result.join("")).toBe(text);
  });

  it("does not separate a surrogate pair at the fallback cut", () => {
    const text = "a".repeat(19) + "😀" + "b".repeat(25);
    const result = chunks(text);
    expect(result.join("")).toBe(text);
    expect(result.every(s => Buffer.from(s, "utf8").toString("utf8") === s)).toBe(true);
    expect(result.every(s => s.length <= 20)).toBe(true);
    expect(chunks("abc", 1)).toEqual(["a", "b", "c"]);
    expect(chunks("😀a", 1)).toEqual(["😀", "a"]);
  });
});
