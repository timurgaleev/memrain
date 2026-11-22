---
name: repo-architecture
version: 1.0.0
description: |
  Where new brain pages go. Decision protocol for filing brain pages by primary
  subject, not by format or source. Reference for all brain-writing skills.
triggers:
  - "where does this go"
  - "filing rules"
  - "create new page"
  - "which directory"
tools:
  - search
  - page_get
  - page_list
mutating: false
---

# Repo Architecture — Filing Rules

> **Full filing rules:** See `_brain-filing-rules.md` (via `get_skill _brain-filing-rules`)

## Contract

This skill guarantees:
- Every new page is filed by primary subject (not format, not source)
- The decision protocol is followed for ambiguous cases
- Common misfiling patterns are caught

## Phases

1. **Identify the primary subject.** What would you search for to find this page?
2. **Walk the decision tree:**
   - About a person → `people/{name-slug}`
   - About a company → `companies/{name-slug}`
   - A reusable concept/framework → `concepts/{slug}`
   - An original idea → `originals/{slug}`
   - A meeting → `meetings/{slug}`
   - Media content → `media/{type}/{slug}`
   - Raw data import → `sources/{slug}`
3. **Cross-link.** Use `link` from related pages; check `backlinks` on the new slug.
4. **Check notability.** See `conventions/quality.md` notability gate (via `get_skill conventions/quality`).

## Output Format

Advisory: "File this at `{type}/{slug}` because the primary subject is {reason}."

## Anti-Patterns

- Filing by format ("it's a PDF so it goes in sources/")
- Filing by source ("it came from email so it goes in sources/")
- Creating pages without checking if one already exists (`search` first, then `page_get`)
- Using `sources/` for anything except raw data dumps
