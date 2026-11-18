---
name: postgres-adopt
version: 1.0.0
description: |
  Find out which engine a Memrain brain runs on (PGLite or Postgres), say when
  Postgres is worth it, and move a PGLite brain to Postgres with every table
  copied and verified (dry run, agree, copy, verify, switch). Detection is one
  read-only command; the move is migrate-engine, never a config flip.
triggers:
  - "which memrain engine"
  - "pglite or postgres"
  - "memrain engine status"
  - "upgrade to postgres"
  - "switch memrain to postgres"
  - "move my brain to postgres"
  - "set up postgres for the brain"
tools:
  - whoami
  - get_status_snapshot
  - run_doctor
mutating: true
---

# Postgres Adopt

> The engine is the brain's foundation. PGLite is the zero-setup floor: one
> process, one directory. Postgres is where concurrent writers, several
> machines and large brains live. This skill answers "which am I on?", says
> when to move, and moves the data safely — never by editing config alone.

## Contract

This skill guarantees:

- Detection is read-only: `memrain engine status` inspects the configuration,
  and `--probe` opens one connection without running migrations.
- An engine change is a data copy, never a config flip. A PGLite brain moves
  with `memrain migrate-engine`, which copies every table in foreign-key order
  from one consistent snapshot and then checks each table by row count and
  content hash. A mismatch fails the run.
- Dry run first, then the user agrees, then the copy, then `--verify-only`,
  and only then does the server point at Postgres.
- The connection string never appears in a command line, a transcript or
  output. It lives in `MEMRAIN_POSTGRES_URL` in the environment, which
  `migrate-engine` reads when `--postgres-url` is not given.
- The source is only read; the PGLite directory stays as it was, and a
  Postgres → PGLite copy back is the rehearsed rollback.
- Provisioning a database is the operator's decision. On the AWS deployment
  the database is RDS, created through terraform with a reviewed plan
  (`docs/DEPLOYMENT.md`); this skill never creates infrastructure.

## Step 1: detect

```bash
memrain engine status --json
memrain engine status --probe --json
```

- `engine: "postgres"` and the probe is `ok`: healthy, done.
- `engine: "postgres"` and the probe fails: an access problem, not an adoption
  problem. Route to `db-repair`.
- `engine: "pglite"` with data: step 2 when a move is wanted.
- `MEMRAIN_REQUIRE_POSTGRES=1` and a PGLite config: the server refuses to start
  by design; the move below is the fix.

Over MCP, an operator token can read `get_status_snapshot` and `run_doctor`
for the same picture.

## Step 2: decide

Recommend Postgres when the operator has concurrent agents or writers,
several machines, connectors syncing in the background, or a large brain.
PGLite allows one process per directory; a second one cannot open it while
the first holds its lock. Otherwise PGLite is genuinely fine: say so.

## Step 3: move a PGLite brain to Postgres

1. **The target.** An empty Postgres database with the `vector` extension
   available. Ask the operator to export the URL without pasting it into the
   conversation, for example `read -rs MEMRAIN_POSTGRES_URL && export
   MEMRAIN_POSTGRES_URL`.
2. **Stop writers.** Stop the server (and any watcher) that holds the PGLite
   directory, so the copy is the last state. The copy reads one snapshot, but
   writes made after it would be left behind.
3. **Dry run** (reads catalogs and counts, writes nothing):

   ```bash
   memrain migrate-engine --from pglite --to postgres --pglite-path <dir> --dry-run
   ```

   Relay the tables and counts. A source schema behind this build is refused:
   upgrade the source first. Stop and wait for the user's yes.
4. **Copy**, after the yes:

   ```bash
   memrain migrate-engine --from pglite --to postgres --pglite-path <dir>
   ```

   Migrations are applied on the destination first. A re-run resumes and
   converges (keyed tables upsert). `--allow-dropped-columns` only when the
   dry run listed the dropped columns and the user agreed.
5. **Verify:**

   ```bash
   memrain migrate-engine --from pglite --to postgres --pglite-path <dir> --verify-only
   ```

   Every table must match. Keep the JSON output: `memrain backup status
   --copy-report <file>` reads it as backup evidence.
6. **Switch.** Point the server at Postgres (`MEMRAIN_POSTGRES_URL` in its
   environment, or the deployment's secret) and restart it. Then
   `memrain engine status --probe` and `memrain doctor`.

Tokens, OAuth clients and grants live in the database and move with it.
Deleting the old PGLite directory is the user's call, after a quiet period.

## Step 4: rehearse the way back (optional)

```bash
memrain migrate-engine --from postgres --to pglite --pglite-path <new-dir> --dry-run
```

A Postgres → PGLite → Postgres round trip is how to prove a rollback works.

## Output Format

```
Engine: <pglite|postgres> (source: <config|env>)   probe: <ok | status>
Action: <none | dry run | copy | verify>, <tables, rows, mismatches>
Next:   <the one next step, or "healthy, nothing to do">
```

Quote `engine status` output as printed; it shows the endpoint, never the
credential.

## When it fails

- The probe on the target fails: route to `db-repair` with the status.
- `migrate-engine` reports a mismatch: the run failed. Do not switch; re-run
  (it converges) and verify again, or report the table.
- The source schema is behind: upgrade and restart the source build, then
  repeat the dry run.

## Anti-Patterns

- Pointing the server at an empty Postgres and calling it a move: the brain
  splits across two stores.
- Copying while a writer still runs against the PGLite directory.
- Skipping the dry run or the verify.
- Putting the URL or password on a command line or in chat.
- Creating databases or cloud resources from this skill.
