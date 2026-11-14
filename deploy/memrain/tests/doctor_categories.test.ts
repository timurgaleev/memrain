/**
 * Doctor taxonomy — unit tests for the category sets + categorize(), and for
 * the three-state verdict vocabulary (worstStatus / couldNotCheck) the report
 * rolls up. The end-to-end drift guards (every check the doctor emits is
 * categorized, and no check reports `ok` from a catch path) live in
 * doctor.test.ts, which runs the real runDoctor.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  BRAIN_CHECK_NAMES,
  OPS_CHECK_NAMES,
  KNOWN_CHECK_NAMES,
  categorize,
  couldNotCheck,
  worstStatus,
  _resetCategoryWarnings,
  type CheckStatus,
} from "../src/core/doctor-categories.ts";

// The `warned` Set is process-global; an earlier test file may have populated
// it before this file runs (bun test shares one process). Reset on BOTH sides
// so the warn-once assertion is robust to file ordering.
beforeEach(() => _resetCategoryWarnings());
afterEach(() => _resetCategoryWarnings());

describe("doctor categorize", () => {
  it("maps brain checks to 'brain'", () => {
    for (const n of BRAIN_CHECK_NAMES) expect(categorize(n)).toBe("brain");
  });

  it("maps ops checks to 'ops'", () => {
    for (const n of OPS_CHECK_NAMES) expect(categorize(n)).toBe("ops");
  });

  it("KNOWN_CHECK_NAMES is the union of every category set", () => {
    expect([...KNOWN_CHECK_NAMES].sort()).toEqual([
      "chronicle-projection-health",
      "chunker-version-lag",
      "code-grammars",
      "code-graph",
      "config",
      "config-yml",
      "connector-accounts",
      "connector-health",
      "contextual-coverage",
      "contradiction-trend",
      "cycle-freshness",
      "cycle-phase-health",
      "dangling-slug-redirects",
      "db-backends",
      "db-connection-budget",
      "document-id-drift",
      "duplicate-pages",
      "embed-backlog",
      "embedding-width",
      "eval-trend",
      "facts-input-windows",
      "facts-without-entity-pages",
      "federation-health",
      "fence-rows-without-markers",
      "index-spread",
      "invalid-indexes",
      "jsonb-integrity",
      "junk-entity-hubs",
      "legacy-config-dir",
      "legacy-env-names",
      "link-interval-overlaps",
      "links-extraction-lag",
      "maintenance-held",
      "mixed-script-targets",
      "namespace-only-targets",
      "oauth-client-health",
      "oauth-client-hygiene",
      "oauth-self-issued-config",
      "outside-content-fences",
      "page-version-storage",
      "pat-scopes-recorded",
      "per-source-embed-coverage",
      "person-name-duplicates",
      "pglite",
      "planner-stats",
      "quarantined-pages",
      "queue-health",
      "redaction-markers",
      "runtime-config-legacy-rows",
      "runtime-config-overlay",
      "runtime-config-values",
      "schema-version",
      "secret-exposure",
      "skillpack",
      "source-health",
      "source-routing-health",
      "stale-locks",
      "stats",
      // Pushed only when teardown FAILS, so a healthy run never carries it —
      // it is named in OPS so the categorizer does not bucket it as `meta`
      // with an "uncategorized" warning at the moment something is wrong.
      "storage-teardown",
      "tenancy-isolation-config",
      "vault",
    ]);
  });

  it("falls through to 'meta' for an unknown name and warns once", () => {
    const errs: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => {
      errs.push(a.map(String).join(" "));
    };
    try {
      expect(categorize("totally-new-check")).toBe("meta");
      expect(categorize("totally-new-check")).toBe("meta"); // second call: no new warn
    } finally {
      console.error = orig;
    }
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("uncategorized");
  });
});

describe("worstStatus", () => {
  it("is ok only when every status is ok", () => {
    expect(worstStatus([])).toBe("ok");
    expect(worstStatus(["ok", "ok"])).toBe("ok");
  });

  it("lets a single warn win over any number of oks", () => {
    expect(worstStatus(["ok", "warn", "ok"])).toBe("warn");
  });

  it("lets fail win over warn, in either order", () => {
    expect(worstStatus(["warn", "fail"])).toBe("fail");
    expect(worstStatus(["fail", "warn"])).toBe("fail");
  });

  it("agrees with the cycle's own rollup rule on every combination", () => {
    // The doctor deliberately reuses PhaseStatus semantics: fail > warn > ok.
    const all: CheckStatus[] = ["ok", "warn", "fail"];
    for (const a of all) {
      for (const b of all) {
        const expected = [a, b].includes("fail")
          ? "fail"
          : [a, b].includes("warn")
            ? "warn"
            : "ok";
        expect(worstStatus([a, b])).toBe(expected);
      }
    }
  });
});

describe("couldNotCheck", () => {
  it("is a warn that keeps the exit code green and names the failure", () => {
    const c = couldNotCheck("queue-health", new Error("relation does not exist"));
    expect(c.status).toBe("warn"); // never "ok" — nothing was measured
    expect(c.ok).toBe(true); // …and a warn never flips the process to exit 1
    expect(c.name).toBe("queue-health");
    expect(c.detail).toBe(
      "could not check queue-health: relation does not exist",
    );
  });

  it("carries a hint and survives a non-Error throw", () => {
    const c = couldNotCheck("chronicle-projection-health", "boom", "pre-migration schema?");
    expect(c.detail).toBe(
      "could not check chronicle-projection-health: boom (pre-migration schema?)",
    );
  });
});
