/**
 * CLI argument parsing.
 *
 * Both defects below turned a typo into a silent, wrong, sometimes expensive
 * run — so each case here is written against the OLD parser's behaviour, which
 * is reproduced verbatim in `oldParseArgs` so the guard can be shown to be real
 * rather than decorative.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseArgs,
  COMMAND_FLAGS,
  SAFETY_FLAG_COMMANDS,
  VALUELESS_FLAGS,
  VALUE_FLAGS,
  KNOWN_FLAGS,
  JSON_GUARDED_COMMANDS,
} from "../src/cli-args.ts";

/** The parser exactly as it shipped before this file existed (cli.ts:85-106). */
function oldParseArgs(raw: readonly string[]) {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const positional: string[] = [];
  const cmd = raw[0];
  for (let i = 1; i < raw.length; i++) {
    const token = raw[i];
    if (!token) continue;
    if (token.startsWith("--")) {
      const next = raw[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        values.set(token, next);
        i++;
      } else {
        flags.add(token);
      }
    } else {
      positional.push(token);
    }
  }
  return { cmd, flags, values, positional };
}

describe("boolean flags never consume a positional (CLI-2)", () => {
  it("retains pinned repair and import plans alongside apply", () => {
    const hash = "b".repeat(64);
    for (const argv of [
      ["import", "--dir", "/export", "--source", "team", "--apply", "--plan-hash", hash],
      ["transcripts", "repair-origin", "/session.jsonl", "--source", "team", "--apply", "--plan-hash", hash],
      ["mirror-adopt", "--source", "team", "--limit", "1", "--apply", "--plan-hash", hash],
    ]) {
      const parsed = parseArgs(argv);
      expect(parsed.values.get("--plan-hash")).toBe(hash);
      expect(parsed.values.get("--source")).toBe("team");
      expect(parsed.flags.has("--apply")).toBe(true);
    }
  });

  it("retains the exact rechunk plan and zero-dollar code budget", () => {
    const hash = "a".repeat(64);
    const parsed = parseArgs(["reindex", "--rechunk-stale", "--source", "code", "--plan-hash", hash, "--max-cost-usd", "0"]);
    expect(parsed.flags.has("--rechunk-stale")).toBe(true);
    expect(parsed.values.get("--plan-hash")).toBe(hash);
    expect(parsed.values.get("--max-cost-usd")).toBe("0");
    expect(parsed.positional).toEqual([]);
  });

  it("keeps the slug AND the dry-run for `embed --dry-run <slug>`", () => {
    // The old parser turned this into values={'--dry-run': 'notes/x'} with an
    // EMPTY flag set, so embed ran a real, paid, whole-corpus backfill.
    const old = oldParseArgs(["embed", "--dry-run", "notes/x"]);
    expect(old.flags.has("--dry-run")).toBe(false);
    expect(old.positional).toEqual([]);

    const now = parseArgs(["embed", "--dry-run", "notes/x"]);
    expect(now.flags.has("--dry-run")).toBe(true);
    expect(now.positional).toEqual(["notes/x"]);
  });

  it("is order-independent", () => {
    const a = parseArgs(["embed", "--dry-run", "notes/x"]);
    const b = parseArgs(["embed", "notes/x", "--dry-run"]);
    expect(a.positional).toEqual(b.positional);
    expect(a.flags.has("--dry-run")).toBe(b.flags.has("--dry-run"));
  });

  it("leaves value-taking flags alone", () => {
    const r = parseArgs(["search", "--k", "5", "hello"]);
    expect(r.values.get("--k")).toBe("5");
    expect(r.positional).toEqual(["hello"]);
  });
});

