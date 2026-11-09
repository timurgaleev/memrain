import { describe, expect, it } from "bun:test";
import { slugifyTarget, validateSlug } from "../src/core/links.ts";

describe("mixed-script slug formation", () => {
  it.each([
    ["Алиса Smith", "алиса-smith"], ["people/Анна (CTO)", "people/анна-cto"],
    ["Tokyo 東京", "tokyo-東京"], ["people/Élodie Иван", "people/élodie-иван"],
    ["a/𐐀 Bee", "a/𐐨-bee"],
  ])("preserves non-Latin letters in %s", (input, expected) => {
    expect(slugifyTarget(input)).toBe(expected);
    expect(slugifyTarget(expected)).toBe(expected);
    expect(() => validateSlug(expected)).not.toThrow();
  });
  it("keeps historical Latin formation and strips variation selectors", () => {
    expect(slugifyTarget("people /Alice Smith")).toBe("people-/alice-smith");
    expect(slugifyTarget("Élodie CEO")).toBe("elodie-ceo");
    expect(slugifyTarget("東京\uFE0F CEO")).toBe("東京-ceo");
    expect(slugifyTarget("123 !")).toBe("123");
  });
});
