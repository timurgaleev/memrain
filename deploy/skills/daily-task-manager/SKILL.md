---
name: daily-task-manager
version: 1.1.0
description: |
  Keep the user's running task list as one brain page with stable task ids:
  add, complete, defer, remove and review tasks, with deterministic action
  routing, version-checked edits and no guessing when a request matches
  several tasks.
triggers:
  - "add task"
  - "complete task"
  - "what are my tasks"
  - "task list"
  - "defer task"
  - "remove task"
  - "mark the task done"
  - "add to my todo list"
tools:
  - page_get
  - page_put
  - page_edit
  - add_timeline_event
  - search
mutating: true
writes_to:
  - tasks/
---

# Daily Task Manager

## Contract

- One page holds the list: slug `tasks/tasks` (type `task`, inferred from the
  prefix). Every task carries a stable id.
- Lifecycle: add, then complete, defer or remove. Priorities: P0 urgent, P1
  today, P2 this week, P3 backlog.
- Completed tasks keep their completion date; deferred tasks keep a target
  date and a reason.
- Every change is a version-checked edit of the affected lines. A change
  never drops unrelated tasks or sections this skill does not recognise.
- Ambiguous or unknown targets fail closed: nothing is changed and the user
  picks.
- Review is read-only.
- Never invents a priority, due date or defer reason.

## Action routing

Decide the action before touching the page:

| The user says | Action |
|---|---|
| "add", "remind me to", "put X on my list" | add |
| "done with X", "finished X", "completed X" | complete |
| "push X", "defer X", "move X to next week" | defer |
| "delete X", "remove X", "kill task X" | remove (explicit delete words only; never inferred) |
| "what are my tasks", "task list" | review ("today" shows P0 and P1) |

## Phases

1. **Load.** `page_get {"slug": "tasks/tasks"}` and keep its `version`.
   First run (`not_found`): create it from the template in Output Format with
   `page_put {"slug": "tasks/tasks", "title": "Tasks", "markdown_body": "<template>"}`
   and note "initialized".
2. **Validate.** Route the action. If a required field is missing, ask one
   short question before changing anything.
3. **Find the target** (complete, defer, remove). Match by id when given;
   otherwise match the description against active tasks only. No match:
   return `not_found`. Several matches: list them with ids and return
   `ambiguous`. Either way, change nothing.
4. **Apply** with `page_edit`, copying the exact old line from the page you
   just read:
   - **Add.** Needs a description. Priority as stated or clearly implied;
     otherwise P3, and say so. A due date only if the user gave one. New id
     `t-YYYYMMDD-NN`, NN the next free number for that day on the page you
     just read. An identical active description already present: report its
     id instead of adding a duplicate. Insert the line under its priority
     heading:

```
page_edit {"slug": "tasks/tasks", "expected_version": 12, "reason": "add t-20260115-03", "edits": [{"old_text": "## P1 — Today\n", "new_text": "## P1 — Today\n- [ ] <!-- id: t-20260115-03 --> Renew the acme-example contract (due: 2026-01-20)\n"}]}
```

   - **Complete.** Tick it and move it to Completed with
     `(completed: YYYY-MM-DD)`: one edit removes the active line, one adds the
     completed line, in the same call.
   - **Defer.** Needs a target date and a reason; ask for whichever is
     missing. Move it to Deferred, keeping its text, id and priority.
   - **Remove.** Confirm first unless the message already does; offer
     complete or defer instead. The removed line stays recoverable from the
     page's version history.
   - **Review.** No edit. Active tasks by priority with ids.
5. **Record.** After add and complete, `add_timeline_event {"slug": "tasks/tasks", "occurred_at": "<today>", "event": "Added t-20260115-03: Renew the acme-example contract"}`.
6. **Link related pages** when a task names a person, company or project:
   `search {"q": "<name>", "k": 3}`, and link the page as `[[slug]]` only if
   one result is clearly it.

Dates are ISO (`YYYY-MM-DD`), computed from the clock, never guessed. Run task
changes one at a time; never let two subagents edit the list in parallel.

## Output Format

The page:

```markdown
# Tasks

## P0 — Urgent
- [ ] <!-- id: t-20260115-01 --> {description} (due: {date})

## P1 — Today
- [ ] <!-- id: {id} --> {description}

## P2 — This Week
- [ ] <!-- id: {id} --> {description}

## P3 — Backlog
- [ ] <!-- id: {id} --> {description}

## Deferred
- [ ] <!-- id: {id} --> {description} (deferred until: {date}; reason: {reason})

## Completed
- [x] <!-- id: {id} --> {description} (completed: {date})
```

After every action, one compact line, plus this result for callers that
chain:

```
{action, task_id, status: ok|not_found|ambiguous|needs_confirmation, priority, date, page: "tasks/tasks", saved: true|false}
```

Review returns the active tasks grouped by priority instead of a single id.
No tables on narrow chat surfaces.

## When it fails

- `version_conflict`: someone changed the list since you read it. Re-read
  with `page_get`, re-find the target, re-derive the next free id, and apply
  the one change again with `current_version`. Never write from the old read.
- `edit_no_match`: the line you copied is no longer on the page. Re-read and
  retry once; if it is gone, the task was already changed: report that.
- `edit_ambiguous_match`: the old text appears twice. Include the task id in
  `old_text` so it is unique.
- The page exists but does not follow the template: edit inside it
  minimally, keep unknown content verbatim, and say it is malformed. Never
  rewrite it with `page_put`.
- `insufficient_scope` or `permission_denied`: the grant does not cover
  `tasks/`; report `saved: false`.

## Anti-Patterns

- A task with no priority, silently. Default P3 and say so.
- Changing the closest match when the request fits several tasks.
- Completing without a date; deferring without a date and reason.
- Removing without confirmation.
- Replacing the whole list with `page_put` for a one-line change.
- Inventing due dates, priorities or reasons.
- Letting the backlog grow past about 20 items without suggesting a review.
- Keeping tasks anywhere but this page.

## Dedup (sharp boundaries)

- `daily-task-prep` prepares the day ("what's on my plate") and reads this
  list for it without changing it; this skill owns the list itself.
- `mail-loops` tracks replies owed and promises made in mail, chat and
  calendar; add one here only when the user asks.
