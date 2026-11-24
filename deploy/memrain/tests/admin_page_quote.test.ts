/**
 * The page view's quote highlight: a `#page/<slug>?q=<quote>` link carries the
 * passage apart from the slug, and the page finds it in its rendered text
 * nodes. Pure helpers, no DOM.
 */
import { describe, expect, it } from "bun:test";
import { locateQuote } from "../admin/src/lib/quote-find.ts";
import { buildHash, parseHash } from "../admin/src/lib/route.ts";

describe("page quote links", () => {
  it("carries a quote on a page link, apart from the slug", () => {
    const hash = buildHash({ name: "page", param: "notes/plan?v2", quote: "plant tomatoes & beans?" });
    expect(hash).toBe("#page/notes%2Fplan%3Fv2?q=plant%20tomatoes%20%26%20beans%3F");
    expect(parseHash(hash)).toEqual({ name: "page", param: "notes/plan?v2", quote: "plant tomatoes & beans?" });
    expect(parseHash("#page/notes%2Fplan")).toEqual({ name: "page", param: "notes/plan" });
    expect(parseHash("#page/notes%2Fplan?q=")).toEqual({ name: "page", param: "notes/plan" });
    expect(parseHash(buildHash({ name: "page", param: "deals/x", quote: "50% off + more" })).quote).toBe("50% off + more");
  });

  it("finds a quote across text nodes, ignoring case, spacing, curly quotes and a trailing stop", () => {
    // "The plan: **plant tomatoes**\n in May." rendered as three text nodes.
    const nodes = ["The plan: ", "plant   Tomatoes", "\n in May’s heat."];
    expect(locateQuote(nodes, "plant tomatoes in May's heat.")).toEqual({ start: [1, 0], end: [2, 15] });
    expect(locateQuote(nodes, "The plan")).toEqual({ start: [0, 0], end: [0, 8] });
    expect(locateQuote(nodes, "tomatoes in June")).toBeNull();
    expect(locateQuote(nodes, "  ")).toBeNull();
    // An elided quote highlights its first part.
    expect(locateQuote(nodes, "plant tomatoes ... heat")).toEqual({ start: [1, 0], end: [1, 16] });
    expect(locateQuote(nodes, "... plant tomatoes")).toEqual({ start: [1, 0], end: [1, 16] });
  });

  it("folds dashes and markdown marks like the server's quote check, and reads across blocks", () => {
    expect(locateQuote(["costs 5–10 euros"], "costs 5-10 euros")).toEqual({ start: [0, 0], end: [0, 16] });
    expect(locateQuote(["the ", "final", " deck"], "the **final** deck")).toEqual({ start: [0, 0], end: [2, 5] });
    // Two paragraphs: the server's check saw "is\n\nready", the page shows two blocks.
    expect(locateQuote(["The plan is", "ready for review"], "plan is ready for review")).toBeNull();
    expect(locateQuote(["The plan is", "ready for review"], "plan is ready for review", [1])).toEqual({ start: [0, 4], end: [1, 16] });
  });
});
