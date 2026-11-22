---
name: cron-scheduler
version: 1.1.0
description: |
  Put recurring work on a Memrain host the right way: pick between the
  background cycle, the built-in daemons, a host timer that submits a durable
  job, and a one-shot deferred job; stagger slots, respect quiet hours, keep
  every run idempotent and inspectable. Use when scheduling, pausing or
  auditing recurring work.
triggers:
  - "schedule a job"
  - "cron"
  - "quiet hours"
  - "what jobs are running"
  - "run this every night"
  - "schedule recurring work"
  - "pause the daemons"
tools:
  - search
  - page_get
  - page_put
  - jobs_submit
  - jobs_list
  - sources_list
  - source_health
mutating: true
writes_to:
  - reports/
---

# Cron Scheduler

> **Convention:** see `conventions/scheduled-work.md` (via `get_skill conventions/scheduled-work`) for what a timer should run, and `conventions/test-before-bulk.md` (via `get_skill conventions/test-before-bulk`): test every scheduled job on 3-5 items first.

## Contract

- The brain does not keep a cron table for agents. Recurring work runs through
  one of four real mechanisms (table below); this skill picks one and never
  invents another.
- Staggered: at most one job per 5-minute slot, never everything at `:00`.
- Quiet hours respected: nothing notifies the user inside them; output is
  written and waits.
- Thin: a scheduled agent run is one line, "read skill X with `get_skill` and
  run it", not a 3,000-word inline prompt.
- Idempotent: a run that fires twice produces one result.
- Inspectable: every run leaves a job row or a report page. A timer that runs
  silently is a bug.
- Host changes (installing a unit, enabling a daemon) are operator actions,
  shown and agreed before they happen.

## Pick the mechanism

| Work | Mechanism | How |
|---|---|---|
| Embedding backfill, link derivation, decay, synthesis phases | The background cycle | Already self-scheduled. Do not add a timer for it |
| Connector sync, open-loop sweeps, notification webhooks | Built-in daemons | `memrain daemons status`, then `enable` / `pause` / `resume` |
| Install-specific work (a nightly digest, a probe) | Host systemd timer that submits a durable job | `conventions/scheduled-work.md`; the handler kind must be registered |
| A plain host command (a reindex, a health check) | Host systemd timer running that command | Allowed; keep it to one consolidated entry |
| Once, later | A deferred job | `jobs_submit` with `not_before` |

Daemons are declared in server code with their own cron and lane:
`connector_sync` every 15 minutes, `loops_sweep` every 30, `notifications`
every 5, and `cycle` on its own loop. The first three are off by default:
each needs `memrain daemons enable <name>` before it runs. The scheduler runs only
where `MEMRAIN_DAEMONS=1`. A new daemon is a code change, not a config entry.

## Phases

1. **Define.** Name, cadence, what it runs (a registered job kind, a skill,
   or a host command), expected duration, timeout, what it writes.
2. **Check what already runs.**
   - `memrain daemons status` for daemons: schedule, pauses, last run,
     failure streak, next window, scheduler leader.
   - `jobs_list {"status": "running"}` and `jobs_list {"kind": "<kind>", "limit": 20}`
     for queue work.
   - `systemctl list-timers` on the host for timers.
   - If the work is indexing, `sources_list {}` and `source_health {}` show
     which sources exist and how stale they are.
   If the cycle or a daemon already does it, stop and say so.
3. **Pick a slot.** 5-minute offsets (`:05`, `:10`, … `:50`); never `:00`;
   nothing within 5 minutes of another job. On a collision, offer the next
   free slot. Leave headroom: a run must finish before its next slot.
4. **Quiet hours.** Default 23:00-08:00 in the user's zone unless they set
   their own. Inside them a run writes its report page and does not notify;
   the next session or briefing picks it up. Separately, the server holds
   back queue jobs flagged for its own quiet-hours window, and a source
   registered with `--respect-quiet-hours` backs off in it. A user who is
   visibly active can lift the delivery hold for that day.
5. **Write the timer.** For agent work, the unit runs a small script that
   submits a durable job with an idempotency key per slot (the script in
   `conventions/scheduled-work.md`). Keep JSON out of `ExecStart`; systemd
   unquotes it. The script runs the CLI inside the serving container
   (`docker exec deploy-memrain-1 bun run src/cli.ts call jobs_submit --args '<json>'`),
   so it reads the brain's own config rather than the timer's environment.
   Log stderr to a file and check the exit code.
6. **Install, with consent.** The operator installs and enables it:
   `install -m 644` the unit files into `/etc/systemd/system/`,
   `systemctl daemon-reload`, `systemctl enable --now <unit>.timer`. The
   shipped units in `deploy/systemd/` (the nightly retrieval probe, the
   bearer rotation) follow the same path; enable bearer rotation only once
   you know every client holding the bearer.
