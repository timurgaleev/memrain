# Transcripts

Memrain stores chat history as `conversation` pages under
`transcripts/<format>/<session>-p<n>`. Each session is redacted for
credentials, split into parts small enough to embed and extract from, and
written idempotently: re-importing an unchanged session writes nothing.
Transcripts get rules other writes do not: cookie values after a
`Cookie:`/`Set-Cookie:` header or a curl `-b`/`--cookie` argument, a `.netrc`
password, a password label with its value on the same line, the password half
of a `login: user / password` pair, a password flag (`--password X`), a cell
under a password column of a Markdown table, and a key, token or password
label whose value sits alone on the next line or opens the next message. With the secret-store key set, every value a
redaction removes is kept in the secret store (see SECURITY.md, "Kept
originals"); `memrain secrets audit --transcripts` rescans transcripts already
stored. Re-import keeps the fenced blocks a pre-Lite brain wrote into a page while
replacing the imported text outside them. If an older page's fence provenance
cannot be proven, the importer reports `unproven_fences` and leaves its body
and versions intact for review.

`memrain transcripts ingest` runs where the brain's database is reachable (the
server, or a local brain) and reads files directly. There is no upload
endpoint: to import a log from a laptop, copy it to the host first.

## Ingest

```bash
memrain transcripts ingest <path> [--format auto|chatgpt|claude-ai|codex|claude-code]
                                  [--source ID] [--since ISO|7d|auto] [--no-embed]
                                  [--dry-run] [--json]
```

`<path>` is a ChatGPT or Claude.ai export, a Codex rollout, a Claude Code
session log, or a directory of session logs.

- `--dry-run` parses, redacts and splits without writing, and prints what the
  run would cost (sessions, parts, bytes to embed).
- `--since <ISO>` keeps only sessions whose last message is newer than that
  time. `--since auto` uses the watermark that the last clean run over the
  same path and source left. A run moves the watermark only when nothing was
  refused, failed or malformed, and only without an explicit `--since`, so a
  partial run never makes the next one skip sessions. `--since` also accepts a
  relative lookback (`7d`, `2w`, `6m`, `1y`); months mean 30 days and years
  365 days.
- `--no-embed` writes the pages and leaves search indexing to the hourly
  housekeeping, which indexes and embeds a bounded batch per run. Pages stay
  unsearchable until it reaches them.

The command exits non-zero when it does not recognise the format, when a
session was refused for carrying a credential under the `reject` disposition,
or when a session log has assistant turns but no user turn
(`user_turns_missing`). That last case usually means the agent changed how it
records user turns, so the session is skipped rather than imported half
empty. The other logs in a directory are still imported.

A log with a session id but no text turn (a session opened and closed without
a word, or one whose every turn was harness traffic) is empty, not drift:
`transcripts ingest` lists it as skipped with `empty_session`.
A log whose turns the importer cannot read (an unknown content block or event
kind) is still reported as a format change.

A Claude Code turn that is only pasted content (`<pasted_content>` blocks)
stays in the transcript, but it does not name the session and is not counted
as something the user typed.

Claude Code also records, as user turns, messages the harness delivered rather
than the person typed. User records whose `origin.kind` is
`task-notification`, `peer` (another agent's message) or `auto-continuation`
are skipped, as are `queue-operation` records. Records with `origin.kind`
`human` or `channel`, an unknown kind, or no `origin` at all (older logs) are
kept. An AskUserQuestion answer is imported as a user turn, one
`header → answer` line per answered question.

## Status

```bash
memrain transcripts status [--source ID] [--json]
```

Shows sessions and parts per source and format, and the `--since auto`
watermark for each path.
