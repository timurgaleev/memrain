/**
 * The admin SPA's chart, layout, onboarding and glossary modules
 * (admin/src/lib/*), plus a compile-time check that the panel's copies of the
 * server response types still match the server. Pure modules, no DOM.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  areaPath,
  fitSpan,
  keyIndex,
  linePath,
  nearestIndex,
  niceTicks,
  partialDayTotals,
  pctChange,
} from "../admin/src/lib/chart.ts";
import { nextTab } from "../admin/src/lib/tabs.ts";
import { GRAPH_VIEW_LIMIT, MAX_NODES, graphTruncated, labelScale, ringLayout } from "../admin/src/lib/ring-layout.ts";
import type { NeighborEdge } from "../admin/src/lib/tool-result.ts";
import { CHATGPT_CALLBACK, CLAUDE_AI_CALLBACKS, buildSnippets } from "../admin/src/lib/onboarding.ts";
import { GLOSSARY, METRIC_HELP } from "../admin/src/lib/glossary.ts";
import { buildHash, parseHash } from "../admin/src/lib/route.ts";
import { readRange } from "../admin/src/lib/range.ts";
import type {
  AdminTimeseries as AdminTs,
  GraphHubs as AdminHubs,
  OnboardingStatus as AdminOnboarding,
} from "../admin/src/admin-types.ts";
import type { AdminTimeseries as ServerTs } from "../src/core/admin-timeseries.ts";
import type { GraphHubs as ServerHubs } from "../src/core/links.ts";
import type { OnboardingStatus as ServerOnboarding } from "../src/core/admin-onboarding.ts";

const DOCS = join(import.meta.dir, "..", "..", "..", "docs", "clients");

describe("chart geometry", () => {
  it("niceTicks covers the maximum in 1/2/5 steps from 0", () => {
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(niceTicks(7, 4)).toEqual([0, 2, 4, 6, 8]);
    const t = niceTicks(0.37);
    expect(t[0]).toBe(0);
    expect(t[t.length - 1]).toBeGreaterThanOrEqual(0.37);
    const step = (t[1] as number) - (t[0] as number);
    const mant = step / 10 ** Math.floor(Math.log10(step));
    expect([1, 2, 5].some((n) => Math.abs(mant - n) < 1e-9)).toBe(true);
    for (let i = 1; i < t.length; i++) expect(t[i] as number).toBeGreaterThan(t[i - 1] as number);
  });

  it("linePath and areaPath break at a null point", () => {
    const pts = [{ x: 0, y: 1 }, null, { x: 2, y: 3 }];
    const line = linePath(pts);
    expect(line.match(/M/g)?.length).toBe(2);
    expect(line).toBe("M0,1M2,3");
    const area = areaPath(pts, 10);
    expect(area.match(/Z/g)?.length).toBe(2);
    // Each run closes to the baseline on its own and never spans the gap.
    expect(area).toBe("M0,10L0,1L0,10ZM2,10L2,3L2,10Z");
  });

  it("nearestIndex clamps at both ends and takes the lower index on a tie", () => {
    const xs = [10, 20, 30];
    expect(nearestIndex(xs, -100)).toBe(0);
    expect(nearestIndex(xs, 1000)).toBe(2);
    expect(nearestIndex(xs, 15)).toBe(0);
    expect(nearestIndex([], 5)).toBe(-1);
  });

  it("pctChange is null without an earlier value", () => {
    expect(pctChange(10, 0)).toBeNull();
    expect(pctChange(0, 0)).toBeNull();
    expect(pctChange(15, 10)).toBe(0.5);
  });

  it("keyIndex steps, clamps, jumps and clears", () => {
    expect(keyIndex("ArrowRight", null, 5)).toBe(0);
    expect(keyIndex("ArrowRight", 4, 5)).toBe(4);
    expect(keyIndex("ArrowLeft", 0, 5)).toBe(0);
    expect(keyIndex("ArrowLeft", null, 5)).toBe(4);
    expect(keyIndex("Home", 3, 5)).toBe(0);
    expect(keyIndex("End", 0, 5)).toBe(4);
    expect(keyIndex("Escape", 2, 5)).toBeNull();
  });

  it("fitSpan keeps a span inside the bounds", () => {
    // A 300px popover opened from x=90 on a 375px phone.
    const left = fitSpan(90 - 8, 300, 16, 375 - 16);
    expect(left).toBeGreaterThanOrEqual(16);
    expect(left + 300).toBeLessThanOrEqual(375 - 16);
    expect(fitSpan(-50, 100, 8, 400)).toBe(8);
    expect(fitSpan(40, 100, 8, 400)).toBe(40);
  });
});

describe("partialDayTotals", () => {
  it("counts today in the total and compares completed days only", () => {
    const r = partialDayTotals([4, 6, 5], 5);
    expect(r.total).toBe(15);
    expect(r.change).toBe(1);
  });

  it("a brain whose only searches ran today is not empty", () => {
    const r = partialDayTotals([0, 0, 0, 3], 0);
    expect(r.total).toBe(3);
    expect(r.change).toBeNull();
  });
});

describe("tabs", () => {
  it("nextTab wraps the arrows and jumps on Home/End", () => {
    expect(nextTab("ArrowRight", 2, 3)).toBe(0);
    expect(nextTab("ArrowLeft", 0, 3)).toBe(2);
    expect(nextTab("Home", 2, 3)).toBe(0);
    expect(nextTab("End", 0, 3)).toBe(2);
    expect(nextTab("Enter", 1, 3)).toBeNull();
    expect(nextTab("ArrowRight", 0, 0)).toBeNull();
  });
});

function edge(source: string, target: string, type: string): NeighborEdge {
  return { id: `${source}>${target}:${type}`, source_slug: source, target_slug: target, type, confidence: null, context: null, direction: "outbound" };
}

describe("ringLayout", () => {
  it("places one, two and three neighbours", () => {
    expect(ringLayout("c", [edge("c", "a", "x")], 100).nodes.map((n) => n.angle)).toEqual([0]);
    expect(ringLayout("c", [edge("c", "a", "x"), edge("c", "b", "x")], 100).nodes.map((n) => n.angle)).toEqual([0, Math.PI]);
    expect(ringLayout("c", [edge("c", "a", "x"), edge("c", "b", "x"), edge("c", "d", "x")], 100).nodes[0]?.angle).toBe(-Math.PI / 2);
  });

  it("merges a mutual pair only when the type matches", () => {
    const same = ringLayout("A", [edge("A", "B", "wikilink"), edge("B", "A", "wikilink")], 100);
    expect(same.edges).toHaveLength(1);
    expect(same.edges[0]?.both).toBe(true);

    const mixed = ringLayout("A", [edge("A", "B", "wikilink"), edge("B", "A", "mentions")], 100);
    expect(mixed.edges).toHaveLength(2);
    expect(mixed.edges.every((e) => !e.both)).toBe(true);
    expect(new Set(mixed.edges.map((e) => e.type)).size).toBe(2);
    expect(new Set(mixed.edges.map((e) => e.offset)).size).toBe(2);
    expect(mixed.types).toEqual(["mentions", "wikilink"]);

    const parallel = ringLayout("A", [edge("A", "B", "wikilink"), edge("A", "B", "mentions")], 100);
    expect(parallel.edges).toHaveLength(2);
  });

  it("keeps a +N more bucket past the node limit", () => {
    const edges: NeighborEdge[] = [];
    for (let t = 0; t < 6; t++) {
      for (let i = 0; i < 8; i++) edges.push(edge("c", `t${t}/n${i}`, `type${t}`));
    }
    const { nodes } = ringLayout("c", edges, 100);
    const shown = nodes.filter((n) => n.slug !== null);
    expect(shown.length).toBeLessThanOrEqual(MAX_NODES);
    const buckets = nodes.filter((n) => n.slug === null);
    expect(buckets.length).toBeGreaterThan(0);
    const hidden = buckets.reduce((a, n) => a + Number(n.label.match(/\d+/)?.[0] ?? 0), 0);
    expect(shown.length + hidden).toBe(48);
  });

  it("graphTruncated flags only a response over the view limit", () => {
    const of = (n: number) => Array.from({ length: n }).fill(0);
    expect(graphTruncated(of(GRAPH_VIEW_LIMIT - 1), GRAPH_VIEW_LIMIT)).toBe(false);
    expect(graphTruncated(of(GRAPH_VIEW_LIMIT), GRAPH_VIEW_LIMIT)).toBe(false);
    expect(graphTruncated(of(GRAPH_VIEW_LIMIT + 1), GRAPH_VIEW_LIMIT)).toBe(true);
  });

  it("labelScale grows labels on a narrow drawing and hides them on a phone", () => {
    expect(labelScale(760, 640, 12)).toEqual({ scale: 760 / 640, hide: false });
    const mid = labelScale(760, 550, 12);
    expect(mid.hide).toBe(false);
    expect((12 * mid.scale * 550) / 760).toBeGreaterThanOrEqual(9);
    expect(labelScale(760, 310, 12).hide).toBe(true);
    expect(labelScale(760, 0, 12)).toEqual({ scale: 1, hide: false });
    expect(labelScale(760, 2000, 12).scale).toBe(1);
  });
});

describe("buildSnippets", () => {
  const url = "https://brain.example.test/mcp";
  const s = buildSnippets(url);

  it("puts the MCP URL in every snippet", () => {
    expect(s.claudeCode).toContain(url);
    expect(s.claudeAi.join("\n")).toContain(url);
    expect(s.chatgpt.join("\n")).toContain(url);
  });

  it("uses only Claude Code flags the client doc shows", () => {
    const doc = readFileSync(join(DOCS, "CLAUDE_CODE.md"), "utf8");
    expect(doc).toContain("claude mcp add");
    const flags = s.claudeCode.match(/--[a-z-]+/g) ?? [];
    expect(flags.length).toBeGreaterThan(0);
    for (const f of flags) expect(doc).toContain(f);
  });

  it("uses the callback URLs the client docs register", () => {
    const claudeAi = readFileSync(join(DOCS, "CLAUDE_AI.md"), "utf8");
    for (const cb of CLAUDE_AI_CALLBACKS) expect(claudeAi).toContain(cb);
    expect(readFileSync(join(DOCS, "CHATGPT.md"), "utf8")).toContain(CHATGPT_CALLBACK);
    expect(s.claudeAi.join("\n")).toContain(CLAUDE_AI_CALLBACKS[0]);
    expect(s.chatgpt.join("\n")).toContain(CHATGPT_CALLBACK);
  });
});

describe("glossary", () => {
  it("every help entry names an existing term, and term ids are unique", () => {
    const ids = GLOSSARY.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const h of Object.values(METRIC_HELP)) expect(ids).toContain(h.term);
    for (const g of GLOSSARY) for (const see of g.see ?? []) expect(ids).toContain(see);
  });
});

describe("routes", () => {
  it("parses and round-trips the glossary and setup routes", () => {
    for (const hash of ["#glossary", "#glossary/fact", "#setup"]) {
      const r = parseHash(hash);
      expect(r.name).toBe(hash.startsWith("#setup") ? "setup" : "glossary");
      expect(buildHash(r)).toBe(hash);
    }
    expect(parseHash("#glossary/fact").param).toBe("fact");
  });
});

describe("readRange", () => {
  const store = (v: string | null) => ({ getItem: () => v });

  it("falls back to 30 for a missing, invalid or throwing value", () => {
    expect(readRange(null)).toBe(30);
    expect(readRange(store(null))).toBe(30);
    expect(readRange(store("14"))).toBe(30);
    expect(readRange(store("abc"))).toBe(30);
    expect(readRange({ getItem: () => { throw new Error("blocked"); } })).toBe(30);
  });

  it("returns a stored 7, 30 or 90", () => {
    expect(readRange(store("7"))).toBe(7);
    expect(readRange(store("30"))).toBe(30);
    expect(readRange(store("90"))).toBe(90);
  });
});

// The panel keeps its own copies of the server response types. Assigning each
// way makes `bun run typecheck` fail when one side changes without the other.
const _tsToAdmin: AdminTs = {} as ServerTs;
const _tsToServer: ServerTs = {} as AdminTs;
const _hubsToAdmin: AdminHubs = {} as ServerHubs;
const _hubsToServer: ServerHubs = {} as AdminHubs;
const _onbToAdmin: AdminOnboarding = {} as ServerOnboarding;
const _onbToServer: ServerOnboarding = {} as AdminOnboarding;
void [_tsToAdmin, _tsToServer, _hubsToAdmin, _hubsToServer, _onbToAdmin, _onbToServer];
