/**
 * The admin SPA's onboarding, tab, route and review-queue helpers
 * (admin/src/lib/*, admin-types.ts), plus a compile-time check that the
 * panel's copies of the server response types still match the server. Pure
 * modules, no DOM.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { nextTab } from "../admin/src/lib/tabs.ts";
import { CHATGPT_CALLBACK, CLAUDE_AI_CALLBACKS, buildSnippets } from "../admin/src/lib/onboarding.ts";
import { buildHash, parseHash } from "../admin/src/lib/route.ts";
import { reviewItems } from "../admin/src/admin-types.ts";
import type {
  HealthReport as AdminHealth,
  OnboardingStatus as AdminOnboarding,
} from "../admin/src/admin-types.ts";
import type { AdminHealthReport as ServerHealth } from "../src/core/admin-health.ts";
import type { OnboardingStatus as ServerOnboarding } from "../src/core/admin-onboarding.ts";

const DOCS = join(import.meta.dir, "..", "..", "..", "docs", "clients");

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

describe("routes", () => {
  it("parses and round-trips the kept routes", () => {
    for (const hash of ["#health", "#search/q", "#pages", "#page/notes%2Fa", "#agents", "#setup", "#security", "#login"]) {
      expect(buildHash(parseHash(hash))).toBe(hash);
    }
  });

  // Value: protects=an old bookmark to a page this build dropped still opens the panel;
  // fails_when=a retired route name parses as itself and renders nothing; why_new=the panel
  // cut removed those pages; seam=none
  it("opens Health for the old Overview bookmarks and for every retired page", () => {
    for (const hash of ["", "#", "#overview", "#dashboard", "#ask/t1", "#office", "#graph/x", "#approvals", "#glossary/fact"]) {
      expect(parseHash(hash)).toEqual({ name: "health", param: null });
    }
  });
});

describe("reviewItems", () => {
  // Value: protects=the Health page names what waits for the operator and the CLI that works it,
  // since the panel has no review page; fails_when=a held write or a quarantined page goes
  // unmentioned or points at the wrong command; why_new=the Approvals page is gone; seam=none
  it("names each non-empty queue with the command that works it", () => {
    expect(reviewItems({ write_gate_holds: 0, row_holds: 0, quarantined: 0 })).toEqual([]);
    expect(reviewItems({ write_gate_holds: 2, row_holds: 1, quarantined: 1 })).toEqual([
      { label: "2 writes held by the write gate", command: "memrain write-gate list" },
      { label: "1 row held by the write gate", command: "memrain write-gate rows" },
      { label: "1 page in quarantine, hidden from search", command: "memrain quarantine list" },
    ]);
  });
});

// The panel keeps its own copies of the server response types. Assigning each
// way makes `bun run typecheck` fail when one side changes without the other.
const _healthToAdmin: AdminHealth = {} as ServerHealth;
const _healthToServer: ServerHealth = {} as AdminHealth;
const _onbToAdmin: AdminOnboarding = {} as ServerOnboarding;
const _onbToServer: ServerOnboarding = {} as AdminOnboarding;
void [_healthToAdmin, _healthToServer, _onbToAdmin, _onbToServer];
