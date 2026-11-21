---
name: brain-link-discipline
version: 1.0.0
description: |
  When you report a brain page to the user (created, edited, or relayed from
  a subagent), a working link is part of the deliverable, in the same
  message. Take the link from the write's admin_url, confirm the page exists
  before linking, and fall back through a fixed chain when there is no link.
  Inside page bodies the rule inverts: [[slug]] links keep the link graph;
  absolute URLs are for chat only.
triggers:
  - "give me the link"
  - "where is the page"
  - "why does this link 404"
  - "brain link discipline"
  - "rewrite subagent paths"
  - "report the pages you created"
  - "send me a clickable link"
  - "link the page in the same message"
tools:
  - page_get
  - resolve_slugs
  - search
  - get_links
mutating: false
---

# brain-link-discipline — The Link Is Part of the Deliverable

> **Convention:** `_output-rules` (via `get_skill _output-rules`) carries the
> cross-skill output rules; this skill carries the link mechanics.
>
> **Convention:** `conventions/brain-first.md` (via `get_skill conventions/brain-first`):
> every reference to a brain page in output is a clickable link where the
> deployment allows one.

A reporting convention for messages that deliver brain pages, not a
mechanical guarantee.

## The rule (same message)

When you write a brain page and tell the user about it, the link goes in that
same message. Every time. The user never has to ask "where is the page".

This applies to any message reporting a created or edited page, bulk reports
("5 pages created": one link per page), references to pages in normal
conversation, and relayed subagent results (rewrite them first, below).

## Where the link comes from

Memrain stores pages in its database, so a page's address is its slug, and
its human view is the admin panel:

1. **`admin_url` from the write result.** `page_put`, `page_append`,
   `page_edit`, `page_rename` and the other page writes return an `admin_url`
   when the caller holds admin scope and the server has `MEMRAIN_PUBLIC_URL`
   set. Use it as given; it already encodes the slug.
2. **Built from the same parts** when you know the server's public URL but the
   result carried no `admin_url`: `<public-url>/admin/#page/<url-encoded slug>`
   (for example `https://brain.example.com/admin/#page/people%2Falice-example`).
   Only build it from a URL the user or the deployment gave you, never a guess.
3. **The slug with a scope note** when there is no public URL (a local brain)
   or the caller is not an admin: give the slug and say it opens in the admin
   panel for people who can sign in to it.
4. **A shared copy** for anyone outside the brain: hand off to `publish`, which
   produces an encrypted HTML file. Offer it as a file; never present it as a
   URL.

## Sequence (write, then link)

1. Write the page (`page_put`, `page_edit`, `page_append`, `page_rename`).
2. Read the result. A version number means the write landed. An error means
   there is nothing new to link; report the error.
3. `search_pending` in the result only means the search index lags; the page
   itself exists and `page_get` reads it. Link it, and say search may take a
   moment to find it.
4. In the same message that reports the write, give the link: a bare URL or
   a markdown link, never a backticked code span.

## Check before linking

Before a link goes out, confirm the page exists under that exact slug with
`page_get`. After a rename, link the new slug (`page_rename` returns it). If
the write was refused or is still pending, give no link: say what happened.
Never compose a slug from memory: if you are unsure, `resolve_slugs` or
`search` by title first.

## In-page versus in-message (the inversion)

| Surface | Link form | Why |
|---|---|---|
| A chat message to the user | `admin_url`, or the fallback chain | slugs alone are not clickable in chat |
| Inside a page body | `[[people/alice-example]]` or `[Alice Example](people/alice-example)` | the brain extracts these into its link graph, which powers backlinks and relational recall; an absolute URL between two pages is invisible to it |

Never write absolute admin URLs for page-to-page references inside a page.
Absolute URLs in a body are for genuinely external targets only.
Frontmatter fields that name other pages (`company:` or `founded:` on a
person, `attendees:` on a meeting) take bare slugs: the brain derives typed
edges from them, and a URL there does not resolve to a page. After a link-heavy write, `get_links` on the page shows what the brain
extracted.

## Subagent relays

Subagents report slugs, local paths or their own guesses. Before relaying a
subagent's result, rewrite every page reference through the chain above and
check each with `page_get`. When you spawn a subagent that writes pages, tell
it: "Report every page as its exact slug and the `admin_url` from the write
result. The parent rewrites them into links."

## Bulk lists

One link per line, no backticks:

```
Created 3 pages:
- https://brain.example.com/admin/#page/people%2Falice-example
- https://brain.example.com/admin/#page/people%2Fcharlie-example
- https://brain.example.com/admin/#page/companies%2Facme-example
```

## Scope note

Admin links open only for people who can sign in to the panel. That is right
for the owner's own chat; for an outside audience use `publish`.

## Contract

- Every message reporting a page write carries its link, or the fallback form,
  in that same message.
- Links come from the write result or from parts the deployment gave you,
  never from memory.
- No link goes out for a page that `page_get` cannot read.
- Subagent relays are rewritten before delivery.
- Page-to-page references inside bodies stay `[[slug]]` links.

## Output Format

With an admin link:

> Saved.
> https://brain.example.com/admin/#page/concepts%2Fwidget-co-pricing
> Changed: concepts/widget-co-pricing (edit), reworked the pricing section.

Without one:

> Saved as `concepts/widget-co-pricing` (this brain has no public URL; it
> opens in the admin panel). Want a shareable copy? I can make one with
> `publish`.

## When it fails

- `not_found` on the slug you meant to link: resolve the real slug before
  linking; never ship a guessed one.
- The write returned `version_conflict` or another error: there is no new
  page to link; report the error instead.
- `publish` fails: give the slug with the scope note.

## Anti-Patterns

- "Saved." with no link.
- A local file path instead of a link or a slug.
- Waiting for the user to ask for the link.
- Relaying a subagent's paths verbatim.
- Presenting `publish` output as a URL.
- Absolute URLs between pages inside a page body.
- Guessing a URL or slug.
- A link in backticks where a clickable one was possible.
- Linking before the write result came back.

## Dedup (sharp boundaries)

- `publish` owns making a shareable copy; this skill only decides when to fall
  back to it.
- `citation-fixer` fixes citations inside pages, not message links.
- `reports` saves report pages; a message delivering one follows this skill.
- `_output-rules` holds the cross-skill output canon; this skill holds the
  per-message mechanics (link source, check, relay rewrite, bulk format).
- `conventions/subagent-routing` says how to route work to subagents; this
  skill adds the rewrite at the relay boundary.
