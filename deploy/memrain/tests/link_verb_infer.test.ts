/**
 * Verb-context link-type inference — the deterministic regex NER (a faithful
 * port). Pure functions: per-edge verbs, the person→company page-role prior,
 * the context window, and the opt-in flag.
 */
import { describe, expect, it } from "bun:test";
import {
  inferLinkType,
  edgeContextWindow,
  linkVerbInferEnabled,
} from "../src/core/link-verb-infer.ts";

describe("inferLinkType — per-edge verbs", () => {
  it("classifies founded / invested_in / advises / works_at from the window", () => {
    expect(inferLinkType("person", "she co-founded the company in 2019")).toBe("founded");
    expect(inferLinkType("person", "the fund invested in them at seed")).toBe("invested_in");
    expect(inferLinkType("person", "serves as a technical advisor to the team")).toBe("advises");
    expect(inferLinkType("person", "a senior engineer at the firm")).toBe("works_at");
  });

  it("respects precedence founded > invested_in > advises > works_at", () => {
    // Both a founder verb and a work verb present → founded wins.
    expect(inferLinkType("person", "founded the startup and works at it daily")).toBe("founded");
    // invested + advises → invested_in wins.
    expect(inferLinkType("person", "invested in and advises the company")).toBe("invested_in");
  });

  it("falls through to mentions when no verb matches", () => {
    expect(inferLinkType("person", "had lunch near the office downtown")).toBe("mentions");
  });

  it("meeting without attendance evidence → mentions; media → mentions", () => {
    expect(inferLinkType("meeting", "anything")).toBe("mentions");
    expect(inferLinkType("media", "co-founded and invested in")).toBe("mentions");
  });
});

describe("inferLinkType — person→company page-role prior", () => {
  const target = "companies/acme";
  it("biases an unverbed company ref by the page-level role", () => {
    expect(inferLinkType("person", "see [[acme]]", "she is a venture partner at the fund", target)).toBe("invested_in");
    expect(inferLinkType("person", "see [[acme]]", "serves as an advisor across the sector", target)).toBe("advises");
    expect(inferLinkType("person", "see [[acme]]", "is a staff engineer at the firm", target)).toBe("works_at");
  });

  it("does NOT fire the prior for a non-company target or a non-person page", () => {
    expect(inferLinkType("person", "no verb", "venture partner", "people/bob")).toBe("mentions");
    expect(inferLinkType("company", "no verb", "venture partner", target)).toBe("mentions");
  });

  it("prior precedence: investor > advisor > employee", () => {
    // Page text that matches BOTH partner and employee priors → invested_in.
    expect(inferLinkType("person", "no verb", "venture partner and staff engineer at", target)).toBe("invested_in");
  });
});

describe("edgeContextWindow", () => {
  it("returns a bounded window around the surface form", () => {
    const body = "x".repeat(500) + "[[acme]]" + "y".repeat(500);
    const w = edgeContextWindow(body, "[[acme]]", 240);
    expect(w).toContain("[[acme]]");
    expect(w.length).toBe(240 + "[[acme]]".length + 240);
  });
  it("returns the whole body when the surface isn't found", () => {
    expect(edgeContextWindow("short body", "[[missing]]")).toBe("short body");
  });
});

