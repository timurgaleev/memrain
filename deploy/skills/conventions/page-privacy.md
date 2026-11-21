# Page Privacy Convention

Write no privacy label on a page. In Memrain who can read a page is decided by
where it lives, not by what its frontmatter says.

## What actually restricts a read

- **The page's source.** Every page belongs to one source, and a credential
  reads only the sources its grant covers. On a team brain each person writes
  to their own source; a page written there is theirs. Write where your grant
  sends you and never try to place a page in another person's source.
- **Owner-only sources.** A mailbox, calendar or transcript source the operator
  marked owner-only (`memrain sources owner-only <id> on`) is read only by the
  operator and the brain owner's keys. Facts, timeline rows and concept pages
  derived from it close with it.
- **Diary pages.** A page of type `diary` or `journal`, or any page under
  `life/diary/`, is never served to a remote caller and its facts stay out of
  shared recall. Use that type or prefix only for genuinely private writing.
- **Fact visibility.** `add_fact` writes `private` by default, which only the
  operator reads back. Pass `"visibility": "world"` only when the fact may be
  read by tenant-scoped and public callers too.

## What does not

A frontmatter key such as `visibility: private`, `access: personal`,
`readable_by: [...]`, `confidential: true` or `private: true` is plain text to
Memrain. It restricts nothing, and a reader may take it as a promise the brain
does not keep. Do not write one, and do not remove one you did not set unless
the user asks.

## The process

1. **Default to nothing.** Research, project, people, company, meeting and ops
   pages get no privacy label and no special type.
2. **Something shared in confidence** (a DM, someone's health or money): ask
   the user where it belongs. The answer is a source with the right readers, a
   diary page, or not writing it at all; never a label.
3. **Check before you promise.** When the user asks who can see a page, the
   operator can answer with `memrain auth who-can-read <slug>`, which checks
   every issued credential through the same read path without recording reads.
   Do not guess from frontmatter.

## Anti-Patterns

- Writing `visibility: private` and telling the user the page is now private
- Filing a confidential note in a shared source because the page "has a label"
- Using the `diary` type for ordinary notes to hide them from search
- Passing `"visibility": "world"` on a fact without a reason
