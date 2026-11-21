# Exec Output Convention

Buffer command output to a file and read a bounded slice. An empty shell result
usually means the output was truncated, not that the shell or the process died.

The harness caps how much a tool call may return. A long result can come back
empty or cut short, and that invites a wrong diagnosis ("the shell is broken",
"the container restarted").

## The failure signature

- `echo alive` works
- Any long loop, table or pipeline returns nothing
- Failures look intermittent
- Some harnesses add a truncation notice; others return nothing at all

A dead shell does not selectively kill long commands. Short commands working
and long ones coming back empty is a size ceiling.

## The rule

Never send large output to stdout. Write it to a file, then read a slice.

```bash
cmd > /tmp/out.txt 2>&1; echo "exit=$?"; tail -40 /tmp/out.txt
```

This applies to anything that can pass a screen of text: loops over more than a
few items, per-item counts, `ps`, `du`, `find`, `git log` without a limit, any
script that prints a table, HTTP responses, and test or typecheck runs. Redirect
a test run to a file first: the exit code and the full failure list survive, a
pipe through `tail` loses both.

## Patterns

```bash
# Loops: buffer, then slice
for d in $(seq 1 30); do ...; done > /tmp/loop.txt 2>&1
tail -40 /tmp/loop.txt

# HTTP: cap the bytes
curl -s "$URL" | head -c 600

# Big JSON: reduce to a summary, never print the file
jq '.items | length' big.json

# A memrain command: keep its exit code with the output
(memrain doctor; echo "exit=$?") > /tmp/doctor.txt 2>&1; tail -40 /tmp/doctor.txt
```

When a `memrain` command stops to ask for confirmation or refuses with a plan
hash, relay its message to the user and stop. Do not re-run it with a flag that
skips the question. For anything long-running, submit a durable job (see the
`minion-orchestrator` skill) instead of leaving a background shell.

## Diagnostic ladder for an empty result

Stop at the first step that explains it.

1. `echo alive`: if it works, the shell is fine and the problem is size.
2. Re-run with `| head -20`: output appearing confirms truncation.
3. Buffer to a file and check its size with `wc -c`. A large file behind an
   empty tool result settles it.
4. Only then look at processes, permissions or infrastructure.

## Anti-Patterns

- Declaring the tool broken after a long command returns empty
- Blaming an unrelated recent event (a deploy, a restart) without evidence
- Re-running the same oversized command hoping for a different result
- Piping a test run through `tail` instead of redirecting it first
- Reporting a task as blocked without walking the ladder
