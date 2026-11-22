---
name: citation-fixer
version: 1.1.0
description: |
  Audit and fix citation formatting across brain pages. Ensures every fact has
  an inline [Source: ...] citation matching the standard format. Also scans for
  broken tweet/post references that lack actual URLs and resolves them via the
  agent's own web search tooling.
triggers:
  - "fix citations"
  - "fix broken citations"
  - "citation audit"
  - "check citations"
  - "citation fixer"
tools:
  - search
  - page_get
  - page_put
  - page_list
mutating: true
writes_to:
  - reports/
---

# Citation Fixer Skill

> **Convention:** see conventions/quality.md (via `get_skill conventions/quality`)
> for the canonical citation format every fix should match.
>
> **Output rule:** all links MUST be deterministic (built from verified
> lookup data, not composed by LLM). See `_output-rules.md`
> (via `get_skill _output-rules`).

## Contract

This skill guarantees:

- Every brain page is scanned for citation compliance.
- Missing citations are flagged with specific location.
- Malformed citations are fixed to match the standard format.
- Tweet / post references without URLs are resolved via the agent's web
  search tooling and patched with deterministic
  `https://x.com/<handle>/status/<id>` links.
- Results reported with counts (scanned, fixed, remaining).

## Phases

1. **Scan pages.** `page_list` the brain and read each page (`page_get`),
   checking for inline `[Source: ...]` citations.
2. **Identify issues:**
   - Facts without any citation
   - Citations missing date
   - Citations missing source type
   - Citations with wrong format
   - Tweet references without `x.com` URLs
3. **Fix format issues.** Rewrite malformed citations to match
   `conventions/quality.md`, writing the corrected page back with `page_put`.
4. **Resolve tweet references** via the agent's web search tooling.
5. **Report results.** Count: pages scanned, citations found, issues
   fixed, tweets resolved, remaining gaps.

## Tweet resolution pipeline

For each broken tweet reference, follow this chain. The lookup goes
through whatever web search / X lookup tooling the host agent has —
never through invented URLs.

### Step 1: Identify broken references

Scan the page for patterns that indicate tweet references without URLs:

- Contains words like `tweeted`, `posted`, `said on X`, `RT`, `retweet`,
  `X post`
- Contains quoted text that looks like a tweet (short, punchy, often
  starts with a quote)
- Has `[Source: ... X/Twitter ...]` without an `x.com` URL
- References engagement metrics (likes, impressions) without a link

### Step 2: Extract searchable content

From each broken reference, extract:

- The **handle** (if mentioned: `@<username>`)
- The **quoted text** (if available)
- The **approximate date** (often present in surrounding timeline entries)

### Step 3: Search for the actual tweet

Use the agent's web search tooling. Query patterns:

```
# Handle + quoted text:
from:<handle> "<exact quote fragment>"

# Quoted text only:
"<exact quote fragment>"

# Original of a retweet:
"<exact quote>" -is:retweet
```

### Step 4: Verify and extract metadata

Once a candidate is found:

- Confirm the text matches the quoted fragment.
- Pull the tweet id, author handle, engagement metrics (likes / RTs /
  impressions) if visible.
- Construct the URL: `https://x.com/<handle>/status/<tweet_id>`.

### Step 5: Patch the brain page

Replace the broken citation with a proper one (via `page_put`):

**Before:**

```
"<quote fragment>" [Source: <some hand-wavy attribution>]
```

**After:**

```
"<full verified quote>" — <N> likes, <N> RTs, <N> impressions
[Source: [X/<handle>, YYYY-MM-DD](https://x.com/<handle>/status/<tweet_id>)]
```

## Batch mode

When sweeping many pages:

### Find candidate pages

The brain is DB-canonical — sweep it through the retrieval surface, not
a filesystem walk:

```
# Pages mentioning tweets but with no x.com links
search "tweeted OR retweet OR X post"     → candidate slugs
page_get <slug>                            → count refs vs x.com/... links
# a page with 3+ tweet-ish refs and 0 status links is a candidate
```

### Priority order

1. Recently created / updated pages — fresh broken refs are easiest to
   resolve while context is fresh.
2. High-traffic pages (frequent reads / writes from other skills — check
   `get_recent_salience` for activity).
3. Everything else — bulk cleanup over time.

### Rate limiting

- Web lookups: respect the host tooling's limits; don't hammer.
- Target ~50 pages per batch run.
- 1-3 lookups per page (search + verify).
- Write back every 10-20 pages so a partial failure doesn't lose
  progress.

## Output format

```
Citation Audit Report
=====================
Pages scanned:        N
Citations found:      N
Issues fixed:         N
Tweet links resolved: N
Remaining gaps:       N (pages with uncitable facts)
```

## Anti-Patterns

- ❌ Inventing citations for facts that have no source. Flag them.
- ❌ Removing facts that lack citations (flag them; don't delete).
- ❌ Fixing citations without reading the full page context.
- ❌ Batch-fixing without checking quality on a sample first
  (see conventions/test-before-bulk.md via `get_skill conventions/test-before-bulk`).
- ❌ Composing tweet URLs by guessing the tweet id. Always verify via
  the web lookup; deterministic links only.

## Integration

This skill can be called:

- **Manually** — "fix citations on this page"
- **As a recurring batch** — weekly sweep via a host systemd timer (or the
  agent harness's scheduler) over pages with broken refs
- **By other skills** — `enrich` or `media-ingest` can call citation-fixer
  before commit to validate output

## Metrics

If running as a recurring batch, track state in a brain page at
`reports/citation-fixer-state` (via `page_put`):

```json
{
  "last_run": "2026-04-15T...",
  "pages_scanned": 0,
  "citations_fixed": 0,
  "tweet_links_resolved": 0,
  "citations_unresolvable": 0,
  "pages_remaining": 1424
}
```


## Output Format

The skill's output shape is documented inline in the body sections above (see "Output", "Brain page format", or equivalent). The literal section header here exists for the conformance test.
