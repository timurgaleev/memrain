---
name: brain-ops
version: 1.0.0
description: |
  Brain knowledge base operations. The core read/write cycle: brain-first lookup,
  read-enrich-write loop, source attribution, ambient enrichment, back-linking.
  Read this before any brain interaction.
triggers:
  - any brain read/write/lookup/citation
tools:
  - search
  - query
  - page_get
  - page_put
  - link
  - add_timeline_event
  - backlinks
mutating: true
writes_pages: true
writes_to:
  - people/
  - companies/
  - deals/
  - concepts/
  - meetings/
---

# Brain Operations — The Ambient Context Layer

The brain is not an archive. It is a live context membrane that every interaction
flows through in both directions.

> **Convention:** See conventions/brain-first.md (via `get_skill conventions/brain-first`) for the 5-step lookup protocol.
> **Convention:** See conventions/quality.md (via `get_skill conventions/quality`) for citation and back-link rules.

## Contract

This skill guarantees:
- Brain is checked BEFORE any external API call (brain-first lookup)
- Every inbound signal triggers the READ → ENRICH → WRITE loop
- Every outbound response checks brain for relevant context
- Source attribution on every fact written (inline `[Source: ...]` citations)
- User's direct statements are highest-authority data
- Back-links maintained on every brain write (Iron Law)

## Iron Law: Back-Linking (MANDATORY)

Every mention of a person or company with a brain page MUST create a back-link
FROM that entity's page TO the page mentioning them. An unlinked mention is a
broken brain. See conventions/quality.md for format.

## Phases

### Phase 1: Brain-First Lookup (MANDATORY)

Before using ANY external API to research a person, company, or topic:

1. `search "name"` — hybrid retrieval (no `expand` knob; expansion is off in the
   default mode bundles)
2. `query "natural question about name"` — same retrieval with broader controls;
   escalate here with `expand: true` when the question is conceptual and step 1
   came back thin
3. `page_get <slug>` — if you know the slug, read the full page
4. Check `backlinks`: who references this entity?
5. Check `entity_timeline`: recent events involving this entity

The brain almost always has something. External APIs fill gaps, not start from scratch.

### Phase 2: On Every Inbound Signal (READ → ENRICH → WRITE)

Every message, meeting, email, or conversation that references a person or company:

1. **Detect entities** — people, companies, deals mentioned
2. **Load brain pages** — read existing pages for context before responding
3. **Identify new information** — what does this signal tell us that the page doesn't know?
4. **Write it back** — update the brain page with new info + timeline entry + source citation
5. **Create if missing** — if notable and no page exists, create via enrich skill

**User's direct statements are the highest-value data source.** Write them to brain
pages immediately with attribution `[Source: User, YYYY-MM-DD]`.

### Phase 2.5: Structured Graph Updates (automatic)

Every `page_put` call automatically extracts entity references and writes them
to the graph (links table) with inferred relationship types. Stale links
(refs no longer in the page text) are removed in the same call. This is
"auto-link" reconciliation.

- No manual `link` calls needed for ordinary page writes.
- Inferred link types: `attended` (meeting -> person), `works_at`, `invested_in`,
  `founded`, `advises`, `source` (frontmatter), `mentions` (default).
- Link edges are derived server-side at write/index time (wikilinks, entity
  mentions, typed links) — the write call doesn't report them back. Verify
  the outcome with the `backlinks` tool.
- Auto-link is a server-side setting, on by default; only disable it
  deliberately (operator-side config).
- Timeline entries with specific dates still need explicit `add_timeline_event`
  (or batch extraction via `extract_facts`).

### Phase 3: On Every Outbound Response (READ → PULL → RESPOND)

Before answering any question about a person, company, or topic:

1. **Check the brain** — read relevant pages
2. **Pull context** — use compiled truth + recent timeline
3. **Respond with context** — the brain makes every answer better

Don't answer from general knowledge when a brain page exists.

### Phase 4: Ambient Enrichment

This is not a special mode. This is the default. Everything the user says is an
ingest event.

- Person mentioned → check brain, create/enrich if needed (spawn background)
- Company mentioned → same
- Link shared → ingest it (delegate to idea-ingest)
- Data shared → delegate to appropriate skill

**Rules:**
- Never interrupt the conversation to do enrichment
- Spawn sub-agents for anything that would slow down the response
- Never announce "I'm enriching the brain" — just do it silently

## Output Format

No separate output. Brain-ops is an always-on behavior layer, not a report generator.
The output is updated brain pages and enriched responses.

## Cross-source citation format

When a brain has multiple sources (the DB-canonical default source plus
the read-only `memory` note corpus, and any future sources), every
citation MUST include the source id: `[source-id:slug]`. Example:

> You told me about the retry budget approach — see
> [default:topics/resilience] and [memory:plans/retry-policy] for where
> this came from.

Rules:
- The key is the source's immutable id (see `sources_list`), never its
  mutable display name.
- Single-source brains still write `[default:slug]` OR may omit the prefix
  for backward compat.
- Every page payload returned by `search`, `query`, `page_get`, `page_list`
  carries `source_id` — always use it when citing, never guess.

If a search result has `source_id: "memory"` and `slug: "plans/foo"`,
the citation is `[memory:plans/foo]`. That's the whole rule.

## Anti-Patterns

- Answering questions about people/companies without checking the brain first
- Using external APIs before checking the brain
- Writing facts without inline `[Source: ...]` citations
- Blocking the response to do enrichment
- Overwriting user's direct statements with lower-authority sources
- Creating brain pages for non-notable entities

## Tools Used

- `search` — hybrid vector+keyword search, no query expansion
- `query` — the same, with every knob exposed (`expand`, `detail`, `mode`, …)
- `page_get` — read a brain page
- `page_put` — create/update brain pages
- `link` — cross-reference entities
- `add_timeline_event` — record events
- `backlinks` — check who references an entity

Index maintenance is the server's own background cycle — there is no
manual sync step; writes are indexed on landing.