describe("linkVerbInferEnabled", () => {
  it("is OFF unless MEMRAIN_LINK_VERB_INFER=1", () => {
    const prev = process.env["MEMRAIN_LINK_VERB_INFER"];
    try {
      delete process.env["MEMRAIN_LINK_VERB_INFER"];
      expect(linkVerbInferEnabled()).toBe(false);
      process.env["MEMRAIN_LINK_VERB_INFER"] = "1";
      expect(linkVerbInferEnabled()).toBe(true);
      process.env["MEMRAIN_LINK_VERB_INFER"] = "0";
      expect(linkVerbInferEnabled()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env["MEMRAIN_LINK_VERB_INFER"];
      else process.env["MEMRAIN_LINK_VERB_INFER"] = prev;
    }
  });
});

describe("inferLinkType — meeting attendance", () => {
  const meeting = (body: string, surface: string, target: string) =>
    inferLinkType("meeting", edgeContextWindow(body, surface), body, target, surface);

  it("an Attendees section yields attended; a person mentioned in the notes does not", () => {
    const body = [
      "# Sync",
      "## Attendees",
      "- [[people/alice]]",
      "- [[people/bob|Bob]] (CEO), [[people/zed]]",
      "## Notes",
      "We talked about [[people/carol]]'s proposal.",
    ].join("\n");
    expect(meeting(body, "people/alice", "people/alice")).toBe("attended");
    expect(meeting(body, "people/bob", "people/bob")).toBe("attended");
    // after the (CEO) aside the run stops — an aside is not an attendee list
    expect(meeting(body, "people/zed", "people/zed")).toBe("mentions");
    expect(meeting(body, "people/carol", "people/carol")).toBe("mentions");
  });

  it("a Participants heading and an inline Attendees: line count", () => {
    const body = "### Participants\n[[dana]], [[eve]]\n## Notes\n**Attendees:** [[frank]] & [[gina]]\nLater [[hank]] joined the thread.";
    for (const s of ["dana", "eve", "frank", "gina"]) expect(meeting(body, s, s)).toBe("attended");
    expect(meeting(body, "hank", "hank")).toBe("mentions");
  });

  it("a later attendee listing counts even when the first mention is prose", () => {
    const body = "Recap of [[people/alice]]'s talk.\n\n## Attendees\n- [[people/alice]]";
    expect(meeting(body, "people/alice", "people/alice")).toBe("attended");
  });

  it("a non-person target in the attendee list stays mentions", () => {
    const body = "## Attendees\n- [[companies/acme]]\n- [[people/alice]]";
    expect(meeting(body, "companies/acme", "companies/acme")).toBe("mentions");
  });

  it("the attendee section ends at the next same-level heading and ignores fenced code", () => {
    const body = "## Attendees\n- [[people/alice]]\n## Action items\n- [[people/bob]]\n```\n## Attendees\n- [[people/carol]]\n```";
    expect(meeting(body, "people/bob", "people/bob")).toBe("mentions");
    expect(meeting(body, "people/carol", "people/carol")).toBe("mentions");
  });
});

describe("inferLinkType — role prior skips list sections", () => {
  const target = "companies/acme";
  const bio = "She is a venture partner at the fund.\n";

  it("a company named only in a Timeline / See also list gets no prior", () => {
    const body = `${bio}\n## Timeline\n- 2024: visited [[companies/acme]]\n`;
    expect(inferLinkType("person", "visited [[companies/acme]]", body, target, target)).toBe("mentions");
    const seeAlso = `${bio}\n## See also\n- [[companies/acme]]\n`;
    expect(inferLinkType("person", "[[companies/acme]]", seeAlso, target, target)).toBe("mentions");
  });

  it("a company also named in the prose keeps the prior", () => {
    const body = `${bio}Portfolio includes [[companies/acme]] among others.\n\n## Timeline\n- [[companies/acme]]\n`;
    expect(inferLinkType("person", "among [[companies/acme]]", body, target, target)).toBe("invested_in");
  });

  it("an explicit verb inside a list section still wins", () => {
    const body = `${bio}\n## Timeline\n- 2019: co-founded [[companies/acme]]\n`;
    expect(inferLinkType("person", "co-founded [[companies/acme]]", body, target, target)).toBe("founded");
  });
});

describe("inferLinkType — role checks", () => {
  const acme = "companies/acme";

  it("a board director advises, not works at", () => {
    expect(inferLinkType("person", "She is a board director at [[companies/acme]].", undefined, acme, acme)).toBe("advises");
    expect(inferLinkType("person", "non-executive director of [[companies/acme]]", undefined, acme, acme)).toBe("advises");
    // A plain director is still employment.
    expect(inferLinkType("person", "director of engineering at [[companies/acme]]", undefined, acme, acme)).toBe("works_at");
  });

  it("an ended role stays a mention and the page prior does not restore it", () => {
    const body = "He is a senior engineer at [[companies/beta]]. He formerly worked at [[companies/acme]].";
    expect(inferLinkType("person", "He formerly worked at [[companies/acme]].", body, acme, acme)).toBe("mentions");
    expect(inferLinkType("person", "no longer works at [[companies/acme]]", undefined, acme, acme)).toBe("mentions");
    expect(inferLinkType("person", "previously at [[companies/acme]]", undefined, acme, acme)).toBe("mentions");
    expect(inferLinkType("person", "a former advisor to [[companies/acme]]", undefined, acme, acme)).toBe("mentions");
    // Founding is not undone by leaving.
    expect(inferLinkType("person", "co-founded [[companies/acme]] and later left", undefined, acme, acme)).toBe("founded");
  });

  it("spells adviser either way", () => {
    expect(inferLinkType("person", "an adviser to [[companies/acme]]", undefined, acme, acme)).toBe("advises");
    expect(inferLinkType("person", "serves as a strategic adviser", undefined, acme, acme)).toBe("advises");
  });

  it("a verb types only the wikilink nearest to it", () => {
    const ctx = "She works at [[companies/beta]] and had lunch with [[people/bob]] near [[companies/acme]].";
    expect(inferLinkType("person", ctx, undefined, acme, acme)).toBe("mentions");
    expect(inferLinkType("person", ctx, undefined, "companies/beta", "companies/beta")).toBe("works_at");
  });

  it("employment and investment need a company target", () => {
    expect(inferLinkType("person", "works at [[people/bob]]", undefined, "people/bob", "people/bob")).toBe("mentions");
    expect(inferLinkType("person", "invested in [[projects/x]]", undefined, "projects/x", "projects/x")).toBe("mentions");
    expect(inferLinkType("person", "works at [[acme]]", undefined, "acme", "acme")).toBe("works_at");
    expect(inferLinkType("person", "advises [[people/bob]]", undefined, "people/bob", "people/bob")).toBe("advises");
  });
});
