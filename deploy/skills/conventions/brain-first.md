# Brain-First Lookup Convention

**Read this before doing ANY entity/person/company/fact lookup.**

Sub-agents and fresh sessions inherit the brain's MCP tools but not the
knowledge of when and how to use them. This file is that knowledge.

## Available Brain Tools

Your tool inventory includes these (over MCP, or `memrain call <tool>` from
the shell):

| Tool | Use for |
|------|---------|
| `search` | Hybrid search (keyword + semantic) — the default entry point |
| `query` | Structured retrieval when you need query-op parameters |
| `page_get` | Direct page read when you know the slug |
| `get_links` | Outgoing links from a page |
| `backlinks` | Who references this entity |
| `entity_timeline` | Dated events for an entity |
| `entity_facts` | Compiled facts for an entity |
| `entity_recall` | Everything the brain knows about an entity, in one call |
| `resolve_slugs` | Fuzzy slug resolution |
| `traverse_graph` | Walk the relationship graph |
| `page_put` | Create or update a brain page |
| `add_timeline_event` | Add a dated event |
| `link` | Add a relationship edge |

Tool names are the same over MCP and via `memrain call`. Use whichever your
environment provides.

## The Lookup Chain (MANDATORY ORDER)

1. **`search`** first — hybrid retrieval, fast, always works. For a concept or
   landscape question, treat a thin result as incomplete rather than final:
   `search` has no `expand` knob, so escalate to `query` with `expand: true`
2. **`entity_recall`** if the query is about one entity — compiled truth,
   facts, and timeline in a single call
3. **`page_get`** if you found a slug — read the full page
4. **External APIs / web search only after steps 1-2 return nothing useful**

Never skip to external lookups without completing steps 1-2. The brain has
hundreds of pages and thousands of chunks. The answer is almost always there.

Before asking the user “who is this person?”, search the brain and inspect
`entity_timeline` / `get_links` for the candidate. Identity requires exact
corroboration, never the top search result or a name variant alone.

## Rules

- **A strong-scoring hit is relevant evidence.** Don't reach for external APIs when the
  brain answered.
- **User's direct statements are highest-authority data.** The brain captures
  what the user said in meetings, conversations, and notes. External sources
  are supplementary.
- **After any brain page write:** nothing to sync — pages are DB-canonical
  and searchable immediately. Only the read-only note corpus needs
  `memrain reindex` (operator-side) when its files change.
- **Every brain page reference in output** should use a clickable link format
  appropriate to the deployment (slug link `[title](type/slug)` or URL).
- **Never use session-memory search for entity lookups.** Session notes
  (MEMORY.md and the like) are the agent's scratch memory, not the brain
  knowledge graph. Use `search` or `entity_recall` for entity lookups.

## Entity Page Conventions

Standard slug-prefix structure:

| Prefix | Type | Example |
|--------|------|---------|
| `people/` | person | `people/paul-graham` |
| `companies/` | company | `companies/stripe` |
| `deals/` | deal | `deals/stripe-series-c` |
| `meetings/` | meeting | `meetings/2026-04-23-weekly-sync` |
| `projects/` | project | `projects/second-brain` |
| `concepts/` | concept | `concepts/compounding-context` |

When creating new pages, include proper frontmatter with `type`, `title`,
and `tags` fields.

## When Spawning Further Sub-agents

If you spawn your own sub-agents, include this line in their task prompt:

> Read `conventions/brain-first.md` (via `get_skill conventions/brain-first`)
> before starting work.

This ensures the convention propagates through any depth of sub-agent chain.

## Declarative opt-out

A skill can declare it does not need brain-first by adding this line to its
frontmatter:

    brain_first: exempt

Use this for pure-infra skills (schedulers, container managers, ask-user
prompters, browser drivers) whose entire job is to operate without
consulting the brain. The doctor `skill_brain_first` check honors this
opt-out.

**Strict canonical form (the parser is loud about typos):**

| Form | Result |
|---|---|
| `brain_first: exempt` | ✅ matches |
| `brain-first: exempt` | ⚠ doctor hint — snake_case required |
| `BrainFirst: exempt`  | ⚠ doctor hint — snake_case required |
| `brain_first: "exempt"` | ⚠ doctor hint — drop the quotes |
| `brain_first: Exempt` | ⚠ doctor hint — value must be lowercase |
| `brain_first: required` | ⚠ doctor hint — only `exempt` is supported |

A near-miss prints a paste-ready fix line and the skill stays flagged
until the canonical form lands. Silent typos would be the worst outcome
("I declared exempt and it still flags!"), so the parser refuses to guess.

**You do NOT need to declare `brain_first: exempt` when:**

- The skill ALREADY includes the canonical Convention callout above
  (this file's path). The compliance check matches `> **Convention:**`
  blockquotes referencing `brain-first.md` and short-circuits to OK.
  `brain-ops`, `signal-detector`, `idea-ingest`, `enrich`,
  `data-research`, and `academic-verify` all pass via this path.
- The skill has no external-lookup references at all (no web-search or
  third-party enrichment API mentions). Trivially exempt.

When in doubt: declare `brain_first: exempt` explicitly OR add the
canonical Convention callout near the top of the skill body. Both are
zero-friction one-line operations.
