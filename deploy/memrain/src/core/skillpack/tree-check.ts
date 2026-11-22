/**
 * skillpack/tree-check.ts — `memrain skillpack check`: is every skill
 * reachable, does each request have one owner, and do skills defer to the
 * shared rules instead of copying them.
 *
 * `skillpack lint` checks each skill against the server (tools, commands,
 * flags, sizes). This checks the pack as a routing tree:
 *   - the resolver (`_resolver.md`) lists every skill, and nothing else;
 *   - every skill owns at least one route: some trigger of its own, sent to
 *     the trigger router as a request, lands on it alone;
 *   - no trigger belongs to two skills (overlap), and every skill carries the
 *     three triggers the pack contract asks for (gap);
 *   - the routing-eval cases still route where they say (uncovered intents
 *     show up as misses);
 *   - skills point at shared rules instead of copying them (dry-check.ts),
 *     and `--fix` rewrites the copies that are safe to rewrite.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listSkillCatalog, type SkillCatalogEntry } from "./brain-resident.ts";
import { RESOLVER_BEGIN, RESOLVER_END, RESOLVER_FILE } from "./plugin-tree.ts";
import { normalizeTrigger, routeByTriggers, scoreBenchmark } from "./routing-eval.ts";
import { loadPackBenchmark } from "../skillopt/benchmark.ts";
import { type DryFixOutcome, findDryIssues, fixDryCopies, loadSharedDocs } from "./dry-check.ts";
import { readSkillText } from "./read-text.ts";

/** Triggers a skill is asked to carry (see `_AGENT_README.md`, "Skill anatomy"). */
export const MIN_TRIGGERS = 3;

export type TreeRule =
  | "missing-resolver"
  | "not-in-resolver"
  | "resolver-orphan"
  | "unreachable"
  | "mece-overlap"
  | "mece-gap"
  | "routing-miss"
  | "routing-wrong"
  | "routing-ambiguous"
  | "routing-false-positive"
  | "routing-fixture"
  | "dry-copy"
  | "dry-named-rule";

export interface TreeIssue {
  rule: TreeRule;
  severity: "error" | "warning";
  /** Skill slug, or the pack file the issue is about. */
  slug: string;
  message: string;
  /** What to change to clear it. */
  action: string;
  /** 1-based line in the skill file, when there is one. */
  line?: number;
}

export interface TreeCheckReport {
  /** No errors (and, under strict, no warnings). */
  ok: boolean;
  skills: number;
  summary: {
    reachable: number;
    unreachable: number;
    overlaps: number;
    gaps: number;
    routing: { total: number; correct: number; accuracy: number };
  };
  errors: TreeIssue[];
  warnings: TreeIssue[];
  /** What `--fix` did; empty without it. */
  fixes: DryFixOutcome[];
}

export interface TreeCheckOptions {
  /** Rewrite the copied shared rules that are safe to rewrite. */
  fix?: boolean;
  /** Warnings fail the check too. */
  strict?: boolean;
}

const REGENERATE = "run `bun scripts/generate-plugin-tree.ts` in deploy/memrain";

/** Slugs the resolver's generated block lists, or null when there is no resolver. */
function resolverSlugs(skillsDir: string): string[] | null {
  const file = join(skillsDir, RESOLVER_FILE);
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8");
  const at = text.indexOf(RESOLVER_BEGIN);
  const end = text.indexOf(RESOLVER_END);
  const block = at !== -1 && end > at ? text.slice(at, end) : text;
  const slugs: string[] = [];
  for (const line of block.split("\n")) {
    const m = /^\| `([a-z0-9][a-z0-9-]*)` \|/.exec(line);
    if (m) slugs.push(m[1]!);
  }
  return slugs;
}

