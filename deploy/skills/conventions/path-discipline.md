# Path Discipline Convention

A display string is not a slug or a path. Never pass a link-formatted reference
to a tool.

## Two types

Replies format references for people: markdown links, full URLs, backticks,
bold. Tools need bare values: a page slug for `page_get`, a filesystem path for
a shell or file tool. Context blurs the two, and a `[label](url)` written in one
turn gets copied into the argument of the next call.

- Bare slug (tool input): `people/alice-example`
- Bare path (tool input): `notes/alice-example.md`
- Display forms (reply only): `[people/alice-example](https://brain.example.com/admin/pages/people/alice-example)`,
  the raw URL, any backticked or bolded wrapping of either

Before any read, write, edit or shell call, the slug or path argument contains
no `[`, `](` or `http`. A slug carries no `.md` suffix and no leading `/`. An
error that shows `https:/` with one slash means a URL was passed where a path
belonged.

## Writes can look successful

Reads fail loudly on a poisoned argument (`not_found`, `ENOENT`). Writes may
not: a local file tool can create a directory named after the link markup and
report success, and a page write can land under a slug nobody will look for.
A success message is not proof the write landed where you meant.

After any write that matters, read it back by its bare slug (`page_get`) or
list the bare path before claiming it is done. A `slug` echoed in the write's
result that differs from the one you meant is a failure, whatever the status.

## Retry discipline

- A malformed argument is not a flaky tool. Retrying the same string never
  works: fix the argument after the first failure.
- When the transcript is full of linked forms, build the value from parts
  (`resolve_slugs` for a name, a shell variable for a path) instead of copying
  it out of an earlier reply.
- If a page landed under a junk slug, move it with `page_rename` (history and
  links follow) rather than writing a second copy.

## Anti-Patterns

- Copying a slug out of your own formatted reply into a tool call
- Trusting a write's success on an argument that contained `](`
- Retrying the same poisoned string because the error "looks flaky"
- Claiming saved or done without reading back the bare slug
