---
name: schema-unify
version: 1.0.0
description: |
  Collapse a brain's sprawl of page types (tweet, tweet-thread, tweet-single,
  x-post…) into a small canonical set, with the long tail kept recoverable.
  Inventories the types, proposes a mapping, records it in the ontology and
  the filing rules, previews and applies the retype in reviewed batches with
  memrain page-retype, and keeps a log that makes every batch reversible.
triggers:
  - "unify my types"
  - "consolidate page types"
  - "too many page types"
  - "shrink type proliferation"
  - "apply a canonical taxonomy"
  - "clean up my page types"
  - "retype pages to canonical"
tools:
  - page_list
  - page_get
  - ontology_get
  - ontology_dimensions
  - ontology_conflicts
  - ontology_propose
  - page_append
  - search
  - link
  - get_skill
mutating: true
writes_pages: true
writes_to:
  - agent/
---

# Schema Unification

> **Convention:** `conventions/schema-evolution.md` (via
> `get_skill conventions/schema-evolution`) decides when a cluster deserves a
> type, an alias or only a prefix. This skill applies those decisions to a
> taxonomy that has already sprawled.
>
> **Filing rule:** `_brain-filing-rules` (via `get_skill _brain-filing-rules`)
> is the shared contract every writing skill reads; extend it, do not rewrite
> it.

## Mental model

Typing is open in Memrain: `type` is a field on each page, prefixes are
conventions, and there is no schema pack to swap. Years of ingestion leave
many near-duplicate types. The cure is a small canonical set (for example
person, company, meeting, concept, article, source, project, note), with
format and origin detail moved into frontmatter, aliases registered in the
ontology so lookups by the old name still work, and every retype logged so
it can be reversed.

Run it when the user asks about cleaning up types, when an inventory shows
many near-duplicate types, or when filtering by type keeps missing pages
because the same kind of page carries three names. It is a hand-run,
reviewed job; never schedule it.

## Decision tree

```
A handful of types, each clearly distinct?
  -> Nothing to unify. Stop and say so.
Several sources in this brain?
  -> Inventory and batch per source (--source-id); each source can be
     unified on its own schedule.
One cluster you are unsure about?
  -> Leave it for last; start with the clearest cluster and a small batch.
Pages that are really edges ("alice-example advises acme-example" and
nothing else)?
  -> Record the relation with `link`; deleting the page afterwards goes
     through data-loss-gate.
Fenced types (diary, journal)?
  -> Out of scope. Never retype them.
```

## Workflow

### Phase 1: inventory

List the types and their counts. `page_list` filtered by `type` (paged with
`cursor`) for the types you know; for a whole prefix, a `memrain page-retype`
preview prints counts per type without changing anything (step 3). Read the
current ontology: `ontology_dimensions` for the axes, `ontology_get` for
existing types and aliases.

### Phase 2: propose the mapping

For each existing type, decide by the schema-evolution decision tree:

- **Canonical:** keep it.
- **Collapse into a canonical type:** `tweet-thread` → `tweet`.
  `page-retype` changes only the type: no frontmatter is written, so the old
  type survives only in the `agent/taxonomy-log` entry (Phase 4). Collapse
  only when the old type carries no detail worth keeping; otherwise keep it
  as its own type or alias.
- **Alias:** a name people search by that should resolve to a canonical type;
  propose it with `ontology_propose` and check `ontology_conflicts` first.
- **Long tail:** fewer than about 20 pages and no clear home → `note`, with
  the original recorded in the log.

Show the mapping to the user as a table (old type, count, new type, why) and
wait for agreement. Do not proceed on an unreviewed mapping.

### Phase 3: build and preview each batch

A batch is an explicit list of slugs, so the log can hold exactly what moved.
Build it from `page_list` with the old `type` (and a `slug_prefix` when one
type spans several areas), following `cursor`: each row carries the slug and
its current type. Keep batches to a few hundred slugs. Then preview that
list:

```bash
memrain page-retype --from tweet-thread --slugs <slug-1>,<slug-2>,... --to tweet --json
```

Preview is the default: it prints the match count, the counts per old type
and a sample of slugs, and changes nothing. The match count must equal the
batch's length; a difference means the list is stale, so rebuild it. It
refuses a selection over 2,000 pages (narrow it by `--from`,
`--path-prefix`, `--slugs` or `--source-id`) and refuses to retype into or
out of the fenced types (`diary`, `journal`), because that would expose or
half-hide private pages. Those refusals are by design; never work around them.

### Phase 4: confirm, log, then apply

A bulk retype changes many pages at once, so each batch goes through the
`data-loss-gate` card first (`get_skill data-loss-gate`): the slug count,
the old and new type, and the rollback command. One yes can cover the
reviewed batch list; a new or changed list needs a new card.

Before applying a batch, append it to `agent/taxonomy-log` with
`page_append`: date, the command, and the full slug list with each slug's old
type from `page_list` (the preview shows only a sample). That entry is the
rollback: `memrain page-retype --from tweet --slugs <the same list> --to
tweet-thread --apply` restores the batch, one old type at a time.

```bash
memrain page-retype --from tweet-thread --slugs <slug-1>,<slug-2>,... --to tweet --apply --json
```

The result's `updated` count must equal the batch's length.

Start with one small batch, read a few retyped pages with `page_get`, then
continue batch by batch. Record in `_brain-filing-rules` the prefix and type
that new ingestion should use, so the sprawl does not regrow.

### Phase 5: verify

Re-run the inventory: the old types are gone or down to the planned long
tail, `ontology_conflicts` is clean, and a `search` filtered to a canonical
type returns the retyped pages.

## Contract

- No retype runs before the user agreed to the mapping and confirmed the
  batch through `data-loss-gate`.
- Every batch is previewed, logged with its slugs and old types, then
  applied; every batch can be reversed from the log.
- No batch exceeds the tool's 2,000-page limit, and the fenced-type refusals
  are never worked around.
- Aliases go through `ontology_propose`, checked with `ontology_conflicts`.
- The filing rule for new pages is updated so the cleanup sticks.

## Output Format

```
Inventory: N types across M pages (top: tweet 1,204 · tweet-thread 380 · …)
Mapping:   N types → K canonical (+ aliases A, long tail → note: L pages)
Batches:   applied B of C   pages retyped: N   log: agent/taxonomy-log
Verify:    remaining legacy types: …   ontology_conflicts: clean
Next:      <next batch | done>
```

## When it fails

- The preview refuses over 2,000 pages: split by prefix or by `--from`.
- The preview refuses a fenced type: leave those pages alone and tell the
  user why.
- `ontology_conflicts` reports a collision: resolve it before proposing the
  alias.

## Anti-Patterns

- Applying without a preview or without the log entry.
- One giant batch across the brain.
- Inventing a type for a one-off cluster (see schema-evolution).
- Retyping fenced pages by any route.
- Changing the filing rules' meaning instead of extending them.
- Renaming slugs to match the new type. A retype changes only `type`; slugs,
  `[[links]]` and backlinks keep working. Moving pages to a new prefix is a
  separate `page_rename` decision.
- Two batches running at the same time, or a batch run on a schedule.
- Mapping every legacy type by hand; the long tail goes to `note` with the
  log as its record.

## Dedup (sharp boundaries)

- `schema-author` adds or evolves one type; this skill consolidates many.
- `brain-taxonomist` decides where one page goes.
- `frontmatter-guard` checks frontmatter shape, not the taxonomy.
- `data-loss-gate` supplies the confirmation card before each apply.
