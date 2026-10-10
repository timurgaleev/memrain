---
name: maintain
version: 1.0.0
description: |
  Brain health checks: back-link enforcement, citation audit, filing validation,
  stale info detection, orphan pages, and benchmarks. Use when asked to check
  brain health, run maintenance, or audit quality.
triggers:
  - "check backlinks"
  - "maintenance"
  - "orphan pages"
  - "stale pages"
  - "extract links"
  - "build link graph"
  - "populate timeline"
  - "populate links"
  - "backfill graph"
  - "extract timeline entries"
  - "run the cycle"
  - "process today's session"
  - "process yesterday's transcripts"
  - "synthesize my conversations"
  - "what patterns did you see"
  - "did the cycle run"
  - "consolidate yesterday's conversations"
tools:
  - run_doctor
  - stats
  - get_status_snapshot
  - page_get
  - page_put
  - page_list
  - backlinks
  - link
  - search
  - find_orphans
  - graph_query
  - source_health
  - jobs_submit
mutating: true
---

# Maintain Skill

Periodic brain health checks and cleanup.

## Contract

This skill guarantees:
- All health dimensions are checked (stale, orphan, dead links, cross-refs, backlinks, citations, filing, tags)
- Each issue found has a specific fix action
- Back-link iron law is enforced
- Citation format is validated against the standard
- Results are reported with counts per dimension

## Phases

### Autonomous path — when you want the brain fixed, not audited

If the user asks "fix what's broken" or "get my brain healthy", prefer the
server's own machinery over walking each dimension by hand:

```bash
memrain doctor          # categorized report: brain / ops / meta findings
memrain cycle           # run the full background maintenance cycle now
```

`run_doctor` (or `memrain doctor` from the shell) reports every dimension with a
cause-ranked, root-first list — fix the root causes first, the downstream
findings usually clear themselves. The background cycle already remediates
most mechanical dimensions on its own schedule: embedding backfill, link
derivation, decay, salience, chronicle. For heavy one-off work (bulk
re-embedding, large backfills), submit a durable job with `jobs_submit` and
watch it with `jobs_get` / `jobs_logs` rather than blocking the conversation.

When a target is unreachable for the brain (an empty brain with no entity
pages cannot have graph coverage; a brain with no embeddings configured cannot
have vector freshness), report what's missing rather than looping.

Use the per-dimension walk below when:
- The user explicitly asks for a dimension-by-dimension audit
- You're investigating why doctor keeps reporting the same finding
- A specific dimension needs manual judgment that the automatic path skips

### Manual path

1. **Run health check.** Call `run_doctor` and `stats` to get the dashboard.
2. **Check each dimension:**

### Stale pages
Pages where compiled_truth is older than the latest timeline entry. The assessment hasn't been updated to reflect recent evidence.
- Check the doctor output for stale page findings
- For each stale page: `page_get` it, review the timeline, determine if compiled_truth needs rewriting

### Orphan pages
Pages with zero inbound links. Nobody references them.
- Run `find_orphans` to enumerate them
- Review orphans: are they genuinely isolated or just missing links?
- Add `link`s from related pages or flag for deletion

### Dead links
Links pointing to pages that don't exist.
- Remove them with `unlink`

### Missing cross-references
Pages that mention entity names but don't have formal links.
- `page_get` the compiled_truth, extract entity mentions, create `link`s

### Link graph population
If `stats` shows `link_count` at 0 or low relative to page count, the graph
layer needs attention. The server derives typed links automatically on every
`page_put` (wikilink and `[Name](people/slug)`-style references become typed
link rows), and the background cycle reconciles the graph on each run. So:
- Run `memrain cycle` (or wait for the scheduled run) to backfill derivation
- Verify with `graph_query` on a well-known entity slug (depth 2 probe)
- Re-check `stats` for `link_count > 0`

### Timeline extraction
If timeline entry counts are 0 despite pages carrying dated lines, the cycle's
extraction hasn't caught up. Dated entries in the
`- **YYYY-MM-DD** | Source — Summary` format are parsed into structured
timeline rows. Verify with `entity_timeline` on a known entity after a cycle
run. Note: extracted entries improve structured queries, not vector search.

### Consolidation cycle: synthesize + patterns

The server's background cycle is the brain's long-term-memory consolidation
loop. It runs its phases in dependency order (lint → backlinks → synthesize →
extract → patterns → embed → orphans, among others) and is the preferred way
to process recent conversations into durable pages.

**Synthesize:** recent transcripts (see `get_recent_transcripts`) are filtered
with a cheap utility-tier (Haiku) verdict to skip routine ops sessions, then a
synthesis-tier (Sonnet) pass per worth-processing transcript writes
reflections (`personal/reflections/...`), originals (`originals/ideas/...`),
and people timeline entries. `extract_facts` pulls structured facts out of
the same material. New page slugs are collected from the cycle's own write
log — never inferred from page timestamps, which would pick up unrelated
writes.

