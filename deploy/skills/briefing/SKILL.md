---
name: briefing
description: Compile daily briefing with meeting context, active deals, and citation tracking
triggers:
  - "daily briefing"
  - "morning briefing"
  - "what's happening today"
tools:
  - search
  - query
  - page_get
  - page_list
  - entity_timeline
  - entity_facts
  - fact_supersessions
  - get_recent_salience
  - chronicle_since
mutating: false
---

# Briefing Skill

Compile a daily briefing from brain context.

> **Filing rule:** When the briefing creates or updates brain pages,
> follow `skills/_brain-filing-rules.md` (via `get_skill _brain-filing-rules`).

## Contract

- Every fact in the briefing includes an inline `[Source: slug, updated DATE]` citation.
- Meeting participants are resolved against the brain; gaps are explicitly flagged.
- Active deals and action items include deadlines and recency context.
- The briefing is read-only: no brain pages are created or modified unless the user explicitly requests it.
- Stale alerts surface pages relevant to today's context, not just all stale pages.

## Phases

0. **Hot memory pulse.** Before composing anything else, pick the window:
   the date of the last briefing when the operator gives one, otherwise
   yesterday (`<since>`, `YYYY-MM-DD`). Then pull its deltas:

   ```
   fact_supersessions { since: <since> }         → contradictions resolved in the window
   get_recent_salience { days: <window days> }   → top entities by recent activity
   entity_facts { entity_slug, since: <since> }  → new facts, per top entity
   chronicle_since { since: <since> }            → the narrative of what happened
   ```

   Fold the result into the briefing under a "Brain pulse" section at the top:
   1. **Contradictions resolved overnight** — the `fact_supersessions` output. Lead
      with these because they're new corrections to your model of the world.
   2. **Top mentions** — from `get_recent_salience` (top 5 entity slugs by
      recent-activity weight in the window).
   3. **New facts since last briefing** — the `entity_facts` rows for each
      entity from the salience list; include `kind`, `notability`, and `confidence`.

   The brain keeps no briefing cursor. A timer-driven run passes its own
   window (for example the last 24 hours), so runs never depend on state
   left by an earlier one.

1. **Today's meetings.** For each meeting on the calendar:
   - `search` the brain for each participant by name
   - Read their pages (`page_get`) for compiled-truth context
   - Summarize: who they are, recent timeline, relationship to you
2. **Active deals.** List deal pages (`page_list` under `deals/`) filtered to active status:
   - Deadlines approaching in the next 7 days
   - Recent timeline entries (last 7 days, via `entity_timeline`)
3. **Time-sensitive threads.** Open items from timeline entries:
   - Items with deadlines in the next 48 hours
   - Follow-ups that are overdue
4. **Recent changes.** Pages updated in the last 24 hours:
   - What changed and why (read timeline entries via `entity_timeline`,
     or `chronicle_day` for the narrative view)
5. **People in play.** List person pages sorted by recency:
   - Updated in last 7 days
   - Have high activity (many recent timeline entries — cross-check
     `get_recent_salience`)
6. **Stale alerts.** Among the pages read for today's meetings:
   - Pages last updated more than 90 days ago, whose compiled truth may no
     longer hold

## Brain-Native Context Loading

Before generating any briefing, load context from the brain systematically.
(See conventions/brain-first.md via `get_skill conventions/brain-first`.)

### Before a meeting

For every attendee on the calendar invite:
- `search "<attendee name>"` — find their brain page
- `page_get <slug>` — load compiled truth, recent timeline, relationship context
- If no page exists, note the gap ("No brain page for Sarah Chen — consider enrichment")

### Before an email reply

Before drafting or triaging any email:
- `search "<sender name>"` — load sender context
- Read their compiled truth to understand who they are, what they care about, and
  your relationship history. This turns a cold reply into an informed one.

### Daily briefing queries

Run these queries to populate the briefing sections:
- `query "active deals status"` — deal pipeline snapshot
- `query "meetings this week"` — recent meeting pages with insights
- `query "pending commitments follow-ups"` — open threads and action items
- `page_list` under `people/` sorted by updated, limit 10 — people in play

## Output Format

```
DAILY BRIEFING -- [date]
========================

MEETINGS TODAY
- [time] [meeting name]
  Participants: [name] (slug: people/name, [key context])

ACTIVE DEALS
- [deal name] -- [status], deadline: [date]
  Recent: [latest timeline entry]

ACTION ITEMS
- [item] -- due [date], related to [slug]

RECENT CHANGES (24h)
- [slug] -- [what changed]

PEOPLE IN PLAY
- [name] -- [why they're active]
```

## Back-Linking During Briefing

If the briefing creates or updates any brain pages (e.g., new meeting prep
pages, updated entity pages), the back-linking iron law applies: every entity
mentioned must have a back-link from their page (`link` + verify with
`backlinks`). See `skills/_brain-filing-rules.md`.

## Citation in Briefings

When presenting facts from brain pages, include inline citations:
- "Jane is CTO of Acme [Source: people/jane-doe, updated 2026-04-01]"
- This lets the user trace any claim back to the brain page and assess freshness

## Anti-Patterns

- **Briefing without brain queries.** Never generate a briefing from memory alone; always query the brain for current data.
- **Uncited facts.** Every claim must include `[Source: slug, updated DATE]`. A fact without a citation is unverifiable.
- **Stale context presented as current.** If a page hasn't been updated in 30+ days, flag the staleness explicitly rather than presenting it as fresh.
- **Modifying brain pages unprompted.** The briefing is read-only by default. Do not create or update pages unless the user explicitly requests it.
- **Ignoring coverage gaps.** When a meeting participant has no brain page, say so. Silence about gaps hides ignorance.

## Tools Used

- Search the brain by name (`search`, `query`)
- Read a page (`page_get`)
- List pages by prefix (`page_list`)
- View timeline entries (`entity_timeline`)
- Pull the window's pulse (`fact_supersessions`, `get_recent_salience`,
  `entity_facts`, `chronicle_since`)