describe("--key=value is split (CLI-3)", () => {
  it("reads the value instead of dropping it", () => {
    // Worse than losing the flag: the old parser treated the whole `--k=5`
    // token as a key and then ate the QUERY as its value, so the search ran
    // with the default k and no search term at all.
    const old = oldParseArgs(["search", "--k=5", "hello"]);
    expect(old.values.get("--k")).toBeUndefined();
    expect(old.values.get("--k=5")).toBe("hello");
    expect(old.positional).toEqual([]);

    const now = parseArgs(["search", "--k=5", "hello"]);
    expect(now.values.get("--k")).toBe("5");
    expect(now.positional).toEqual(["hello"]);
  });

  it("splits on the first '=' only, so values may contain more", () => {
    const r = parseArgs(["call", "--args={\"a\":\"b=c\"}"]);
    expect(r.values.get("--args")).toBe('{"a":"b=c"}');
  });

  it("accepts explicit boolean literals", () => {
    expect(parseArgs(["reindex", "--force=true"]).flags.has("--force")).toBe(true);
    expect(parseArgs(["reindex", "--force=false"]).flags.has("--force")).toBe(false);
  });

  it("REFUSES a bare `--flag=` rather than guessing ON", () => {
    // An unset shell variable expands to nothing: `--force=$MODE` -> `--force=`.
    // Guessing ON there arms a destructive mode by accident.
    expect(() => parseArgs(["reindex", "--force="])).toThrow(/boolean flag/);
  });
});

describe("VALUELESS_FLAGS stays in sync", () => {
  it("contains the destructive booleans", () => {
    for (const f of ["--force", "--apply", "--fix", "--dry-run"]) {
      expect(VALUELESS_FLAGS.has(f)).toBe(true);
    }
  });

  it("does not contain value-taking near-twins", () => {
    for (const f of ["--limit", "--stale-days", "--k"]) {
      expect(VALUELESS_FLAGS.has(f)).toBe(false);
    }
  });
});

describe("strict flag validation", () => {
  it("refuses a misspelled flag and points at the real one", () => {
    expect(() => parseArgs(["embed", "--dry-runn"])).toThrow(
      /unknown flag '--dry-runn' — did you mean --dry-run\?/,
    );
    expect(() => parseArgs(["search", "--kk", "5"])).toThrow(/unknown flag '--kk'/);
  });

  it("refuses a safety flag on a command that would ignore it", () => {
    // The dangerous case is a CORRECTLY spelled flag the command drops: the
    // caller reads "preview", the command does the real thing.
    expect(() => parseArgs(["search", "--dry-run", "q"])).toThrow(
      /--dry-run is not supported by 'search'/,
    );
    expect(() => parseArgs(["embed", "--dry-run"])).not.toThrow();
  });

  it("accepts every flag the CLI actually reads", () => {
    for (const f of VALUELESS_FLAGS) expect(KNOWN_FLAGS.has(f)).toBe(true);
    for (const f of VALUE_FLAGS) expect(KNOWN_FLAGS.has(f)).toBe(true);
  });

  it("can be switched off for callers that parse foreign argv", () => {
    const r = parseArgs(["embed", "--not-a-memex-flag"], { strict: false });
    expect(r.flags.has("--not-a-memex-flag")).toBe(true);
  });
});

