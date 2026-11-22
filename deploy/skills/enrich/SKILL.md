---
name: enrich
version: 1.0.0
description: |
  Enrich brain pages with tiered enrichment protocol. Creates and updates
  person/company pages with compiled truth, timeline, and cross-links.
  Use when a new entity is mentioned or an existing page needs updating.
triggers:
  - "enrich"
  - "create person page"
  - "update company page"
  - "who is this person"
  - "look up this company"
tools:
  - page_get
  - page_put
  - search
  - query
  - link
  - add_timeline_event
  - backlinks
  - put_raw_data
  - get_raw_data
  - page_list
mutating: true
writes_pages: true
writes_to:
  - people/
  - companies/
---

# Enrich Skill

Enrich person and company pages from external sources. Scale effort to importance.

## Contract

This skill guarantees:
- Every enriched page has compiled truth (State section) with inline citations
- Every enriched page has a timeline with dated entries
- Back-links are created bidirectionally
- Tiered enrichment: Tier 1 (full), Tier 2 (medium), Tier 3 (minimal) based on notability
- No stubs: every new page has meaningful content from web search or existing brain context

> **Filing rule:** Read `_brain-filing-rules.md` (via `get_skill _brain-filing-rules`) before creating any new page.

> **Convention:** See `conventions/quality.md` (via `get_skill conventions/quality`) for Iron Law back-linking.

## Philosophy

A brain page should read like an intelligence dossier, not a LinkedIn scrape.
Facts are table stakes. Texture is the value -- what do they believe, what are
they building, what makes them tick, where are they headed.

## Citation Requirements (MANDATORY)

> **Convention:** see `conventions/quality.md` (via `get_skill conventions/quality`) for citation formats and source precedence.

> **Convention:** see `_brain-filing-rules.md` (via `get_skill _brain-filing-rules`) for Citation Requirements.

## When To Enrich

### Primary triggers
- User mentions an entity in conversation
- Entity appears in a meeting transcript or email
- New contact appears with significant context
- Entity makes news or has a major event
- Any ingest pipeline encounters a notable entity

### Do NOT enrich
- Random mentions with no relationship signal
- Bot/spam accounts
- Entities with no substantive connection to the user's work
- Same page enriched within the past week (unless new signal warrants it)

## Enrichment Tiers

Scale enrichment to importance. Don't waste API calls on low-value entities.

| Tier | Who | Effort | Sources |
|------|-----|--------|---------|
| 1 (key) | Inner circle, close collaborators, key contacts | Full pipeline | All available APIs + deep Perplexity research |
| 2 (notable) | Occasional interactions, industry figures | Moderate | Web research + social + brain cross-ref |
| 3 (minor) | Worth tracking, not critical | Light | Brain cross-ref + social lookup if handle known |

## The Enrichment Protocol (7 Steps)

### Step 1: Identify entities

Extract people, companies, concepts from the incoming signal.

### Step 2: Check brain state

For each entity:
- `search "name"` -- does a page already exist?
- **If yes:** UPDATE path (add new signal, update compiled truth if material)
- **If no:** CREATE path (check notability gate first, then create)

### Step 3: Extract signal from source

Don't just capture facts. Capture texture:

| Signal Type | What to Extract |
|-------------|----------------|
| Opinions, beliefs | What They Believe section |
| Current projects, features shipped | What They're Building section |
| Ambition, career arc, motivation | What Motivates Them section |
| Topics they return to obsessively | Hobby Horses section |
| Who they amplify, argue with, respect | Network / Relationships |
| Ascending, plateauing, pivoting? | Trajectory section |
| Role, company, funding, location | State section (hard facts) |

### Step 4: External data source lookups

Priority order -- stop when you have enough signal for the entity's tier.

**4a. Brain cross-reference (always, all tiers)**
- `search "name"` and `query "what do we know about name"` (or
  `entity_recall` for a full dossier pull)
- Check related pages: company pages for person enrichment and vice versa
- This is free and often the richest source

**4b. Web research (Tier 1 and 2)**
- Use the agent's own web search tooling (see `skills/perplexity-research` for
  the brain-first research protocol)
