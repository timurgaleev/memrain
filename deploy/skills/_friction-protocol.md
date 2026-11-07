# Friction protocol — convention

> Cross-cutting rule shared by the operational skills (setup, brain-ops,
> query, ingest, smoke-test, migrations). Reference via
> `> **Convention:** see [skills/_friction-protocol.md](_friction-protocol.md).`

When you encounter friction working against the brain — anything confusing,
missing, surprising, or wrong — log it via the `log_friction` MCP tool so the
operator can see it without you writing a bug report. Friction reports feed
the brain's own improvement loop (the background cycle aggregates them and
proposes fixes).

## When to log

Log friction when any of these happens:

- A tool call failed with a non-actionable error message
- A doc said one thing and the tool did another
- You couldn't find the next step
- A setup step needed a manual workaround
- A parameter exists but isn't documented in the tool contract
- A success condition was unclear (you couldn't tell if the call worked)

Log delight (positive signal) when:

- Something worked on the first try and the docs were exactly right
- An error message handed you the fix
- A parameter you guessed at turned out to exist with the obvious name

## How to log

Call the `log_friction` tool:

```json
{
  "kind": "other",
  "severity": "confused",
  "query": "<which-phase-or-tool>",
  "reason": "<one-line-what-happened; optionally: what could be better>"
}
```

Use a narrower kind when one fits: `search-miss`, `wrong-answer`,
`tool-error`, `low-confidence`. For delight, set `"kind": "delight"` and pick
any severity.

The server stamps the timestamp and context automatically, so you can call
this anywhere — mid-skill, during normal use, or from a scripted test. From
the shell: `memrain call log_friction '{...}'`.

Do NOT put PII, secret values, or full page contents in `query` / `reason`.
One line of what happened, one line of what would be better.

## Severity guide

| severity   | meaning |
|------------|---------|
| `blocker`  | Couldn't proceed at all. Hard stop. |
| `error`    | Tool call failed unexpectedly. |
| `confused` | Docs/tool mismatch, ambiguity, missing pointer. |
| `nit`      | Polish opportunity. Cosmetic or low-impact. |

Be specific: "doctor says `schema_version=0` and points at migrations, but
the migration step exits clean with no output" beats "doctor was confusing."

## Inspecting reports

Friction entries are stored in the brain and surfaced two ways:

- The background cycle's friction-propose phase clusters recent entries and
  drafts remediation suggestions for the operator.
- `run_doctor` / `memrain doctor` surface friction-volume anomalies.

If you need to review raw entries during a session, ask the operator — the
friction log is an operator-facing surface, not an agent read-back channel.
Reports are redacted before they leave the host (paths and identifiers
stripped), so summaries paste safely into issues.