**Patterns:** runs after extraction (so the graph state is fresh). Reads
recent reflections within the lookback window (default 30 days), runs a single
synthesis-tier pass to surface recurring themes, and writes pattern pages to
`personal/patterns/<theme>` when enough reflections (default 3) support a
pattern.

**Quality bar (Iron Law for synthesis):**
1. Quote the user verbatim. Do not paraphrase memorable phrasings.
2. Cross-reference compulsively: every new page MUST have at least one wikilink.
3. Slug discipline: lowercase alphanumeric and hyphens only. NO underscores, NO file extensions.
4. Edited transcripts produce NEW slugs (content-hash suffix changes) — never silently overwrite.

**Trust boundary:** synthesis writes are confined to an explicit allow-list of
page-path prefixes (reflections, originals, patterns, people timelines). Even
on prompt-injection success inside a transcript, the synthesizer cannot write
outside that list, and destructive operations (`page_delete`,
`purge_deleted_pages`) are never reachable from the public ingress at all.
Widening the allow-list is a config change, not something a transcript can do.

**Idempotency + privacy:** transcripts are keyed by content hash, so re-running
on the same content is a no-op. Exclude patterns (default `medical`,
`therapy`) filter transcripts before any LLM call; each entry is matched as a
word-boundary regex (`medical` matches "medical advice" but NOT "comedical").

**Cooldown:** the cycle's spend cap. Synthesis runs at most ~2× per day under
the scheduler; the completion timestamp is written ONLY on successful runs
(not on skipped/failed). Explicit operator-invoked runs bypass cooldown.

**Invocation patterns:**
```bash
memrain cycle                   # full maintenance cycle now
memrain status                  # snapshot incl. last cycle result
memrain call get_status_snapshot '{}' # same, via MCP from the shell
```

There is no git step: the brain is DB-canonical. Pages written by the cycle
are live immediately; no commit or push exists to forget.

### Scheduler check
Verify the cycle is actually running on schedule:
- `get_status_snapshot` (or `memrain status`) shows the last cycle completion
  and any warn-state phases
- On the host, the cycle runs under the server's own scheduler; systemd timers
  cover host-side jobs. If the last run is stale, check the server logs and
  `run_doctor` for the cause.

### Fix a half-migrated install
Migrations run at server boot. If the schema version is behind (doctor reports
current vs expected), a restart applies pending migrations idempotently —
safe on healthy installs. If doctor still reports schema drift after a
restart, escalate to the operator rather than patching tables by hand.

### Back-link enforcement
Check that the back-linking iron law is being followed:
- For each recently updated page, check if entities mentioned in it have
  corresponding back-links FROM those entity pages (`backlinks`)
- A mention without a back-link is a broken brain
- Fix: add the missing back-link to the entity's Timeline or See Also section
- Format: `- **YYYY-MM-DD** | Referenced in [page title](path) -- brief context`

### Filing rule violations
Check for common misfiling patterns (see `skills/_brain-filing-rules.md`):
- Content with clear primary subjects filed in `sources/` instead of the
  appropriate directory (people/, companies/, concepts/, etc.)
- Use `search` to find pages in `sources/` that reference specific
  people, companies, or concepts -- these may be misfiled
- Flag misfiled pages for review or re-filing

### Citation audit
Spot-check pages for missing `[Source: ...]` citations:
- Read 5-10 recently updated pages
- Check that compiled truth (above the line) has inline citations
- Check that timeline entries have source attribution
- Flag pages where facts appear without provenance

### Tag consistency
Inconsistent tagging (e.g., "vc" vs "venture-capital", "ai" vs "artificial-intelligence").
- Standardize to the most common variant with `add_tag` / `remove_tag`

### Graph verification

The links and timeline tables are the structured graph layer. After major
imports, verify they populated:

- `graph_query` on a well-known entity slug with depth 2 — verify connectivity.
- `stats` — verify `link_count > 0` and timeline entries exist after a cycle run.
- `run_doctor` — review link and timeline coverage findings on entity pages
  (person/company). Low coverage means the source pages lack extractable
  references, not that extraction is broken — read a few pages to confirm.

Available link types (use with `graph_query`):
`attended`, `works_at`, `invested_in`, `founded`, `advises`, `mentions`, `source`.

Every `page_put` auto-derives and reconciles links, so graph population is
mostly a one-time concern after bulk imports; the cycle re-runs derivation
after content edits that add new references or dated entries.

### Embedding freshness
Chunks without embeddings, or chunks embedded with an old model.
- `stats` shows embedded vs total chunk counts
- Backfill from the shell: `memrain embed`
- For large refreshes (>1000 chunks), run detached:
  `nohup memrain embed > /tmp/memrain-embed.log 2>&1 &` then `tail -1` the log

