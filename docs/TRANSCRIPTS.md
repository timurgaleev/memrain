# Transcripts

Memrain stores chat history as `conversation` pages under
`transcripts/<format>/<session>-p<n>`. Each session is redacted for
credentials, split into parts small enough to embed and extract from, and
written idempotently: re-importing an unchanged session writes nothing.

There are two ways in:

- **`memrain transcripts ingest`** runs where the brain's database is
  reachable (the server, or a local brain) and reads files directly.
- **`memrain transcripts push`** runs on a laptop and sends one session log to
  a hosted brain's `POST /ingest`.

## Ingest

```bash
memrain transcripts ingest <path> [--format auto|chatgpt|claude-ai|codex|claude-code]
                                  [--source ID] [--since ISO|auto] [--no-embed]
                                  [--facts --max-cost-usd N] [--dry-run] [--json]
```

`<path>` is a ChatGPT or Claude.ai export, a Codex rollout, a Claude Code
session log, or a directory of session logs.

- `--dry-run` parses, redacts and splits without writing, and prints what the
  run would cost (sessions, parts, bytes to embed).
- `--since <ISO>` keeps only sessions whose last message is newer than that
  time. `--since auto` uses the watermark that the last clean run over the
  same path and source left. A run moves the watermark only when nothing was
  refused, failed or malformed, and only without an explicit `--since`, so a
  partial run never makes the next one skip sessions.
- `--no-embed` writes the pages and leaves search indexing to the cycle's
  `mirror-pages` phase, which indexes and embeds a bounded batch per run.
  Pages stay unsearchable until the cycle reaches them.
- `--facts --max-cost-usd N` runs the paid fact extractor over the parts this
  run wrote, stopping at N dollars. It needs `MEMRAIN_FACTS_EXTRACTION=1`.

The command exits non-zero when it does not recognise the format, when a
session was refused for carrying a credential under the `reject` disposition,
or when a session log has assistant turns but no user turn
(`user_turns_missing`). That last case usually means the agent changed how it
records user turns, so the session is skipped rather than imported half
empty. The other logs in a directory are still imported.

A Claude Code turn that is only pasted content (`<pasted_content>` blocks)
stays in the transcript, but it does not name the session and is not counted
as something the user typed.

## Status

```bash
memrain transcripts status [--source ID] [--json]
```

Shows sessions and parts per source and format, pushed logs by job status, and
the `--since auto` watermark for each path.

## Push from a laptop

```bash
memrain transcripts push <path> --url https://brain.example.com \
  --token-file ~/.config/memrain/push-token [--hook-stdin] [--dry-run] [--json]
```

- `<path>` must be a `.jsonl` session log under `~/.claude/projects` or
  `~/.codex/sessions`. Push resolves every symlink in the path first and
  refuses a file outside those directories, as well as a file that is itself a
  symlink.
- The token is a bearer token with the `write` scope. Keep it in a file only
  you can read (`chmod 600`). Push refuses a token file that other users can
  read, and it never accepts a token on the command line.
- `--url` must be `https`. Plain `http` is accepted only for `localhost`.
- The file is capped at `MEMRAIN_INGEST_TRANSCRIPT_MAX_BYTES` (default 8 MiB)
  on both ends. A bigger file is refused whole, never truncated.

The server checks the log the same way `transcripts ingest` does, against the
token's own write source and slug-prefix grant, and scans it for credentials
before anything is queued. It answers `202` with a job id. The
`transcripts_ingest` job then writes the pages. Pushing the same file twice
reuses the same job. Refusals give an error code and counts, never the log's
text:

| Status | `error` | Meaning |
|---|---|---|
| 400 | `transcript_unreadable` | No session could be read from the body. |
| 400 | `user_turns_missing` | Assistant turns but no user turn. |
| 400 | `secret_in_content` | A credential, under the `reject` disposition. |
| 403 | `permission_denied` | No write source, or the session is outside the token's bound prefixes. |
| 413 | | Over `MEMRAIN_INGEST_TRANSCRIPT_MAX_BYTES`. |
| 415 | `unsupported_transcript` | A log that is not from Codex or Claude Code. |
| 429 | `push_in_flight` | Another push from the same client is still being read; retry after `Retry-After`. |

### Claude Code session hook

Nothing is installed for you. To push every Claude Code session when it ends,
add a `SessionEnd` hook to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "memrain transcripts push --hook-stdin --url https://brain.example.com --token-file ~/.config/memrain/push-token"
          }
        ]
      }
    ]
  }
}
```

With `--hook-stdin`, push reads `transcript_path` from the JSON that Claude
Code passes to the hook. It reports any failure on stderr and still exits 0,
so a brain that is unreachable never breaks the session.

Codex has no session-end hook. Push its rollouts by hand or from a scheduled
job, one file at a time:

```bash
memrain transcripts push ~/.codex/sessions/2026/10/01/rollout-<id>.jsonl \
  --url https://brain.example.com --token-file ~/.config/memrain/push-token
```
