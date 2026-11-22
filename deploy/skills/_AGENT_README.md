# Agent onboarding — what to do with the Memrain skill layer

You (the agent) are connected to a Memrain brain over MCP. This file is the
operating contract for the skill layer. Read it on every cold start. It is
short on purpose.

## Where skills live

Skills are served by the brain itself:

- `list_skills` — enumerate every available skill with its frontmatter
  (name, triggers, tools, write surfaces).
- `get_skill` — fetch a skill's full body by slug (e.g.
  `get_skill conventions/brain-first`).

A locally scaffolded copy may also exist on disk (this directory). When both
exist, the layout is the same:

```
skills/
  _AGENT_README.md          ← you are here
  _resolver.md              ← every skill and its triggers in one table
  _brain-filing-rules.md    ← where to file brain pages (read on every write)
  _output-rules.md          ← output quality standards (no LLM slop, exact phrasing)
  _friction-protocol.md     ← log friction via the log_friction tool
  conventions/              ← cross-cutting rules every skill defers to
  <skill-name>/
    SKILL.md                ← the skill's contract + workflow
    routing-eval.jsonl      ← (optional) test fixtures for routing-eval
    script.ts               ← (optional) deterministic code, if any
```

Other files in the host repo (`src/`, `docs/`, `deploy/` beyond this
directory) are owned by the server, not by the skill layer. Don't treat them
as skill artifacts.

## Routing — your first job

Discover skills at runtime via `list_skills` (or, on a scaffolded copy, by
walking every `skills/<slug>/SKILL.md` and parsing the YAML frontmatter).
Each skill declares one or more `triggers:` strings; they are the
user-facing phrases that route to that skill.

```yaml
---
name: book-mirror
triggers:
  - "personalized version of this book"
  - "mirror this book"
  - "two-column book analysis"
---
```

On every user message, match the message against every skill's `triggers:`
array. Substring match is the baseline. Semantic similarity (embedding or
keyword expansion) is fine on top. When a trigger matches strongly, invoke
the skill — fetch its full body via `get_skill <slug>` and follow the
workflow described there.

Routing lives in frontmatter. `get_skill _resolver` serves the same routing
as one table, generated from that frontmatter, plus disambiguation rules for
requests two skills could take. If the table and a skill's frontmatter ever
disagree, the frontmatter wins.

## Skill anatomy

Every skill reads the same way, so you know where to look:

- **Frontmatter.** `name` (the folder name), `version`, `description` (what it
  does and when to use it), `triggers` (three or more phrases a user would
  say; no two skills share one), `tools` (exactly the MCP tools the body tells
  you to call), `mutating`, and `writes_to` when it writes pages.
- **Convention pointers.** `> **Convention:**` lines name the
  `conventions/*.md` rules the skill relies on. Fetch them with `get_skill`.
- **`## Contract`.** What the skill promises, its bounds, and what it never
  does. A skill that reads outside text cites `conventions/untrusted-content`
  here.
- **The workflow.** `## Phases` or `## Workflow`: numbered steps, with
  decision tables where a choice depends on what you find.
- **`## Output Format`.** What you hand back.
- **`## When it fails`.** The error codes you may meet and what to do about
  each.
- **`## Anti-Patterns`** and **`## Dedup (sharp boundaries)`**: what not to do,
  and which neighbouring skill owns the request instead.

Cross-cutting rules live in `conventions/`: `brain-first`, `untrusted-content`,
`test-before-bulk`, `page-privacy`, `path-discipline`, `exec-output`,
`regex-discipline` and the rest. A skill's own text wins over a convention only
where it says so.

## When the user invokes a skill

Read the entire skill body (`get_skill <slug>` or the local SKILL.md).
Follow its `## Phases`, `## Workflow`, or equivalent step-by-step section.
If the skill has `mutating: true` frontmatter and declares `writes_pages:`
/ `writes_to:`, those are the brain-side write surfaces — consult
`_brain-filing-rules.md` to confirm the target slug prefix is sanctioned
before calling `page_put`.

Every tool a skill names must be a real MCP tool on this brain (`search`,
`page_put`, `jobs_submit`, ...) or a `memrain <cmd>` shell command where a
shell step is genuinely meant. `memrain call <tool> --args '<json>'` invokes any MCP
tool from the shell when you are working host-side.

## Updates — when the server ships a new version

Skills ship with the server; `list_skills` / `get_skill` always serve the
current bundle. A locally scaffolded copy DOES NOT change automatically —
after an upgrade it becomes a snapshot you compare against.

On every cold start with a scaffolded copy, or any time the operator
mentions an upgrade, compare each local file with the served one
(`get_skill <slug>` prints the canonical body) and sort it into `identical`,
`differs` or `missing`. Host-side, `memrain skillpack --out <path>` bundles
the whole pack as a tar.gz whose `.manifest.json` lists the sha256 of every
file, so a full copy can be checked in one pass. For each `differs`, inspect
the diff, then decide per file:

- **Local edit was intentional.** Keep your version. The server bundle is
  reference, not law.
- **Local edit was accidental drift** (e.g. you wrote stale content into
  the skill body). Patch by hand from the server copy
  (`get_skill <slug>` prints the canonical body).
- **Genuinely new change in a section you don't care about.** Skip or
  apply per your judgment.

For `missing` files (the server added a new bundled skill since you
scaffolded), scaffold it locally from the `get_skill` output — or just rely
on `get_skill` at runtime; the local copy is a convenience, not a
requirement.

**Warning on wholesale re-sync:** overwriting a local file from the server
bundle discards ANY local edits, including intentional ones. Always inspect
the diff first. Reset-to-bundle only when you're confident the local edits
were accidental.

## Removing a scaffolded skill

The local files are yours:

```bash
rm -rf skills/<slug>
```

The server-side bundle is unaffected; `list_skills` will still offer the
skill. Simply stop routing to it if the operator wants it retired.

## When in doubt

`list_skills` + `get_skill` are the source of truth for skill content. The
individual SKILL.md bodies are the source of truth for skill behavior. This
file (`_AGENT_README.md`) is the routing contract — keep it short.
