/** The labelling page's DOM-free pieces: its route and the tag input. */
import { describe, expect, it } from "bun:test";
import { buildHash, parseHash } from "../admin/src/lib/route.ts";
import { latestOnly, parseTagInput } from "../admin/src/lib/labels.ts";

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

describe("latestOnly", () => {
  it("lets only the newest preview request through, so a slow one cannot land on another query", () => {
    // Review A, then Review B before A's preview returns: A's results must not
    // be shown under B, or its documents would be saved as B's labels.
    const latest = latestOnly();
    const a = latest.start();
    const b = latest.start();
    expect(a()).toBe(false);
    expect(b()).toBe(true);
    latest.start(); // Close, save or dismiss: nothing in flight is current any more.
    expect(b()).toBe(false);
  });

  it("tells a save that finished late that another query was opened meanwhile", () => {
    // Save on A captures A's check; Review on B while the save runs; the save
    // must then leave B open instead of closing it.
    const latest = latestOnly();
    const savedOn = latest.start();
    expect(savedOn()).toBe(true);
    latest.start();
    expect(savedOn()).toBe(false);
  });
});
