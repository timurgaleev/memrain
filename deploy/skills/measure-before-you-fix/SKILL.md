---
name: measure-before-you-fix
version: 1.0.0
description: |
  Before fixing a slow, stale or timed-out alert, measure the blamed step
  yourself: kill the theory with a stopwatch, not a code change. Measure-first
  triage for temporal alerts (stale, timeout, freshness, wedged, N hours
  behind) from doctor, daemons, connector syncs, the job queue and external
  monitors. Runs before any timeout raise, threshold change or pipeline
  rewrite. Read-only.
triggers:
  - "keeps timing out"
  - "etimedout"
  - "why is this data stale"
  - "freshness alert"
  - "wedged"
  - "job is slow"
  - "sync is stuck"
  - "raise the timeout"
tools:
  - source_health
  - sources_status
  - get_status_snapshot
  - run_doctor
  - jobs_list
  - jobs_get
  - search
mutating: false
---

# Measure Before You Fix

> **Convention:** `conventions/brain-first.md` (via `get_skill conventions/brain-first`):
> before re-deriving a diagnosis, `search` the brain for earlier incidents of
> the same alert. A recurring alert often has a recorded verdict.

Route here on any alert whose claim is temporal: "X is stale", "step timed
out", "pipeline wedged", "job is slow", "N hours behind". These alerts invite
an immediate structural fix (raise the timeout, split the step, reorder the
pipeline). Measure first. It is almost always cheaper than the fix, and it
often invalidates it.

On Memrain this covers doctor's freshness and backlog checks, the daemons'
last runs (`memrain daemons status`), connector accounts that fell behind or
went `needs_reconnect`, `waiting` refusing on syncs older than 24 hours,
wedged or deferred jobs, and any external monitor built on top of them.

## The rule

**One stopwatch measurement of the suspect step, before any change.**

If you cannot state the measured duration of the thing you claim is slow, you
do not yet know the root cause, and any fix is a guess wearing a diff.

## Contract

This skill guarantees:

- No structural fix (timeout raise, step split, pipeline reorder, wrapper
  rewrite) is proposed before a measured duration of the blamed step exists.
- The measurement targets the specific entity the alert named (one source,
  one daemon, one job), not the aggregate.
- The alert's threshold is compared with the authoritative one (doctor's warn
  and fail lines) before the system is declared unhealthy.
- The verdict separates "needs more time" from "is wedged"; they have
  opposite fixes.
- Read-only: no timeout, threshold, configuration or code changes. The output
  is a verdict that sizes the fix.

## Procedure

1. **Read the alert's own numbers.** They often contradict the theory
   already. Note what they rule out and drop that branch.

2. **Look at the named entity's real state.**

   ```bash
   memrain daemons status --json
   memrain jobs stats --by-kind
   memrain status
   ```

   Over MCP with an operator token: `get_status_snapshot`, `jobs_list` and
   `jobs_get` for a named job; for any caller, `source_health` and
   `sources_status` for the named source. A job that is `deferred` waits on
   something (a budget, a lock, a schedule); a job that is running but shows
   no progress is wedged. They are different problems.

3. **Time the step directly.** Run the smallest unit the alert blames, once,
   with a clock:

   ```bash
   time memrain doctor
   time memrain search "<a query the alert involves>" --k 5
   memrain jobs progress <id>
   ```

   For a connector, read the account's last run and duration on the
   Connections page or in doctor's connector line rather than forcing a sync.

4. **Compare measured with budgeted.** Find every timeout on the path, not
   only the helper's default: a generous override at the call site makes the
   default irrelevant.

5. **Check the alert's threshold against the authoritative one.** A monitor
   may act earlier than doctor warns, to keep drift out of the red. That is
   good design. The bug is reusing the act line as the alert line: everything
   between "act" and "warn" becomes a recurring page about a healthy system.
   Act at the aggressive line; speak at the authoritative one.

6. **Only now design the fix**, against the number you measured.

## Red flags that you are theorising

- A root cause with no measured duration.
- A rewrite before running the step once.
- Two revisions of the theory with no new measurement between them.
- "No recovery in flight": check whether the worker is in fact running
  (`daemons status`, the job's state) before believing it.
- "Nothing to do" in the step's output: that step is not your bottleneck.

## Output Format

```
## Measurement verdict
- Alert:      <the alert text and which monitor sent it>
- Claim:      <the temporal claim, e.g. "source mail-work 14h behind">
- Measured:   <exact command> → <duration> (<key output>)
- Budgeted:   <timeout and any call-site override, file:line>
- Thresholds: monitor act line <X>h vs doctor warn line <Y>h → <match | MISMATCH>
- Verdict:    false page on a healthy system | needs more time | wedged | real regression
- Fix:        <the change the number justifies, or "none; move the alert line">
```

## When it fails

- Doctor warns or fails: record the exact check and threshold before calling
  the system unhealthy.
- A connector account shows `needs_reconnect`: that is the measured cause;
  the owner reconnects it, nobody raises a timeout.
- A job is `deferred` on `budget_exhausted` or `no_brain_cap`: the cause is
  the spend cap, not time. Report it; do not raise caps from here.

## Anti-Patterns

- Raising a timeout to fix a stall: a hung step just hangs longer.
- Rewriting a pipeline on an unmeasured starvation theory.
- Trusting the alert's causal claim: alerts report symptoms well and causes
  badly.
- Writing an unmeasured root cause into a runbook or a skill.

## Dedup (sharp boundaries)

- Debugging wrong code behaviour is a code investigation, not this skill; hand
  it over with the measured number when the stopwatch confirms a regression.
- `maintain` runs health checks and repairs; this skill governs the response
  when one of them pages.
- `smoke-test` answers "is it up after a restart"; this skill answers "is this
  slow or stale claim even true".
- `cron-scheduler` decides when monitors run; this skill supplies the
  act-line versus alert-line rule.
