/** The labelling page's DOM-free pieces: its route and the tag input. */
import { describe, expect, it } from "bun:test";
import { buildHash, parseHash } from "../admin/src/lib/route.ts";
import { parseTagInput } from "../admin/src/lib/labels.ts";

describe("labelling route", () => {
  it("round-trips #labelling instead of falling back to the overview", () => {
    expect(parseHash("#labelling")).toEqual({ name: "labelling", param: null });
    expect(buildHash({ name: "labelling", param: null })).toBe("#labelling");
  });
});

describe("parseTagInput", () => {
  it("splits on commas and spaces, lowercases and drops duplicates", () => {
    expect(parseTagInput("intent:topic, Kind:Alias kind:alias")).toEqual({ tags: ["intent:topic", "kind:alias"], error: null });
    expect(parseTagInput("")).toEqual({ tags: [], error: null });
  });

  it("names a tag the server would refuse", () => {
    expect(parseTagInput("kind:alias a:b:c").error).toContain("a:b:c");
    expect(parseTagInput(Array.from({ length: 17 }, (_, i) => `t${i}`).join(" ")).error).toContain("16");
  });
});