### Security
Run `run_doctor` and review the ops findings: ingress configuration, bearer
auth, and redaction on the public surface. Public reads must omit page
content; destructive tools must be internal-only. If doctor flags an ingress
finding, escalate to the operator — do not change auth config mid-audit.

### Schema health
Check that the schema version is up to date. `run_doctor` reports the current
migration version vs expected. If behind, a server restart applies pending
migrations automatically.

### Raw data provenance
Check the integrity of stored raw sources:
- Spot-check recently ingested pages: does `get_raw_data` return a payload
  for pages that claim an ingested source?
- Review `get_ingest_log` for failed or partial ingests
- Flag pages whose `**Source:**` line points at a URL or file that no longer
  resolves

### Open threads
Timeline items older than 30 days with unresolved action items.
- Flag for review

## Benchmark Testing

Periodically verify search quality hasn't regressed. Run a battery of test
queries across difficulty tiers:

- **Tier 1 (entity lookup):** known names -- should always resolve
- **Tier 2 (topic recall):** concepts, topics -- keyword search should handle
- **Tier 3 (semantic):** queries with no exact keyword match -- needs embeddings
- **Tier 4 (cross-domain):** relational/connection queries -- only semantic handles

Compare `memrain search` results across modes (keyword vs hybrid), and run
`memrain eval` for the scored retrieval-quality battery. Quality matters more
than speed (2.5s right > 200ms wrong).

When to run benchmarks:
- After major brain imports or re-imports
- After server version upgrades
- After embedding regeneration
- Monthly to track quality drift

## Heartbeat Integration

For production agents running on a schedule, integrate brain health checks into
your operational heartbeat.

### On every heartbeat (hourly or per-session)

Call `run_doctor` (or `memrain doctor` from the shell) and check for
degradation. Report any failing checks to the user. Key signals: connection
health, schema version, ingress/auth status, embedding staleness.

### Weekly maintenance

Run `memrain embed` to refresh embeddings for pages that have changed since
their last embedding. For large brains (>5000 pages), run this detached:
```bash
nohup memrain embed > /tmp/memrain-embed.log 2>&1 &
```

### Daily verification

Verify the note source is fresh: check `source_health` and confirm the
'memory' source was indexed within the last 24 hours. If indexing has
stopped, the brain is drifting from the note corpus — run `memrain reindex`
and investigate why the scheduled index lapsed.

### Stale compiled truth detection

Flag pages where compiled truth is >30 days old but the timeline has recent entries.
This means new evidence exists that hasn't been synthesized. These pages need a
compiled truth rewrite (see the maintain workflow above).

## Report Storage

After maintenance runs, save a report as a brain page (`page_put` under
`reports/`):
- Health check results (before/after findings for each dimension)
- Back-link violations found and fixed
- Filing rule violations found
- Citation gaps flagged
- Benchmark results (if run)
- Outstanding issues requiring user attention

This creates an audit trail for brain health over time.

## Quality Rules

- Never delete pages without confirmation
- Log all changes via timeline entries
- Run `run_doctor` before and after to show improvement

## Anti-Patterns

- Fixing pages without reading them first -- you must understand context before editing
- Silently skipping dimensions -- every dimension must be checked and reported, even if clean
- Deleting orphan pages without checking if they should be linked instead
- Running embedding refresh during peak usage hours
- Batch-fixing back-links without verifying the relationship is real
- Marking a dimension "clean" without actually querying it
- Rewriting compiled truth without reading the full timeline first
- Removing tags without checking if other pages use the same tag consistently

## Output Format

The maintenance report follows this structure:

```
## Brain Health Report — YYYY-MM-DD

| Dimension           | Issues Found | Fixed | Remaining |
|----------------------|-------------|-------|-----------|
| Stale pages          | N           | N     | N         |
| Orphan pages         | N           | N     | N         |
| Dead links           | N           | N     | N         |
| Missing cross-refs   | N           | N     | N         |
| Back-link violations | N           | N     | N         |
| Citation gaps        | N           | N     | N         |
| Filing violations    | N           | N     | N         |
| Tag inconsistencies  | N           | N     | N         |
| Embedding staleness  | N           | N     | N         |
| Security (ingress)   | N           | N     | N         |
| Schema health        | N           | N     | N         |
| Raw data provenance  | N           | N     | N         |
| Open threads         | N           | N     | N         |

### Details
[Per-dimension breakdown with specific pages and actions taken]

### Benchmark Results (if run)
[Tier 1-4 query results with pass/fail]

### Outstanding Issues
[Items requiring user attention or confirmation]
```

## Tools Used

- Check brain health (run_doctor, stats, get_status_snapshot)
- List pages with filters (page_list)
- Read a page (page_get)
- Check backlinks (backlinks)
- Find orphan pages (find_orphans)
- Link entities (link)
- Remove links (unlink)
- Tag a page (add_tag)
- Remove a tag (remove_tag)
- View a timeline (entity_timeline)
- Check note-source freshness (source_health)