function checkResolver(skillsDir: string, skills: readonly SkillCatalogEntry[], issues: TreeIssue[]): void {
  const listed = resolverSlugs(skillsDir);
  if (listed === null) {
    issues.push({
      rule: "missing-resolver",
      severity: "error",
      slug: RESOLVER_FILE,
      message: `${RESOLVER_FILE} is missing, so agents have no dispatch map`,
      action: REGENERATE,
    });
    return;
  }
  const onDisk = new Set(skills.map((s) => s.slug));
  const inResolver = new Set(listed);
  for (const s of skills) {
    if (inResolver.has(s.slug)) continue;
    issues.push({
      rule: "not-in-resolver",
      severity: "error",
      slug: s.slug,
      message: `${s.slug} has no row in ${RESOLVER_FILE}`,
      action: REGENERATE,
    });
  }
  for (const slug of listed) {
    if (onDisk.has(slug)) continue;
    issues.push({
      rule: "resolver-orphan",
      severity: "error",
      slug,
      message: `${RESOLVER_FILE} lists ${slug}, which is not a skill in the pack`,
      action: REGENERATE,
    });
  }
}

/** Reachability, overlap and gap. Returns the counts for the summary. */
function checkRoutes(
  skills: readonly SkillCatalogEntry[],
  issues: TreeIssue[],
): { reachable: number; overlaps: number; gaps: number } {
  const owners = new Map<string, Set<string>>();
  for (const s of skills) {
    for (const t of s.triggers) {
      const n = normalizeTrigger(t);
      if (n.length === 0) continue;
      const set = owners.get(n) ?? new Set<string>();
      set.add(s.slug);
      owners.set(n, set);
    }
  }
  let overlaps = 0;
  for (const [trigger, set] of owners) {
    if (set.size < 2) continue;
    overlaps++;
    const slugs = [...set].sort();
    issues.push({
      rule: "mece-overlap",
      severity: "error",
      slug: slugs.join(", "),
      message: `"${trigger}" is a trigger of ${slugs.join(" and ")}, so the router cannot choose`,
      action: "keep the trigger on the skill that owns the request and narrow it on the others",
    });
  }
  let reachable = 0;
  let gaps = 0;
  for (const s of skills) {
    const own = s.triggers.some((t) => {
      const r = routeByTriggers(t, skills);
      return r.kind === "match" && r.slug === s.slug;
    });
    if (own) {
      reachable++;
    } else {
      issues.push({
        rule: "unreachable",
        severity: "error",
        slug: s.slug,
        message: s.triggers.length === 0
          ? `${s.slug} declares no triggers, so no request routes to it`
          : `no trigger of ${s.slug} routes to it alone; each is shared or empty`,
        action: "add a trigger phrase only this skill answers to its frontmatter",
      });
    }
    const distinct = new Set(s.triggers.map(normalizeTrigger).filter((t) => t.length > 0)).size;
    if (distinct >= MIN_TRIGGERS) continue;
    gaps++;
    issues.push({
      rule: "mece-gap",
      severity: "warning",
      slug: s.slug,
      message: `${s.slug} has ${distinct} trigger(s); the pack asks for ${MIN_TRIGGERS}, so requests worded another way find no skill`,
      action: "add the phrases a user would say for this skill to its frontmatter triggers",
    });
  }
  return { reachable, overlaps, gaps };
}

function checkRoutingEval(
  skillsDir: string,
  skills: readonly SkillCatalogEntry[],
  issues: TreeIssue[],
): TreeCheckReport["summary"]["routing"] {
  const bench = loadPackBenchmark(skillsDir);
  for (const e of bench.errors) {
    issues.push({ rule: "routing-fixture", severity: "warning", slug: e.split(":")[0] ?? "", message: e, action: "fix the routing-eval.jsonl line" });
  }
  const known = new Set(skills.map((s) => s.slug));
  for (const c of bench.cases) {
    for (const named of [c.expected_skill, ...c.ambiguous_with]) {
      if (named === null || known.has(named)) continue;
      issues.push({
        rule: "routing-fixture",
        severity: "warning",
        slug: c.skill,
        message: `${c.skill}/routing-eval.jsonl:${c.line} names ${named}, which is not a skill in the pack`,
        action: "point the case at a skill that exists, or drop it",
      });
    }
  }
  const score = scoreBenchmark(bench.cases, skills);
  const rules = {
    missed: "routing-miss",
    wrong: "routing-wrong",
    ambiguous: "routing-ambiguous",
    false_positive: "routing-false-positive",
  } as const;
  for (const f of score.failures) {
    const got = f.got.length === 0 ? "no skill" : f.got.join(", ");
    issues.push({
      rule: rules[f.outcome],
      severity: "warning",
      slug: f.expected_skill ?? "(negative case)",
      message: `"${f.intent}" routes to ${got}, expected ${f.expected_skill ?? "no skill"}`,
      action: f.outcome === "missed"
        ? "no trigger covers this request: add one to the expected skill"
        : "narrow the trigger that took the request, or correct the case",
    });
  }
  return { total: score.total, correct: score.correct, accuracy: score.accuracy };
}