7. **Test.** Run it once by hand on 3-5 items, then
   `jobs_list {"kind": "<kind>", "limit": 5}` shows the row and its status.
8. **Report.** Name, cadence, slot, next run, where output goes.

## Idempotency

- The submit carries `idempotency_key: "<kind>:<slot>"`, so a timer firing
  while the previous run still works is a no-op in the queue.
- Before writing output, `page_get` the target; write with `expected_version`.
- Long runs keep a checkpoint page (`reports/<job-name>/checkpoint`) and
  resume from it.
- Results land at `reports/<job-name>/<YYYY-MM-DD-HHMM>` via `page_put`; find
  earlier runs with `search {"q": "<job-name>", "slug_prefix": "reports/<job-name>/"}`.

## Indexing: one entry

Pages are database-canonical, so there is nothing to sync. The only recurring
corpus work is indexing read-only note directories, and one consolidated
entry covers them all. The `memrain` CLI exists only inside the serving
container, so the entry is a host systemd timer that runs it there, with
stdout and stderr appended to a log and the exit code left to systemd
(`systemctl status` shows a failed run):

```ini
# /etc/systemd/system/memrain-reindex.service
[Unit]
Description=Reindex the read-only note directories into the brain
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
ExecStart=/usr/bin/docker exec deploy-memrain-1 bun run src/cli.ts reindex
StandardOutput=append:/var/log/memrain/memrain-reindex.log
StandardError=append:/var/log/memrain/memrain-reindex.log

# /etc/systemd/system/memrain-reindex.timer
[Timer]
OnCalendar=*:05/30
Persistent=true

[Install]
WantedBy=timers.target
```

Install it as in phase 6 (`systemctl enable --now memrain-reindex.timer`)
and run the service once by hand first (`systemctl start
memrain-reindex.service`, then read the log). The directories must be mounted
into the container; a path only the host sees indexes nothing. The entry
picks up new note directories without a timer edit. Avoid one
`memrain index <path>` entry per directory: each new directory needs manual
deconfliction, and a slow one races a fast one on the index lock. Check
`memrain doctor` before adding any indexing entry.

## Pausing

- One daemon: `memrain daemons pause <name> --reason "<why>"`; back with
  `memrain daemons resume <name>`. `all` pauses every daemon.
- One source of a daemon: add `--source <id>`.
- The cycle obeys a pause on its next tick.

## Output Format

```
Scheduled: <name> via <cycle | daemon <name> | timer <unit> | deferred job>
Cadence:   <cron expression or not_before>, slot :<mm>, zone <tz>
Runs:      <job kind | command | skill>, timeout <t>
Output:    reports/<job-name>/<YYYY-MM-DD-HHMM> | job row only
Quiet:     <window>, delivery held: yes | no
Next run:  <time>   Test run: <job id, status> | not yet
```

For "what is running": daemons (state, last run, next window), running and
pending jobs, host timers, each on one line.

## When it fails

- Submit refused with the list of known kinds: the timer names an
  unregistered handler. The handler has to ship as server code first; do not
  rename the kind to make it pass.
- A daemon shows `paused (auto:failures)`: it failed 5 runs in a row. Read its
  last outcome, fix the cause, then `memrain daemons resume <name>`.
- `memrain daemons status` says no leader or `MEMRAIN_DAEMONS is not 1`: the
  scheduler is off in that process; enabling it is an operator decision.
- A timer's runs return empty results everywhere: it ran outside the
  container or without the brain's config. An empty result from a run whose
  stderr went nowhere is not evidence of "no notes".
- Overlapping runs: widen the interval or add the slot idempotency key; never
  add a second overlapping schedule.
- `version_conflict` writing a report or checkpoint: re-read with `page_get`
  and retry with the current version.

## Anti-Patterns

- Everything at the same minute.
- Inline 3,000-word prompts in a scheduled run.
- Scheduling without a 3-5 item test run.
- Runs that produce different output when repeated.
- Notifying during quiet hours.
- A timer for maintenance the cycle or a daemon already performs.
- One `memrain index` entry per directory instead of one `memrain reindex`.
- Printing the environment into a log while debugging (it holds database and
  provider credentials).
- `2>/dev/null` on a scheduled call, or ignoring its exit code.

## Dedup (sharp boundaries)

- `minion-orchestrator` runs, watches, cancels and retries the jobs a
  schedule fires.
- `reports` saves and loads the pages scheduled runs write.
- `briefing` composes the daily view that surfaces held output.
- `maintain` and `advisor` decide what maintenance is due.
