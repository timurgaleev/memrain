---
name: context-audit
version: 1.0.0
description: |
  Token-hygiene audit of the context an agent loads on every turn: the
  harness's instruction files (CLAUDE.md, AGENTS.md and their equivalents),
  its auto-memory index, and the brain's own identity pages when the harness
  loads them. Finds redundancy, contradictions, stale content and content
  that belongs in a skill, and returns a ranked action list by token savings
  with a risk class per finding. Report-only: it never edits an audited file
  or page.
triggers:
  - "context audit"
  - "context diet"
  - "system prompt audit"
  - "prompt compression"
  - "reduce context size"
  - "audit my context stack"
  - "context is too big"
  - "token hygiene"
tools:
  - search
  - page_get
  - get_brain_identity
  - list_skills
mutating: false
---

# context-audit — Token Hygiene for the Always-Loaded Context

> **Convention:** `conventions/brain-first.md` (via `get_skill conventions/brain-first`):
> before a fresh audit, `search` for earlier audit reports, so you can report
> the drift since the last run and not re-flag findings the user declined.
>
> **Convention:** `conventions/quality.md`: every finding cites its file and
> evidence.

## What this is

Every file loaded on every turn is a per-turn tax: tokens, latency and, past a
point, how well instructions are followed. Always-loaded files accrete:
release notes appended forever, memory entries nobody re-reads, one rule
restated in three files that drift into contradiction. This skill audits the
whole stack at once and returns an evidence-cited list ranked by savings.

It is an auditor, not a surgeon. The user, or a skill the user invokes
afterwards, applies changes.

## Scope: what counts as always-loaded

Enumerate what this harness actually loads; do not assume a fixed list.

| File | Role | Where the fix belongs |
|---|---|---|
| project `CLAUDE.md` / `AGENTS.md` | orientation, routing, invariants | the file itself |
| user-global instructions and the rule files they pull in | cross-project rules | the file itself |
| the auto-memory index (`MEMORY.md` or similar) | promoted memories | the memory store (demote, merge, expire) |
| the brain's identity pages (`identity/soul`, `identity/user`, …), when the harness injects them | persona, operator profile | the `soul-audit` interview, never a direct page edit |
| the MCP server instructions and tool list the harness loads at start | tool routing | the server operator; not editable from here |

Skills and on-demand docs are not audit subjects (they cost nothing until
loaded), but they are where extracted content goes.

## Contract

This skill guarantees:

- **Report-only.** No audited file or page is edited and nothing is
  auto-fixed, including zero-risk findings.
- **Identity content goes through the interview.** A finding about what an
  identity page says is a recommendation to re-run `soul-audit` for that
  section, never a direct edit.
- **Estimates state their basis.** Token figures come from the deterministic
  pre-pass (bytes ÷ 2.8, a midpoint for Claude-family tokenisers on markdown
  dense with paths and code). The report prints the divisor. A figure the host
  reports exactly (for example Claude Code's `/context`) wins.
- **No paid brain call.** The audit reads files and pages only. A second
  opinion goes through `cross-modal-review` with the agent's own models, one
  cheap model by default; a full multi-model panel only when the user asks for
  it.

## Procedure

### 1. Enumerate and measure (deterministic)

```bash
for f in CLAUDE.md AGENTS.md MEMORY.md; do
  [ -f "$f" ] && echo "$f: $(wc -c < "$f") bytes (~$(( ( $(wc -c < "$f") * 10 + 27 ) / 28 )) tokens)"
done
```

Add the files this harness loads that are not in that list (global rule
files, imported fragments). For identity pages the harness injects, read them
with `get_brain_identity` or `page_get` and count their bytes the same way.
Record the total, and the drift against the last report if one exists.

### 2. Read and analyse

Read every file in full. Judge six dimensions:

1. **Token efficiency:** tokens per unit of behaviour.
2. **Redundancy:** the same rule or fact in more than one file.
3. **Contradictions:** conflicting rules, numbers or policies.
4. **Skill-worthiness:** content that matters for one workflow only
   (`list_skills` shows whether a skill already covers it).
5. **Staleness:** outdated facts, removed features, memories that no longer
   earn their slot.
6. **Clarity:** compressible without changing behaviour, or ambiguous enough
   to misfire.

### 3. Classify every finding by risk

- **Zero risk:** deleting an exact duplicate or dead content.
- **Low risk:** compression, or extraction to a skill with a clear trigger.
- **Medium risk:** a change that could shift edge-case behaviour.

The class tells the user how much care to take; it does not let this skill
act.

### 4. Second opinion (optional)

Hand the draft to `cross-modal-review` with the criteria: every finding cites
file and quoted evidence; savings are estimates with the divisor stated;
findings are ranked by savings; identity findings route to `soul-audit`;
every row has a risk class. Fix what it flags. If no second model is
available, label the report "unreviewed".

### 5. Deliver

Print the report in the conversation. If the user wants it kept, hand it to
`reports` to save as a report page; this skill writes nothing itself.

## Output Format

```
# Context Audit — YYYY-MM-DD

Stack total: ~NN,NNN tokens across N files (drift since last audit: +/-N,NNN)
Estimate basis: bytes/2.8 | host-reported total: NN,NNN or n/a
Findings: N (~NN,NNN tokens recoverable) | Contradictions: N
Review: cross-modal-review pass | unreviewed

| # | Save (tok) | Risk | File | Finding | Evidence | Fix, and where it lives |
|---|-----------|------|------|---------|----------|-------------------------|
| 1 | ~2,400 | zero | ... | redundancy: X restated | "quoted line" | delete from A; B keeps it |
| 2 | ~1,100 | low | identity/user | stale: ... | "quoted line" | re-run soul-audit for this section |

## Contradictions (fix these first)
- FILE-A says "..." but FILE-B says "..."; keep one.

## Skill-extraction candidates
- <content> matters only when <workflow>; extract with skill-creator.
```

Sorted by savings, except contradictions, which come first whatever their
size: they cost correctness, not just tokens.

## When it fails

- A file the harness loads cannot be read: list it as unaudited with the
  reason; do not guess its size.
- The second model is unavailable: deliver labelled "unreviewed"; never invent
  a review result.

## Anti-Patterns

- Editing any audited file or page.
- Editing an identity page directly instead of re-running the interview.
- Hard-coded model IDs for the review.
- A multi-model panel by default.
- Auditing on-demand skills as if they were always loaded.
- Token counts without the pre-pass.

## Dedup (sharp boundaries)

- `soul-audit`: what the identity pages should say, from the user's own words.
  "The operator profile is outdated" goes there; "it repeats 800 tokens of the
  persona" stays here.
- `skill-optimizer`: tunes one skill's routing against a benchmark.
- `functional-area-resolver`: a technique for oversized routing tables; this
  skill may recommend it, never apply it.
- `skillpack-check`: install and runtime health, not context size.
- `cross-modal-review`: the general second-opinion gate this skill calls.
