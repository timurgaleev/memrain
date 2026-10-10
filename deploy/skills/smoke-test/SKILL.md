---
name: smoke-test
description: |
  Post-restart smoke tests + auto-fix for the Memrain server environment.
  Walks a fixed check list over the real CLI and MCP surface (status, doctor,
  search, page round-trip), auto-fixes known issues, and reports what's left.
triggers:
  - "smoke test"
  - "run smoke tests"
  - "container restart check"
  - "did the restart break anything"
  - "did the container restart break anything"
tools:
  - run_doctor
  - get_status_snapshot
  - search
  - page_put
  - page_get
mutating: true
---

# Smoke Test Skillpack

> Walk the check list below after any container restart. There is no
> smoke-test binary — every check is a real `memrain` command you run and read.

## Contract

This skill guarantees:
- 6 core checks verify Memrain server health after restart
- Each check is a real command, not a wrapper script
- Known failures are auto-fixed before reporting
- Results are reported as a single summary line plus per-check status
- The reported failure count = checks still broken after auto-fix (0 = all pass)

## The Check List

| # | Check | Command | Auto-Fix |
|---|-------|---------|----------|
| 1 | Server answers + config sane | `memrain status` | Restart the service |
| 2 | Database, sources, brain health | `memrain doctor` | Per-finding (doctor names the cause) |
| 3 | Background cycle ran recently | `memrain status` (cycle timestamp) | Kick a manual `memrain cycle` |
| 4 | Secrets + Bedrock reachable | `memrain doctor` (auth findings) | Re-run the fetch-secrets step, restart |
| 5 | Read path returns hits | `memrain call search --args '{"q":"<known topic>"}'` | Re-index, then `memrain embed` |
| 6 | Write path round-trips | `page_put` → `page_get` (see below) | — (escalate; a broken write path is not self-healing) |

Checks 1-4 are read-only. Check 5 reads. Check 6 writes one throwaway page
and reads it back.

## Usage

### From a shell on the host

```bash
memrain status
memrain doctor
memrain call search --args '{"q":"<a topic you know is indexed>"}'
```

### Write-path round-trip (check 6)

```bash
memrain call page_put --args '{"slug":"reports/smoke/_probe","markdown_body":"# probe\nsmoke check"}'
memrain call page_get --args '{"slug":"reports/smoke/_probe"}'
```

The `page_get` must return the content the `page_put` just wrote. Reuse the
same slug every run — the probe page is overwritten, not accumulated.

### From an agent without shell access

The same checks run over MCP: `get_status_snapshot` (1, 3), `run_doctor` (2, 4),
`search` (5), `page_put` + `page_get` (6). Read-only checks are identical; the
auto-fixes that need a service restart aren't available over MCP — report them
instead.

### From host bootstrap

Bootstrap can't run judgment. Have it run the two commands that exit non-zero
on real trouble and log them for a human or agent to read:

```bash
memrain status >> /tmp/bootstrap.log 2>&1
memrain doctor >> /tmp/bootstrap.log 2>&1
```

## Adding a Check

There's no script to edit — a new check is a new row in the table above plus
the command that proves it. Follow this pattern:

```
N. [What it proves]
   Probe:    memrain call <tool> --args '<json>'   # or a memrain subcommand
   Pass:     [the specific field/shape that means healthy]
   Auto-fix: [the command] → re-run the probe → still bad? report it
```

Prefer `memrain call <tool>` over raw HTTP: it goes through the same dispatch
the MCP clients use, so a green check means the surface agents actually use
is green.

### Design rules:
1. **Probe first** — never fix without confirming broken
2. **Re-probe after fix** — verify the fix worked
3. **Bound every command** — wrap anything that could hang in `timeout N`
4. **One line per check** — status, check name, and the detail if it failed
5. **Idempotent fixes** — safe to run repeatedly
6. **Skip gracefully** — a missing prerequisite is a skip, not a failure

## Configuration

The checks carry no knobs of their own — they read whatever the server is
already configured with. `memrain status` prints the resolved configuration
(sources, model tiers, region, cycle state); `memrain doctor` names the config
that's wrong when a check fails. If a check needs a value, get it from those
two commands rather than assuming an env var.

## Known Issues & Their Auto-Fixes

### Secrets not yet fetched after restart
- **Symptom:** server boots but `/health` reports degraded; Bedrock and DB
  calls fail with auth errors
- **Cause:** the container restarted before the secrets-fetch step wrote the
  secrets files, so the process started with an empty env
- **Auto-fix:** re-run the fetch-secrets step, then restart the service
- **Persistence:** does NOT survive container restart (the race can recur on
  every boot)
- This is why smoke tests must run on every restart

### Worker DB Auth Failure
- **Symptom:** background jobs can't connect to the DB
- **Cause:** the database URL isn't propagated to the worker subprocess
- **Auto-fix:** restart the service so the worker inherits the fetched env;
  `memrain doctor` confirms the job surface recovered

## Anti-Patterns

- ❌ Running smoke checks on every chat turn. Once per container restart (or
  on user request) is plenty. The checks are cheap but they're not free.
- ❌ Running a probe without `timeout N` around anything that could hang.
  One hung probe stalls every check after it.
- ❌ Auto-fixing without confirming the check is actually broken first.
  The `probe → fail-detected → fix → re-probe` loop is the contract; fixes
  that skip the re-probe can report success on a still-broken state.
- ❌ Treating a skip as a failure. Missing prerequisites (no note source
  mounted, no worker configured) are skips. The reported failure count is
  real failures only.
- ❌ Inventing a command to make a check look green. Every check in the list
  above is a command that exists; if you need a new probe, use `memrain call
  <tool>` against a real tool rather than a script that isn't there.
- ❌ Leaving the check-6 probe page behind under a fresh slug each run. Reuse
  one slug so the brain doesn't accumulate smoke debris.

## Output Format

Report one line per check (✅ / ❌ / 🔧 fixed / ⏭️ skipped) naming the check and,
on failure, the command output that proved it broken. Close with a single
summary line: `Results: N/M passed, F auto-fixed, S skipped`. When any check
is still red after its auto-fix, say which ones and what the fix attempt
returned — a smoke report that hides the failing command is worse than no
report.
