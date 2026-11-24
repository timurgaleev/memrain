/**
 * The modules this build keeps import nothing from the feature code it drops:
 * synthesis, connectors, the job runtime, members, groups and the extension
 * registry. A kept module that still reached into one of them would either
 * break when that code goes or keep a dropped feature half alive.
 *
 * "Kept" is every file under src/ that is not on the removal list below. The
 * removal list is the set of modules and commands this build retires. Every one
 * of them is deleted, and no kept module is exempt from the boundary.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";

const SRC = join(import.meta.dir, "../src");

/** Imports no kept module may make. */
function forbidden(target: string): boolean {
  return /^core\/(synthesis|connectors|jobs)\//.test(target) ||
    ["core/members.ts", "core/groups.ts", "core/extension.ts"].includes(target);
}

/** Directories this build retires whole. */
const REMOVED_DIRS = [
  "core/synthesis/", "core/connectors/", "core/jobs/", "core/chat/", "core/daemons/", "core/loops/",
  "core/notifications/", "core/advisor/", "core/skillopt/", "core/skillpack/", "core/agent/", "core/bench/",
  "core/feedback/", "core/cycle/", "core/context/", "core/chronicle/", "core/search/stages/", "eval/", "recipes/",
];

/** Single modules this build retires. */
const REMOVED_FILES = new Set([
  "core/gazetteer.ts", "core/typed-links.ts", "core/link-verb-infer.ts", "core/page-retype.ts",
  "core/contextual-reembed.ts", "core/chunkers/code.ts", "core/sweep-code.ts", "core/indexer-code.ts",
  "core/trust-proposals.ts", "core/trust-derived.ts", "core/token-min-trust.ts", "core/typed-conflicts.ts",
  "core/members.ts", "core/groups.ts", "core/grant-profiles.ts", "core/member-offboarding.ts", "core/brain-owner.ts",
  "core/owner-identity.ts", "core/spend-notice.ts", "core/spend-report.ts", "core/request-cost.ts",
  "core/hot_memory.ts", "core/insights.ts", "core/usage-insights.ts", "core/salience-score.ts", "core/extension.ts",
  "core/doctor-tenancy.ts", "core/throttle.ts", "core/llm/haiku.ts", "core/llm/sonnet.ts", "core/llm/converse.ts",
  "core/transcripts/push.ts",
  "mcp/read-floor.ts", "mcp/caller-capabilities.ts", "mcp/tool-catalog.ts",
  "http/ingest.ts", "http/share.ts", "http/chat-api.ts", "http/feedback-api.ts", "http/admin-office.ts",
  "http/admin-events.ts", "http/admin-eval.ts", "http/admin-connectors.ts", "http/admin-members.ts",
  "http/admin-approvals.ts", "http/admin-notifications.ts", "http/admin-autonomy.ts",
  "core/admin-timeseries.ts",
]);

/** Name prefixes of retired core modules (facts, chronicle, timeline, code, entities, ontology, eval). */
const REMOVED_PREFIXES = [
  "core/facts", "core/chronicle", "core/timeline", "core/code-", "core/entity-",
  "core/ontology-", "core/eval-",
];
/** fact-* modules go too, except the withdrawal ledger a rename carries along. */
const KEPT_DESPITE_PREFIX = new Set(["core/fact-withdrawals.ts"]);

/** The search modules the rewritten hybrid search keeps; every other search module goes. */
const KEPT_SEARCH = new Set([
  "hybrid.ts", "keyword.ts", "vector.ts", "filters.ts", "exact.ts", "dedup.ts", "token-budget.ts", "snippet-cap.ts",
  "page-fusion.ts", "search-meta.ts", "curation.ts", "page-slug.ts", "identifier-probe.ts",
]);

/** The commands this build keeps; every other command goes. */
const KEPT_COMMANDS = new Set([
  "init", "serve", "export", "backup", "config", "apply-migrations", "engine-status", "with-storage", "rename", "doctor",
  "auth", "status", "reindex", "embed", "import", "sources", "quarantine", "write-gate", "secrets", "transcripts",
  "admin", "erase", "purge-leftovers", "remote-doctor",
]);

function removed(file: string): boolean {
  if (REMOVED_DIRS.some((d) => file.startsWith(d)) || REMOVED_FILES.has(file)) return true;
  if (KEPT_DESPITE_PREFIX.has(file)) return false;
  if (REMOVED_PREFIXES.some((p) => file.startsWith(p)) || file.startsWith("core/fact-")) return true;
  if (file.startsWith("core/search/")) return !KEPT_SEARCH.has(file.slice("core/search/".length));
  if (file.startsWith("commands/")) {
    const name = file.slice("commands/".length).replace(/\.ts$/, "");
    return !KEPT_COMMANDS.has(name) && !name.startsWith("doctor");
  }
  return false;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*)["']([^"']+)["']/g;

function importsOf(path: string): string[] {
  const text = readFileSync(path, "utf8");
  return [...text.matchAll(SPECIFIER)]
    .map((m) => m[1]!)
    .filter((s) => s.startsWith("."))
    .map((s) => normalize(relative(SRC, join(dirname(path), s))));
}

describe("kept modules import no retired feature code", () => {
  const files = walk(SRC).map((p) => ({ path: p, rel: relative(SRC, p) }));

  // Value: protects=the kept core stands without synthesis, connectors, jobs, members,
  // groups and the extension registry; fails_when=a kept module imports one of them;
  // why_new=nothing enforced the boundary before the cut; seam=none
  it("no kept module imports one", () => {
    const violations = files
      .filter((f) => !removed(f.rel))
      .flatMap((f) => importsOf(f.path).filter(forbidden).map((t) => `${f.rel} -> ${t}`));
    expect(violations).toEqual([]);
  });

  // Value: protects=a retired module does not linger as dead or half-wired code;
  // fails_when=a module on the removal list exists again; why_new=the cut deleted them; seam=none
  it("every retired module is gone", () => {
    expect(files.filter((f) => removed(f.rel)).map((f) => f.rel)).toEqual([]);
  });
});