/** Pack-relative paths of the shared rules a skill may defer to. */
function sharedDocFiles(skillsDir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(skillsDir).sort()) {
    if (name.startsWith("_") && name.endsWith(".md") && name !== RESOLVER_FILE && name !== "_AGENT_README.md") out.push(name);
  }
  const conventions = join(skillsDir, "conventions");
  if (existsSync(conventions)) {
    for (const name of readdirSync(conventions).sort()) if (name.endsWith(".md")) out.push(`conventions/${name}`);
  }
  return out;
}

function skillFile(skillsDir: string, slug: string): string {
  const dirFile = join(skillsDir, slug, "SKILL.md");
  return existsSync(dirFile) ? dirFile : join(skillsDir, `${slug}.md`);
}

function checkDry(
  skillsDir: string,
  skills: readonly SkillCatalogEntry[],
  fix: boolean,
  issues: TreeIssue[],
): DryFixOutcome[] {
  const docs = loadSharedDocs(skillsDir, sharedDocFiles(skillsDir));
  const fixes: DryFixOutcome[] = [];
  for (const s of skills) {
    const file = skillFile(skillsDir, s.slug);
    let text: string;
    try {
      text = readSkillText(file, skillsDir);
    } catch {
      continue; // `skillpack lint` reports a skill it cannot read
    }
    let findings = findDryIssues(text, docs);
    // Fix first, then report what is left, so the report and the exit code describe the tree after the fix.
    if (fix) {
      const outcomes = fixDryCopies(skillsDir, s.slug, file, findings);
      fixes.push(...outcomes);
      if (outcomes.some((o) => o.status === "applied")) findings = findDryIssues(readSkillText(file, skillsDir), docs);
    }
    for (const f of findings) {
      issues.push(f.kind === "copy"
        ? {
            rule: "dry-copy",
            severity: "warning",
            slug: s.slug,
            line: f.line,
            message: `${s.slug} copies ${f.label} from ${f.doc} word for word`,
            action: `replace the copy with a pointer to ${f.doc} (\`memrain skillpack check --fix\` does it when safe)`,
          }
        : {
            rule: "dry-named-rule",
            severity: "warning",
            slug: s.slug,
            line: f.line,
            message: `${s.slug} names ${f.label} with no pointer to ${f.doc} nearby`,
            action: `point at ${f.doc} (via \`get_skill ${f.doc}\`) where the rule is used`,
          });
    }
  }
  return fixes;
}

export function checkSkillTree(skillsDir: string, opts: TreeCheckOptions = {}): TreeCheckReport {
  if (!existsSync(skillsDir)) throw new Error(`skillpack check: skills directory not found at ${skillsDir}`);
  const skills = listSkillCatalog({ skillsDir }).skills;
  const issues: TreeIssue[] = [];
  checkResolver(skillsDir, skills, issues);
  const routes = checkRoutes(skills, issues);
  const routing = checkRoutingEval(skillsDir, skills, issues);
  const fixes = checkDry(skillsDir, skills, opts.fix === true, issues);
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  return {
    ok: errors.length === 0 && (opts.strict !== true || warnings.length === 0),
    skills: skills.length,
    summary: {
      reachable: routes.reachable,
      unreachable: skills.length - routes.reachable,
      overlaps: routes.overlaps,
      gaps: routes.gaps,
      routing,
    },
    errors,
    warnings,
    fixes,
  };
}
