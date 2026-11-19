---
name: skill-optimizer
version: 1.0.0
description: |
  Improve how reliably a skill gets picked, against its routing benchmark,
  with a paid but hard-capped evaluation. The candidate is a copy of the
  skill with a rewritten description and triggers; memrain skillopt eval
  scores it against the current text on held-out cases and answers ACCEPT or
  REJECT. Manual and operator-run only: off by default, capped per run, never
  on a schedule, and it never writes the pack or the brain.
triggers:
  - "optimize this skill"
  - "tune the skill against the benchmark"
  - "make the skill route better"
  - "run skillopt"
  - "skillopt for"
tools:
  - list_skills
  - get_skill
mutating: false
---

# Skill Optimizer

Treat a skill's description and triggers as the parameters an agent routes
on, and change them only when a held-out measurement says the change helps
the skill without hurting its neighbours.

## Spend cap (read first)

`memrain skillopt eval` makes paid model calls (the brain's `utility` tier),
so it is fenced:

- **Off by default.** It refuses unless the operator set
  `MEMRAIN_SKILLOPT_ENABLED=1`.
- **Capped per run.** `MEMRAIN_SKILLOPT_MAX_USD` (default **$0.25**) is the
  ceiling for one run. `--max-usd` can lower it for a run, never raise it.
- **Refused before it starts.** The worst case (cases × variants × repeats at
  the model's registered price) is estimated first; a run whose worst case
  exceeds the cap is refused before any storage is opened or call is made.
- **Booked.** Every call is recorded in the spend log under the `skillopt`
  label; `memrain spend` shows it.
- **Manual only.** A person runs it from the host, one run at a time. It is
  never scheduled and never started by another skill or a background job.

Ask the user before each paid run, quoting the cap that applies.

## Contract

This skill guarantees:

- Nothing is paid for without `MEMRAIN_SKILLOPT_ENABLED=1`, and no run exceeds
  `MEMRAIN_SKILLOPT_MAX_USD`.
- Only the routing surface (`description`, `triggers`) of the candidate
  changes; the `name`, the tools and the body stay as they are.
- A candidate is accepted only by the held-out gate: the target skill must
  gain more than epsilon (default 0.05) and no other skill may lose more than
  epsilon, as the median of repeats.
- The tool writes no skill file, no page and no row other than its spend
  records. An accepted candidate reaches the pack only through a human-reviewed
  change to `deploy/skills/`.

## Steps

### 1. The benchmark (free)

The benchmark is the skill's `routing-eval.jsonl` next to its `SKILL.md`:
one JSON object per line, `{"intent", "expected_skill", "ambiguous_with"?}`.
Intents paraphrase real requests instead of copying a trigger. Include
neighbours (requests that should go to a nearby skill, with
`ambiguous_with` naming this one) and negatives (`"expected_skill": null`).
About 30% of each file is held out deterministically, so a file needs at
least 5 cases to have a meaningful held-out set.

Free checks first, no model: `memrain skillpack lint` (unknown tools,
duplicated or swallowed triggers), and the repository's routing test
(`bun test tests/skillpack_routing_eval.test.ts` in `deploy/memrain`), which
routes every case with the deterministic trigger matcher.

### 2. Baseline (paid, capped)

```bash
memrain skillopt eval --skill <slug> --split all --repeats 3 --max-usd 0.10
```

Read the per-split medians for the skill and the overall line.

### 3. Write a candidate (no model call needed)

Copy the skill's `SKILL.md` to a scratch path outside `deploy/skills/`. Change
only `description` and `triggers`: name the requests the skill must win,
drop phrases a neighbour owns, add the paraphrases the baseline missed. Use
`list_skills` and `get_skill` to read the neighbours' triggers so the
candidate does not steal their cases.

### 4. Gate (paid, capped)

```bash
memrain skillopt eval --skill <slug> --candidate <scratch>/SKILL.md --max-usd 0.25
```

It scores the current text and the candidate on the held-out cases of every
benchmark in the pack and prints ACCEPT, or REJECT with exit code 3 and the
skills that regressed.

### 5. Land it (human)

On ACCEPT, a person copies the candidate's `description` and `triggers` into
`deploy/skills/<slug>/SKILL.md`, then runs `memrain skillpack lint`, the
routing test, and the plugin tree generator if the skill ships in the plugin
(`bun scripts/generate-plugin-tree.ts` in `deploy/memrain`), and opens a
change for review. On REJECT, keep the current text.

## Output Format

```
Skill: <slug>   benchmark: N cases (held-out N)
Baseline: heldout <median> [r1 r2 r3]   overall <median>
Candidate: heldout <median> [r1 r2 r3]
Gate: ACCEPT | REJECT (regressed: <skill> -0.08)
Spend: $<run cost> of $<cap> (the day's total is in the spend report)
Next: <copy into deploy/skills and review | keep current text>
```

## When it fails

- Refused because it is not enabled: the operator decides whether to set
  `MEMRAIN_SKILLOPT_ENABLED=1`; do not work around it.
- Refused because the worst case exceeds the cap: fewer `--repeats`, one
  `--skill`, or a narrower `--split`; never ask for a higher cap as a
  workaround.
- `--candidate` with `--split train` or `all` is refused: the gate is
  held-out only.
- Unparsed or ambiguous verdicts in the report: tighten the benchmark's
  intents before trusting the score.

## Anti-Patterns

- Running it in a loop until something passes.
- Starting it from a schedule or a background job.
- Editing the body, the name or the tools in the candidate.
- Writing the candidate straight into `deploy/skills/` before the gate.
- A benchmark whose intents copy the triggers word for word.
- Accepting a gain for one skill that costs a neighbour.

## Dedup (sharp boundaries)

- `skill-autobench` writes the benchmark from real usage; this skill
  optimises against it.
- `skillify` and `skill-creator` make new skills.
- `skillpack-check` is install health, not routing quality.