- **Key pattern:** Send existing brain knowledge as context so the search
  returns DELTA (what's new vs what you already know), not a rehash
- Sonnet-tier synthesis for Tier 1 deep research, Haiku-tier for Tier 2

**4c. Social media lookup (all tiers when handle known)**
- Pull recent posts/tweets for tone, interests, current focus
- Social media is the highest-texture signal for what someone actually thinks

**4d. People enrichment APIs (Tier 1)**
- LinkedIn data, career history, connections, education

**4e. Company enrichment APIs (Tier 1)**
- Company data, financials, headcount, key hires, recent news

| Data Need | Example Sources | Tier |
|-----------|----------------|------|
| Web research | Agent web search tooling | 1-2 |
| LinkedIn / career | Crustdata, Proxycurl, People Data Labs | 1 |
| Career history | Happenstance, LinkedIn | 1 |
| Funding / company data | Crunchbase, PitchBook, Clearbit | 1 |
| Social media | Platform APIs, web scraping | 1-3 |
| Meeting history | Calendar/meeting transcript tools | 1-2 |

### Step 5: Save raw data (preserves provenance)

Store raw API responses via `put_raw_data`:
```json
{
  "source": "crustdata",
  "fetched_at": "2026-04-11T...",
  "query": "jane doe",
  "data": { ... }
}
```

Raw data preserves provenance. If the compiled truth is ever questioned,
the raw data (`get_raw_data`) shows exactly what the API returned.

### Step 6: Write to brain

#### CREATE path

1. Check notability gate (see `_brain-filing-rules.md`)
2. Check filing rules -- where does this entity go?
3. Create page with the appropriate template (below) via `page_put`
4. Fill compiled truth with citations
5. Add first timeline entry (`add_timeline_event`)
6. Leave empty sections as `[No data yet]` (don't fill with boilerplate)

#### UPDATE path

1. Add new timeline entries (reverse-chronological, append-only)
2. Update compiled truth ONLY if the new signal materially changes the picture
3. Update State section with new facts
4. Flag contradictions between new signal and existing compiled truth
5. Don't overwrite user-written assessments with API boilerplate

#### Person page template

```markdown
---
title: Full Name
type: person
created: YYYY-MM-DD
updated: YYYY-MM-DD
tags: []
company: Current Company
relationship: How the user knows them
email:
linkedin:
twitter:
location:
---

# Full Name

> 1-paragraph executive summary: HOW do you know them, WHY do they matter,
> what's the current state of the relationship.

## State
Role, company, key context. Hard facts only.

## What They Believe
Ideology, first principles, worldview. What hills do they die on?

## What They're Building
Current projects, recent launches, what they're focused on.

## What Motivates Them
Ambition, career arc, what drives them.

## Hobby Horses
Topics they return to obsessively. Recurring themes in their work/posts.

## Assessment
Your read on this person. Strengths, gaps, trajectory.

## Trajectory
Ascending, plateauing, pivoting, declining? Where are they headed?

## Relationship
History of interactions, shared context, relationship quality.

## Contact
Email, social handles, preferred communication channel.

## Network
Key connections, mutual contacts, organizational relationships.

## Open Threads
Active conversations, pending items, things to follow up on.

---

## Timeline
Reverse chronological. Every entry has a date and [Source: ...] citation.
- **YYYY-MM-DD** | Event description [Source: ...]
```

#### Company page template

```markdown
---
title: Company Name
type: company
created: YYYY-MM-DD
updated: YYYY-MM-DD
tags: []
---

# Company Name

> 1-paragraph executive summary.

## State
What they do, stage, key people, key metrics, your connection.

## Open Threads
Active items, pending decisions, things to track.

---

## Timeline
- **YYYY-MM-DD** | Event description [Source: ...]
```

### Step 7: Cross-reference

- Update company pages from person enrichment (and vice versa)
- Update related project/deal pages if relevant context surfaced
- Check index files if the brain uses them

**Note:** Wikilink-style mentions between brain pages are derived
automatically when a page is written and indexed. Step 7 focuses on
content cross-references (updating related pages' compiled truth with new
signal from this enrichment), not on re-creating those links. For an
explicit typed relationship, call `link`; verify what resolved with
`backlinks` on the entity page. Timeline entries still need explicit
`add_timeline_event` calls.

## Bulk Enrichment Rules

> **Convention:** `conventions/test-before-bulk.md` (via `get_skill conventions/test-before-bulk`).

- **Test on 3-5 entities first.** Read actual output. Check quality.
- Only proceed to bulk after test shots pass your quality bar.
- 3+ entities from one source -> batch process or fan out to your own
  subagents; for server-side batch work, submit a durable job
  (`jobs_submit`) and track it with `jobs_get`.
- Throttle API calls. Respect rate limits.
- Pages are live on each `page_put` -- pause every 5-10 entities during
  bulk runs to spot-check output before continuing.
- Save a report after bulk enrichment (see Report Storage below).

## Validation Rules

- Connection count < 20 on LinkedIn = likely wrong person, skip
- Name mismatch between brain and API = skip, flag for review
- Joke profiles or obviously wrong data = save to raw, don't update page
- Don't overwrite user-written assessments with API boilerplate
- When in doubt: save raw data but don't update brain page

## Report Storage

After enrichment sweeps, save a report as a brain page
(`page_put reports/enrich-<date>`):
- Number of entities processed
- New pages created vs existing updated
- Data sources called and results quality
- Notable discoveries or contradictions
- Validation flags or API failures

This creates an audit trail for brain enrichment over time.

## Anti-Patterns

- Creating stub pages with no content
- Enriching without checking brain first
- Overwriting user's direct statements with API data
- Creating pages for non-notable entities

## Output Format

An enriched person page contains:
- **Frontmatter** with type, tags, company, relationship, and contact fields
- **Executive summary** (1 paragraph: how you know them, why they matter, relationship state)
- **State** section with hard facts and inline `[Source: ...]` citations
- **Texture sections** (What They Believe, What They're Building, What Motivates Them, Hobby Horses)
- **Assessment** with trajectory read
- **Relationship** history and contact info
- **Network** connections and mutual contacts
- **Timeline** in reverse chronological order, every entry dated with source citation

An enriched company page contains:
- **Frontmatter** with type and tags
- **Executive summary** (1 paragraph)
- **State** section (what they do, stage, key people, metrics, your connection)
- **Open Threads** (active items, pending decisions)
- **Timeline** in reverse chronological order with dated, cited entries

Both page types have bidirectional back-links to every entity they mention.

## Tools Used

- Read a page from the brain (page_get)
- Store/update a page in the brain (page_put)
- Add a timeline entry (add_timeline_event)
- List pages by type/prefix (page_list)
- Store raw API data (put_raw_data)
- Retrieve raw data (get_raw_data)
- Link entities (link)
- Check backlinks (backlinks)