describe("SAFETY_FLAG_COMMANDS is derived from cli.ts, not hand-maintained", () => {
  // Hand-listing which commands honour --dry-run/--apply/--fix is exactly what
  // shipped a regression: `lint --dry-run`, `migrate-engine --dry-run` and
  // `quarantine scan --apply` were all real and all refused. The truth lives in
  // the command switch, so read it from there.
  const source = readFileSync(
    join(import.meta.dir, "..", "src", "cli.ts"),
    "utf8",
  );

  const authSource = readFileSync(
    join(import.meta.dir, "..", "src", "commands", "auth.ts"),
    "utf8",
  );

  function ownersOf(flag: string): string[] {
    const parts = source.split(/\n    case "([a-z0-9-]+)":/);
    const bodies = new Map<string, string>();
    for (let i = 1; i < parts.length; i += 2) {
      const cmd = parts[i]!;
      bodies.set(cmd, (bodies.get(cmd) ?? "") + parts[i + 1]!);
    }
    const owners = [...bodies]
      .filter(([, body]) => body.includes(`flags.has("${flag}")`))
      .map(([cmd]) => cmd);
    // `auth` re-parses its own raw argv, so its reads live in auth.ts.
    if (authSource.includes(`flags["${flag.slice(2)}"]`)) owners.push("auth");
    return owners.sort();
  }

  for (const flag of ["--dry-run", "--apply", "--fix"]) {
    it(`lists exactly the commands that read ${flag}`, () => {
      const declared = [...(SAFETY_FLAG_COMMANDS.get(flag) ?? [])].sort();
      expect(declared).toEqual(ownersOf(flag));
    });
  }

  it("accepts the invocations the first hand-written list refused", () => {
    for (const argv of [
      ["lint", "--dry-run"],
      ["lint", "--fix"],
      ["migrate-engine", "--dry-run"],
      ["quarantine", "scan", "--apply"],
      ["eval-prune", "--apply"],
    ]) {
      expect(() => parseArgs(argv)).not.toThrow();
    }
  });

  it("still refuses a safety flag on a command that ignores it", () => {
    expect(() => parseArgs(["doctor", "--fix"])).toThrow(/not supported by 'doctor'/);
  });
});

describe("--json on the guarded commands", () => {
  it("is accepted by every guarded command, whether or not its case reads it", () => {
    for (const cmd of JSON_GUARDED_COMMANDS) {
      expect(() => parseArgs([cmd, "--json"])).not.toThrow();
    }
  });

  it("is still refused by a command outside the guarded set", () => {
    expect(() => parseArgs(["reindex", "--json"])).toThrow(/unknown flag '--json'/);
  });
});

describe("the accepted vocabulary is per command (CLI-4)", () => {
  it("accepts the doctor self-heal flags a global vocabulary refused", () => {
    // These are read inside runDoctor (off process.argv), so a union-of-all
    // -commands check called every one of them a typo and left the entire
    // remediation surface unreachable from the CLI.
    for (const argv of [
      ["doctor", "--remediation-plan"],
      ["doctor", "--remediate"],
      ["doctor", "--remediate", "--execute"],
      ["doctor", "--remediate", "--yes"],
    ]) {
      expect(() => parseArgs(argv)).not.toThrow();
    }
    expect(parseArgs(["doctor", "--remediate", "--max-jobs", "3"]).values.get("--max-jobs"))
      .toBe("3");
  });

  it("refuses a real flag on a command that never reads it", () => {
    // `reindex` has no --stale (that is embed/extract), so it was accepted and
    // dropped: the caller asked for a stale-only pass and got a full one.
    expect(() => parseArgs(["reindex", "--stale"])).toThrow(
      /unknown flag '--stale'/,
    );
    expect(() => parseArgs(["reindex", "--stale"])).toThrow(
      /'reindex' accepts: .*--rechunk-stale/,
    );
    // …and stays legal on the commands that do read it.
    expect(() => parseArgs(["embed", "--stale"])).not.toThrow();
    expect(() => parseArgs(["extract", "--stale"])).not.toThrow();
  });

  it("names the command and what it takes when the command takes nothing", () => {
    expect(() => parseArgs(["orphans", "--json"])).toThrow(
      /unknown flag '--json' \('orphans' takes no flags\)/,
    );
  });

  it("accepts the auth flags auth parses for itself", () => {
    // `auth` re-parses the raw tail, so none of its flags appear in the switch
    // — the global set never learned them and every auth invocation with a
    // flag died before reaching runAuth.
    expect(() =>
      parseArgs(["auth", "register-client", "cc", "--scopes", "read", "--source", "s"]),
    ).not.toThrow();
    expect(() => parseArgs(["auth", "test", "https://x", "--token", "t"])).not.toThrow();
  });

  it("suggests only flags the command would then accept", () => {
    expect(() => parseArgs(["embed", "--stalee"])).toThrow(/did you mean --stale\?/);
    // reindex does not read --stale, so pointing at it would be a second dead
    // end rather than a fix.
    let msg = "";
    try {
      parseArgs(["reindex", "--stalee"]);
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toMatch(/unknown flag '--stalee'/);
    expect(msg).not.toMatch(/did you mean --stale\?/);
  });

  it("answers --help everywhere without listing it per command", () => {
    for (const cmd of ["watch", "reindex", "orphans", "auth"]) {
      expect(() => parseArgs([cmd, "--help"])).not.toThrow();
      expect(COMMAND_FLAGS.get(cmd)?.has("--help")).toBe(false);
    }
  });

  it("falls back to the global vocabulary for an unknown command", () => {
    // cli.ts owns the "unknown command" message; hijacking it with a flag
    // complaint would name the wrong problem.
    expect(() => parseArgs(["frobnicate", "--k", "5"])).not.toThrow();
    expect(() => parseArgs(["frobnicate", "--kk", "5"])).toThrow(/unknown flag '--kk'/);
  });
});

describe("a value-taking flag given no value is an error (CLI-5)", () => {
  it("refuses `reindex --vault --all` instead of reindexing the default vault", () => {
    // Both tokens land in `flags` — the parser deliberately will not let
    // --vault eat --all — and reindex then ran on defaults with no complaint.
    const loose = parseArgs(["reindex", "--vault", "--all"], { strict: false });
    expect(loose.flags.has("--vault")).toBe(true);
    expect(loose.values.has("--vault")).toBe(false);

    expect(() => parseArgs(["reindex", "--vault", "--all"])).toThrow(
      /memrain reindex: --vault requires a value/,
    );
  });

  it("fires at the end of the line too", () => {
    expect(() => parseArgs(["search", "hello", "--k"])).toThrow(
      /memrain search: --k requires a value/,
    );
  });

  it("does NOT fire for a boolean flag followed by a positional", () => {
    // The v1.110.0 fix: a boolean is a boolean wherever it sits, so --dry-run
    // must not be read as "value-taking flag missing its value" here.
    const r = parseArgs(["embed", "--dry-run", "notes/x"]);
    expect(r.flags.has("--dry-run")).toBe(true);
    expect(r.positional).toEqual(["notes/x"]);
    expect(() => parseArgs(["reindex", "--all"])).not.toThrow();
    expect(() => parseArgs(["extract", "--stale", "--dry-run"])).not.toThrow();
  });

  it("covers the checks the command cases used to carry one by one", () => {
    // salience/cycle/embed each hand-rolled this guard for their own flags;
    // every other command had none. It belongs to the parser, once.
    expect(() => parseArgs(["salience", "--type"])).toThrow(
      /memrain salience: --type requires a value/,
    );
    expect(() => parseArgs(["cycle", "--phases"])).toThrow(
      /memrain cycle: --phases requires a value/,
    );
    expect(() => parseArgs(["embed", "--limit"])).toThrow(
      /memrain embed: --limit requires a value/,
    );
  });
});

describe("COMMAND_FLAGS is derived from the code, not hand-maintained", () => {
  // Same reasoning as SAFETY_FLAG_COMMANDS above: a hand-kept table drifts, and
  // both directions of drift are silent for the operator — a missing entry
  // refuses a working flag, a stale one accepts a flag nobody reads.
  const root = join(import.meta.dir, "..");
  const cli = readFileSync(join(root, "src", "cli.ts"), "utf8");

  /** Case labels grouped by shared body, so fallthrough labels share flags. */
  function caseGroups(): { labels: string[]; body: string }[] {
    const parts = cli.split(/\n    case "(.+?)":/);
    const groups: { labels: string[]; body: string }[] = [];
    let pending: string[] = [];
    for (let i = 1; i < parts.length; i += 2) {
      pending.push(parts[i]!);
      const body = parts[i + 1]!;
      if (body.trim().length === 0) continue;
      groups.push({ labels: pending, body });
      pending = [];
    }
    if (pending.length > 0) groups.push({ labels: pending, body: "" });
    return groups;
  }

  function flagsIn(body: string, pattern: RegExp): string[] {
    return [...new Set([...body.matchAll(pattern)].map((m) => `--${m[1]!}`))].sort();
  }

  const readsInCase = /(?:flags\.has|values\.get|values\.has)\("--([a-z0-9-]+)"\)/g;

  for (const group of caseGroups()) {
    // `case undefined:` / `case "--version":` are aliases, not commands.
    const labels = group.labels.filter((l) => /^[a-z0-9][a-z0-9-]*$/.test(l));
    if (labels.length === 0) continue;
    const read = flagsIn(group.body, readsInCase).filter((f) => f !== "--help");
    for (const label of labels) {
      it(`lists exactly what '${label}' reads`, () => {
        const declared = COMMAND_FLAGS.get(label);
        expect(declared).toBeDefined();
        // doctor and auth parse their own argv; their rows are checked below.
        if (label === "doctor" || label === "auth") return;
        expect([...declared!].sort()).toEqual(read);
      });
    }
  }

  it("takes doctor's row from the flags runDoctor reads off argv", () => {
    const doctor = readFileSync(join(root, "src", "commands", "doctor.ts"), "utf8");
    const expected = [
      ...new Set([
        ...flagsIn(doctor, /argv\.includes\("--([a-z-]+)"\)/g),
        ...flagsIn(doctor, /parseNumFlag\(argv, "--([a-z-]+)"\)/g),
      ]),
    ].sort();
    expect([...COMMAND_FLAGS.get("doctor")!].sort()).toEqual(expected);
  });

  it("takes auth's row from the flags its own parser reads", () => {
    const auth = readFileSync(join(root, "src", "commands", "auth.ts"), "utf8");
    const read = flagsIn(auth, /flags\["([a-z-]+)"\]/g);
    expect([...COMMAND_FLAGS.get("auth")!].sort()).toEqual(read);
  });

  it("declares only flags the parser knows how to shape", () => {
    for (const [cmd, flags] of COMMAND_FLAGS) {
      for (const f of flags) {
        expect(`${cmd} ${f} known`).toBe(
          `${cmd} ${f} ${KNOWN_FLAGS.has(f) ? "known" : "UNKNOWN"}`,
        );
      }
    }
  });

  it("keeps the safety flags reachable on the commands that honour them", () => {
    for (const [flag, commands] of SAFETY_FLAG_COMMANDS) {
      for (const cmd of commands) {
        expect(`${cmd} accepts ${flag}: ${COMMAND_FLAGS.get(cmd)?.has(flag)}`).toBe(
          `${cmd} accepts ${flag}: true`,
        );
      }
    }
  });
});

describe("migrate-engine flags", () => {
  it("parses --to-pglite-path, --verify-only and --tables", () => {
    const r = parseArgs([
      "migrate-engine", "--from", "pglite", "--to", "pglite", "--pglite-path", "/a",
      "--to-pglite-path", "/b", "--verify-only", "--tables", "pages,links",
    ]);
    expect(r.values.get("--to-pglite-path")).toBe("/b");
    expect(r.values.get("--tables")).toBe("pages,links");
    expect(r.flags.has("--verify-only")).toBe(true);
    expect(r.positional).toEqual([]);
  });

  it("keeps --verify-only boolean wherever it sits", () => {
    const r = parseArgs(["migrate-engine", "--verify-only", "--tables", "pages"]);
    expect(r.flags.has("--verify-only")).toBe(true);
    expect(r.values.get("--tables")).toBe("pages");
  });

  it("keeps --allow-dropped-columns boolean", () => {
    const r = parseArgs(["migrate-engine", "--allow-dropped-columns", "--tables", "pages"]);
    expect(r.flags.has("--allow-dropped-columns")).toBe(true);
    expect(r.values.get("--tables")).toBe("pages");
  });

  it("refuses --tables without a value", () => {
    expect(() => parseArgs(["migrate-engine", "--tables"])).toThrow(/requires a value/);
  });
});
