# TODO — Memrain

Forward-looking work that is intentionally deferred. Items already
shipped live in [`CHANGELOG.md`](./CHANGELOG.md); items rejected as
out-of-scope live under "NOT in scope" in the design doc that
introduces them.

Versions `v1.x` in items written before the rename mean `memex-v1.x`.

---

## Roadmap — 2026-09-13

The program makes memex safe and fast as a brain that one connector can share
with a whole team, then builds the depth agents need on top: honest contracts,
durable background work, measured retrieval, an agent layer and wider
ingestion. It runs in five waves. **Wave 1** (safety and the live write-path
incident) has no entry condition and its five items can run in parallel.
**Wave 2** (substrate, contracts, measurement) needs RM-01 before RM-07/RM-10,
RM-03 before RM-08, and an operator go for the public benchmark in RM-06.
**Wave 3** (retrieval quality and the agent layer) needs the RM-06 baseline
receipt before any RM-11 ranking change and an operator go for RM-13.
**Wave 4** (depth and multi-tenant operations) needs RM-08 for anything that
fans out and RM-13 for RM-22. **Wave 5** (big bets) starts only on an explicit
operator plan and go per item.

Every item inherits the ship gates in `CLAUDE.md` (`make audit`,
`make scrub-audit` HIGH:0, `make typecheck`, `make lint-ts`, `make test`,
pytest, `env -C deploy/memrain bun run test:sharded`), a second-opinion review
per batch plus the matching specialist reviewer, and every new `MEMRAIN_*` knob
added to the `deploy/docker-compose.yml` allowlist. Every new MCP tool is
classified in `FORBIDDEN_MCP_TOOLS_FROM_PUBLIC`, scoped, redacted, and
regenerates `deploy/memrain/tests/fixtures/tool_defs.snapshot.json`.

| Wave | Goal | Items (priority order) | Entry condition |
|---|---|---|---|
| 1 — Safety and the live incident | Tenant-safe reads and spend, fast `page_put`, a hardened runtime | RM-01, RM-02, RM-03, RM-04, RM-05 | None; five parallel tracks |
| 2 — Substrate, contracts, measurement | Honest MCP surface, durable jobs, a public benchmark, an honest skill pack, a grant lifecycle | RM-06, RM-07, RM-08, RM-09, RM-10 | RM-01 for RM-07/RM-10; RM-03 for RM-08; operator go for RM-06 |
| 3 — Quality and the agent layer | Retrieval v2 against receipts, ambient recall, agent tool loop, transcript ingestion, grounded synthesis | RM-11, RM-12, RM-13, RM-14, RM-15 | RM-06 baseline before RM-11 ranking changes; operator go for RM-13 |
| 4 — Depth and multi-tenant operations | Facts/takes v2, tenant-aware cycle, self-healing doctor, graph enrichment, think v2, hosted onboarding, delegated agents, code intel, CLI/config | RM-16 … RM-24 | RM-08 for fan-out; RM-13 for RM-22 |
| 5 — Big bets, conditional | Composite page identity, live connectors, skill optimization | RM-25, RM-26, RM-27 | Explicit operator plan and go per item |

Hard dependencies (item ← what it needs first):

| Item | Needs | Item | Needs |
|---|---|---|---|
| RM-01..RM-05 | — | RM-16 | RM-04, RM-07 |
| RM-06 | — (soft: RM-04) | RM-17 | RM-03, RM-04, RM-08 |
| RM-07 | RM-01 | RM-18 | RM-08, RM-17 |
| RM-08 | RM-03 | RM-19 | RM-05, RM-08 |
| RM-09 | — (soft: RM-07) | RM-20 | RM-04, RM-06, RM-11 |
| RM-10 | RM-01, RM-07 | RM-21 | RM-07, RM-09, RM-10 |
| RM-11 | RM-01, RM-06 | RM-22 | RM-04, RM-10, RM-13 |
| RM-12 | RM-01, RM-07 | RM-23 | RM-01, RM-02, RM-06 |
| RM-13 | RM-04, RM-08 | RM-24 | RM-03 |
| RM-14 | RM-05, RM-08 | RM-25 | RM-01, RM-03 |
| RM-15 | RM-04, RM-08, RM-14 | RM-26 | RM-05, RM-08, RM-14 |
| | | RM-27 | RM-06, RM-09, RM-13 |

Paths below are relative to `deploy/memrain/` unless they start with
`deploy/`, `docs/`, `scripts/` or `.github/`.

### RM-01 — Tenant isolation closure (reads, derived writes, code graph, deletion)

**Why.** v1.128.0 lets one connector serve a team, each person in their own
source. The contract behind that — `undefined` is the operator, `[]` is a
caller granted nothing, a non-empty list reads only those sources — is not
enforced end to end:

- About 106 call sites test `sourceIds && sourceIds.length`, which reads `[]`
  as the whole brain.
- Eight hybrid-search stages widened an empty grant (cache keys, cached and
  final hydrate, identifier arm, relational, structural, alias-hop); alias-hop
  injected another tenant's page head; final hydrate had no
  deleted/archived/quarantine filter.
- `page_append`, `page_revert`, `page_restore`, operator tags and the
  delete/restore version markers land in the wrong source.
- A source can be deleted while live grants still name it.
- A purge with `[]` purges the whole brain and aborts on the first FK error.
- Token verification does not reject a soft-deleted client.
- `code_edges_symbol.source_id` is always NULL, so `code_blast` and `code_flow`
  return nothing for any scoped caller.

MCP dispatch hides most of this behind a fail-closed sentinel today, but no
layer below it is safe on its own, and none of it can be relied on before a
second tenant holds credentials.

**Design decisions (operator, 2026-09-13).**

- Ships as three sequential releases: A read isolation, B derived writes,
  deletion, purge and auth, C code-graph `source_id`.
- Every collapsing site is rewritten to one helper, not only the search ones.
- Code edges get `source_id` at index time plus a backfill; code intel is not
  switched off.
- An unscoped write into a tenant page inherits the page's source.

**Depends on.** Nothing.

**Risks.** Operator ranking must stay byte-identical when hydration filters
move (proved by the operator scope fixture and the retrieval suites); a
cache-miss spike after the key change; the `code_edges_symbol` backfill runs on
live RDS; the page mirror path collision (section below) must not be "fixed" by
widening the index ownership fence.

**Done when.** `hybridSearch(..., { sourceIds: [] })` returns zero rows on
every arm and cache path; the isolation matrix is green for all 91 operations
with zero cross-tenant bytes; a grant caller's `code_blast` on a seeded
two-tenant brain returns its own edges and none of the other tenant's;
deleting a source a grant references is refused with the referent list; a purge
with one FK-blocked row reports it as blocked and purges the rest; live, with
`MEMEX_TENANT_FAIL_CLOSED=1` set, `whoami` and `search` are unchanged for the
operator PAT.

**Needs operator go.** Commit, push, deploy and tag for each release, and
setting `MEMEX_TENANT_FAIL_CLOSED=1` in the live compose env.

**Out of scope.** RLS under a non-BYPASSRLS application role (terraform/IAM,
operator-gated stretch); composite `(source_id, slug)` identity and the slug
enumeration oracle (RM-25); the page mirror path collision; per-grant budgets
(RM-04); honest `tools/list` (RM-07).

#### Release A — read isolation (no migration)

Helper `src/core/source-scope.ts`, composed next to `visibilityClause`
(`src/core/visibility.ts:21`):

| Function | `undefined` | `[]` or sentinel-only | non-empty |
|---|---|---|---|
| `isNoGrant(s)` | false | true | false |
| `andSourceScope(col, s, params)` | `""` (operator SQL text byte-identical) | ` AND FALSE` | ` AND col = ANY($n::text[])` |
| `normalizeScope(s)` (clean a list for a bound array) | `undefined` | `[]` | deduped list |
| `normalizeSourceFilterParam(v)` (user-input boundaries only) | `undefined` | `undefined` | trimmed list |

Column names are checked as SQL identifiers (`alias.column`).

Site classes, inventoried with
`rg --pcre2 '(\b[\w.?]*[sS]ources?(?:Ids?)?)\s*&&\s*\1\??\.length'` plus the
ternary and early-return variants:

- **AUTH** — the ~50 sites in `src/mcp/dispatch.ts` and the core readers
  (pages, links, facts, timeline, tags, chunks-read, slug-*, page-aliases,
  raw-data, context, search). Switch to the helper; `[]` reads nothing.
- **RANK** — cosine-rescore, graph-signals, backlink-boost, graph-rerank.
  Rewritten for consistency.
- **USER** — `src/cli.ts:868`, `src/commands/export.ts:49`,
  `src/core/bench/harness.ts:158`, `src/core/advisor/collectors.ts:346`.
  Normalize at the parse boundary and keep today's meaning.

Ordered commits:

1. Red tests
   - [x] `tests/operator_scope_parity.test.ts` + `tests/fixtures/operator_scope_parity.json`:
     SQL text, bound params and responses for 46 unscoped dispatch reads,
     recorded on the pre-change tree (timestamps, latencies and float tails
     scrubbed).
   - [x] `tests/search_empty_scope.test.ts` (red first: the identifier arm
     leaked tenant B to `[]`, the query was embedded, cache keys were equal).
   - [x] `tests/helpers/tenant_seed.ts` — two-tenant seed factored out of
     `tests/tenant_isolation_contract.test.ts:91-180`; the contract test uses it.
2. Helper and ratchets
   - [x] `src/core/source-scope.ts` (`isNoGrant`, `andSourceScope`, `normalizeScope`,
     `normalizeSourceFilterParam`, identifier check) + `tests/source_scope.test.ts`.
     `andSourceScope` denies a sentinel-only scope outright (` AND FALSE`), and
     `registerSource` refuses the sentinel as a source id.
   - [x] `tests/source_scope_pattern_ratchet.test.ts` written, with a
     positive-control probe; comments are stripped before matching.
   - [x] Ratchet reaches zero hits. It matches `x && x.length`,
     `Array.isArray(x) && x.length`, and normalisers that turn an empty list
     into `undefined` (`x.length === 0) return undefined`).
   - [ ] Also fail on a `source_id = ANY(` built without the helper (47 files
     still hand-write it correctly; allowlist that only shrinks).
3. Cache
   - [x] `src/core/search/query-cache.ts:246,273` — key material for `[]`
     differs from `undefined`; operator key bytes unchanged.
   - [x] `hybridSearch` returns early on `isNoGrant`, before embedding and
     before the cache.
4. Hydrate
   - [x] `src/core/search/hybrid.ts:548` (cached hydrate) and `:971` (final
     hydrate) use `andSourceScope`.
   - [x] Final hydrate gains `visibilityClause('d')` — the one intended operator
     change: soft-deleted, archived and quarantined structural neighbours no
     longer surface. Fixture re-recorded; the only diff is that clause in the
     `search` and `query` SQL.
   - [x] `tests/structural_expand.test.ts` — empty grant keeps no neighbour;
     final hydrate hides a soft-deleted neighbour (red before, green after).
5. Arms
   - [x] `src/core/search/title-arm.ts:141`.
   - [x] `src/core/search/relational-recall.ts:297`, `:490`.
   - [x] `src/core/search/structural-expand.ts:54`, `:181` (the NULL-tolerant
     edge scope at `:130` stays until Release C).
   - [x] `src/core/search/alias-hop.ts:70`, `:162-180` — scope and visibility;
     `[]` yields no candidate paths.
   - [x] RANK modules: cosine-rescore, graph-signals, backlink-boost,
     graph-rerank; also query-refine.
6. Core readers (~30 sites)
   - [x] `tags.ts:156`; `facts.ts:752,907,946,1065`; `context/volunteer.ts:177,277`;
     `context/reflex.ts:106`; `slug-resolve.ts:75`; `typed-links.ts:261`;
     `links.ts:411,489,587,1164,1215`; `timeline.ts:198`; `links-read.ts:62,129`;
     `chunks-read.ts:44,92`; `slug-aliases.ts:51`; `ingest-log.ts:90`;
     `page-aliases.ts:149,192`; `gazetteer.ts:114`;
     `slug-canonicalize.ts:134,162,199,232,273`; `backlinks.ts:50`;
     `facts-recall.ts:76,148`; `raw-data.ts:103`; `pages.ts:556,631,667`;
     `pages-purge.ts:42`. `tests/core_readers_empty_scope.test.ts` calls each with
     `[]` against an unscoped positive control.
   - [x] Four duplicate `normalizeSourceIds` helpers (`usage-insights.ts`,
     `transcripts-read.ts`, `code-graph.ts`, `code-walk.ts`) turned `[]` into
     unscoped — `get_recent_salience`, `find_anomalies`, every `code_*` read and
     `get_recent_transcripts` leaked to a caller with no grant. All seven copies
     (plus `insights.ts`, `synthesis/reads.ts`, `structural-expand.ts`) now use
     `normalizeScope`.
   - [x] Take writes `setTakeStatus` (`synthesis/takes.ts`) and `resolveTake`
     (`synthesis/takes-canon.ts`) update nothing for an empty scope.
   - [x] Comments that still said "empty = unscoped" corrected.
7. Dispatch (~50 sites)
   - [x] All 51 collapsing sites in `src/mcp/dispatch.ts`
     (`tests/tenant_isolation_matrix.test.ts`, empty-grant principal).
   - [x] `callSearch`, `callQuery`.
   - [x] `callThink` tests `!== undefined` and short-circuits on `isNoGrant`
     without an LLM call or a spend row (today the write gate refuses `think`
     for a no-grant caller first).
   - [x] Export `OPERATOR_ONLY_TOOLS`.
8. USER boundaries
   - [x] `normalizeSourceFilterParam` at `cli.ts` (`export --source`),
     `commands/export.ts`, `core/bench/harness.ts`. `core/advisor/collectors.ts`
     turned out to carry the caller's grant, so it reads `[]` as nothing.
9. Isolation matrix — `tests/tenant_isolation_matrix.test.ts`
   - [x] Per-operation disposition table in `tests/fixtures/tenant_isolation_matrix.ts`
     (not on `Operation`, so the tool snapshot does not change). Modes:
     `isolated`, `brainwide`, `operator_only`, `write`, `skip` (a `skip` names
     the test that owns the op).
   - [x] Coverage assertions: table names equal `OPERATIONS`; `operator_only`
     equals `OPERATOR_ONLY_TOOLS`; `write` equals `WRITE_SCOPED_TOOLS`.
   - [x] Principals: scalar grant, federated grant, no grant with fail-closed on
     and off, and direct `[]` library calls.
   - [x] Check: `JSON.stringify` of the full response envelope holds none of
     tenant B's leak tokens.
   - [x] Operator control: the unscoped call must see tenant B first, otherwise
     the row fails as `VACUOUS`.
   - [x] No-grant callers must not see tenant A tokens either.
   - [x] 91 rows: isolated, write, operator_only, brainwide and 6 `skip` rows
     with owner suites. Mutation check: dropping the scope in `callSearch` fails
     the `search` row with tenant B's token.
10. Ingress (revertible on its own)
    - [x] `effectiveReadSourceIdsForIngress` returns `[]` instead of the
      sentinel for reads; writes keep the sentinel.
    - [x] Update `tests/tenant_fail_closed.test.ts`; add `search`, `query` and
      `think` cases. Emitting `[]` exposed the normaliser leaks listed under 6.

Release A verification:

- [ ] Local gates (above), never a bare full `bun test`.
- [ ] Operator byte-identical proof: the operator scope fixture plus
  `retrieval_quality*.test.ts`, `retrieval_precision`, `search_ranking_pushdown`,
  `graph_rerank`, `structural_expand`, `search_alias_hop`, `query_cache*`,
  `eval_replay_gate` and `eval_compare_gate` identical before and after.
- [x] Reviewers: second opinion, `security-engineer`, `code-reviewer`; no
  CRITICAL/HIGH read leak left; every MEDIUM acted on.
- [x] Live (v1.129.0): three fixed operator `search` calls return the same
  chunks in the same order before and after deploy; an uncached call returns the
  same score and evidence as the pre-deploy baseline. `MEMEX_TENANT_FAIL_CLOSED=1`
  was already set on the host and every registered client and PAT carries a
  source grant, so no live principal changed.
- [ ] Live check with a real no-grant client (reads nothing, writes refused,
  static bearer still whole-brain) — needs a throwaway client on the host.

#### Release B — derived writes, deletion, purge, auth

- [x] Derived writes follow the page owner: `page_append`, `page_revert` and
  `page_restore` pass the page's source to link, mention, typed and verb link
  writers, the extraction watermark and the facts reconcile (`page_put` already
  did). A scoped caller's own source wins, since it can only reach its own page.
  No separate helper: each handler already holds the page row.
- [x] Version markers: `deletePage` / `restorePage` insert `source_id` from the
  page row read in the same transaction.
- [x] Tags: an unscoped `addTag` stamps the page's source; one lookup checks the
  page and finds its owner.
- [x] Deletion guard: `sources.ts` `sourceReferences(engine, id)` counts
  documents, pages, page versions, facts, links, tags, timeline events,
  calibration profiles, every client row naming the source (revoked ones too —
  their foreign key still blocks), live OAuth tokens and codes, open
  enrollments, and unrevoked personal tokens (including permissions stored as a
  JSON string). `default` is never deletable. `deleteSource` locks the grant
  tables for the check-and-delete and maps a foreign-key violation to a refusal;
  `memex sources delete` prints the referents and reports a missing source.
- [x] Purge: one set-based DELETE, falling back on SQLSTATE 23503 to one DELETE
  per page (same expiry and scope predicate) that reports blocked pages and
  purges the rest. Shared by `purge_deleted_pages` and the cycle phase
  (`blocked_pages`). An empty scope purges nothing (Release A).
- [x] Health: brain and per-source metrics skip soft-deleted and archived
  documents.
- [x] OAuth: a token whose client row is soft-deleted is rejected; a personal
  token's `last_used_at` is written at most once a minute.
- [x] Migration `103_derived_rows_follow_page_owner.sql`: moves delete/restore
  markers on pages owned by a named source from `default` to that source.
  Tags are NOT moved (no foreign key to the page, so a tag can outlive a purged
  page whose slug another source reuses).
- [x] Tests (red before the fix): `tenant_derived_write_owner`,
  `sources_crud` (one case per grant kind, revoked client, string-encoded PAT,
  fallback source, stale grants), `identity_purge` (FK-blocked page),
  `per_source_health`, `oauth_per_grant_source` (revoked client),
  `auth_pat` (debounce), `migration_103_derived_rows_owner`.
- [x] Live (v1.130.0): migration 103 applied (doctor: schema at 103, 0 failures),
  container healthy with no restarts, the scoped PAT still authenticates.
  Source deletion and client revocation were not exercised on the live brain —
  both are irreversible there; tests cover them.
- [ ] Follow-up (not in the approved plan): an explicit `source_id` naming an
  archived or removed source returns `unknown_source`; code-intel ops route to
  one resolved source.
- [ ] REFUSED for now: moving the tags and fence facts an unscoped writer left
  under `default` on a tenant's page. A migration guarded on the row being newer
  than the page row was written and then dropped: `renamePage` carries the old
  row's `created_at` onto the new slug, so rows written for a slug's PREVIOUS
  occupant pass the guard and would move to the current owner (reproduced
  against PGLite), and a live `default` row whose owner already holds a
  tombstone at the same `(slug, row_num)` would move in and read as live again,
  resurrecting a forgotten claim. The fence key is partial on
  `forgotten_at IS NULL`, so nothing would raise. Moving these rows safely needs
  evidence of who owned the slug when the row was written — a per-slug ownership
  history the schema does not keep. Until then they stay in `default`, which is
  fail-closed: only the operator reads them.

#### Release C — code graph `source_id`

- [x] Edge writes: `code-edges.ts` inserts each edge with the source of its
  chunk's document (`INSERT … SELECT … d.source_id`); the per-edge `sourceId`
  input is gone, so no writer can stamp a different one.
- [x] `indexCodeDocument` accepts an optional `sourceId` for the document.
- [x] Scoped readers: `code-walk.ts` and `search/structural-expand.ts` build the
  edge filter with `andSourceScope`; a sourceless edge no longer passes a scoped
  structural expansion.
- [x] Volunteer events carry their page's source; `volunteerUsageStats` narrows
  to the caller's sources instead of refusing a scoped caller (`[]` sees nothing).
- [x] Migration `104_code_edges_and_volunteer_events_source.sql`: fills NULL
  edge sources from the chunk's document and NULL event sources from the page,
  and indexes `code_edges_symbol(source_id)`.
- [x] Matrix: the `code_*` reads and `volunteer_context` are `isolated` rows.
- [x] `backfillDocumentSources` hands a late-assigned document source on to its
  chunks and code edges; structural expansion scopes def-chunk lookups too.
- [x] Migration 104 attributes a volunteer event to a page only if the event is
  newer than the page row (slugs can be reused after a purge); scoped stats
  count "used" only from the caller's own page.
- [x] Tests: `code_graph_source_stamp` (edges stamped; the owner walks its graph,
  empty before; a sourceless edge stays out of a scoped expansion; scoped volunteer
  stats), `migration_104_code_edges_source`, `context_volunteer` updated.
- [x] Live (v1.131.0): migration 104 applied (doctor: schema at 104, 0
  failures); a source-scoped personal token's `code_flow` returns the call graph,
  empty for every scoped caller before.
- [x] `sweepVault`, `sweepCodeRoots` and `memex index <file>` classify what they
  indexed: each ends with `backfillDocumentSources`, which assigns the source
  whose `path_prefix` owns the document's path and carries it down to chunks and
  code edges. The indexers keep passing no source on purpose — a caller that
  NAMES one is fenced from rows another source or nobody owns, so resolving the
  source inside `indexFile` would make every re-index of a NULL-owned row a
  `permission_denied`.
- [x] The classification pass is fenced to local provenance: a sweep passes a
  path only after it indexed that file, or skipped it because the row already
  held the sweep's own newer index. Without the fence it was an escalation —
  `index` is in `PUBLIC_WRITE_TOOLS`, its inline `sourcePath` + `text` form
  deliberately keeps the caller's label un-canonicalized, and the static public
  bearer carries no write source, so a remote caller could label a document
  under a tenant's prefix. Collecting every path the walk SAW was not enough: a
  walk that breaks on `maxFiles`, or fails on a file, would have handed the row
  planted at that path its prefix owner. A `last_indexed_mtime IS NOT NULL`
  condition was tried instead and dropped — a degraded code parse stores plain
  text with no mtime on purpose (so the next sweep retries the grammar), and
  those legitimate local documents would never have been classified.
- [x] The prefix match is exact and boundary-anchored: `left(path, length(prefix))
  = prefix` plus a separator check, so neither the `__default__` sentinel's four
  LIKE wildcards nor a mid-name prefix (`/vault/team` vs `/vault/team-archive`)
  can claim a path. `registerSource` and `updateSource` both refuse an empty
  prefix.
- [x] The pass runs in one transaction, and drives chunk and edge propagation
  off the rows' own NULL state, unconditionally — so a document an interrupted
  earlier run classified without propagating is repaired even when this pass
  moves nothing. A failure is recorded in the sweep result instead of discarding
  a successful walk.
- [x] Migration `105_documents_source_id_index.sql`: migration 004's
  `documents(source_id)` index never existed — it reused the name 001 had taken
  for `documents(source_path)`, so every source-scoped read was a sequential
  scan.  It also adds the partial `chunks(document_id) WHERE source_id IS NULL`
  the classification pass needs: migration 058's chunk index is partial on
  `source_id IS NOT NULL`, the opposite predicate, so that statement scanned
  every chunk row on every sweep tick.
- [x] Both provenance tests are mutation-checked: moving the sweeps' path push
  back to "every file the walk saw" makes `tests/sweep_code.test.ts` and
  `tests/sweep.test.ts` fail. The first version of the code-sweep case did NOT
  — `maxFiles: 0` with `force` left the confirmed list empty, and the planted
  path had no file on disk, so it only proved that an empty list classifies
  nothing.
- [ ] Open operator decision: the 45 remaining NULL-source documents on the live
  brain are all under `/memory/` (sample `/memory/20-projects/…`), and no
  registered source owns that prefix — live prefixes are `__default__`,
  `/repo-source/` and `tenant:timur`. The classification pass will not invent an
  owner, so they stay operator-only until a source with a `/memory/` prefix is
  registered. Registering one changes who can read them, so it is a deliberate
  call, not a cleanup.
- [ ] Follow-up (pre-existing, not introduced here): the inline `index` form
  derives the document id from the caller's `sourcePath` label, and a caller with
  no write source is not write-fenced, so a public-write install lets a remote
  caller overwrite any document by naming its path. Needs the inline form to
  namespace remote labels, or to refuse a write to an existing row it does not
  own. v1.155.0 narrowed it: a non-operator label equal to or under a vault/code
  root, or under another source's path prefix, is refused; any other label is
  still open.
- [x] Follow-up (pre-existing): the `index` `path` form ignored the caller's
  write source. Done in v1.155.0: the path form is operator-only, and every
  local re-read goes through the owner guard.

#### Gated live steps (explicit "yes" at the time)

- [ ] Commit, push, deploy and tag each release through `/ship`.
- [ ] `MEMEX_TENANT_FAIL_CLOSED=1` is already set in the live compose env (see the
  v1.129.0 live check above); verify: a no-grant client gets empty `search`,
  `query`, `think` and `page_list`; no
  `think` spend row is written; writes return `permission_denied`; the static
  bearer still reads the whole brain.
- [ ] Stretch: RLS policies bound to a session scope GUC as defence in depth,
  under a non-BYPASSRLS application role (terraform/IAM change).

### RM-02 — Write path and embedding pipeline (live `page_put` latency)

**Why.** Writes on the live brain are slow, not failing: `page_put` averaged
33.3 s with a 116 s worst on 2026-09-08, alongside 12 AWS SDK 30 s request
timeouts. `page_put` mirrors into search synchronously and embeds chunk by
chunk (`src/mcp/dispatch.ts:1487-1530`, `src/core/indexer.ts:337-437`); with
`MEMEX_CONTEXTUAL_LLM=1` each chunk also waits on a Haiku call under one 30 s
timeout shared by every call kind (`src/core/llm/gateway.ts:62-74`). Retries
exist only for 429 on the backfill path (`src/core/embed-backfill.ts:395-419`).
A re-embed silently downgrades LLM-tier chunks because nothing records the tier.
Agents feel all of this as a stalled tool call on every write.

**Measured baseline (live brain, 2026-09-18).** From `mcp_request_log`:

| operation | window | n | avg | p95 | max |
|---|---|---|---|---|---|
| `page_put` | 30 d | 165 | 16.2 s | 45.6 s | 116.1 s |
| `page_append` | 30 d | 58 | 3.1 s | 9.6 s | 12.5 s |
| `add_fact` | 30 d | 402 | 8 ms | 20 ms | 37 ms |
| `add_timeline_event` | 30 d | 64 | 10 ms | 19 ms | 26 ms |
| `search` | 7 d | 53 | 1.5 s | 2.6 s | 7.7 s |
| `query` | 7 d | 11 | 2.3 s | 3.1 s | 3.2 s |

It has not improved: 2026-09-18 alone is avg 17.7 s / p95 46.4 s over 8 calls.
The two write tools that do NOT embed are three orders of magnitude faster,
which localises the cost precisely.

Composition, same day: the live env carries `MEMEX_CONTEXTUAL_LLM=1` and
`MEMEX_CONTEXTUAL_RETRIEVAL=1`, so every chunk waits on a Haiku call and then a
Titan embed, serially. The spend ledger over 7 days shows 708 embedding calls
and 282 `utility-llm` Haiku calls. Page documents: 1116 total, of which 1065
carry 1-10 chunks, 41 carry 11-20, 9 carry 21-30 and one carries 31. Eight
chunks × (a Haiku round trip plus an embed round trip) accounts for the observed
average on its own. Container logs for the last 72 h contain ZERO AWS SDK
`requestTimeout` lines, so this is serial work on the request path, not failures
— the 12 timeouts seen on 2026-09-08 were a symptom of the same queueing, not
the cause.

**Scope.**

- Measure first: DONE (above). Still pending: the `MEMEX_CONTEXTUAL_LLM=0`
  experiment against the eval-probe baseline (hit rate 0.889 / MRR 0.611),
  which needs an operator go.
- Move the page→search mirror and embedding off the request path onto durable
  job kinds (`page_mirror`, `embed_backfill`, `contextual_reindex`) with
  per-source single-flight locks (`src/core/db-lock.ts`); keep the reconcile
  phase as backstop; return `search_indexed` in the `page_put` response.
- Embedding lifecycle: retry with jitter on 429/5xx/timeouts honouring
  retry-after, classified by AWS SDK error name and `$metadata.httpStatusCode`;
  a progress-keyed stall watchdog that leaves a resumable run; per-source
  cooldown and USD cap on backfills; bounded per-chunk concurrency under
  `MEMEX_EMBED_CONCURRENCY` (Titan v2 has no batch API).
- Bulk-writer pacing: backfill jobs yield to interactive `page_put` on RDS
  (a pacing knob next to `MEMEX_EMBED_CONCURRENCY`).
- Per-call-kind timeouts (utility chat, reasoning chat, embedding) composed
  with caller abort signals.
- Contextual tier resolution page frontmatter → source row → global flag,
  using the inert `contextual_retrieval_mode` columns from migration 024; a
  per-chunk tier stamp so re-embeds keep the tier; two-phase re-embed (compute
  outside, write in one transaction).
- Stale-take embedding backfill as a cycle phase next to `embed-facts`.
- Stretch: HNSW-servable orderings for the curation-boost and max-pool vector
  queries.
- Files: `src/mcp/dispatch.ts`, `src/core/page-index.ts`, `indexer.ts`,
  `embedding.ts`, `embed-backfill.ts`, `contextual-reembed.ts`,
  `search/contextual-embed.ts`, `search/contextual-llm.ts`, `llm/gateway.ts`,
  `llm/haiku.ts`, `llm/sonnet.ts`, `jobs/handlers.ts`, `commands/serve.ts`,
  `cycle/index.ts`, `cycle/mirror-pages.ts`, `synthesis/takes.ts`, a tier-stamp
  migration, `deploy/docker-compose.yml`. Spend goes through `trackedInvoke`.

**Release plan (design reviewed 2026-09-18).** Six lenses — request path,
job infrastructure, embedding layer, read-after-write, phasing, tests — each
proposal stressed by an independent critic against the code. None survived
unchanged; 22 came back with concrete revisions and 2 were rejected. The order
below puts the reversible, contract-preserving levers first and the async
mirror last, because the mirror is where every blocker sits.

- **R1 — make the write path attributable (no behaviour change).**
  - Contextual Haiku calls book under `contextual-llm`, not `utility-llm`:
    `generateChunkContext` passes `operation: CONTEXTUAL_LLM_LABEL` into
    `resolveLlmFn`. Add an optional `client` to its options so a test can reach
    the real transport and assert the ledger row.
  - One structured log line per `indexDocument`: kind, slug, chunks total,
    reused, llm ok / skipped, embed calls, fence embeds, ms total, ms tx. Paid
    time split into queue / send / ledger through an AsyncLocalStorage
    accumulator, the way `runWithSpendClient` already works — timing from
    inside the indexer would count the inflight-cap queue as Bedrock time.
  - Do NOT flip `MEMEX_REQUEST_LOG_DB`: it adds internal and static-bearer
    calls to `mcp_request_log` and breaks comparison with the baseline above.
    Every baseline and target query pins `token_name IS NOT NULL`.
  - Exit: a live `page_put` log line decomposes its latency.
  - DONE, live 2026-09-18 (v1.133.0). A 3-chunk probe `page_put` logged
    `chunks=3 reused=0 llm_ok=3 embeds=3 ms_total=4135 ms_bedrock=3965
    ms_queue=0 ms_ledger=45 ms_tx=86`: 96% of the write is serial Bedrock time
    (about 1.3 s per chunk for the contextual call plus the embed); the spend
    ledger and the write transaction are noise. That makes R3's fan-out the
    lever for new pages and R2's reuse the lever for edits — not the database.
- **R2 — reuse vectors by content, and prompt-cache the document.**
  - DONE, v1.137.0: reuse keyed by chunk text within the document, prose and
    fenced-code symbols in separate maps, fenced-code symbols reused too. Live:
    a section inserted above three unchanged sections logged `chunks=4
    reused=3 embeds=1 ms_total=1116`.
  - REFUSED: the document prompt cache. Since R3 a write's chunks start
    together, so no cache write has finished when its siblings send — every
    call would pay the 1.25x write and none would read it. And a typical page
    (about 10 chunks) stays under Haiku 4.5's 4096-token cache minimum anyway.
    It would raise cost, not lower latency. `contextual-reembed` (serial, one
    document at a time) keeps its cache.
  - (original R2 spec below)
  - Re-key the prior-vector map from `chunk_index` to chunk text, as two maps
    (`markdown` and `fenced_code`, from `chunk_source`) so a prose chunk never
    reuses a symbol body's vector built from a different input. Admit a prior
    row only on same model and width. Keep the `document_id = $1` scope — that
    scope IS the tenancy guarantee; never widen it into a cross-document cache.
  - Decide reuse for every chunk first, then set `cacheDocument` only when at
    least two chunks still need the LLM and the document clears Haiku 4.5's
    cache minimum (4096 tokens; confirm the Bedrock figure). Below that the
    cache write costs 1.25x with no read.
  - A knob, if kept, reads empty or unset as ON — compose passes `""`.
  - Exit: re-putting a page with one edited section makes one LLM call and
    one embed call, not N; counted on the injected fns in
    `tests/reindex_reuse.test.ts`.
- **R3 — bounded per-chunk fan-out (first move for NEW pages).** Shipped
  before R2 (live R1 data showed 96% of a write is serial Bedrock time, and
  positional vector reuse already exists, so R2's latency win is marginal).
  DONE, live 2026-09-18 (v1.134.0): the same 3-chunk probe went from
  `ms_total=4135` to `ms_total=1598` — 2.6x on wall clock with the same
  Bedrock work (sum 4309 ms) run in parallel. Only interactive writes fan out;
  sweeps, reindex and the cycle stay serial. Open: the embedding client still
  has default SDK retries (not adaptive), so a Titan throttle under parallel
  load aborts the whole page — that is R4. `embed-backfill` keeps its own pool
  of 8 outside the shared ceiling.
- (original R3 spec)
  - Swap `withInflightCap`'s hand-rolled queue for the existing `Semaphore`
    (`concurrency.ts`), resolved lazily with a test-only reset (tests mutate
    the env per case).
  - A new `MEMEX_EMBED_MAX_INFLIGHT` (default 4) acquired at the WRITER call
    sites only — the indexer loop, `embedPage`, `contextual-reembed`. Never
    inside `embedText`: `embedQueryBounded` races a 6 s wall clock that starts
    before any wait, so a search during a backfill would silently fall back to
    keyword-only. `MEMEX_EMBED_CONCURRENCY` keeps its meaning (backfill width,
    default 8) and is not renamed.
  - The chunk loop becomes an index-keyed `allSettled` with pre-sized
    `vectors` (all four `push` sites converted), preserving the half-write
    guard: a hard failure aborts before any write, with no stray sibling
    rejection.
  - Add every knob to the `deploy/docker-compose.yml` allowlist, and make
    `resolveConcurrency` treat `""` as unset (today it becomes 0, clamped to 1).
  - Exit: p95 `page_put` over 7 days (`token_name IS NOT NULL`) roughly
    quartered; a query embed under a saturated ceiling still settles inside
    `MEMEX_QUERY_EMBED_TIMEOUT_MS`.
- **R4 — make the timeouts real.**
  - Today's 30 s is advisory: add `throwOnRequestTimeout: true` next to every
    `requestTimeout`, and give the embedding client an explicit handler,
    `maxAttempts` and `retryMode: "adaptive"`.
  - Split per call kind — `MEMEX_LLM_UTILITY_TIMEOUT_MS`,
    `MEMEX_LLM_REASONING_TIMEOUT_MS`, `MEMEX_EMBED_TIMEOUT_MS`, each falling
    back to `MEMEX_LLM_TIMEOUT_MS` (which is itself missing from the compose
    allowlist today).
  - Keep retry classification in the SDK. No app-level retry around
    `embed`/`llmFn` on the write path — it multiplies attempts and honours
    retry-after twice. A shared classifier, if any, replaces `isThrottle` in
    `embed-backfill.ts` only, where the SDK has already given up.
  - Thread an `AbortSignal` through `LlmCallInput`, both `c.send` calls in
    `haiku.ts`, and the semaphore wait.
  - Test at the transport seam: a stub request handler that returns 503, then
    hangs past the timeout, then 200. The old "no duplicate chunks" claim holds
    by construction (delete-then-insert with deterministic ids) and proves
    nothing about retries.
  - DONE in v1.135.0 (see CHANGELOG), with two corrections the review forced:
    a chat call's timeout is its tier base plus 25 ms per allowed output token
    (Converse does not stream — a fixed 30 s/120 s limit would cut `think`'s
    8000-token retry at ~130 s and the SDK would re-send it, billing each
    attempt in full), and the embedding client uses standard retry, not
    adaptive, so a throttled backfill cannot rate-limit live query embeds
    through their shared client.
  - Open from the R4 review:
    - Accepted as a known limit: a timed-out attempt books a $0 row (trackedInvoke
      already writes one for a call that threw before reporting usage), so the
      ATTEMPT is counted, but its dollars are not — the token count of a cut
      request is unknowable client-side. The token-scaled chat timeout makes a
      cut long generation rare. Revisit only if Cost Explorer's Bedrock line
      drifts above the ledger total.
    - DONE (v1.136.0): `skillify.ts` and `friction-propose.ts` use
      `bedrockClientConfig` with a `maxTokens`-scaled timeout;
      `search/intent.ts` and `search/expansion.ts` — which had NO timeout on
      the search path — use it plus a 5 s search budget
      (`SEARCH_LLM_BUDGET_MS`), fail-open as before. `search/two-pass.ts` was
      already bounded by `MEMEX_RERANK_TIMEOUT_MS` and is unchanged.
    - DONE (v1.136.0): `embed-backfill.ts`'s throttle loop is capped at 2 extra
      tries (was 5), so one throttled chunk costs at most 12 sends, not 24.
    - DONE (v1.140.0): the query embed caps each attempt at a third of its
      6 s budget (a per-request timeout, no second client), so an SDK retry
      fits inside the search deadline.
- **R5 — stamp the contextual tier.** DONE, v1.138.0: `chunks.contextual_tier`
  (migration 106), stamped by the indexer (which, it turned out, had never set
  `contextual_embedded` at all — every live-wrapped chunk read as un-wrapped, so
  `reindex --contextual` re-paid for them and could downgrade LLM vectors) and by
  `reindex --contextual`, which now never lowers a tier (`tierKept`).
  NOT done, deliberately: the per-page / per-source tier resolver over the
  inert `contextual_retrieval_mode` columns from migration 024. Nothing writes
  those columns and no per-source tier policy has been asked for; the global
  flags stay the only switch until one is. Pre-106 chunks have NULL tier and are
  not guessed at, so a forced re-embed can still lower one of THOSE — only a
  fresh write or a re-embed under the LLM tier gives them a recorded tier.
- (original R5 spec) `chunks.contextual_tier` plus a tier
  resolver (page frontmatter → source row → global flag), joined into the reuse
  check, so a forced re-embed cannot silently downgrade an LLM-tier chunk.
  Ships before anything re-embeds at scale.
- **R6 — move the mirror onto a `page_mirror` job (the contract change).**
  BUILT, v1.139.0, behind `MEMEX_PAGE_MIRROR_SYNC` (default: inline, i.e. no
  live behaviour change). Job id unique per write (a random UUID — simpler than
  the version-keyed id and it has the same property: no edit ever collapses
  onto an old job; the handler mirrors the page as it is when it runs, so an
  older job landing late is wasted work, never stale data). `remote` carried in
  the payload, fail-closed. Owner taken from the page row. Queue failure falls
  back to inline. After security and correctness review: exact-slug read (no
  cross-source redirect hop), `contentHash` in the payload with a superseded
  skip (the trust flag belongs to one write), mirror removed again when the page
  is deleted mid-embed, one failure row per page rather than per retry.
  `wait_for_index` added. Response: `search_pending` +
  `search_job_id` when queued; `search_indexed:false` keeps meaning "failed".
  `page_revert` / `page_restore` stay inline. Tenant mirror removed on delete.
  - OPEN OPERATOR DECISION: flip `MEMRAIN_PAGE_MIRROR_SYNC=0` live. It is the one
    change that makes p95 independent of page size, but an agent that writes
    and then searches in the same turn will miss the page for a few seconds
    unless it passes `wait_for_index`. Decide after the 7-day p95 with
    R2 + R3 (v1.134.0, v1.137.0) is in — if large pages still hold p95 above
    3 s, flip; if not, leave it inline.
  - Not done from the review list, with reasons: per-source single-flight lock
    (the single elected worker at concurrency 1 already serialises, and a
    `null` acquire read as done would lose an edit); a second interactive
    worker lane (`page_mirror` is enqueued at priority 1, which `Queue.claim`
    already sorts first); `jobs.source_id` (the handler never reads a source
    from the job — only from the page row); `MEMEX_RESPONSE_VERSION` bump (the
    new fields are additive and appear only when the operator turns async on).
    `reconcilePageMirrors` still indexes with no `remote` flag — pre-existing,
    and deciding it needs a stored per-page trust bit the schema does not have.
- (original R6 spec)
  - Job id keyed on the version the write produced
    (`page_mirror:<src>:<slug>:v<n>`), NOT on `content_hash`: `page_revert`
    and any A→B→A put reproduce an old hash, `ON CONFLICT DO NOTHING` then
    enqueues nothing, and search serves reverted content for up to 6 h.
    `RestoreResult` needs the version surfaced.
  - Carry `remote` in the payload and treat missing as `true` (fail closed).
    It is a property of the caller, not the page row; without it a scoped
    writer plants `quarantine` / `embed_skip` / `content_flag` and the job
    indexes them as trusted. The same hole already exists in
    `reconcilePageMirrors` and is fixed with it.
  - Re-read the page at run time: no-op on `deleted_at`, take the source from
    the row (`page.source_id ?? writeSource`), and re-check `deleted_at` inside
    the write transaction.
  - No per-source `tryAcquireDbLock`: the single elected worker at
    concurrency 1 already serialises, and a `null` acquire read as "done"
    loses the edit.
  - `search_indexed` becomes required on `page_put` / `page_append`, derived
    from a `pageMirrorState` that shares one SQL predicate with
    `reconcilePageMirrors`, plus `search_index: { state, vectors_pending }`;
    the same block on `page_get`, which is the only poll handle a tenant or
    public caller can reach. A per-call `wait_for_index` for callers that need
    read-after-write in one turn; `MEMEX_PAGE_MIRROR_SYNC` stays default ON
    until the job path is proven live. `MEMEX_RESPONSE_VERSION` bumps in this
    release only. The four tool descriptions must say the mirror is deferred.
  - Fix `callPageDelete` in the same release: it removes only the legacy
    `page://<slug>` mirror, so a tenant's deleted page stays searchable until
    the 6-hourly sweep.
  - Exit: p95 `page_put` under 3 s over 7 days AND p95 mirror lag
    (`finished_at - created_at` for kind `page_mirror`) reported next to it —
    otherwise the latency number stops meaning "searchable".
- **Not doing, with reasons.**
  - The `MEMEX_CONTEXTUAL_LLM=0` experiment as specced: the flag only affects
    indexing (`core/indexer.ts`, `contextual-reembed.ts`), and `eval-probe`
    scores the vectors already stored, so a before/after run scores the same
    corpus and measures noise. It also has no power at this n (0.889 is 8/9; one
    query moves the hit rate by 11 points). A real tier comparison needs the
    probe corpus re-embedded under each tier and a per-query diff.
  - `embed_backfill` / `contextual_reindex` as job kinds: rejected — the job
    row carries no source today (`ctx.job.sourceId` does not exist), so a
    per-source job is a tenancy break until migration 106 adds one.

**Depends on.** Nothing hard; RM-08 leases make long backfills safer (start on
the existing queue).

**Risks.** Read-after-write: an agent that writes then searches may miss the
page until the job runs — expose `search_indexed:false` and keep a synchronous
path behind a flag; job pile-up on bulk imports until RM-08 admission control;
changing contextual tiers moves rankings; the experiment needs operator go.

**Done when.** p95 `page_put` latency from `mcp_request_log` under 3 s over 7
days on the live brain with zero lost mirrors (reconcile finds nothing); no
SDK "exceeded requestTimeout" warnings attributable to the write path;
eval-probe hit rate/MRR not below baseline; a unit test proves a forced
re-embed keeps an LLM-tier chunk's tier; a fault-injection test shows
503/timeout retries then success without duplicate chunks.

**Needs operator go.** The `MEMRAIN_CONTEXTUAL_LLM=0` live experiment.

### RM-03 — Database and process resilience on RDS

**Why.** memex is one container on one host in front of one RDS instance. An
RDS blip at boot crash-loops the container (`src/commands/serve.ts:94`);
migrations have no cross-process lock although serve and `docker exec memex …`
both run them (`src/core/migrate.ts:290-333`); an omitted body blanks a
populated page (`src/core/pages.ts:227`, `:414-425`) and concurrent
`page_append` loses updates (read outside the transaction, no `FOR UPDATE`);
`page_versions.version_n` is `MAX()+1` without a lock; timed-out searches keep
their SQL running and holding pool slots (`src/core/engine/postgres.ts:57-65`);
a synchronous spin freezes every MCP client with nothing to restart the
process; a lost cycle lock is never noticed; the test suite never touches
Postgres. Agents and background work amplify every one of these.

**Scope.**

- Write path: refuse empty-over-non-empty page writes unless an explicit flag;
  `SELECT … FOR UPDATE` on the page row inside `putPage`, `appendPage` folded
  into the same transaction, `version_n` computed under the lock; a deleted
  page is not silently undone by a later importer/synthesis write without an
  explicit restore.
- DB access: pool GUCs `idle_in_transaction_session_timeout`, jittered
  `max_lifetime`, connect timeout and bounded connect retry; optional `signal`
  on `Engine.query` cancelling the in-flight postgres-js query; a classified,
  redacted DB error (`auth_failed`, `ssl_required`, `dns_failed`,
  `conn_refused`, `pool_exhausted`, `db_missing`, `vector_missing`) on MCP and
  CLI; degraded serve that boots with a lazy single-flight reconnect and a
  `/health` degraded reason (hybrid raises the classified error, never serves
  empty results); `memex engine status --probe` that never runs migrations.
- Migrations: cross-process advisory lock with holder heartbeat and hard
  deadline around `runMigrations` (Postgres only); warn when the DB schema is
  ahead of the image (rollback).
- Process: cooperative abort helpers (reason codes, combined signals) threaded
  into cycle phases, embed loops and job handlers; opt-in worker-thread stall
  watchdog that terminates a wedged serve so docker restarts it (15 s floor);
  bounded CLI teardown with stdout drain for large piped JSON; `init: true` on
  the memex compose service.
- Tests: local `make test-pg` lane against pgvector Postgres in docker compose
  covering JSONB binds, RLS triggers, `SKIP LOCKED` contention, search_path
  hardening and migration replay; engine behaviour tests across PGLite and
  Postgres.
- Stretch: atomic writes for CLI outputs (`lint --fix`, `init`, `export`); a
  surrogate-safe truncation helper for prompt slices; a `host=` redaction kind;
  detach signal listeners in test reset.
- Files: `src/core/pages.ts`, `engine/interface.ts`, `engine/postgres.ts`,
  `engine/factory.ts`, `storage.ts`, `migrate.ts`, `doctor-ops.ts`,
  `src/http/health.ts`, `src/commands/serve.ts`, `src/cli.ts`, `src/cli-exit.ts`,
  `process-cleanup.ts`, `cycle/index.ts`, `jobs/worker.ts`, `search/hybrid.ts`
  (signal threading), `url-redact.ts`, `deploy/docker-compose.yml`, `Makefile`,
  new `tests/pg/*`. The degraded wrapper is a thin wrapper over the 5-method
  `Engine`; locks are SQL on RDS; the Postgres lane is a local ship gate, not a
  CI blocker.

**Progress.** Write-path integrity DONE in v1.141.0: slug-scoped
`pg_advisory_xact_lock` in `putPage` (covers new slugs too; `FOR UPDATE` is not
allowed next to the version `GROUP BY`), appends composed under that lock
(`appendContent`) instead of an optimistic retry — ten racing appends all
land; omitted body keeps the current body, explicit empty over non-empty needs
`allow_empty_body`; PGLite transactions serialized with a re-entrant join (a
real local-engine bug: one session shared by concurrent BEGINs); per-migration
cross-process advisory lock + applied re-check (statement_timeout raised
before the wait, so a long migration next door does not cut it). The slug
lock (`lockPageSlugs`, sorted) is held by EVERY version writer — put, append,
delete, restore, rename, merge. Appends take title/truth from the locked row
too. CAVEAT: on PGLite the advisory locks are re-entrant in its single session,
so the tests prove the serialization and the re-check, not the Postgres locks
themselves — that needs the `make test-pg` lane below. Verified LIVE on RDS
instead (v1.141.0): 10 concurrent appends through the real pool — 0 failures,
all 10 lines, 11 distinct versions, 287 ms. Pool GUCs DONE (v1.142.0): `idle_in_transaction_session_timeout` 60 s,
`connect_timeout` 10 s; `max_lifetime` is already jittered 30-60 min by
postgres-js's default. Still open: the deleted-page-undone-by-a-later-write
rule (an operator call — the current behaviour is a documented tradeoff),
classified DB errors,
degraded boot, query `signal`, stall watchdog, CLI teardown, and adding
`make test-pg` to the ship gate list. Postgres lane DONE (v1.160.0): `make
test-pg` runs the Postgres-only tests and applies every migration twice
against a throwaway `pgvector/pgvector:pg16` container (or a scratch database
named by `MEMEX_TEST_POSTGRES_URL`) and removes the container even on failure;
CI runs it as an advisory `Postgres tests` job.

**Depends on.** Nothing.

**Risks.** `FOR UPDATE` adds lock waits on hot slugs (bounded by
`lock_timeout`); a watchdog false positive restarts a healthy container
(opt-in, measured on the host); degraded serve must never return empty results
as if healthy; pool GUC changes on live RDS need a maintenance note.

**Done when.** Red-first tests for: blank overwrite refused; 10 concurrent
`page_append` calls produce 10 appends and no PK violation; two concurrent
`runMigrations` on the Postgres lane both succeed; a cancelled search releases
its backend (`pg_stat_activity` check); serve boots with RDS unreachable,
reports `degraded`, then recovers without restart; a fixture that blocks the
loop is killed by the watchdog while healthy runs are untouched; piped
`memex call … --json` over 64 KiB round-trips intact; `make test-pg` green and
added to the ship gate list.

### RM-04 — LLM gateway resilience and spend correctness

**Why.** The per-client ceiling is check-then-act: K concurrent calls all pass
`refuseIfClientExhausted` and overshoot by K× the per-call cost; a PAT is never
capped; an enrollment connector shares one cap across the whole team; the
ledger stores cents but no tokens, cache tokens, phase or grant; an unpriced
model books $0 (`src/core/budget.ts:251-275`, `:562`). The concurrent
overshoot, the uncapped PAT and the shared team cap are fixed (v1.143.0,
v1.144.0); what is left is under "Spend ledger — remaining approximations"
below. `BudgetTracker` records after the fact, so parallel synthesis passes
`wouldExceed` against the same total, and any call site that forgets a tracker
is uncapped. Expired credentials or throttled quota make every phase burn a
30 s timeout per item. `core/search/intent.ts` and `expansion.ts` build their
own Bedrock clients with hardcoded model ids. Every later LLM item spends
through this chokepoint.

**Scope.**

- Per-attempt worst-case reservation at `trackedInvoke` (max input × input
  rate + max output × output rate), settled from actual Bedrock usage, sharing
  the advisory lock `reserveSpend` takes; refusal errors carry a tag fallbacks
  must rethrow; job-run paid calls bound to the submitting client through the
  existing ALS.
- Per-grant and per-PAT daily caps (grant id on the spend row;
  `budget_usd_per_day` on enrollment rows copied to the grant; a PAT column);
  overdue holds keep counting until reconciled instead of expiring at the TTL
  or UTC midnight; the `spent == cap` comparisons made consistent.
- Ledger columns for input/output/cache-read/cache-write tokens, phase label,
  grant id and a nullable cost for unpriced models; an operator-scoped usage
  report op (by model, phase, client/grant, with coverage notes); the admin
  spend page reads `actual_cents`.
- `BudgetTracker` with outstanding reservations, optional wall-clock cap and
  an exhaustion hook, installed as an ambient ALS scope read inside
  `trackedInvoke` so un-threaded call sites are still capped.
- Bedrock error classifier (AccessDenied/ExpiredToken → halt the run;
  ServiceQuotaExceeded/repeated throttling → halt with cooldown;
  ValidationException input-too-long → non-retryable) and a cross-job cooldown
  row so queued LLM jobs back off together; a DB-backed lease cap for
  concurrent Bedrock calls once more than one process spends.
- One tolerant, linear-time JSON decoder (fenced block, direct parse, first
  object/array, retry after stripping `<thinking>` blocks) used by every
  structured Bedrock parser.
- Model resolution with per-feature keys (think, drift, concepts, expansion,
  intent) and runtime-config overrides; expansion and intent call
  `resolveModel`; stale `v1-nova` prompt-version labels renamed with a
  cache-version bump.
- Progressive ramp for paid backfills (contextual re-embed, fact extraction):
  run a small first stage, verify, then expand under the cost cap — a policy on
  job fan-out, executed by RM-08.
- Stretch: `MEMEX_PRICING_OVERRIDES`; one USD-limit parser shared by the ~18
  `MEMEX_*_BUDGET_USD` knobs plus a spend-posture switch; pre-flight dollar
  estimate for bulk re-embeds; structured-output expansion via Converse forced
  tool choice; an observe-only guardrail hook seam with optional
  `guardrailConfig` passthrough when an operator-provisioned guardrail id is
  configured; a Bedrock model reachability probe in doctor.
- Files: `src/core/budget.ts`, `src/mcp/dispatch.ts` (`withClientSpend`,
  `PAID_OP_ESTIMATE_USD`), `llm/gateway.ts`, `llm/haiku.ts`, `llm/sonnet.ts`,
  `llm/resolve-model.ts`, `llm/truncation.ts`, `search/expansion.ts`,
  `search/intent.ts`, `facts-extract.ts`, `synthesis/*.ts`, `jobs/worker.ts`,
  `oauth-provider.ts` (grant id on AuthInfo), `src/http/admin-api.ts`,
  `admin/src/pages/*`, `src/mcp/operations.ts`, a ledger/caps migration.
  Pricing comes from `MODEL_PRICING` and Titan pricing; no non-Bedrock branches.

**Depends on.** Nothing. RM-13, RM-15 and RM-22 depend on it.

**Risks.** Worst-case reservations refuse calls earlier near the cap (errs
safe, documented); a ledger migration on a hot table; a decoder change alters
which malformed outputs are salvaged (linearity tests through the real
function); guardrail resources and IAM tightening are terraform and
operator-gated.

**Done when.** 20 parallel paid calls at a $0.10 cap book at most cap + one
attempt's worst case; a capped PAT is refused at the cap; enrollment grants
have independent caps; usage report totals reconcile with `mcp_spend_log` over
a seeded day; an AccessDenied on the first item stops a synthesis phase after
one call; a grep gate in a test proves every structured parser uses the shared
decoder.

**Progress.** R1 (v1.143.0): PAT caps (`access_tokens.budget_usd_per_day`,
set with `auth set-budget`, inherited on re-mint); the cap is read at token
verification and carried on the spend context (null = uncapped, zero lookups);
raw token columns and a nullable cost on `mcp_spend_log`; a capped caller is
refused an unpriced model before send. R2 (v1.144.0): per-call worst-case
hold at `trackedInvoke` for capped clients, settled in the booking
transaction; holds live to the end of the day; `withClientSpend` only refuses
an already-spent day; search fallbacks rethrow refusals. Not covered: SDK
retries of a timed-out attempt bill more than one worst case. R3
(v1.144.0): `llm/bedrock-errors.ts` classifier; in-process circuit read at
`trackedInvoke` inside batch scopes (cycle phase, job, embed backfill,
contextual re-embed), credential → all models, access/quota → that model, 5
min; a timed-out phase/job's orphaned paid calls are refused. Not done: a
cross-process cooldown row (one process spends today) and rescheduling a
halted job at the circuit's reopen time. R4 (v1.144.0): migration 108;
an enrollment-redeemed token spends under the enrollment id (`grant_id` on
codes and tokens, `AuthInfo.spendId`), capped by the enrollment's cap else the
connector's per person. PAT names starting with `memex_cl_`/`memex_enr_` are
refused at mint (v1.160.0), so a PAT can no longer share an OAuth client's or an
enrollment's ledger key. Not done: a combined connector-wide cap across all its
enrolled people, and the admin spend page listing enrollments. R5
(v1.144.0): `BudgetTracker.reserve/settle/release`; `wouldExceed` counts
holds; `generateChunkContext` migrated; takes, drift, contradictions,
facts-classify and facts-extract now reserve before the call and settle from
actual usage (a truncation retry grows its hold) (v1.160.0). The remaining ten
check-then-record sites — `synthesis/patterns.ts`, `reflections.ts`,
`enrich-thin.ts`, `think.ts`, `deep-synth.ts`, `concepts.ts`,
`search/graph-rerank.ts`, `search/relational-llm.ts`,
`chronicle/extract-events.ts` and `commands/extract-conversation-facts.ts` —
now reserve, settle and release on failure too (Unreleased, after v1.160.0;
`tests/budget_reserve_search_synthesis.test.ts` admits exactly
floor(cap / estimate) of 12 parallel calls). Not done: an ambient tracker read
inside `trackedInvoke`. Decoder
(v1.144.0): `llm/json-output.ts` `parseModelJson`, 13 parsers migrated, gate
in `tests/model_json.test.ts` with 5 stated exemptions; the two
`isWellFormedEmptyExtraction` checks keep their exact-`[]` rule on purpose. Model keys
(v1.144.0): `resolveModel(tier, override, feature)` with
`MEMEX_<FEATURE>_MODEL` for think, drift, concepts, expansion, intent, rerank.
Not done: runtime-config overrides and the `v1-nova` prompt-version rename. Spend report
(v1.145.0): `core/spend-report.ts`, `memex spend`, `/admin/api/spend/report`
— operator-only surfaces, no MCP op (a remote tool would need tenancy rules
for a cross-tenant rollup).
- LOW: the admin spend page lists OAuth clients only; PAT caps and spend are
  not shown there.

### RM-05 — Ingest content safety and supply chain

**Why.** Agents paste transcripts, env dumps and configs into the brain, and
nothing scans ingested content for credential shapes before it is stored,
chunked, embedded and served to every grant that reads the source (only
eval-capture rows are scrubbed, `src/core/eval-capture-scrub.ts`). A
false-positive quarantine hides a page with no audit trail, no remote list and
no per-pattern off switch (`src/core/content-sanity.ts`). `memex capture --file`
reads binaries as text (`src/commands/capture.ts:127`). Junk entity names
(`team`, `meeting`, `unknown`) accrete edges. Sanitizer closers for `</take>`,
`</page>`, `</trajectory>` are missing although think wraps evidence in exactly
those tags (`src/core/llm/sanitize.ts:21-45`, `src/core/synthesis/think.ts:436`).
The repo is public and ships to a host holding RDS and Bedrock credentials, yet
CI has no secret or dependency scanning and actions are only partly SHA-pinned.

**Scope.**

- Ingest secret scanner at the single chokepoint next to the content-sanity
  gate (`src/core/indexer.ts:240-260`) and on `page_put`, `/ingest` and
  capture: named token prefixes written from vendors' published formats (AWS,
  GitHub, Slack, Anthropic) plus memex's own `memex_at_`/`memex_rt_`/PAT
  shapes, whole-block PEM redaction, an optional entropy rule, SHA-256
  fingerprints instead of values, a fingerprint allowlist in runtime config,
  `MEMEX_SECRET_SCAN_DISPOSITION=redact|flag|reject`; a `page_versions` scrub
  path for already-stored hits.
- Content-sanity observability: an audit row per trip in a DB table (shared
  with RM-18's `ops_audit`), a doctor summary, an operator-only
  `quarantine_list` MCP op, per-pattern disable, operator literal directives
  (`# name=`, `# applies_to=`).
- Binary guard (magic signatures + NUL scan of the first 8 KB) shared by
  capture, `/ingest` and index; one slug convention across CLI/MCP/webhook
  capture.
- Shared junk-entity-name gate used by gazetteer, fact entity resolution and
  chronicle, plus a `junk-entity-hubs` doctor check.
- Sanitizer closers for take/trajectory/page/calibration blocks.
- CI: gitleaks over commit ranges, `bun audit`, OSV on lockfile changes,
  actionlint, SHA-pinning of every action — all non-blocking per the local-gate
  policy; `make audit` unchanged.
- Files: `src/core/indexer.ts`, `content-sanity.ts`, `quarantine.ts`,
  `src/commands/quarantine.ts`, `src/commands/capture.ts`, `src/http/ingest.ts`,
  `src/mcp/operations.ts`, `dispatch.ts`, `src/http/public_guard.ts`,
  `gazetteer.ts`, `facts-extract.ts`, `chronicle/extract-events.ts`,
  `llm/sanitize.ts`, `src/commands/doctor.ts`, `doctor-categories.ts`,
  `.github/workflows/ci.yml`, an audit-table migration.

**Depends on.** Nothing. RM-14 and RM-26 depend on it.

**Risks.** False positives on hashes and UUIDs — default the entropy rule to
`flag` and `redact` only named prefixes; scanning cost on 5 MB bodies — every
regex passes the linearity rule measured through the exported function;
redacting stored `page_versions` rewrites history rows.

**Done when.** A seeded page with an AWS key, a memex PAT and a PEM block is
stored with those spans redacted plus a fingerprint audit row, and no chunk
contains them; `quarantine_list` works for the operator and is refused to
tenants; `capture --file` on a PNG exits non-zero; gitleaks over the full
history reports zero findings (or an allowlisted fixture set); linearity tests
exist for every new pattern.

**Progress.** R1 (1.145.0): `core/secret-scan.ts` (named prefixes + bounded
PEM/PGP blocks, fingerprint audit rows in `ingest_log`, disposition and
allowlist env) on putPage body/append, the indexer, raw data and `/ingest`
before enqueue; `core/binary-guard.ts` on capture and `/ingest`; sanitizer
closers for think's evidence blocks. R2 (1.146.0): facts (text and
context), timeline events, hot_memory, chronicle projections, page title and
every string in compiled_truth are scanned too (`guardFields` /
`guardSecretsDeep`); a `reject` writes a `secret-rejected` audit row before
refusing. `ontology_propose` values are scanned in `mergeOntologyFact`;
`/ingest` scans only after the tenancy gates, so a client with no grant gets
a 403 and leaves no audit row. R3 (1.146.0): each quarantine trip writes a
`quarantine` row to `ingest_log` (pattern names only; only a new or changed
verdict, after the write commits, best-effort), a `quarantined-pages`
doctor check reports count and top patterns, and `MEMEX_CONTENT_SANITY_DISABLE`
switches off individual patterns. R4 (1.146.0): `core/entity-junk.ts`
`isJunkEntityName` (merged from the gazetteer's generic stop-phrases) gates
fact entity resolution, chronicle `who`, gazetteer phrases, typed frontmatter
links and meeting-attendee timeline entries; a read-only `junk-entity-hubs`
doctor check ranks existing junk-named entity pages by links; the gate strips
the punctuation the slugifier drops, `isJunkEntitySlug` re-checks the resolved
slug at every write site, and all-caps acronyms (`US`, `IT`) are not junk. R5
(1.147.0): every action in `ci.yml` is SHA-pinned; advisory
`supply-chain.yml` (gitleaks over the pushed commit range with a per-commit
fixture allowlist in `.gitleaks.toml`, actionlint) and `deps-audit.yml` (`bun
audit` + OSV on `bun.lock` changes, weekly, manual), every job
`continue-on-error`, scanner binaries checksum-verified;
`tests/test_workflows.py` holds the shape. The full history scans clean with
that allowlist. Push runs never share a concurrency group, so no pushed range
is cancelled unscanned, and a weekly scheduled run rescans the full history.
Open: facts
derived by reconcile/consolidate inherit already-scanned text and are not
rescanned; no scrub of rows stored before (`page_versions` history); the
operator-only `quarantine_list` MCP op and literal directives (`# name=`,
`# applies_to=`), merging or deleting existing junk hubs.

### RM-06 — Measurement program: public benchmark, judged answers, eval governance

**Why.** Retrieval quality was first measured on 2026-08-12 (hit@5 86.1%) on a
small hand-curated set (`tests/eval/qrels.json`); the eval-probe baseline is
hit rate 0.889 / MRR 0.611. A small in-house set cannot catch a fusion
regression that only shows on long, multi-session haystacks, RM-11's ranking
changes need receipts, and the synthesis layer (think, takes, synthesis) has no
answer-quality number at all. Capture rows carry no source axis under per-grant
tenancy (`src/core/migrations/011_eval_candidates.sql`).

**Scope.**

- Retrieval lane: `memex eval longmemeval` — haystack sessions become pages on
  a throwaway PGLite or a disposable RDS schema, per-question reset via
  `src/core/bench/reset.ts`, strict `recall_all@k` and `recall_any@k` on raw
  session ids with slug-collision detection, abstention excluded, per-type
  buckets and floors, a run-config hash, dataset checksum pin, resume with
  recompute and last-wins compaction, a memex-generated seed-42 split and dev
  slice.
- Answer lane: memex-authored reader and judge prompts, temperature 0,
  `judge_error` distinct from incorrect, fail-closed budget with
  `--max-usd --yes`, seeded percentile bootstrap intervals; the judge runs on
  Bedrock Claude only and the report states that it differs from the public
  protocol's judge, so numbers are not directly comparable.
- Cost and diagnostics: content-addressed embedding cache (bun:sqlite, model +
  dims + text hash, dims integrity check); pool capture and a per-arm miss
  classifier (vector/keyword/title/relational rank, fused rank, post-rerank
  rank, final rank) on `hybridSearch`'s capture hook; a ledger across suites
  with paired bootstrap and Bonferroni in `eval compare`; a cumulative eval
  spend reservation against `mcp_spend_log`; a metric glossary in JSON outputs;
  nDCG/P@k in `eval` reports; the deterministic embedder moved from tests to a
  CLI canary.
- Governance: bench corpus sealed-gold loader with `fixtures_hash` and a
  holdout slice; a seeded corpus generator for push/continuity fixtures
  covering the known blind spots (all-lowercase mentions, `Did/Can/Will <Name>`);
  capture hardening — `source_id` on capture rows, a failures table with closed
  reasons, capture for `volunteer_context`, a doctor capture-health check;
  replay of exported NDJSON traffic with latency delta; named-thing retrieval
  families as a live-brain CLI; the nightly probe gains an optional benchmark
  slice.
- Files: new `src/eval/longmemeval/*`, `src/commands/eval.ts`,
  `eval-compare.ts`, `eval-replay.ts`, `eval-probe.ts`, `src/core/eval-capture.ts`,
  `search/hybrid.ts` (capture fields), `search/metrics.ts`,
  `bench/fixtures.ts`, `bench/reset.ts`, `bench/scoreboard.ts`, `budget.ts`,
  `src/commands/doctor.ts`, `tests/det-embed.ts` (moved), a capture/failures
  migration, `deploy/systemd/memex-eval-probe.*`.

**Depends on.** Nothing hard; soft on RM-04 for the eval reservation.

**Risks.** Paid runs: a retrieval-only run embeds tens of millions of haystack
tokens (order of a dollar at `EMBEDDING_PRICING` $0.02/1M before caching) and
the judged lane costs materially more — run locally or on a disposable
environment, never on the t4g.medium host; dataset licence and size must be
checked before committing any derived file; a Claude-only judge weakens
comparability and must be disclosed.

**Done when.** A committed, reproducible baseline receipt (strict
`recall_all@5` per type, run-config hash, dataset checksum) for the `default`
and `balanced` bundles; a second run with the embed cache shows near-zero
embedding spend and identical metrics; a mutation (broken RRF weights) moves
the metric beyond the bootstrap interval; a judged-lane receipt with CI and
`judge_error` count; capture rows carry `source_id` and the doctor check fires
on a forced capture failure.

**Needs operator go.** The benchmark lanes and their spend (recorded as
deferred/ask).

**Progress.** Slice 1, noise-aware metrics on the existing harnesses, is
done. A seeded percentile bootstrap and a paired-delta bootstrap
(`src/core/search/bootstrap.ts`) put 95% intervals on `eval`, `eval
run-all/gate`, `eval-replay run` (`significantDrop`), `eval-probe`, the
`eval_snapshots.detail` JSON and doctor's eval-trend line. `eval` reports
nDCG@k and P@k. Records and gate baselines carry a run-config hash, the qrels
sha256 and per-query scores, and the JSON outputs carry a metric glossary.
The run-config hash is taken over the resolved knobs (`resolveSearchKnobs`,
the ranking `MEMEX_*` env knobs, the embedding signature), so it tracks env
and mode defaults; the corpus is still not covered. The `eval gate` verdict
is unchanged; `eval-replay run` now takes its deltas over the paired
(baselined) queries only, matching the interval, so a capture newer than the
last promote cannot fail it. Done-when "a mutation (broken RRF weights) moves
the metric beyond the bootstrap interval" is proven on the real
`reciprocalRankFusion` over a hermetic PGLite corpus
(`tests/eval_mutation_bootstrap.test.ts`). Because `rrf.ts` treats a
non-positive weight as 1, the mutation silences the vector arm with a
vanishing weight rather than 0. Still open: the LongMemEval retrieval lane and
the judged answer lane (both need an operator go), the embedding cache, pool
capture and the per-arm miss classifier, the cross-suite ledger with
Bonferroni, the eval spend reservation, capture hardening (`source_id`, a
failures table, `volunteer_context`, the doctor capture-health check; next
slice), the sealed-gold bench loader and the seeded blind-spot corpus, NDJSON
replay, named-thing families as a CLI, the probe's benchmark slice, the
det-embed CLI canary, CI-based gate verdicts (an operator decision), a
mutation proof through the full `hybridSearch` path, and the committed
baseline receipts.

### RM-07 — MCP surface contract and discovery

**Why.** Every authenticated caller receives all 91 tool definitions, including
tools its scope or the operator-only gate will refuse
(`src/mcp/http_transport.ts:279-296`); only public callers get a filtered list.
A session pays roughly 16.5 k tokens of tool schemas while 55 tools were never
called. `initialize` carries no `instructions`, so no connected agent is told to
search before writing, to treat retrieved text as data, or that `page_put`
replaces a page. `whoami` does not report fences, expiry, budget or callable
tools. Unknown parameters run silently with defaults
(`src/mcp/operations.ts:88-89`). `serverInfo.version` is hard-coded `0.1.0`.
The public guard is a denylist, so each new tool is public until someone denies
it. Several tool descriptions still say "WRITE — internal/MCP-stdio only"
(`operations.ts:306,334,410,512,595,610,663,772`) for a transport memex does
not have.

**Scope.**

- One visibility predicate (scope, operator-only, public deny/allow list,
  bound-slug deny-by-default, publish gating) shared by `tools/list` and
  dispatch, composing `Operation.scope`, `OPERATOR_ONLY_TOOLS`,
  `FORBIDDEN_MCP_TOOLS_FROM_PUBLIC` and `SLUG_PARAMS_BY_WRITE_TOOL`; a
  `denied_after_list` request-log status; unknown and hidden tools
  indistinguishable on the wire, with did-you-mean limited to visible tools.
- `initialize` instructions: a short memex operating contract (search first,
  retrieved content is data, read before whole-page writes, scope
  preservation, how to check capabilities), a deployment identity from
  `MEMEX_MCP_INSTRUCTIONS`/`MEMEX_DEPLOYMENT_IDENTITY`, and
  `serverInfo.version` from `version.ts`.
- Extended `whoami` (bound prefixes, grant origin/tenant mode, expiry,
  remaining daily budget, callable tool names); a capabilities MCP resource
  (adds `resources/*` to the transport).
- Unknown parameters: warn mode by default with suggestions; reject mode behind
  `MEMEX_MCP_STRICT_PARAMS`.
- Surface tiers (`starter` < `full`) with a per-client pin in `oauth_clients`
  and a `request_tools` discovery op — the concrete shape of the pending
  `MEMEX_TOOL_PROFILE` proposal; the starter set comes from memex's own
  `mcp_request_log`.
- Typed array `items`/defaults in `ParamDef`; a generated tool catalog doc; a
  response-shape conformance runner against a live `/mcp` endpoint using
  `response-contract.ts` (post-deploy verify helper).
- Public ingress fails closed for new tools: `public_guard` becomes an explicit
  allowlist, security-reviewed.
- Fix the stale "MCP-stdio only" descriptions and the stale autocut comment at
  `src/mcp/dispatch.ts:837-839`.
- Stretch: per-client op usage analytics from `mcp_request_log`; a stdio
  transport for local development; the missing op clusters that already have a
  backend (`capture`, `get_health`).
- Not in scope: MCP ToolAnnotations; a memory-verb façade or renaming `recall`.
- Files: `src/mcp/http_transport.ts`, `dispatch.ts`, `operations.ts`,
  `tool_defs.ts`, `response-contract.ts`, `request-log-db.ts`,
  `src/http/public_guard.ts`, `src/core/scope.ts`, `identity.ts`,
  `oauth-provider.ts` (surface pin column), `src/version.ts`,
  `tests/fixtures/tool_defs.snapshot.json`, `tests/mcp.test.ts`,
  `docs/CONFIGURATION.md`.

**Depends on.** RM-01 (the list predicate reuses the isolation dispositions).

**Risks.** Hiding tools a client relied on seeing (the operator's own clients)
— ship behind a flag and verify with the operator PAT and the claude.ai
connector; the allowlist flip changes public-ingress behaviour
(`security-engineer` review); warn-mode params can mask client bugs until
reject mode is on.

**Done when.** For every scope/fence/public combination, `tools/list` equals the
set of tools whose `tools/call` is not refused (property test over all 91 ops);
`initialize` returns instructions and the stamped version on the live host;
`whoami` for a grant token lists exactly its callable tools; the conformance
runner passes against the live endpoint in the ship verify step; adding a dummy
tool without a public classification fails a test.

**Needs operator go.** The starter tool set.

**Progress.** Slice 1 shipped: `initialize` returns `instructions` (the memex
operating contract, plus optional `MEMEX_DEPLOYMENT_IDENTITY` and
`MEMEX_MCP_INSTRUCTIONS`, each capped at 2000 characters) and
`serverInfo.version` from `src/version.ts` instead of `0.1.0`; the fifteen
"MCP-stdio only" descriptions now state the real gate, a contract test keeps
the phrase out, and the stale autocut comment in `dispatch.ts` is corrected. No
tool was added, hidden or reclassified. v1.158.0: every tool carries MCP
`annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
`openWorldHint: false`) derived from its scope, although the scope above left
annotations out; `initialize` negotiates 2025-03-26, 2025-06-18 or 2025-11-25
and a wrong `MCP-Protocol-Version` header is a 400; an `insufficient_scope`
refusal carries the step-up challenge in `_meta`. Visibility predicate DONE
(v1.160.0): `src/mcp/visibility.ts` is the one check behind `tools/list` and
dispatch (ingress walls plus scope, operator-only, fail-closed write gate and
slug binding), and `tests/tools_list_visibility.test.ts` asserts that
`tools/list` equals the callable set for each caller shape. Still open:
`denied_after_list`, indistinguishable unknown/hidden errors with did-you-mean
limited to visible tools, the public-guard allowlist flip, extended `whoami`, the capabilities resource,
unknown-parameter warn/reject modes, surface tiers with `request_tools`, typed
array params with a generated catalog and the live conformance runner, and the
stretch items. The live check of the stamped version and instructions waits on
the next deploy.

### RM-08 — Durable job runtime v2

**Why.** The queue is a solid `SKIP LOCKED` core, but DAG fan-in is not wired
(`writeChildDoneInbox` has no caller outside `src/core/jobs/dag.ts`), cancel
does not reach running descendants, writes are gated on status only with no
claim generation, the lock is a fixed 300 s with one extension, a timed-out
handler keeps running and mutating state (`src/core/jobs/worker.ts:830-840`),
`jobs_submit` accepts any kind string (`src/mcp/dispatch.ts:2414-2437`), the
idempotency key is not tenant-scoped (`dag.ts:151`), there is no admission
control, and the worker runs in serve with concurrency 1 and 5 s polling. The
agent loop, synthesis, per-source cycles and remediation all need fan-out that
survives crashes and deploys, and `deploy/skills/minion-orchestrator/SKILL.md`
already promises it.

**Scope.**

- Claim generation / lock token fencing every terminal write; `delayed`,
  `waiting_children`, `paused` statuses; `UnrecoverableError`; jittered
  backoff; pause/resume/replay with data overrides; kind validated against the
  handler registry at submit; tenant-scoped idempotency keys.
- DAG fan-in: terminal transitions write the child-done inbox in the same
  transaction, parents park in `waiting_children` and wake, `on_child_fail`
  policy, `max_children`, cascade cancel to running descendants via abort;
  align FK delete behaviour and close the inbox-during-cancel race.
- Lock renewal tick with verify-before-evict (fenced re-check before aborting),
  reclaim grace, per-kind lock/timeout defaults (`chronicle_extract`,
  `ingest_capture`, `remediation`, `page_mirror`, future `subagent`),
  AbortSignal and deadline in the handler context.
- Admission control: parentless duplicate submits coalesce onto the waiting job
  (stable-stringified params hash), waiting TTL, per-kind waiting quota
  returning retryable `rate_limited`, single-flight per-source dispatch.
- Worker runtime: a real concurrency pool, RSS watchdog, DB liveness probe
  distinguishing pool starvation from outage, reconnect-before-claim, graceful
  drain on deploy; a shared drain registry for fire-and-forget sinks.
- Queue stats: per-kind throughput, oldest waiting, a wedge/divergence verdict,
  an operator-only `get_job_stats` op and the admin jobs page.
- Stretch: job attachments table; per-job quiet-hours policy with deterministic
  stagger; an operator-only `shell` kind behind `MEMEX_ALLOW_SHELL_JOBS`
  (default off) — or the shell promise removed from the skill in RM-09.
- Files: `src/core/jobs/queue.ts`, `dag.ts`, `worker.ts`, `worker-lock.ts`,
  `backoff.ts`, `handlers.ts`, `lifecycle.ts`, `quiet-hours.ts`, `types.ts`,
  `concurrency.ts`, `context/volunteer-events.ts`, `last-retrieved.ts`,
  `search/telemetry.ts`, `src/commands/jobs.ts`, `serve.ts`,
  `src/mcp/operations.ts`, `dispatch.ts`, `src/http/admin-api.ts`,
  `admin/src/pages/JobsWatch.tsx`, migrations (statuses, generation,
  attachments).

**Depends on.** RM-03 (abort helpers, cancellable queries, Postgres lane for
contention tests).

**Risks.** A status migration on a live queue — pause ingress and drain before
migrating; fencing bugs can orphan jobs; concurrency above 1 in serve competes
with MCP latency on a t4g.medium (default stays 1, measured).

**Done when.** Postgres-lane tests: a stalled attempt cannot complete a job
re-claimed by a newer attempt; a parent with 5 children wakes exactly once with
5 inbox rows after a SIGKILL mid-run; cancel reaches running children within one
renewal tick; 50 identical submits create one waiting job; a CPU-starved worker
does not evict its own healthy job; `get_job_stats` flags a seeded wedge;
submitting an unknown kind is refused.

**Progress.** R1 (1.147.0): attempt fencing and submit-side kind
validation. Migration 109 adds `jobs.claim_generation`; every claim bumps it,
and complete/fail/extendLock/updateProgress/recordUsage match the attempt's
generation as well as `status='running'`, so a stalled or timed-out attempt
whose row was re-claimed cannot finish, fail or write progress/usage onto the
newer attempt (the worker counts those as `fenced` and logs "claim lost").
`jobs_submit` and `memex jobs submit` (sharing `isKnownJobKind` in
`handlers.ts`) refuse a kind that is neither built in
(`BUILTIN_JOB_KINDS`) nor registered; `jobs_get`/`jobs_list` show
`claim_generation`. Both "Done when" items are proven on PGLite
(`tests/jobs_fencing.test.ts`, `tests/jobs_submit_kind.test.ts`,
`tests/jobs_lifecycle.test.ts`, `tests/jobs_cli_lifecycle.test.ts`); the Postgres-lane repeat waits on RM-03's
`make test-pg`. Still open: `delayed`/`waiting_children`/`paused` statuses,
`UnrecoverableError`, jittered backoff, pause/resume/replay; DAG fan-in in
the terminal transaction; cascade cancel via abort; the renewal tick with
verify-before-evict; admission control; tenant-scoped idempotency keys; the
concurrency pool and worker runtime; `get_job_stats` and the admin page.

### RM-09 — Skill pack integrity and library currency

**Why.** The brain serves its skill pack to every connected agent
(`src/core/skillpack/brain-resident.ts`), and agents follow it literally.
Shipped skills tell agents to run commands memex does not have: `memex skillpack check`
(`deploy/skills/skillpack-check/SKILL.md:5,30,51`), `memex skillpack harvest`/`scaffold`
(`deploy/skills/skillpack-harvest/SKILL.md:33`), a skill optimizer
(`deploy/skills/skill-optimizer/SKILL.md`), schema-pack authoring
(`deploy/skills/schema-author/`, `schema-unify/`), shell jobs and subagent
spawning (`deploy/skills/minion-orchestrator/SKILL.md:13-15,71`). The
`list_brain_skillpack` description points at a command that only builds a
tarball (`src/mcp/operations.ts:971`). `skillify check` validates `title`/`tags`
while the pack uses `name`/`triggers`/`tools` (`src/core/skillify.ts:330-380`);
47 skills declare `tools:` that nothing checks. `get_skill` returns raw bodies
with no size cap. Doctor has no skill category
(`src/core/doctor-categories.ts:15-16`).

**Scope.**

- One skill frontmatter parser (`name`, `description`, `triggers`, `tools`,
  `mutating`, `requires`, `writes_to`) used by listing, `get_skill`,
  `skillify check` and doctor.
- Pack honesty: a tools-vs-ops lint against `operations.ts` and a
  command-reference lint against `cli.ts`, both test gates; every dead reference
  implemented elsewhere in this roadmap or removed/rewritten now; `skillify`
  emits the `<slug>/SKILL.md` layout with a routing-eval file.
- A brain-first lint rule: each skill consults the brain before external
  lookups.
- Integrity: a sha256 lockfile for `deploy/skills` with a freshness test
  (modified/missing/extra) and a doctor `skills` category (manifest integrity,
  conformance, `requires:` preconditions evaluated read-only against sources,
  pages and runtime config) — deliberately reversing the
  `doctor-categories.ts` comment.
- Catalog hardening: byte cap on `get_skill`, allowlisted frontmatter fields,
  optional section filter, `tools` filtered to existing ops, realpath
  confinement of the mounted directory (`MEMEX_SKILLS_DIR`, read-only).
- `memex skillpack check` as a tri-state wrapper over doctor + pending
  migrations, or the skill rewritten to call `run_doctor`.
- Library currency: memex-authored behavioural skills worth having
  (data-loss gate, fact-check, correction pipeline, resolve-before-asking,
  measure-before-you-fix, brain-ingest gate) and four conventions (untrusted
  content, path discipline, regex discipline, exec-output discipline), using
  memex tool names and Bedrock tiers; deterministic helpers behind the
  data-research skill (tracker parse/append, fuzzy dedup with amount tolerance).
- A skill routing eval over trigger fixtures with negative cases.
- Files: `deploy/skills/**`, `src/core/skillpack/brain-resident.ts`,
  `src/core/skillify.ts`, `src/commands/skillify.ts`, `skillpack.ts`,
  `src/cli.ts`, `src/mcp/operations.ts`, `dispatch.ts` (`callGetSkill`),
  `src/commands/doctor.ts`, `doctor-categories.ts`, new
  `tests/skillpack_*.test.ts`.

**Depends on.** Nothing; soft on RM-07 for the generated catalog.

**Risks.** Removing promises agents already rely on; new skill prose must pass
`make scrub-audit` like any other tracked text.

**Done when.** The lint fails when a skill names a non-existent tool or CLI
command and passes on the whole pack; the lockfile test detects a one-byte
change; `get_skill` refuses a body over the cap; doctor shows a `skills`
category on the live host; the routing eval passes with negative cases.

**Progress.** R1 (1.152.0): pack honesty. One frontmatter parser
(`src/core/skillpack/frontmatter.ts`) now backs the listing, `get_skill` and
`skillify check`; `src/core/skillpack/lint.ts` checks every `tools:` entry
against OPERATIONS and every `memex <cmd> [<sub>]` in code spans and fenced
blocks against `src/cli-commands.ts` (a drift test pins that table to
cli.ts's switch); `memex skillpack lint [--json] [--dir PATH]` runs it on the
mounted pack. The real-pack gate (`tests/skillpack_lint.test.ts`) is green on
50 skills: `skillpack-check` rewritten around `run_doctor`/`memex doctor`,
`minion-orchestrator` without the shell lane, `schema-author` on
`memex page-retype`, `skillify` without `eval cross-modal`, and
`skill-optimizer`, `skillpack-harvest`, `schema-unify` removed (the last
submitted a `unify-types` job kind that was never registered).
`list_brain_skillpack` no longer promises installation. `memex skillify`
now drafts the pack contract (`name`, `description`, `triggers`, known
`tools` only) through the same parser, and a test lints its output with
`lintSkillpack`; the parser reads column-0 `- item` lists, so such a
`tools:` list is checked instead of passing empty. "Done when" item 1 is
met. Still open: the lockfile, the doctor `skills` category, `get_skill`
hardening (byte cap, field allowlist, section filter, realpath confinement),
a `memex skillpack check` wrapper, `skillify` emitting `<slug>/SKILL.md`
with a routing-eval file, the brain-first rule, the routing eval, library
currency, and a lint rule for `jobs_submit` kinds (today only prose review
caught `unify-types`/`retype-backfill`).

### RM-10 — Grants, access profiles and the admin grant editor

**Why.** Rescoping a client is one blind UPDATE of source, federated read,
prefixes and tenant mode with no revision, no dry-run, no audit trail, and
scopes cannot be rescoped at all (`src/core/oauth-provider.ts:574-607`,
`src/http/admin-api.ts:423-464`). On a team connector the operator cannot answer
"who widened this grant and when". Composing scopes by hand per client invites
over-grant; no admin-scoped token can act as operator; three scopes are dead
(`agent`, `sources_admin`, `users_admin` in `src/core/scope.ts`);
authorization-code and refresh tokens ignore per-client TTL
(`oauth-provider.ts:925`, `:980`); legacy PATs never expire and expired OAuth
tokens are swept only at boot; CLI and admin revocation differ; client secret
hashes are compared with `!==` (`oauth-provider.ts:1179`, `:1205`). The admin
SPA lags the CLI: no enrollment codes, tenant mode, bound prefixes or budgets.

**Scope.**

- Grant mutation service: revision counter, `SELECT … FOR UPDATE` with an
  expected revision (`grant_conflict`), dry-run with before/after diff,
  validation reason codes (unknown/archived sources; prefix grammar requiring
  lowercase and a trailing `/` or `/*`, no `..`), full rescope including scopes,
  and one CTE writing an `oauth_grant_audit` row (actor, before, after, via)
  from CLI, admin API and enrollment paths.
- Named profiles (memory-reader, memory-writer, coding-agent, operator, full)
  resolving scopes, surface pin (RM-07), TTL defaults and a frozen
  `allowed_operations` snapshot enforced by the RM-07 visibility predicate; an
  explicit operator profile so an admin-scoped token can reach operator-only
  tools by grant; wire the dead scopes or remove them.
- Token lifecycle: per-client TTL on authorization-code and refresh issuance, a
  DCR TTL window clamp, expiring PATs with a TTL column, a periodic expired-token
  sweep, revoke PAT by id, least-privilege PAT mint requiring scopes and a
  source grant, unified client revocation, verification rejecting deleted
  clients.
- Consent re-check: a policy digest captured at `/authorize`; redemption and
  refresh intersect with the current grant.
- A shared constant-time comparison module for every secret/hash compare.
- Admin SPA grant editor: dry-run preview, revision-checked save, enrollment
  code issue/list/revoke, tenant mode, prefixes, per-grant budget (RM-04
  fields), consent page with explicit deny.
- Advisor collector proposing least-privilege rescopes from 30-day
  `mcp_request_log` usage (aggregate-only for tenants).
- Files: `src/core/oauth-provider.ts`, `scope.ts`, `auth-info.ts`,
  `src/http/oauth-endpoints.ts`, `admin.ts`, `admin-api.ts`,
  `src/commands/auth.ts`, `src/cli-args.ts`, `src/mcp/dispatch.ts` (operator
  gate), `advisor/collectors.ts`, `admin/src/pages/Credentials.tsx`,
  `admin/src/App.tsx`, `admin/src/api.ts`, migrations (revision, audit, PAT TTL,
  profile snapshot). Every field maps to the per-grant model (token-level
  `source_id`/`grant_bound`, enrollment rows, `tenant_mode`,
  `bound_slug_prefixes`, `budget_usd_per_day`).

**Depends on.** RM-01, RM-07.

**Risks.** Authentication/authorization change with a large blast radius —
state it and confirm first, `security-engineer` review, live two-tenant smoke;
moving existing clients to profiles must be additive (`NULL` = legacy
behaviour).

**Done when.** Concurrent rescopes: the stale one fails with `grant_conflict`
and writes no audit row; dry-run output equals the subsequent apply's audit
diff; a client narrowed between `/authorize` and redemption receives the
narrowed scopes; a revoked or deleted client's tokens fail verification
immediately; the admin editor works end to end on a two-tenant local install; a
timing-safe compare test exists.

**Progress.** Release 1 shipped the grant mutation service
(`OAuthProvider.rescopeClient`, migration 110): `grant_revision` plus
`SELECT … FOR UPDATE`, an optional expected revision failing closed with
`grant_conflict`, a dry run returning the before/after diff, collected reason
codes (`unknown_source`, `empty_read_set`, `invalid_prefix`), and one CTE that
bumps the revision and writes the `oauth_grant_audit` row (actor, via, before,
after). The CLI (`auth rescope-client --expected-revision/--dry-run`,
`auth grant-history`) and the admin API (`POST /admin/api/rescope-client`,
`GET /admin/api/grant-audit`) both go through it, for source, read set, prefix
fence and tenant mode. The audit snapshots bind through `::text::jsonb` (a
bare `::jsonb` stored them as string scalars on Postgres), and a source-level
test pins the `FOR UPDATE` on the revision read, since PGLite serializes
transactions and cannot prove the lock; a Postgres-backed concurrency test is
still missing. Still open: rescoping scopes (and the dead `agent` /
`sources_admin` / `users_admin` scopes), named profiles and the
`allowed_operations` snapshot, routing enrollment redemption and
register-client through the service (`via='enrollment'`), the stricter prefix
grammar and an archived-source reason.

Lifecycle parts shipped since: `auth revoke-grant` revokes one redeemed
enrollment and deletes that grant's tokens and codes (v1.155.0); per-client
access and refresh TTLs (`--access-ttl`, `--refresh-ttl`, migration 117),
`auth invalidate-tokens [--grant]`, a code refused at `/token` after a rescope
(the code records `grant_revision`), `grant_types` enforced, and optional
`--source`/`--federated-read`/`--scopes` on PAT mint (v1.157.0); enrollment
codes and member grants issued, listed and revoked from the admin API and a
Members panel, `enroll --replaces`, `auth set-redirect-uris`, the
`oauth_enrollment_audit` trail (migration 118), and `revoke-client` revoking
instead of deleting (v1.158.0). Still open: rescoping scopes and the dead
scopes, profiles, the DCR TTL clamp, PAT TTL/expiry, a periodic expired-token
sweep, revoke PAT by id, a mint that requires scopes and a source, a consent
re-check that intersects redemption and refresh with the current grant, the
constant-time compare module, the admin grant editor (dry-run, revision-checked
save, tenant mode, prefixes, budgets), and the advisor collector.

### RM-11 — Retrieval pipeline v2 (honest degradation, fusion hygiene, confidence)

**Why.** An agent cannot tell "the brain has nothing" from "the Bedrock embed
timed out and you got keyword-only results": `hybridSearch` returns bare hits
(`src/core/search/hybrid.ts:593-597`) and silently falls back (`:788-794`). The
keyword arm is AND-only (`keyword.ts:98-112`), so long natural-language
questions return zero lexical rows exactly when the vector arm is down.
Expansion variants never reach the vector arm and fusion weights are positional
(`hybrid.ts:851-871`). Every metadata boost runs regardless of which arms voted
(`hybrid.ts:1096-1281`), so hubs can outrank the real answer on paraphrase
queries. Rerank can bury the typed-edge rows that answer relational questions.
A slug-shaped query is not guaranteed its page at rank 1; superseded pages
outrank their replacements. Agent and think loops burn context on full chunks.

**Scope.**

- `SearchMeta` returned with hits: vector enabled, intent, mode, `degraded[]`
  with a closed vocabulary (`embed_timeout`, `vector_arm_failed`,
  `keyword_zero`, `expansion_failed`, `budget_truncated`, `rerank_skipped`),
  retrieved count, pool underfill; degraded result sets cached with a short TTL
  instead of skipped; surfaced in `search`/`query` MCP responses under public
  redaction rules and in the CLI empty-result message.
- AND→OR relaxed keyword retry on zero rows (bounded terms/length); relaxed rows
  tagged and dropped before fusion whenever the vector arm returned rows.
- Fusion lists composed in one place with role tags (original, variant,
  clause); each expansion variant embedded (via `embedQueryBounded` and
  `trackedInvoke`) and vector-searched under one deadline with salvage; a shared
  variant weight budget; a pre-fusion pool floor `max(k*2, 50, offset+k)`.
- Keyword-arm confidence (scores from `keywordSearch`/`titleArmChunkIds`) and a
  metadata-boost gate that skips backlink/salience/recency/graph/alias boosts
  when no lexical, title or relational row fused; decisions stamped in
  `--explain`.
- Exact-lookup tier (slug-shaped or exact title → rank 1, at most 3,
  supersession-filtered); supersede downrank from `supersedes` links with a
  memoized existence probe; a relational evidence slot plus a rerank pin as a
  permutation over ranked ids.
- Zero-LLM retrieval confidence grade (strong/moderate/weak) derived from the
  `Evidence` enum and arm membership (the Haiku reorder produces order, not a
  calibrated score), attached to `query`; opt-in escalation to the expensive
  bundle for weak results only, operator-gated like `mode`.
- Per-hit snippet cap with a `page_get` pointer; `types` and per-call
  `source_id` filters pushed into arm SQL (`filters.ts`).
- Stretch: CJK density detection with a bounded ILIKE/bigram keyword fallback,
  a Latin stroke-letter fold (keeping `'simple'` FTS), CJK-aware recursive chunk
  delimiters and overlap; per-brain intent pattern extensions in runtime config
  folded into `rankingSignature()`; knob attribution across
  per-call/env/runtime-config/bundle in `search modes`; `search_stats`,
  `search_modes`, `cache_stats` as operator-only MCP ops.
- Files: `src/core/search/hybrid.ts`, `keyword.ts`, `vector.ts`, `title-arm.ts`,
  `expansion.ts`, `intent-weights.ts`, `src/core/rrf.ts`, `relational-recall.ts`,
  `two-pass.ts`, `graph-rerank.ts`, `evidence.ts`, `explain.ts`,
  `query-cache.ts` (signature suffix bumps), `mode.ts`, `filters.ts`,
  `query-intent.ts`, `telemetry.ts`, `src/core/chunkers/recursive.ts`,
  `src/mcp/operations.ts`, `dispatch.ts`, `src/core/public_redaction.ts`,
  `src/commands/search.ts`, `search-modes.ts`, `search-diagnose.ts`,
  `tests/retrieval_quality_*.test.ts`.

**Depends on.** RM-01 (read policy), RM-06 (baseline receipt before any ranking
change).

**Risks.** Live ranking changes on the operator's brain — each stage behind a
knob, measured against the RM-06 receipt and the eval-probe baseline, one stage
per release; meta fields on public ingress can become an existence oracle
(redact counts, keep closed reason codes); CJK ILIKE scans must be bounded on
RDS.

**Done when.** Each stage has a paired benchmark + hermetic-suite result with no
regression beyond the bootstrap interval and the targeted improvement where
claimed; a forced embed failure yields `degraded:["embed_timeout"]` and a 60 s
cache entry; a slug query returns the page at rank 1 against a stronger body
match elsewhere; a relational fixture keeps the edge answer in the top 3 with
rerank on; `weak` fires on a no-answer fixture and `strong` on an exact match.

**Progress.** Release 1 (honest degradation, no ranking change):
`core/search/search-meta.ts` defines `SearchMeta` and the closed six-code
vocabulary; `hybridSearch` reports it through an `onMeta` side channel and
emits `embed_timeout` (a `QueryEmbedDeadlineError` or the deadline's abort),
`vector_arm_failed`, `keyword_zero` and `budget_truncated`. `search`/`query`
return `meta`; only the operator gets the full block. Public callers and OAuth
tenants get `vectorEnabled` plus the corpus-independent codes (`embed_timeout`,
`vector_arm_failed`), keyed on the caller rather than on body redaction:
counts, `keyword_zero` and `budget_truncated` are computed before the page and
diary fences, so they would confirm fenced matches (real-Storage test in
`tests/search_meta_fences.test.ts`); `memex search`
prints it and explains an empty result on stderr. Degraded runs are still
never cached, so a cache hit reports `vectorEnabled:true`. Still open:
emitting `expansion_failed`/`rerank_skipped` (the expander and rerankers fail
open internally), the 60 s degraded cache entry (needs a `query_cache`
migration), meta on the `query` `refine` path, pool underfill, AND→OR relaxed
retry, fusion roles/variants and the pool floor, keyword confidence and the
boost gate, the exact-lookup tier, supersede downrank and rerank pin, the
confidence grade, snippet cap, filter pushdown, degraded counts in telemetry,
`search_stats`/`search_modes`/`cache_stats` ops, the CJK stretch, and
recomputing `keyword_zero`/counts after the fences so tenants can get them.

### RM-12 — Ambient recall and session context

**Why.** The brain helps an agent most when context arrives without the agent
remembering to ask. memex has `volunteer_context`
(`src/core/context/volunteer.ts`), `chronicle_since` and a `hot_memory` table,
but `hot_memory` is never written in production and its `_meta` injection reads
that empty table with no tenant axis (`src/core/hot-memory-meta.ts`); there is
no per-session cursor, no budgeted "what matters now" pack, no "what changed
since my last turn" delta, no gate that turns salient user statements into
facts, no client hook, and the reflex resolver misses lowercase, surname-only
and CJK mentions (`src/core/context/reflex.ts:38-49`).

**Scope.**

- New read-only tools over existing memex reads: `context_pack` (entity cards
  for up to 8 standing entities + open threads + top decayed facts, trimmed to a
  token budget, cards before facts) and `context_delta` (pages, facts and thread
  changes since a timestamp or a per-session cursor, at-least-once delivery);
  both public-forbidden, grant-scoped, tested for identical REST/MCP redaction.
  Not a façade over write tools and not a rename of `recall`.
- `session_context_state` table keyed by (source_id, client/grant, session_id)
  holding cursor, surfaced slugs (volunteering stops repeating within a
  session) and standing entities; GC bounded per client.
- `_meta` hot facts computed from `entity_facts` through `effectiveConfidence`,
  keyed by (source, session, holder allow-list), short TTL clamped by
  `valid_until`, bounded cache; keep the public-ingress decay-off guard; wire
  `recordHotFact` or retire the `hot_memory` table.
- Zero-LLM writeback gate (too short, ack/greeting, slash command,
  question-only, quoted tool output, bulk paste, content-hash idempotency)
  feeding `add_fact`/`extract_facts` with the grant's source; contract text
  delivered through RM-07 `initialize` instructions; off by default.
- Reflex precision arms: alias-only weak lowercase candidates, a surname arm
  when exactly one person page carries the surname, a CJK title arm; ambiguity
  injects nothing; kill switch.
- A thin client hook entry (Claude Code `SessionStart`, `UserPromptSubmit`,
  `PreCompact`, `Stop`) calling the remote `/mcp` with a PAT under a hard
  deadline, failing open, never touching a local brain.
- Stretch: compaction checkpoint harvest (hook spools the window; the server
  extracts facts through the durable queue with session provenance and a
  content-addressed segment ledger in `raw_data`); a compiled warm-context
  export as an operator-only op returning text; a DB-backed since-last-run
  cursor per token.
- Files: `src/core/context/volunteer.ts`, `reflex.ts`, `entity-salience.ts`,
  `volunteer-events.ts`, `chronicle-context.ts`, `hot-memory-meta.ts`,
  `hot_memory.ts`, `facts-decay.ts`, `facts.ts`, `facts-extract.ts`,
  `recall-budget.ts`, `chronicle.ts`, `src/mcp/operations.ts`, `dispatch.ts`,
  `src/http/public_guard.ts`, `src/core/public_redaction.ts`, new
  `scripts/hooks/*` (client side), a session-state migration.

**Depends on.** RM-01, RM-07.

**Risks.** New read tools are new oracle surfaces — public-forbidden and covered
by the RM-01 isolation matrix; ambient writeback on a shared brain can capture
private statements — off by default, consent recorded, per-grant switch; hook
latency on every prompt (hard deadline, fail open).

**Done when.** `context_pack` for a grant token holds no other tenant's bytes
(matrix test) and stays within budget; `context_delta` with one session id
never re-delivers a surfaced slug and never skips an update under concurrent
writes; `_meta` hot facts are non-empty for a tenant with facts; the gate corpus
(acks, pastes, questions vs real statements) meets the thresholds pinned in the
test; a hook round trip against a local serve stays under 1.5 s p95 and fails
open on timeout; the push bench blind spots (lowercase, `Did <Name>`) move from
expected-miss to hit.

**Needs operator go.** The reflex arms, if the 2026-07-07 "retrieval-reflex"
skip was meant to cover resolver arms rather than a host-side recipe.

**Progress.** Slice 1 shipped: the read-only `context_pack` tool
(`src/core/context/context-pack.ts`). It builds entity cards (title, type, top
5 facts, 3 recent events, no page body) for up to 8 standing entities, explicit
`slugs` first and then entities the volunteer resolver finds in `window` at
its default gate, followed by the top decayed facts across the grant minus the
card facts. The pack is trimmed to `token_budget` (200..8000), cards before
facts, and `budget` reports the dropped cards, facts, card facts and card
events. A missing, out-of-grant, soft-stub or diary-fenced slug gives the same
output. It is grant-scoped, floored to world-visible facts for any token
caller, public-forbidden and has a row in the RM-01 isolation matrix. No
migration, env knob, regex or LLM call. Still open: `context_delta` and the
`session_context_state` table (which will feed standing entities into the
pack), open threads (no thread model exists yet), the `_meta` hot facts
rewrite, the writeback gate, the reflex arms, the client hook and the stretch
items. The live check waits on the next deploy. A review fix applies one
diary fence (slug prefix and `diary`/`journal` page type) to all three
sections: brain facts on a fenced entity are dropped (the fact read widens so
`facts_limit` still fills), and a fenced page named in `window` no longer
takes an entity slot, so a token caller cannot tell it exists.

### RM-13 — Agent tool-loop runtime (Bedrock Converse)

**Why.** Every synthesis step is a single Haiku/Sonnet call
(`src/core/llm/haiku.ts`, `sonnet.ts`); there is no `toolConfig`/`toolUse`
anywhere in `src`. The durable ledger exists but nothing runs on it
(`src/core/subagent_ledger.ts`, migration 021), the `agent` scope is unused, and
`oauth_clients.bound_tools`/`bound_max_concurrent` are never read (migration
046). Multi-step tasks — enrich an entity from ten pages, reconcile a
contradiction, synthesize a transcript chunk with verified links — need a loop
that calls brain tools, survives a crash without re-running non-idempotent
tools, and spends under a cap.

**Scope.**

- Multi-turn Converse primitive in `src/core/llm/` (messages, system and tool
  cache points, `toolConfig`, tool-result pairing repair, stop reasons
  `max_tokens`/`guardrail_intervened`/`content_filtered`), spending through
  RM-04's per-attempt reservation.
- A `subagent` job kind that persists each assistant turn before dispatching
  tools, records pending tool rows bound to a worker/run id, replays completed
  turns on resume, short-circuits already-executed tools, and never re-executes
  a cross-worker pending row; service-minted tool ids; per-turn lease permits;
  heartbeats; ledger keyed by the existing `turn_num` schema.
- Brain-tool allowlist derived from `operations.ts` ParamDefs into Bedrock
  `toolSpec` (read tools + fenced writes into an agent namespace or the grant's
  prefixes, no graph-edge writes), dispatched through `dispatchTool` with the
  job's AuthInfo so every existing gate applies; a deterministic tool preamble.
- Oneshot synthesis mode: one structured completion validated all-or-nothing
  (slug grammar, allow-list, exact wikilinks, content-hash suffix) with a
  ledger-first write batch, falling back to the loop with a recorded reason.
- Fan-out aggregator over RM-08 fan-in with a deterministic summary;
  `memex agent run|logs` CLI and an operator-only MCP status op; transcript
  rendering from `subagent_messages`; subagent definitions as markdown in
  `MEMEX_AGENT_DEFINITIONS_DIR`.
- Error clustering into Bedrock buckets (throttling, input too long, malformed
  JSON, guardrail) and one classifier-gated self-fix resubmit within a depth
  cap.
- Not here: tenant delegation (RM-22). This item is operator/internal only;
  ledger content stays internal-token-only.
- Files: `src/core/llm/gateway.ts`, `sonnet.ts`, `haiku.ts`, new
  `src/core/agent/*`, `subagent_ledger.ts`, `jobs/handlers.ts`, `worker.ts`,
  `dag.ts`, `src/mcp/operations.ts`, `dispatch.ts`, `tool_defs.ts`, `scope.ts`,
  `budget.ts`, `src/commands/serve.ts`, `src/cli.ts`, new
  `src/commands/agent.ts`, a migration adjusting `021_subagent_ledger.sql`
  (worker binding, message index).

**Depends on.** RM-04, RM-08.

**Risks.** Stored command injection through forged pending rows (bind to
worker, internal-only); runaway spend (per-job and per-tree budgets, halt
cooldown); CPU/memory on the t4g.medium host (concurrency 1, RM-08 RSS
watchdog, no instance resize); agent writes stay in `synth_*`/agent namespaces
and never overwrite source notes.

**Done when.** A SIGKILL mid-loop resumes and completes without re-executing a
completed non-idempotent tool (ledger-row assertion); a fixture task runs end
to end on Bedrock under a $0.25 cap and books every call in `mcp_spend_log`;
oneshot validation rejects a hallucinated wikilink and falls back with a
reason; the allowlist excludes every public-forbidden write tool not explicitly
listed; `agent logs` renders a transcript; second-opinion and
`security-engineer` review before any deploy.

**Needs operator go.** Given 2026-09-19: the operator approved RM-13 and
RM-22 and lifted the "Not planned" mark on the server-side runtime. It stays
opt-in (`MEMEX_AGENT_ENABLED=1`) and spend-capped.

**Progress.** Release A (1.153.0, live) ships the read-only
loop: `src/core/llm/converse.ts` (multi-turn Converse with `toolConfig`,
tool-result pairing repair, booked through `trackedInvoke` as `agent`),
`src/core/agent/{tools,runner,handler}.ts`, the `subagent` job kind registered
only under `MEMEX_AGENT_ENABLED=1`, `memex agent run|logs`, and migration 114
binding each ledger tool row to its `tool_use_id` and claim generation. The
allowlist is ten read ops dispatched as the operator (`_meta` dropped, output
capped at 16 KB); it includes four content reads the public ingress forbids
(`get_chunks`, `get_links`, `get_tags`, `resolve_slugs`) and no write. The
per-job cap is min(payload, `MEMEX_AGENT_MAX_USD`, $0.25 default) seeded from
`jobs.cost_usd`; the reserve estimate is the previous call's reported tokens
plus one token per byte of what was appended since. Tests cover a resume after
a mid-tool kill (one ledger row per finished tool, zero re-dispatches), a
foreign pending row skipped, the budget seed, terminal stop reasons and the
turn cap. The loop checks its claim (a progress write fenced by claim
generation) before and after every Converse call and stops on a refusal, so a
timed-out or requeued attempt makes no further model call, runs no tool and
appends nothing; the handler refuses a `subagent` row without `timeout_ms`, so
the worker always extends the claim lock over the run. Done-when items met in code: SIGKILL resume, allowlist excluding
every public-forbidden write, `agent logs`. Still open: the live $0.25 Bedrock
fixture run plus `/codex` and `security-engineer` review before deploy; fenced
writes and oneshot synthesis (release B, with the hallucinated-wikilink item);
fan-out and per-tree budgets; an MCP status op; definitions in
`MEMEX_AGENT_DEFINITIONS_DIR`; error clustering and self-fix; cache points;
per-turn lease permits and heartbeats; charging in-tool paid calls (search
embeddings) to the job cap; the one-call under-count when a billed Converse
call is killed before `recordUsage`.

### RM-14 — Transcript and chat ingestion pipeline

**Why.** The operator's decisions and facts live in agent sessions and chat
histories, and memex captures almost none of them. The only chat path is an
offline script that writes files for a manual `memex index` and flattens a
ChatGPT `mapping` by sorting every node on timestamp, so regenerated and
abandoned branches are interleaved (`scripts/import-chat-history.ts:118-138`);
it has no size cap, format detection, secret redaction, splitting or idempotent
re-import. Long transcripts land as one `embed_skip` page invisible to vector
search (`src/core/content-sanity.ts:499-534`). Claude Code and Codex sessions
are never read. `get_recent_transcripts` does not list the importer's
`conversation` type (`src/core/transcripts-read.ts:19-24`).

**Scope.**

- A transcript adapter seam with per-file diagnostics (bytes read but zero
  sessions = format drift), ordered format detection with explicit override,
  size caps that reject rather than truncate.
- ChatGPT export adapter walking from `current_node` through parent pointers
  (drops regenerated branches, orphan-safe, latest-leaf fallback) and a
  Claude.ai export adapter; real source timestamps only; per-message ids.
- Claude Code JSONL and Codex rollout adapters (sidechain/summary/control
  records skipped, tool payloads and thinking replaced by placeholders,
  subagent logs not treated as sessions).
- Ingest pipeline as durable jobs: RM-05 secret redaction before render,
  anchor/fence escaping so content cannot forge speakers, split at message
  boundaries with overlap into `-pN` parts, per-session content-hash
  idempotency and stale-part deletion, `raw_data` sidecar, a `since` checkpoint
  in `recipe_state`, embedding through RM-02's jobs, per-grant write source;
  `memex transcripts ingest|status` CLI and an `/ingest` content type for pushed
  sessions.
- Client-side discovery and session-end capture for Claude Code/Codex pushing
  rendered sessions to `/ingest` with a PAT (harness roots live on the laptop,
  never on the EC2 host), confined to pinned roots with symlink rejection.
- One supervised source interface with backoff and queue dispatch, shared with
  RM-26 connectors instead of per-connector loops.
- Conversation parser breadth: Discord, Teams, Signal, Matrix, markdown-heading
  turns, ChatGPT "You/ChatGPT" copy-paste, chosen by whole-document scoring
  rather than first match per line; a frontmatter/effective-date context ladder;
  per-format fixture tests; every regex measured linear through
  `parseConversation`. No LLM parser fallback.
- Sweep hardening: a mass-delete safety valve in `reconcileDeletedDocuments`
  (refuse when most of a source would retire) and a persistent per-path failure
  ledger with auto-skip after repeated identical failures.
- Stretch: cross-slug identity dedup and volatile-frontmatter-insensitive
  content hashing in `putPage`; `tombstone` events and a bounded dedup window on
  `/ingest`; `get_recent_transcripts` type alignment.
- Files: new `src/core/transcripts/*`, `scripts/import-chat-history.ts`
  (retired or rewired), `conversation-parser.ts`, `src/http/ingest.ts`,
  `indexer.ts`, `pages.ts`, `raw-data.ts`, `recipe-state.ts`,
  `reconcile-deletes.ts`, `sweep.ts`, `ingest-log.ts`, `transcripts-read.ts`,
  `jobs/handlers.ts`, `src/cli.ts`, new `src/commands/transcripts.ts`,
  client-side scripts under `scripts/`, `tests/conversation_parser_*.test.ts`.

**Depends on.** RM-05 (redaction), RM-08 (durable fan-out).

**Risks.** Privacy — transcripts contain secrets and third-party personal data;
default to private visibility and per-grant sources; volume — backfilling months
of sessions spends Titan and extraction budget (RM-04 caps, dry-run cost
preview); export formats drift (diagnostics must alarm, not import zero).

**Done when.** A ChatGPT export fixture with two regenerated answers imports
only the chosen branch; re-running ingest on unchanged exports writes zero rows;
a shrunken session deletes its stale parts; a transcript containing a PAT is
stored redacted; a 5 MB session splits into searchable parts with vector
coverage; the valve refuses a sweep of an unmounted root; parser fixtures are
green with linearity growth ratios recorded.

**Progress.** R1 (1.149.0): `memex transcripts ingest <export.json>
[--format auto|chatgpt|claude-ai] [--source ID] [--dry-run] [--json]` over a
new `src/core/transcripts/` seam (ordered detection with override, per-file
diagnostics, format drift exits non-zero, `MEMEX_TRANSCRIPT_MAX_FILE_BYTES`
refuses rather than truncates). ChatGPT walks `current_node` up the parent
pointers (orphan/cycle-safe, newest-leaf fallback); Claude.ai reads
`chat_messages`. Whole-session secret scan before render, continuation lines
indented so no message line parses as a turn, parts of <= 40 KB at message
boundaries with one message of overlap as `transcripts/<format>/<id>-pN`
(metadata in compiled truth, not frontmatter: a page body's frontmatter is not
parsed by the mirror), content-hash no-op re-runs, stale parts soft-deleted in
the same source, changed parts mirrored; `get_recent_transcripts` lists
`conversation`. Done-when items 1-5 are covered by tests; the zero-rows
re-run holds under all three secret dispositions (a flagged part is audited
only when written, an identical refusal is audited once). A session whose part
another source owns or that was merged away is reported as failed (exit 1)
and the run continues. Open: durable jobs +
`transcripts status`, `raw_data` sidecar and `since` checkpoint, `/ingest`
content type, client-side capture, supervised
source interface, parser breadth, sweep valve and failure ledger, retiring
`scripts/import-chat-history.ts` (its timestamp-sort flattening remains), and
the stretch items. R2 (v1.160.0): Codex rollout
(`~/.codex/sessions/**/rollout-*.jsonl`) and Claude Code session
(`~/.claude/projects/<project>/<session>.jsonl`) adapters, one file or a
directory, `--format codex|claude-code` or detection; tool calls and results,
reasoning, sub-agent traffic, system reminders and slash-command bookkeeping
are dropped, as are whole Codex sub-agent rollouts; same redaction and split
as the export adapters.

### RM-15 — Transcript synthesis and grounding

**Why.** Once transcripts arrive, memex turns them into knowledge through one
Sonnet `reflections` call over up to 20 recent transcripts
(`src/core/synthesis/reflections.ts`) behind a boolean worth-gate
(`synthesis/worth-gate.ts`). Nothing writes per-transcript entity/decision
pages, nothing checks that quotes attributed to people are verbatim,
synthesized `[[wikilinks]]` are model guesses that later show as unresolved,
atoms have a document-count cap but no USD gate (`synthesis/atoms.ts:15`),
zero-yield pages are re-paid on every backfill run
(`cycle/conversation-facts-backfill.ts:14-21`), and worth verdicts never expire
or re-judge after a prompt change (migration 077).

**Scope.**

- Scored triage replacing the boolean worth verdict: score, content type,
  verified segments, entity candidates, cached per (source_ref, content hash,
  triage version) with a TTL; degenerate verdicts never cached; threshold
  applied at read time; a rescue band admitting below-threshold transcripts when
  enough judged segments verify verbatim; `memex dream retriage --dry-run`,
  which also reconciles queued synthesis jobs when the gate or its version
  changes.
- Per-transcript synthesis as queued jobs: token-budget chunking, one structured
  Sonnet completion per chunk validated all-or-nothing (RM-13 oneshot mode when
  available, else the same validator on a single call), writes only to synthesis
  namespaces pinned to the transcript's source, one cycle summary page per local
  day, cooldown keys.
- Mechanical quote verification after synthesis writes: keep exact spans,
  replace near matches with the verbatim slice (rare-trigram anchor,
  token-overlap bar, ambiguity refusal), strip quote marks otherwise; CPU-capped;
  ungrounded number/date telemetry.
- Link-candidate manifest built before the call from triage entities via
  keyword search and the slug resolver, grant-scoped and diary-fenced, passed as
  a write allow-list.
- Atoms: USD budget gate via `BudgetTracker`, quote offsets located in the exact
  text the model saw, source page folded into atom identity, completion marker
  outside the content hash, bounded drain reporting remaining work.
- Bulk conversation facts: time-gap segmentation with a speaker-heading guard,
  checkpoint resume keyed by (source, slug, segment end), per-page advisory
  locks, durable zero-yield audit rows so non-extractable pages are skipped,
  notability tiers, keyless guidance in `extract_facts`.
- Files: `src/core/synthesis/worth-gate.ts`, `reflections.ts`, `atoms.ts`,
  `concepts.ts`, `cycle/index.ts`, `cycle/conversation-facts-backfill.ts`,
  `facts-extract.ts`, `facts-queue.ts`, `search/keyword.ts`,
  `slug-canonicalize.ts`, `ingest-log.ts`, `src/recipes/cycle.ts`,
  `src/mcp/dispatch.ts` (`extract_facts` envelope), new
  `synthesis/transcript-synthesis.ts`, `quote-verify.ts`, `link-manifest.ts`,
  migrations (triage columns and TTL on `synth_worth_verdicts`, zero-yield audit
  rows). Prompts are memex-authored; Haiku triages, Sonnet synthesizes.

**Depends on.** RM-04, RM-08, RM-14.

**Risks.** Paid volume (per-source daily submission caps, dry-run estimates,
quiet-hours scheduling); synthesis never overwrites source notes; quote repair
must not splice garbled text when case folding expands characters (one shared
folding routine, Unicode tests).

**Done when.** A hermetic mini-corpus run through the real phase with only the
model transport scripted (seconds, zero spend) reports survival/fidelity metrics
and pins them; an injected paraphrased quote is repaired to the verbatim span; a
hallucinated link target is refused by the manifest; re-running backfill on a
zero-yield page makes zero model calls; atoms stop at the USD cap mid-run with a
partial report.

**Progress.** Durable zero-yield audit rows shipped (migration 111,
`facts_backfill_scans`): a page whose paid extraction reads cleanly but yields
no new fact is memoized per (source_id, slug, content_hash,
`FACTS_EXTRACT_VERSION`) and the backfill discovery query skips it before
`LIMIT`, so re-running backfill on a zero-yield page makes zero model calls
(Done-when item met). Edits and extractor version bumps re-open the page;
unreadable, budget and model-error outcomes, and facts that failed to write,
stay retryable. Pages written by `memex transcripts ingest` (type
`conversation`) are now extraction-eligible, so imported ChatGPT/Claude.ai
sessions reach the backfill, on-write extraction and reflections. Still open: scored
triage (including keying `synth_worth_verdicts` by source_id, not slug alone),
per-transcript synthesis jobs, mechanical quote verification, the
link-candidate manifest, the atoms USD gate and quote offsets, the rest of bulk
conversation facts (time-gap segmentation, checkpoint resume, per-page advisory
locks, notability tiers, keyless `extract_facts` guidance), the hermetic
mini-corpus metrics, and a doctor/stats surface plus an operator clear command
for the zero-yield memo.

### RM-16 — Facts, takes and calibration ledger v2

**Why.** A forgotten fact comes back the next time the same claim is
re-extracted from another transcript or added by an agent, because tombstones
survive only a fence rebuild of the same page (`src/core/facts-reconcile.ts:190-237`,
`facts.ts:327-348`). Agents cannot record, revise, supersede or resolve a take
over MCP — the only mutation is `set_take_status` (`src/mcp/operations.ts:997`),
and `upsertTakeRow`/`supersedeRow` have no callers
(`synthesis/takes-fence.ts`). A contradiction run where every judge call errors
reports zero contradictions (`synthesis/contradictions.ts:535-537`). The
take-commit bias nudge has no production caller. The `add_fact` schema hides
`kind`, `notability` and `source_session` although the core accepts them. There
is no `idea` kind, no fence supersede-by-row, no calibration forecast on
proposals, and grading pays for a full ensemble or none.

**Scope.**

- Durable withdrawal: a `fact_withdrawals` table keyed by (source_id,
  visibility, normalized-claim hash), a trigger re-expiring matching inserts
  under a source lock, backfill from existing tombstones, expiry of every active
  duplicate on forget.
- Takes write tools `takes_add`, `takes_update`, `takes_supersede`,
  `takes_resolve`: DB-canonical fence edit via `putPage` + `syncTakesFromFence`,
  holder allow-list checks, fence-cell injection guard, server-stamped
  `resolved_by` from the token principal, unparsed fence rows preserved verbatim
  and fractional resolution values kept exact; `set_take_status` becomes
  holder-gated. New tools public-forbidden and write-fenced through
  `SLUG_PARAMS_BY_WRITE_TOOL`.
- `add_fact` exposes `kind`, `notability`, `source_session` (validity/TTL
  fields stay out).
- Contradiction probe honesty: `run_status: judge_failed` when every pair
  errored; temporal verdict classes (supersession, regression, evolution,
  negation artifact); undated-side date pre-filter; optional query-driven mode
  sampling pairs from `eval_candidates` and hybrid top-K; trend/review CLI;
  zero-total doctor check; orphan takes skipped rather than coalesced to
  `default`.
- Proposal queue: predicted Brier forecast from the holder's live scorecard,
  dedup against existing takes passed to the prompt, promote-on-accept writing a
  fence row.
- Calibration consumers: voice-gate modes beyond `pattern_statement`/`nudge`,
  nudges wired to fence commits and accepts with the 14-day cooldown, a
  one-transaction undo for an auto-grading wave; mid-confidence band escalation
  from one judge to the existing ensemble.
- `idea` fact kind (365-day half-life, CHECK widening); fence
  `superseded by #N` / `forgotten: reason` resolved in the insert transaction.
- Verify that the bulk fact insert path canonicalizes entities on save like
  `facts-extract.ts` does.
- Stretch: takes-from-pages classifier over authored longform page types with a
  consent gate, graduated by a labelled precision/recall corpus; a think A/B
  harness (needs the operator's ask).
- Not in scope: per-holder persisted calibration profile rows, a takes-quality
  model panel, configurable default visibility.
- Files: `src/core/facts.ts`, `facts-recall.ts`, `facts-reconcile.ts`,
  `facts-fence.ts`, `facts-decay.ts`, `facts-extract.ts`, `synthesis/takes.ts`,
  `takes-fence.ts`, `takes-canon.ts`, `reads.ts`, `contradictions.ts`,
  `calibration.ts`, `voice-gate.ts`, `nudge.ts`, `src/mcp/operations.ts`,
  `dispatch.ts`, `src/http/public_guard.ts`, `src/commands/doctor.ts`,
  migrations (withdrawals + trigger, `idea` kind, contradiction run status).

**Depends on.** RM-04, RM-07.

**Risks.** A withdrawal trigger on `entity_facts` affects every write path
(measure insert latency on RDS); holder gating on `set_take_status` changes
behaviour for existing tokens; the 182-day grading bar and the
`synth_takes.holder` default `world` are open operator decisions this item must
not change silently.

**Done when.** Forget → re-extract the same claim from a different page → the
fact stays inactive; an agent records, supersedes and resolves a take over MCP
and the scorecard separates agent from owner verdicts; a contradiction run with a
stubbed failing judge ends `judge_failed`; accepting a proposal writes exactly
one fence row; undoing a grading wave restores prior take statuses in one
transaction.

**Progress.** Release A (1.154.0), durable withdrawal: migration 112 adds
`fact_withdrawals`, the `memex_fact_claim_key()` SQL normalization (trim,
collapse whitespace, lowercase, md5), a BEFORE INSERT trigger on
`entity_facts` that lands any withdrawn claim already forgotten whatever the
write path, and a backfill from existing `forget`/legacy tombstones. The
backfill changes no live row: a claim with a live copy today may have been
re-added on purpose (the only way to undo a forget before 112), so it is left
unwithdrawn and counted in a migration NOTICE. Merge and rename carry the old
slug's withdrawals to the new one and retire moved live copies. Lock order
(documented in `fact-withdrawals.ts`): fact row locks first, the per-source
withdraw lock after, so a forget cannot deadlock against a fence reconcile;
there is no two-connection Postgres test yet (the suite runs on PGLite). `forget_fact` records the withdrawal
and retires every live duplicate in the row's own source in one transaction
under a per-source advisory lock (`withdrawn_duplicates` in the result);
`add_fact` refuses a withdrawn claim before the paid embed/classify path
(`withdrawn: true`, `id: null`); fence reconcile skips withdrawn claims so
re-puts do not pile up tombstones. The first "Done when" item holds. Deviation
from the scope text: the key also carries `entity_slug`, so a short claim
forgotten on one subject is not suppressed on another. Withdrawals are
permanent: there is no unwithdraw path yet (needs an operator decision). Still
open: takes write tools and holder-gated `set_take_status` (needs RM-07),
`add_fact` kind/notability/source_session, contradiction honesty, the proposal
queue, calibration consumers, the `idea` kind and fence `superseded by #N` /
`forgotten: reason`, bulk-path entity canonicalization check, and the stretch
items. Live trigger latency on RDS is still to be measured after deploy.

### RM-17 — Tenant-aware cycle orchestration

**Why.** `runCycleOnce` is one brain-wide pass that never takes a source
(`src/core/cycle/index.ts:496-841`); page-writing synthesis phases fall back to
`default` (`synthesis/patterns.ts:208`, `drift.ts:272`), so non-default tenants
never get reflections, patterns, drift or enrich-thin, and `cycle-freshness`
checks one snapshot stream (`cycle-freshness.ts:9-10`). There is no skipped
status, no reason codes, no totals, no abort — a timed-out phase keeps spending
after the wrapper gives up (`index.ts:392-422`). A lost cycle lock is never
detected: `refresh()` ignores its row count and both callers swallow it
(`db-lock.ts:214-222`, `src/recipes/cycle.ts:235-241`). Consolidation,
conversation-facts backfill and rechunk sweep are never scheduled; the synthesis
chain runs only in a hard-coded Europe/Berlin 06–08 window that a 6 h interval
hits at most once a day.

**Scope.**

- Phase-scope map (source / mixed / global) and per-source cycle jobs on RM-08's
  queue: freshness phases per source, synthesis phases in a global lane with
  per-source budgets, single-flight dispatch per source, failure cooldown from
  dead/failed rows, per-source `last_source_cycle_at`/`last_full_cycle_at`
  stamps (not stamped when every attempted phase failed), per-source freshness
  doctor rows.
- Structured cycle report: `skipped` status and reason codes
  (`cycle_already_running`, `lock_stolen`, `aborted`, `budget_exhausted`),
  error class/hint, totals rollup including spend, schema version; AbortSignal
  and job deadline threaded into every phase with a reserve before the job kill.
- Fenced lock refresh: `refresh()` returns affected rows; a zero-row refresh
  aborts the run with a partial report and `lock_stolen`.
- Scheduling: quiet hours configurable (`MEMEX_QUIET_HOURS`, `MEMEX_QUIET_TZ`)
  and shared by the cycle and the jobs claim filter (respecting the existing
  `quiet_hours_skip` job flag); consolidate-facts, conversation-facts backfill
  and rechunk sweep schedulable via `MEMEX_CYCLE_EXTRA_PHASES`; a time-budgeted
  link-extraction drain phase for `links_extracted_at` staleness; a
  net-fact-deletion warning in fence reconcile.
- Remove stale comments naming a non-existent `frontmatter-inference` phase and
  the "6-phase" header (`src/recipes/cycle.ts`, `src/core/cycle/index.ts`).
- Files: `src/core/cycle/index.ts`, all `cycle/*.ts` phases (signal + source
  params), `synthesis/patterns.ts`, `reflections.ts`, `drift.ts`,
  `enrich-thin.ts`, `auto-think.ts`, `src/recipes/cycle.ts`,
  `src/commands/cycle.ts`, `db-lock.ts`, `cycle-freshness.ts`,
  `jobs/quiet-hours.ts`, `facts-reconcile.ts`, `sources.ts`,
  `deploy/docker-compose.yml`.

**Depends on.** RM-03 (abort), RM-04 (per-source budgets), RM-08 (per-source
jobs and admission).

**Risks.** N tenants multiply paid synthesis (per-source caps, default-off
stays); scheduled consolidation changes the fact ledger unattended (dry-run
first run); the report schema change breaks the admin reports page (versioned).

**Done when.** On a seeded two-tenant brain both tenants receive their own
reflections/patterns pages with the right `source_id` and zero cross-tenant
evidence; a simulated lock steal ends the run as `partial/lock_stolen` within one
refresh interval; a phase with no work reports `skipped` with a reason; report
totals equal the sum of phase spend rows; the freshness doctor shows per-source
ages.

**Progress.** Release 1 shipped the fenced lock, the abort signal and the
versioned report: `refresh()` and `release()` match pid + host +
`acquired_at` and `refresh()` returns whether the row is still ours;
`startLockHeartbeat` (shared by the daemon and `memex cycle`) aborts with
`lock_stolen` on a zero-row refresh and only logs a thrown one; `runCycleOnce`
takes `signal`, checks it before each phase and, mid-phase, stops the phase's
BatchScope and returns at once; `CycleResult` has `schemaVersion: 2`,
`outcome`, `reason` (`cycle_already_running` / `lock_stolen` / `aborted`) and
`phasesNotRun`; a lost acquire prints a real `skipped` report; the stale
"6-phase" header and `frontmatter-inference` comments are gone. A simulated
steal ends the run as `partial/lock_stolen` within one refresh interval. Still
open: phase-scope map and per-source cycle jobs on RM-08 (single-flight,
cooldown, per-source stamps and freshness rows), tenant-correct synthesis,
phase-level `skipped` with reasons, error class/hint and `budget_exhausted`,
totals and spend rollup, job deadline with a reserve and the signal threaded
into each phase's inner loops (DB work in an aborted phase still drains),
configurable quiet hours, `MEMEX_CYCLE_EXTRA_PHASES`, the link-extraction
drain, the net-fact-deletion warning, and an admin consumer of schema v2.
A follow-up closed two gaps: the quiet-hours deep-synth pass now runs in a
BatchScope stopped by the heartbeat signal and checks the signal between
questions, and an aborted phase gets a bounded 10 s settle wait before the run
returns, with `orphanedPhase` in the report when it is still running. In v1.160.0 the
phases under `cycle/` (embed-stale, embed-facts, rechunk sweep, consolidation,
conversation-facts backfill, symbol-edge resolution, salience, orphans purge,
purge) now call `phaseCheckpoint()` in their loops and `await phaseFenceCheck()`
before each write, so a stolen or aborted run stops before its next write; a
phase that absorbed errors or failed rows reports `warn`. Still unfenced:
`core/extract.ts`, `page-index.ts` (mirror-pages), `timeline-meetings.ts`,
`timeline-anchor.ts` and the `synthesis/*` phases — their paid calls stop
through the batch scope, their DB loops do not.

### RM-18 — Doctor, advisor and self-healing v2

**Why.** The one automatic data fix does nothing: `reembed-source` passes a
tenant id such as `default` to `runReindex`, which acts only on
`vault`/`code`/`all`, so the job "succeeds" without re-embedding
(`src/core/jobs/remediation-handlers.ts:78-89`, `src/commands/reindex.ts:118-172`);
tests inject a fake runner, so it was never exercised. Remediation is
fire-and-forget with no ordering, no post-step recheck and no resume; only two
actions are fixable. Doctor has no health score, no fix hints, no dead-link
probe, no checks for silently broken paid features, no integrity checks, and no
durable record of DB retries, pool reaps, lock faults or Bedrock refusals to
correlate with incidents like the `page_put` latency. Advisor findings cannot be
applied and carry no history.

**Scope.**

- Fix `reembed-source` (per-source re-embed through RM-02's job kinds) with an
  un-mocked integration test.
- An `ops_audit` table (kind, payload JSONB, source_id, ts) with a purge-phase
  TTL, fed by retries, pool recovery, lock faults, content-sanity trips (RM-05)
  and Bedrock refusal/guardrail/max-token outcomes; doctor and the admin SPA
  read it.
- Doctor health score and per-category scores, `top_issues` with fix hints,
  `--fast`, `--scope`, `--locks` (idle-in-transaction backends older than
  5 min); status sections with per-section deadlines.
- Doctor long tail: LLM layer (calibration freshness, grade confidence drift,
  voice-gate health, worth-verdict/extraction backlogs, phase spend rollups,
  refusal rate) and integrity/graph (dead links, orphan ratio via
  `orphan-policy.ts`, junk hubs, JSONB/frontmatter integrity including
  scalar-string frontmatter, oversized pages, RLS-enabled audit, type
  proliferation, timeline coverage, dangling aliases); an extraction health
  aggregate view.
- A retrieval upgrade plan: one `--plan` preview with row counts and a USD
  estimate for pending re-chunk, re-embed and contextual-tier work before apply.
- Remediation planner/runner on RM-08: steps with `depends_on`, idempotency
  keys, wait for completion, plan recomputed from fresh health after each step,
  target and reachable score reporting, budget-exhaustion checkpoint in the DB
  and `--resume`; hard stop on the per-run budget.
- Advisor structured findings with `dispatch_id` → allowlisted remediation
  actions (`advisor --apply <id>` after confirmation, only actions verified to
  fix the condition), run history and new/resolved delta, nag fingerprint;
  onboarding-style coverage checks with an impact log of before/after metrics.
- Stretch: a daily cohort anomaly mode for `find_anomalies`; a
  deterministic-first/LLM-fallback telemetry wrapper for regex paths that fall
  back to Bedrock.
- Files: `src/core/jobs/remediation-handlers.ts`, `remediation.ts`,
  `src/commands/doctor.ts`, `doctor-categories.ts`, `doctor-cause-rank.ts`,
  `doctor-ops.ts`, `doctor-tenancy.ts`, `advisor/collectors.ts`, `advisor/run.ts`,
  `advisor/types.ts`, `retry.ts`, `audit-week-file.ts` (retired for the DB
  sink), `usage-insights.ts`, `src/commands/status.ts`, `cycle/purge.ts`,
  `src/http/admin-api.ts`, `admin/src/pages/Dashboard.tsx`,
  `src/mcp/operations.ts` (`run_doctor`, `advisor`), migrations (ops_audit,
  remediation checkpoints, advisor history). Probes stay tenant-safe through
  `run_doctor`; remediation dispatches job kinds and never shells out.

**Depends on.** RM-08, RM-17.

**Risks.** Automatic remediation mutating a live brain (dry-run default, budget
cap, operator confirmation); doctor noise (every new check gets a
false-positive test on the live corpus before shipping); audit table growth
(TTL).

**Done when.** An integration test proves `reembed-source` re-embeds the target
source's null vectors; a seeded brain with a dead link, a scalar frontmatter row
and a disabled RLS table produces three named findings with fix hints; a
remediation run with a failing step skips its dependents, checkpoints on budget
exhaustion and resumes to completion; the health score is computed on the live
host and trended in the SPA.

**Progress.** The `reembed-source` fix shipped (first Done-when item): the job
now runs the embed backfill on the worker's own storage, pinned to its
`source_id`, gap-fill only (never deletes vectors), reports
candidates/embedded/failed/last_id, and fails when it had work but embedded
nothing. Doctor no longer plans a re-embed for the NULL-source
`(unclassified)` bucket (a display label, not a source_id), and a job pinned to
a source that owns no live document fails instead of succeeding as a no-op.
`tests/remediation_reembed_integration.test.ts` proves both through the real
Queue, Worker, handler and backfill on PGLite. Still open: `ops_audit`;
health score, `top_issues`, `--fast`/`--scope`/`--locks`; the doctor long tail
(dead links, scalar frontmatter, RLS audit and the rest); the `--plan` USD
preview; the planner/runner with `depends_on`/checkpoint/`--resume`; `advisor
--apply` and history; the SPA trend. Since v1.160.0 the cycle report marks a
phase that absorbed errors or failed rows as `warn`, not `ok` (RM-17), so
that status is there to pass through. Confirmed defect, still open: the
`cycle-phase` job's `defaultRunCyclePhase` calls the CLI `runCycle`, which
returns `void`, so the job succeeds even when the phase failed. `runCycle`
should return its `CycleResult`, and the handler should throw on
`status === "fail"` or `outcome !== "complete"` and pass `warn` through in its
output.

### RM-19 — Graph, timeline and entity enrichment

**Why.** Out of the box the typed graph holds wikilink/code-ref edges and
explicit `link` calls, and the timeline is empty unless events are added by hand
or the meeting/anchor phases are on. `## Timeline` bullets, `### date — title`
headers and `[Source: X, YYYY-MM-DD]` citations in page bodies never become
`timeline_events` (`src/core/links-stale-sweep.ts:14`). Relative markdown links
from imported doc trees are dropped (`links.ts:741-742`). Gazetteer edges go
stale after renames with no scan, non-Latin names do not auto-link, and aliases
colliding with titles create false edges. A long event summary aborts the insert
because the dedup unique index keys raw `event` text
(`079_timeline_dedup_detail.sql:39-41`). People and companies mentioned across
many pages never become reviewable entity pages; duplicate stubs (`alice` next
to `people/alice`) fold only by manual `memex merge`. `traverse_graph` on a hub
has no row ceiling (`links.ts:600-617`). Agent-written pages get no feedback on
broken citations or missing back-links. Chronicle auto-extraction never enqueues
for grant-scoped writers (`src/mcp/dispatch.ts:1455-1456`).

**Scope.**

- Body timeline parsing (bullets, headers, inline citations, CJK dates) with a
  replace-own `source_chunk_id` key, on write and as a backfill.
- Timeline dedup index rebuilt on `md5(event)` with the existing partial
  predicate, duplicates collapsed first.
- Link extraction breadth: relative/same-directory resolution against the
  linking page's path, qualified `[[source:dir/slug]]` syntax honouring grants,
  basename multi-match producing explicit edges instead of a slugify guess.
- Gazetteer hardening: read-only stale-mention scan + doctor check +
  `--rebuild`, CJK minimum length and tokenizer, alias-vs-title collision skip,
  organization/entity types; typed NER verbs over gazetteer mentions, not only
  wikilinks.
- Enrichment service minting reviewable people/company stub pages from repeated
  mentions (mention-count tiers, quarantine marker until reviewed, operator-only
  review ops), a Haiku extractor under a budget; an `unverified` stamp that drops
  the compiled-truth boost for such stubs in search.
- Automatic phantom-page redirect pass using `entity-merge.ts`, source-scoped,
  capped per cycle, outcomes in `ops_audit` (RM-18); standalone bulk page→alias
  and page→link converters on `slug_aliases` and `links`.
- Write-time validators on `page_put` (citation shape, link resolvability,
  back-link presence) returned as non-blocking `writer_lint`; decide explicitly
  whether it stays advisory or becomes a commit-time gate over all pages touched
  in one transaction; traversal row cap with a truncation flag.
- Chronicle auto-extract enqueues for grant writers using the page's source and
  per-grant budget.
- Stretch: company/deal frontmatter edges after a link-origin coexistence
  migration; unresolved frontmatter names reported back in `page_put`; a
  `find_experts` labelled hit-rate fixture and replay Jaccard.
- Files: `src/core/links.ts`, `links-read.ts`, `links-stale-sweep.ts`,
  `gazetteer.ts`, `typed-links.ts`, `link-verb-infer.ts`, `timeline.ts`,
  `timeline-meetings.ts`, `timeline-anchor.ts`, `entities.ts`, `entity-merge.ts`,
  `slug-aliases.ts`, `page-aliases.ts`, `slug-canonicalize.ts`, `pages.ts`,
  `search/hybrid.ts` (unverified stamp), `chronicle/extract-events.ts`,
  `src/mcp/dispatch.ts`, `operations.ts`, `cycle/index.ts`, `insights.ts`,
  migrations (md5 dedup index, enrichment review state). Stubs go through
  `putPage` under the slug-owner fence.

**Depends on.** RM-05 (junk-name gate), RM-08 (enrichment and review jobs).

**Risks.** Auto-minted stubs pollute a curated vault (quarantine until reviewed,
default off); timeline backfill rewrites many rows (replace-own keys keep it
idempotent); index rebuild on live RDS (`lock_timeout`, quiet window).

**Done when.** A page body with bullets, a header and two citations yields
exactly those events and no duplicates on re-put; a 10 KB event inserts; a
relative link in a nested doc resolves; renaming a person page followed by the
stale scan lists the old mention edges; a phantom stub folds onto its canonical
page with facts moved and an audit row; `traverse_graph` on a 10 k-edge hub
returns at most the cap with `truncated:true`.

**Progress.** Release 1 (1.150.0): body timeline parsing on write.
`src/core/timeline-body.ts` turns `## Timeline` bullets, `### YYYY-MM-DD`
headers and `[Source: X, YYYY-MM-DD]` citations into `timeline_events` from
`page_put`, `page_append` and `page_revert`, keyed
`body-timeline:<slug>:<hash16>` and reconciled by a keyed diff (no migration,
no LLM, default on, `MEMEX_BODY_TIMELINE=0` off, diary pages skipped, 200
events per page). Review fixes: a merge drops the stub's body-derived rows
instead of moving them outside the canonical's reconcile prefix, bullets and
headers claim the 200-event cap before citations, and a write inserts only
keys new to the body (one statement diffs, so an append of one bullet is one
insert). Still open: a backfill for pages not rewritten since (a
timeline arm in `memex extract --stale` or a dedicated command), non-ISO and
CJK date forms, the `md5(event)` dedup index (10 KB events), link breadth,
gazetteer hardening, the enrichment service, phantom-page redirects,
`writer_lint`, the traversal cap, chronicle auto-extract for grant writers and
the stretch items.

### RM-20 — Think v2 and idea generation

**Why.** `think` is the cross-page answer layer and it fails silently: a
synthesis failure returns a null parse and a free-text reason, with no status
enum and no answer even when retrieval gathered good pages
(`src/core/synthesis/think.ts:952`, `:1178`, `:1250`); every page contributes a
fixed 600-character excerpt regardless of budget (`think.ts:55`); month windows
are not first-class. Nothing grades synthesized answers. Crossing a question with
distant corners of the corpus to generate ideas is not possible today.

**Scope.**

- `synthesis_status` (`ok`, `empty_answer`, `not_json`, `output_truncated`,
  `no_llm`, `model_unusable`, `llm_error`) with a closed failure class mapped
  from Bedrock errors; an extractive fallback digest from gathered pages with
  citations when compose fails (labelled as such); budget-aware per-page
  excerpts (total budget, floor, ceiling); `YYYY-MM` month bounds with an
  invalid-window error; salvage of partially valid envelopes through RM-04's
  decoder.
- Answer-quality panel: a Claude-only multi-judge rubric (Haiku/Sonnet/optional
  Opus with prompt-varied judges) producing PASS/FAIL/INCONCLUSIVE with JSON
  repair and receipts over a fixed think question set; disclose that same-family
  judges are less independent than a cross-vendor panel.
- After go — idea generation (`memex brainstorm`): a domain bank sampling one
  page per slug prefix with an optional stale-corner bias, per-cross generation
  with calibration context, a five-axis judge rubric, cost estimate and USD cap,
  checkpoint/resume in the jobs table, output written as a synthesis page,
  retrieval tenant-scoped through `hybridSearch`.
- Files: `src/core/synthesis/think.ts`, `think-persist.ts`, `intent.ts`,
  `search/filters.ts`, `src/commands/think.ts`, `src/mcp/operations.ts`,
  `dispatch.ts` (`callThink` envelope), new `synthesis/brainstorm/*`, new
  `src/commands/brainstorm.ts`, `src/commands/eval.ts` (panel lane),
  `budget.ts`. Prompts and rubrics are memex-authored.

**Depends on.** RM-04, RM-06, RM-11 (retrieval meta feeds status and fallback).

**Risks.** An extractive fallback presenting weak evidence as an answer (label
it); brainstorm spend per run (hard cap, estimate first); panel cost per release
(sampled question set).

**Done when.** A stubbed failing compose returns `synthesis_status:"llm_error"`
plus a cited extractive answer; long pages contribute more than 600 characters
within the total budget; the panel gives a stable verdict on the fixed question
set across two runs; brainstorm (after go) resumes from a checkpoint without
re-spending completed crosses.

**Needs operator go.** The idea-generation half (recorded as ask).

**Progress.** Release 1 (1.150.0): every think result carries a closed
`synthesisStatus` (`synthesis_status` on MCP) mapped from the parse outcome,
the truncation flag, the budget pre-flight (an unpriced model is
`model_unusable`) and the Bedrock error class. When compose fails after pages
were gathered, a `fallback` digest (`kind:"extractive"`) quotes the top five
pages with validated citations, makes no model call and is never persisted
(`synthesis` stays null, so save/take, auto_think and deep-synth skip it). The
first Done-when clause holds in tests. Non-operator callers get the `search`
diary fence on every think page stream (hybrid, gap rounds, anchor subgraph),
so neither the prompt nor the verbatim digest carries `life/diary/*`; covered
by an MCP-level tenant test. Still open: budget-aware excerpts,
`YYYY-MM` windows, envelope salvage through the RM-04 decoder, RM-11 meta in the
status and digest, the answer-quality panel, and brainstorm (needs go).

### RM-21 — Hosted onboarding, harness provisioning and skill distribution

**Why.** Onboarding a new agent or teammate takes several `memex auth` calls
plus a hand-written `claude mcp add` block; `scripts/mcp-refresh.sh` supports
Claude Code only, with no hooks, no Codex/opencode config and no check that the
minted credential reaches the intended source. There is no client-side check
that a remote brain is reachable, that OAuth discovery and token minting work
and that tools answer — the ship verify step does this by hand
(`src/commands/auth.ts:569-692` covers only a PAT smoke). The skill pack cannot
be installed or updated on a client without clobbering local edits, and the
`list_brain_skillpack` advice points at a bundler (`src/commands/skillpack.ts`).

**Scope.**

- `memex connect` / `memex agent provision`: one transaction minting a
  least-privilege grant from an RM-10 profile over memex's admin/OAuth APIs,
  writing a private 0600 credentials handoff file with resume, printing or
  installing paste-ready config for Claude Code (JSON), Codex (TOML with
  `http_headers`) and the claude.ai connector, then verifying end to end (OAuth
  discovery → token → `initialize` → `tools/list` → scoped read) and revoking the
  fresh credential on failure.
- Remote doctor: discovery metadata, client-credentials mint, MCP smoke, scope
  probe, `/health` version-stamp drift, as one report usable in the ship verify
  step.
- Instruction blocks for client instruction files (CLAUDE.md/AGENTS.md):
  marker-owned, idempotent, backed up, carrying the RM-07 `initialize` contract;
  removed when writeback is off.
- Skill distribution: stub `SKILL.md` pointers that fetch current bodies through
  `get_skill` (the server stays the source of truth), an install ledger with
  install-time hashes distinguishing local edits from server-side changes,
  three-way diff with apply-clean-hunks, ledger-scoped remove; personas curated
  from memex's own pack.
- Claude Code/Codex plugin manifests pointing at the remote `/mcp` over OAuth
  (no local stdio launcher), with skill text limited to what memex actually has.
- Not in scope: local agent-workspace bootstrap (interview, identity render,
  per-agent GitHub repo); only its verify round trip is taken.
- Files: `src/commands/auth.ts`, new `src/commands/connect.ts`, `src/cli.ts`,
  `src/cli-args.ts`, `src/commands/skillpack.ts`,
  `src/core/skillpack/brain-resident.ts`, `oauth-provider.ts`,
  `src/http/oauth-metadata.ts`, `scripts/mcp-refresh.sh`, new repo-root plugin
  manifests, `docs/DEPLOYMENT.md`, `deploy/memrain/docs/CLAUDE-CODE.md`.

**Depends on.** RM-07, RM-09, RM-10.

**Risks.** Credential material on disk (0600, never argv, redaction in errors);
writing into users' instruction files (marker-bounded, backups, refuse symlinks);
consent and privacy on shared brains.

**Done when.** From a clean laptop profile, one command connects Claude Code to a
local two-tenant memex, the verify step proves a tenant-scoped read, and a forced
wrong source makes it fail and revoke; remote doctor is green against the live
host in the ship loop; stub skill install reports `identical/differs/missing`
correctly after a local edit and a server-side change.

**Progress.** Release 1 (1.151.0): the remote doctor. `memex auth doctor
<base-url>` (`src/commands/remote-doctor.ts`) runs /health + stamp drift →
both discovery documents (issuer = given origin, same-origin token_endpoint,
client_credentials advertised, protected-resource agrees) → client_credentials
mint from a 0600 `--client-file` (or `--token-file`, mint skipped) →
`initialize` (serverInfo.version = /health stamp, instructions present) →
`tools/list` → `whoami` → scope probe (`--expect-source` / `--expect-operator`).
HTTP-200 JSON-RPC errors and `isError` fail; exit 0/1/2. Client-side only, no
server change; documented as a ship verify step in CLAUDE.md and
DEPLOYMENT.md §10. Still open: running it green against the live host (and
adding it to `/ship` as an automated gate); `memex connect` / `agent
provision` (blocked on RM-10 profiles and least-privilege mint; it will call
`runRemoteDoctor` as its verify step); a tenant-scoped read proof beyond
whoami and the two-tenant local scenario; instruction blocks; stub skill
distribution (waits on RM-09); plugin manifests; `mcp-refresh.sh` extension.
`auth test` still treats an HTTP-200 JSON-RPC error as success — retire it or
rebuild it on the doctor as a follow-up. Review fixes: `--expect-operator` now
checks the real whoami contract (`is_public:false` and reads null or covering
`default`), so the operator PAT passes and the public bearer, fail-closed `[]`
and sentinel-only grants fail — tested against payloads from a live ingress
and dispatch, not stubs; no fetch follows redirects (3xx fails, naming the
Location origin), so a proxied 307 cannot re-post the client secret or bearer.
Client docs (v1.159.0): `docs/clients/` has a connect guide per client —
Claude.ai personal and Team/Enterprise, ChatGPT, Codex CLI and Claude Code —
with registration, exact steps, verification and a troubleshooting table
built from the server's real error strings. They are hand-written steps, not
the `memex connect` automation above, which stays open.

### RM-22 — Delegated agents for tenants

**Why.** With RM-13 in place, a remote client (a teammate's Claude connector, a
Codex harness) could hand the brain a bounded long-running task. Today every
`jobs_*` tool is operator-only (`src/mcp/dispatch.ts:284-320`), jobs record no
submitting principal or grant, and the columns meant for this (`bound_tools`,
`bound_source_id`, `bound_max_concurrent`) are never read
(`046_oauth.sql:61-65`).

**Scope.**

- Submission authority: every tenant-submitted job snapshots principal, grant
  id, source, allowed tools, prefixes and a payload hash; the snapshot is
  re-checked against the live grant at claim, retry and each tool boundary; a
  narrowed or revoked grant stops pending and running work; LLM-spending kinds
  stay operator-only unless the grant's profile allows delegation.
- `submit_agent` (agent scope + delegating profile) intersecting requested tools
  and prefixes with the bound grant, `FOR UPDATE` per-client concurrency check,
  dry-run preview, owner-fenced `get_agent_job` with uniform not-found and queue
  position; delegation audit rows.
- Per-job-tree budget with CAS reservation/refund across children and subtree
  halt on exhaustion; submit-time cost and duration projection; spend attributed
  to the grant (RM-04).
- Stretch: out-of-process isolation for tenant agent runs (a separate compose
  worker service or Bun subprocess with a DB-heartbeat watchdog that exits for a
  docker restart) so a runaway tenant job cannot take down the MCP server.
- Files: `src/mcp/operations.ts`, `dispatch.ts`, `jobs/queue.ts`, `dag.ts`,
  `worker.ts`, `src/core/agent/*` (from RM-13), `oauth-provider.ts`, `scope.ts`,
  `budget.ts`, `src/http/public_guard.ts`, `deploy/docker-compose.yml`
  (optional worker service), migrations (job authority columns, delegation
  audit, tree budget). No filesystem-root jobs.

**Depends on.** RM-04, RM-10, RM-13.

**Risks.** The largest authorization surface in the program — blast radius
stated, `security-engineer` + second-opinion review, a live two-tenant pilot
smoke before enabling; cost exposure per tenant (tree budgets finite by
default); prompt injection from tenant content steering tools (allowlist,
fences, sanitizer, no graph-edge writes).

**Done when.** A tenant submits an agent task that reads only its source and
writes only its prefix; revoking the grant mid-run stops the job at the next tool
boundary; a concurrent submit beyond `bound_max_concurrent` is refused; a child
exhausting the tree budget halts its siblings; the RM-01 isolation matrix covers
the new ops.

**Needs operator go.** Given 2026-09-19, together with RM-13.

**Progress.** Release A (1.153.0, live): `submit_agent` and
`get_agent_job` (scope `agent`, forbidden on public ingress, `skip` rows in the
isolation matrix owned by `tests/agent_tenant.test.ts`) run the RM-13 loop as
the submitting client. Migration 115 adds `jobs.submitted_by` and
`jobs.authority`, the grant snapshot (client, spender, grant revision, sources,
token scopes, tools, payload hash). `src/core/agent/authority.ts` re-checks it
against the live client row at claim and before every Converse call and tool
dispatch, and refuses a deleted client, a moved revision, a withdrawn `agent`
scope or daily cap, changed sources and narrowed `bound_tools`. The run
dispatches as the rebuilt tenant AuthInfo inside `runWithSpendClient(spender)`
with no fixed cap, so each call reads the live cap, and a spent cap ends the
run as `budget_exhausted`. Submit is gated by both env flags, the `agent`
scope, a finite budget, a non-empty read grant, a token that carries its
client's own grant (enrollment-bound tokens are refused), and a `FOR UPDATE`
count against `bound_max_concurrent`. Tenant jobs are enqueued with
`max_retries` 0, so a revoked grant never comes back as a retry. Done-when met
in code: reads only its source, revoke stops at the next tool boundary, submit
beyond `bound_max_concurrent` refused, matrix covers the new ops.
`get_agent_job` also checks the caller against the job's grant snapshot: an
enrollment-bound session, or a client whose sources no longer match the ones
the job read, gets the same not-found; a moved grant revision with unchanged
sources (a narrowed slug fence) keeps the status readable but withholds the
answer. Still open:
the live pilot smoke, `/codex` and `security-engineer` review before deploy;
writes confined to the grant's prefixes (needs RM-13 release B); per-tree
budgets with children and subtree halt (needs RM-13 fan-out / RM-08); dry-run
cost preview and queue position; a delegation audit table; enrollment-bound
sessions; other LLM-spending kinds for tenants; out-of-process isolation; a
tenant transcript view; owner cancel.

### RM-23 — Code intelligence v2

**Why.** memex parses five languages with six grammars
(`src/core/chunkers/parsers.ts:28-56`) — plain JavaScript repos are not parsed.
Code chunks are never embedded (`src/core/indexer-code.ts`,
`embed-backfill.ts:236`), so "where do we retry Bedrock throttles" cannot reach
code through the vector arm. Class chunks duplicate every method body, decorators
fall outside Python chunks, qualified names always use `::`. Callee resolution
is bare-name and same-document only, so same-named methods alias. An empty result
does not say whether the symbol is missing or the graph is unbuilt. (RM-01
Release C fixes the edge `source_id`; this item fixes fidelity.)

**Scope.**

- Grammars from official per-language npm packages at the pinned
  web-tree-sitter ABI (JavaScript/JSX first, then Rust, Java, C#, Ruby) with
  node-type tables and self-check probes.
- Embed code chunks with a `[lang] path:start-end kind name (in Parent)` header
  stripped before unchanged-chunk reuse, through Titan with spend accounting;
  oversize symbol splitting at body-child boundaries and a Titan input cap; slim
  class scope headers with member digests; per-language qualified-name
  separators with a chunker version bump and backfill; decorator-inclusive
  ranges.
- Edge fidelity: receiver-type resolution (`this`/`self`, imported receivers,
  `new C()` locals), import and type-reference edges, an extractor-version
  watermark that re-walks old chunks, unmatched counts.
- Readiness signal on empty code lookups (`not_built`, `no_symbols`,
  `indexing`, `ready`); ranked definitions with snippets and a language filter;
  text-occurrence refs; resolved/unresolved flags; `code-blast`/`code-flow` CLI
  with source flags; cost-previewed code reindex.
- A code-retrieval eval comparing hybrid search with the code ops on a public
  fixture corpus.
- Stretch: small-sibling merge with a definition guard; Svelte/Astro script
  regions.
- Not in scope: a traversal cache; semantic/LLM chunkers (one Titan call per
  sentence, no batch API).
- Files: `src/core/chunkers/parsers.ts`, `code.ts`, `fenced-code.ts`,
  `code-entities.ts`, `code-edges.ts`, `code-graph.ts`, `code-walk.ts`,
  `indexer-code.ts`, `sweep-code.ts`, `embed-backfill.ts`,
  `contextual-reembed.ts`, `cycle/resolve-symbol-edges.ts`, `chunker-version.ts`,
  `search/structural-expand.ts`, `src/commands/code.ts`, `reindex.ts`, `wasm/`,
  `scripts/vendor-grammars.ts`, `src/mcp/operations.ts`, migrations
  (qualified-name backfill, edge watermark). Keeps the iterative visitor,
  doc-comment extraction and the single-table `code_edges_symbol` design.

**Depends on.** RM-01 (edge `source_id`), RM-02 (embedding jobs), RM-06 (eval
harness).

**Risks.** Embedding a large code corpus costs money and grows the HNSW index
(dry-run cost preview, opt-in per source); the separator change invalidates
`near_symbol` inputs (accept both during a deprecation window); WASM memory on
the t4g.medium host.

**Done when.** A JS fixture repo yields symbol chunks, call edges and
definitions; a semantic code question hits the right function via the vector arm
with precision above the hybrid baseline in the code-retrieval eval;
`this.save()` resolves to `Class::save`; an empty `code_def` on an unindexed
source returns `not_built`; decorated Python functions include their decorators.

**Needs operator go.** New grammars beyond the current set (wide tree-sitter
language coverage is recorded as deferred); JavaScript is the recommended first
addition.

**Progress.** Release 1 (readiness signal) shipped: empty `code_def` /
`code_refs` / `code_callers` / `code_callees` results and `code_blast` /
`code_flow` results with no nodes (`not_found`, or `ok` with empty
`depth_groups` from a qualified, `exact` or edgeless start) carry
`readiness: { state, code_documents, symbols }`
(`not_built` | `indexing` | `no_symbols` | `ready`), counted over the caller's
sources only (capped count queries, no query at all for a caller granted
nothing), and the `memex code-*` CLI prints it on stderr. The "empty `code_def`
on an unindexed source returns `not_built`" criterion is met. `indexing` comes
from a process-local flag, so it covers the in-server boot sweep but not an
out-of-process `memex reindex`. Still open: new grammars (operator go),
embedding code chunks (RM-02, RM-06), class headers / decorator ranges /
qualified-name separators, receiver-type resolution and the edge watermark,
ranked definitions and the remaining CLI surface, the code-retrieval eval, and
a persisted `indexing` signal. The code-mention wipe is fixed: the entity
re-extract deleted every mention on each chunk of a re-staled doc but
re-created only wikilink/tag/date, and a code reindex re-stales the doc through
`updated_at`, so every cycle emptied the code-def/ref/caller/callee graph (prod
showed `no_symbols` over 187 code documents). The delete is now scoped to
`TEXT_ENTITY_TYPES`, and `docs/DEPLOYMENT.md` documents the one-shot repair
`reindex --source code --all`. Still open besides the list above: an automatic
repair on upgrade, and skipping code documents in the text extract altogether.

### RM-24 — Operator CLI and config plane

**Why.** `memex config set` accepts any key matching `^MEMEX_[A-Z0-9_]{1,64}$`,
so `MEMEX_SERCH_MODE` silently stores a dead key and malformed values fail only
at the next restart (`src/commands/config.ts`, `src/core/runtime-config.ts`);
env readers disagree on `1`/`true`/`yes` across ~119 `process.env.MEMEX_*`
reads. Long commands (embed, reindex, extract, migrate-engine) print progress to
stdout, which pollutes `--json` (`src/core/output/progress.ts`), and give cron
and agents no machine-readable progress. There is no confirmation helper, no
PGLite rebuild path for local installs (`src/commands/init.ts:97` exits 0 on an
existing install), no CLI for insight ops beyond `memex call`, and no
`purge-deleted` CLI.

**Scope.**

- A known-key registry generated from the `MEMEX_*` reads (type, default,
  validator, sensitive flag, docs link), did-you-mean on keys (Levenshtein),
  set-time validation, one canonical truthiness helper adopted everywhere, and a
  drift test against `docs/CONFIGURATION.md` and the compose allowlist. Env wins
  over the DB overlay; no dotted keys.
- Global flags accepted in any position (`--quiet`, `--progress-json`,
  `--timeout` with exit 124); a stderr progress reporter (human/JSON/quiet,
  rate-limited ticks, abort event); a shared yes/no prompt that declines on EOF.
- `memex reinit-pglite` for local/dev installs; `memex pages purge-deleted`;
  `whoknows`/`anomalies`/`calibration` CLI wrappers over dispatch with
  `--explain`.
- Stretch: a four-metric operator scorecard from facts and takes (the backup
  posture verdict lives in RM-25).
- Not in scope: publish-to-HTML, provider pickers, self-upgrade, mounts.
- Files: `src/core/runtime-config.ts`, `config.ts`, `src/commands/config.ts`,
  `src/cli.ts`, `src/cli-args.ts`, `src/core/output/progress.ts`,
  `src/commands/embed.ts`, `reindex.ts`, `extract.ts`, `migrate-engine.ts`,
  `init.ts`, `pages.ts`, new `src/commands/insights.ts`, `docs/CONFIGURATION.md`,
  `deploy/docker-compose.yml`.

**Depends on.** RM-03 (bounded teardown and exit semantics).

**Risks.** Tightening `config set` rejects keys operators already stored (report
existing unknown keys first); the stderr/stdout split changes scripts that parse
output (release note).

**Done when.** `config set MEMEX_SERCH_MODE x` fails with a suggestion; a test
enumerates every `process.env.MEMEX_*` read and fails if a key is missing from
the registry or the compose allowlist; `memex embed --progress-json` emits
parseable events on stderr while stdout stays valid JSON.

**Progress.** Release A (MCP argument contract) shipped: every MCP operation
refuses undeclared argument keys with a did-you-mean hint (the bounded
edit-distance helper now lives in `src/core/did-you-mean.ts`, shared with the
CLI flag check and ready for `config set`), with `MEMEX_MCP_LENIENT_ARGS=1` as
the escape; fact ids leave `facts.ts` / `facts-recall.ts` as numbers on both
engines and `recall` / `forget_fact` accept canonical decimal strings, pinned by
a dispatch test that serves int8 as strings the way postgres.js does. The new
check caught two test calls that passed `entity_facts {slug}` (ignored, so the
read ran brain-wide) and `volunteer_context {q}`. Still open: the config key
registry with did-you-mean on `config set`, set-time validation and a report of
already-stored unknown keys; the truthiness helper and the drift test against
docs and the compose allowlist; global flags and the stderr progress reporter;
the yes/no prompt; `reinit-pglite`; `pages purge-deleted`; the insights CLI
wrappers; the scorecard stretch; and returning the other BIGSERIAL ids
(timeline events, jobs, versions) as numbers.

### RM-25 — Composite page identity and full-fidelity portability

**Why.** `pages.slug` is the global primary key (migration 015): one owner per
slug. Two tenants cannot both own `people/alice`, and `page_put` distinguishes
"owned by another source" from "free", so a tenant can enumerate other tenants'
slugs (see "Cross-tenant slug enumeration" below). The fix touches every read
path that resolves a slug plus `slug_aliases`, merge, rename and the page mirror
path (see "Page mirror path collision" below). Such a migration needs a tested
rollback, yet `migrate-engine` copies only the legacy table set — no pages,
versions, links, facts, timeline, synth tables or OAuth rows
(`src/commands/migrate-engine.ts:45-90`) — and `memex export` is one-way and
lossy.

**Scope.**

- Portability first: catalog-driven full-table engine copy in FK order (column
  intersection, GENERATED columns skipped, resume manifest, per-table verify
  counts, config flip only on zero failures); `memex import` restoring
  `memex export` output with pages, versions, facts and tags per source
  (quarantining unfinished jobs on restore); a read-only backup-posture verdict
  (RDS automated backup retention, EFS backup policy, secret presence) from
  read-only AWS calls.
- Identity: `(source_id, slug)` primary key through a backfill-safe plan (shadow
  column, dual-read, cutover), a non-transactional `CREATE INDEX CONCURRENTLY`
  migration lane, slug resolution taking the caller's source,
  aliases/merge/rename/mirror paths keyed by source, uniform write outcomes that
  no longer leak existence.
- Files: new migrations after `015_pages.sql`, `src/core/pages.ts`,
  `slug-resolve.ts`, `slug-canonicalize.ts`, `slug-aliases.ts`,
  `page-aliases.ts`, `entity-merge.ts`, `page-index.ts`, `page-retype.ts`,
  `links.ts`, `facts.ts`, `timeline.ts`, `tags.ts`, `src/mcp/dispatch.ts`,
  `migrate.ts`, `src/commands/migrate-engine.ts`, `export.ts`, new
  `src/commands/import.ts`, `src/commands/doctor.ts`. Migration 059 is not
  reverted.

**Depends on.** RM-01, RM-03.

**Risks.** The highest-risk schema change in the program — full RDS snapshot
first, rehearsal on a restored snapshot, a written rollback, a maintenance
window, terraform untouched; every slug-keyed index and FK changes; external
clients passing bare slugs keep working only through the caller's source.

**Done when.** A PGLite→Postgres→PGLite round trip preserves every row count and
content hash across all tables; importing an export reproduces pages, facts and
versions for a source; on a rehearsal copy of the live DB, two tenants each
create `people/alice`, both reads return their own page, and `page_put` gives
identical outcomes for "taken elsewhere" and "free"; the full sharded suite and
the Postgres lane pass on the new identity.

**Needs operator go.** Yes: an explicit plan and go (the composite key was
deferred in favour of tenant slug prefixes on 2026-07-02 and re-opened on
2026-09-07).

**Progress.** Release A (full-fidelity engine copy) is done locally, not yet
deployed: `migrate-engine` reads both catalogs and copies every public table
in FK order (`src/core/engine-copy.ts`: column intersection, generated columns
skipped, text transport, keyset batches, triggers off via
`session_replication_role`, upsert on the key, sequences advanced), then checks
each table by count and an order-independent content hash and exits 1 on any
mismatch. pglite→pglite, `--verify-only` and `--tables` are in;
`tests/engine_copy.test.ts` proves a two-hop PGLite round trip across all
tables. Review fixes: every source read (catalog, copy, hash) runs in one
`REPEATABLE READ READ ONLY` transaction so a live source verifies; sequences
take the later of the copied maximum and the source sequence's last value;
a source-only column fails the run unless `--allow-dropped-columns`. Still open: the live Postgres→PGLite check on the EC2; the resume
manifest and the config flip; `memex import`; the backup-posture verdict; the
composite identity itself; a CI Postgres lane.

### RM-26 — Live source connectors (chat history, GitHub)

**Why.** RM-14 imports exports and sessions the operator pushes. Continuous
capture of ChatGPT/Claude.ai history, and of project history (issues, PRs,
reviews) next to the code graph, is the remaining connector gap; neither was
part of the removed life integrations.

**Scope.**

- A provider seam with a response classifier (rate limit, auth, challenge page,
  5xx) and a fixed-origin client with spacing and retry-after; a clean-run-only
  watermark with a trailing gap-heal window in `recipe_state`; statuses
  (`success`, `nothing_new`, `partial`, `auth_required`, `forbidden`); a
  `connector_sync` job kind with per-provider schedule; a doctor check for
  re-auth needed and stalls. Shares RM-14's supervised source interface.
- Chat connectors run client-side (laptop CLI) and push through RM-14's pipeline,
  because provider challenge pages make fetches from the EC2 egress a likely dead
  end; credentials never enter the DB or MCP payloads; the export-file path stays
  the supported fallback.
- GitHub source kind: token from Secrets Manager under
  `<secrets_prefix>/github-<name>`, issue/PR/review/check pages under a source,
  `#n` and `Closes/Fixes` links, since-delta and full reconcile, an HMAC-verified
  webhook route beside `/ingest` (public-ingress change, security review).
- Files: new `src/core/connectors/*`, `recipe-state.ts`, `sources.ts`,
  `src/commands/sources.ts`, `src/http/server.ts`, new `src/http/webhooks.ts`,
  `src/http/public_guard.ts`, `jobs/handlers.ts`, `src/commands/doctor.ts`,
  client-side scripts, secret pointers only (terraform only if a new secret
  resource is approved).

**Depends on.** RM-05, RM-08, RM-14.

**Risks.** Provider terms and breakage (cookie lanes are brittle); a new public
webhook route; personal data volume and privacy on shared brains.

**Done when.** A recorded-response test suite covers each provider state; the
watermark does not advance on a partial run; a GitHub fixture repo mirrors
issues/PRs with links and a webhook refresh updates one item; doctor flags an
expired credential.

**Needs operator go.** Yes (Gmail/Calendar stay out; see open decisions).

**Progress.** R1 (1.151.0): the provider seam and the GitHub connector as a
one-shot operator CLI. `core/connectors/`: a pure response classifier (ok,
rate_limited, auth_required, forbidden, challenge, server_error; a GitHub
secondary-limit 403 is told from a real one), a fixed-origin client (paths
only, same-origin pagination, no redirects, spacing, Retry-After and
X-RateLimit-Reset waits up to a cap, bounded retries, token scrubbed from
errors), a clean-run-only watermark in `recipe_state` with a gap-heal window,
and the run statuses. `memex connectors github sync <owner/repo> --source ID
[--full] [--dry-run] [--json]` writes issue and PR pages into a `github`-kind
source (migration 113) through `putPage`, secret-scanned, with `#n` and
closing keywords as wiki links (a PR page aliases its `issues/<n>` slug so a
bare `#n` lands on it); `memex connectors status`; a `connector-health` doctor
check. Token from `MEMEX_GITHUB_TOKEN` or `--token-file`, no MCP op, no
ingress change. Also fixed: `putPage` versioned an unchanged truth whose keys
were in another order. Review fixes (1.151.0): the list is paged newest
first and the watermark is capped at the run's start, so a mid-run edit shifts
items into a repeat instead of a gap (recorded shifted-page test); refusals a
retry cannot fix (secret `reject`, ownership fence, malformed element) go to a
per-connector refusal ledger in `recipe_state` that doctor names, and no longer
pin the run at `partial`; only a retryable write failure or a stopped fetch
keeps the watermark; labels and the author are secret-scanned at render;
repository slug segments are one-to-one (a non-plain name is folded plus a
hash suffix) and the target folds case.
Still open: the HMAC-verified webhook route (the last "Done when" item),
Secrets Manager token, `connector_sync` job kind and schedule on RM-14's
supervised interface, reviews/comments/checks pages and deletion reconcile,
chat connectors, links to code-graph symbols, and the live check on the EC2.

### RM-27 — Skill optimization loop

**Why.** memex ships a `skill-optimizer` skill with no backing code
(`deploy/skills/skill-optimizer/SKILL.md`). With routing-eval files in the pack,
a measured, validation-gated edit loop would improve the 59 skills against
benchmarks instead of hand edits — once RM-13 exists to run rollouts.

**Scope.**

- JSONL benchmark format and splitter; read-only rollouts through the RM-13 loop
  over an allowlist without write tools; rule and LLM judges (Claude tiers); a
  median-of-3 validation gate with an epsilon; a pure add/replace/delete
  markdown patcher with frontmatter immutability; version store, checkpoints and
  a rejected-edit buffer in RDS; per-skill DB lock, cost preflight and USD caps;
  an audit trail.
- Benchmark bootstrap from routing-eval files with a review sentinel; a
  held-out gate; an opt-in cycle phase for stale skills with hard caps; an
  operator-only MCP op with confined benchmark paths.
- Output is a proposed diff for the operator's laptop checkout (the container
  mounts skills read-only), never an in-container write.
- Files: new `src/core/skillopt/*`, `src/core/agent/*` (rollout),
  `deploy/skills/*/routing-eval.jsonl`, `budget.ts`, `db-lock.ts`,
  `cycle/index.ts`, `src/mcp/operations.ts`, new `src/commands/skillopt.ts`.

**Depends on.** RM-06, RM-09, RM-13.

**Risks.** Paid rollouts (hard caps); overfitting to small benchmarks (held-out
gate); proposed skill prose must pass `make scrub-audit`.

**Done when.** On a seeded benchmark, a deliberately degraded skill improves
beyond the validation epsilon on held-out tasks and an unhelpful edit is
rejected; a run stops at its USD cap with a checkpoint; proposed diffs pass
`make scrub-audit`.

**Needs operator go.** Yes (recorded as deferred, low priority).

**Progress.** Release A (1.153.0): `memex skillopt eval` behind
`MEMEX_SKILLOPT_ENABLED=1` — the scorer and gate everything else needs.
`src/core/skillopt/benchmark.ts` loads the 16 `routing-eval.jsonl` files (93
cases; confined to `<skillsDir>/<slug>/`, no symlinks, 64 KB cap, line-numbered
errors; `expected_skill: null` is a negative case answered `none`) and splits
each file deterministically, ceil(30%) held out. `catalog.ts` builds the
slug/description/triggers catalog and swaps in a candidate with its name held
fixed. `judge.ts` is the linear rule judge plus median and the epsilon gate.
`evaluate.ts` runs tool-less 32-token Haiku Converse calls booked as
`skillopt`, refuses a worst case over the cap before any call, and stops at
the cap with a partial report. `--candidate` scores both catalogs on every
file's held-out cases and rejects an edit that costs any other skill more than
epsilon, so a greedy description cannot buy its own recall with another
skill's requests; that makes a candidate run pack-wide (35 held-out cases, 210 calls at 3
repeats), above the default cap. Only the worst case is priced (one token per
prompt byte, about 4x the real cost), so the default $0.25 buys about 12 calls
with the whole-pack catalog: scope runs with `--skill`. Still open:
checkpoints, version store and rejected-edit buffer in RDS (the cap stop has
no checkpoint yet); the markdown patcher and LLM proposal loop; the LLM judge
and task benchmarks run through the agent loop; benchmark bootstrap with a
review sentinel; per-skill DB lock and audit trail; the cycle phase; the
operator-only MCP op; proposed-diff output checked by `make scrub-audit`;
prompt-cache points on the catalog prompt.

### Not planned

Not in any roadmap item, with the reason:

- **Cross-encoder rerank tier and score-cliff autocut** — blocked by the
  Anthropic-via-Bedrock-only rule and the absence of a calibrated rerank score;
  reopens only if the first-party Bedrock rerank question below is answered yes.
- **Embedding model migration tooling** — no model switch is decided; build it
  alongside a decided swap.
- **Image search and multimodal/OCR** — no image corpus; Titan Multimodal G1 is
  the path if one appears.
- **Multi-provider LLM plumbing** — conflicts with Anthropic via Bedrock only.
- **Per-holder persisted calibration rows** — a live per-holder scorecard
  already exists (`src/core/synthesis/reads.ts:106-156`, migration 091).
- **Takes-quality model panel** — triaged out; a cross-provider panel also
  conflicts with the model rule.
- **Markdown-first fact writes** — memex is DB-canonical.
- **Cross-brain calibration and SVG charts** — no federation; value-1 items.
- **Publish gates for skill catalogs** — the pack is public repo content and
  `advisor` is already operator-only.
- **SSRF-guarded outbound fetch** — memex fetches no caller-supplied URL today;
  add it with the first feature that does.
- **Outbound credential vault, Google OAuth, Google source, open-loop detection
  and email-derived loops** — life integrations were removed on purpose.
- **Keyless capability probe and a local IPC listener** — one provider,
  HTTP-only serving.
- **Cross-source identity groups** — overlaps the deferred federation decision.
- **Unix-socket IPC and a hook relay to a third-party store** — prod is RDS;
  the relay would leave the AWS data boundary.
- **A generic backfill framework and a frontmatter engine** — memex already has
  keyset-checkpointed backfill (`src/core/embed-backfill.ts:42-47`) and a line
  parser (`src/core/frontmatter.ts:15-40`).
- **Emotional-weight scoring** — already folded into salience
  (`src/core/salience-score.ts`); `pages.emotional_weight` (migration 024) has no
  writer and is a cleanup candidate, not work.
- **A nightly answer-quality probe** — the retrieval probe covers the brain;
  answer quality arrives through RM-06/RM-20.
- **Inline private-queue drain, a filing-rule ladder, a skill DRY auto-fixer** —
  runtime and authoring shapes memex does not use; grant prefixes already fence
  writes.
- **Git-remote backup coverage and a filesystem corpus sweep** — DB-canonical;
  the RDS posture verdict is in RM-25.
- **Private per-run queues, in-agent local installer, host context engine,
  vendor-binary E2E** — single EC2, remote-MCP-only deployment.
- **Audio transcription** — needs new AWS infrastructure nobody requested and
  there is no audio corpus.
- **Git-backed sync family, disk write-through, archive crawler** — deferred
  federation plus a DB-canonical store with no consumer.
- **Conversation-parser LLM fallback, its cache and its eval** — the parser is
  deterministic by design (`src/core/conversation-parser.ts:10-13`).
- **Configurable FTS language** — `'simple'` stays for the multilingual corpus;
  CJK handling arrives in RM-11 without changing it.
- **Blob storage tiers, PGLite WAL repair extras, a dual pool manager, a wide
  engine contract / multi-brain registry** — deferred by stack, closed, or no
  capability gain (memex connects directly to RDS).
- **A skill pack registry network and schema packs** — no third-party pack
  ecosystem; no operator-authored packs served to multiple tenants. The dead
  schema skills are handled in RM-09.
- **Alias type classification** — stricter write-time enforcement already exists
  (`src/core/pages.ts:180-195`).
- **Local agent-workspace bootstrap and integration recipes** — RM-21 takes only
  the verify round trip; passive-ingest integrations are out of scope.
- **A bench baseline file gate** — the gate lives in bun tests on purpose
  (`src/commands/bench.ts:13-18`).
- **Multi-harness bench adapters** — reconsider after RM-12's hook entry exists.
- **Retrieval drift watch** — the container has no `.git`; local retrieval gates
  are already mandatory.
- **Parser/extractor eval gates** — RM-14 adds per-format parser unit tests.
- **Self-upgrade, provider pickers, mounts/resolvers, serve-delegated sync** —
  conflict with the docker/SSM deploy, Bedrock-only stack and RDS; a Bedrock
  reachability probe is folded into RM-04.
- **A code traversal cache and semantic/LLM chunkers** — triaged out; one Titan
  call per sentence with no batch API.
- **Markdown chunker helpers** — H1 title fallback exists
  (`src/core/indexer.ts:444`); timeline splitting belongs to RM-19.
- **An in-app PID-1 reaper** — replaced by `init: true` on the compose service
  (RM-03).
- **Git clone/visibility and host-install helpers** — no counterpart on this
  deployment.
- **Per-book long-document fan-out** — no book corpus; revisit when RM-13/RM-15
  need fan-out over one large page.

Closed operator decisions this roadmap does not re-raise:

- **A fixed memory-verb façade over the write tools, and renaming `recall`.**
  RM-12's `context_pack`/`context_delta` are new read-only, public-forbidden
  tools over existing reads.
- **Refused with evidence:** MCP ToolAnnotations; `add_fact` TTL →
  `valid_until`; remote writes defaulting to `visibility=world`; opaque string
  protocol ids; failing a whole batch when every item is invalid;
  read-back-and-throw write verification; renaming `orphans`; downgrading
  web-tree-sitter or using the broken grammar blob package; a pre-auth throttle
  on internal `/ingest`; migrating legacy relative `source_path` rows;
  configurable default fact visibility.
- **Closed:** linter choice (@antfu); instance size t4g.medium (heavy eval and
  agent runs go off-host or are capped).
- **Accepted deviations:** Anthropic via Bedrock plus Titan embeddings only; the
  permanent public bearer (rotation stays disabled); the semantic query-cache arm
  default off; the conservative default search bundle; `'simple'` FTS; the
  facts/takes deviations (fence stripped from chunks, holder default, scoped
  principals floored to world); the MCP-surface deviations (remote
  `get_recent_transcripts`, admin-scoped purge, `think` behind a flag, public
  stats/jobs forbidden).
- **Triaged skips:** drift decisions table, calibration (source_id, holder)
  scoping, conversation-parser LLM cache, features scan, takes-quality eval,
  conversation-parser eval, publish, backlinks materialization, pages→content
  chunks merge.
- **Standing constraints:** no unrequested monitoring, alarms or AWS
  infrastructure (a Guardrail resource, a non-BYPASSRLS role, new secrets or IAM
  are operator-gated); synthesis and agent output only in their own namespaces;
  ship through `/ship`.
- **Still deferred and unscheduled:** jobs-follow, a backfill runner,
  frontmatter tooling, an op-registry CLI (RM-07 builds only the conformance
  runner), a bench trend table, ontology transaction-time history.

### Open operator decisions

1. **First-party Bedrock rerank model.** The "Deferred by stack" table says
   Bedrock has no rerank API, but Bedrock now exposes a Rerank API with a
   first-party Amazon model — closer to the Titan embeddings allowance than to an
   external reranker. EU-region availability is unverified. If allowed, a rerank
   arm with readiness and fail-open stamps plus autocut becomes a phase of RM-11.
2. **Agent runtime go/no-go** for RM-13 and RM-22: **go given 2026-09-19.** The ledger ships with no
   runner (`src/core/subagent_ledger.ts`, migration 021), the `agent` scope is
   unused, `bound_tools`/`bound_max_concurrent` are never read (migration 046),
   and `deploy/skills/minion-orchestrator/SKILL.md:13-15,71` promises subagent
   and shell jobs.
3. **Benchmark spend** for RM-06 (retrieval lane about a dollar of embeddings
   before caching; the judged lane materially more), and whether to run it
   locally or on a disposable environment.
4. **Idea generation and skill optimization** (RM-20 second half, RM-27), and
   wider tree-sitter language coverage (RM-23).
5. **Public graph edge dump revisit.** The 2026-08-15 acceptance of
   `graph_neighbors`/`graph_query` returning raw edges on public ingress said to
   revisit "if the brain ever serves more than one person"; v1.128.0 lets one
   connector serve a team. Tenant tokens are not public-classified and graph
   reads are source-scoped, so the question is who holds the static public
   bearer today.
6. **Entity card by free text.** The earlier refusal named a specific slug-leak
   defect, not the capability; a public-forbidden, grant-scoped card composed of
   `resolve_slugs` + `entity_recall` exposes nothing a caller cannot already reach
   in two calls, and the RM-01 matrix supplies the proof. Reopen inside RM-12?
7. **Life integrations stay removed** (Gmail/Calendar). Recommended default:
   yes. Remnants remain (`src/core/recipe-state.ts`, `mailbox`/`calendar` source
   kinds in migration 004).
8. **Page/timeline FTS arm.** "Deferred real gap (2026-07-07) — page/timeline
   FTS" below calls it high value, while an earlier worklog marked it skipped
   because pages are mirrored into chunks. Decide which record stands before
   RM-11 planning; RM-19 makes timeline text richer.
9. **`MEMRAIN_OAUTH_REQUIRE_LOGIN` on prod.** Owner consent on authorization-code
   connections is desirable, but with Memrain's single operator login the flag
   blocks teammates on an enrollment connector (`docs/CONFIGURATION.md`).
10. **`MEMRAIN_TENANT_FAIL_CLOSED=1` live.** Already set on the host at the
    v1.129.0 deploy (RM-01 live check). Still open: the check with a real
    no-grant client (RM-01).
11. **Revoke unused clients** `operator` and `cloud-app`; the admin bootstrap
    secret.
12. **`MEMRAIN_CONTEXTUAL_LLM=0` experiment** against the eval-probe baseline
    (RM-02).
13. **Also pending:** the 182-day takes grading bar; `synth_takes.holder`
    default `world`; the `MEMRAIN_TOOL_PROFILE` starter set (RM-07); pilot Bedrock
    posture (no Guardrail, invocation logging off, Nova still allowed in
    `terraform/iam.tf`, `us-east-1` in allowed regions).

---


## Claude 5.5 model support — review follow-ups (2026-10-08, v1.0.7)

Found by the review of the 5-generation support. The live stack runs Haiku 5.5
and Sonnet 5.5; dream synthesis (takes) is off there, so none of these fire.

- **MEDIUM — takes judges lose their temperature spread on Claude 5.**
  `synthesis/takes.ts` runs one judge at 0 and the rest at 0.6; the 5-generation
  models reject a custom temperature, so `generationFields` drops it and every
  judge runs at the model default. The stable anchor judge is no longer stable.
  Decide whether to keep the judges on a 4.x model or accept it.
- **LOW — truncation retry assumes temperature 0** (`llm/output-limits.ts`,
  `llm/truncation.ts`). Still correct on Claude 5, but the stated reason is not;
  update the comment when either file is next touched.
- **LOW — tiny `maxTokens` on models that cannot disable thinking.** `intent.ts`
  (8) and `expansion.ts` (120) would get `max_tokens` with no text block on Opus
  5.5 or Fable. Only the deep tier would plausibly point there.
- **LOW — `CLAUDE_5` has no boundary after the 5** (`llm/gateway.ts`), so a future
  `claude-sonnet-50` would match. Tighten it when the next generation lands.

---

## Auth and re-read hardening follow-ups (2026-09-28, v1.155.0–v1.160.0)

- **Four `timur`-owned `/memory` rows carry no `last_indexed_mtime`.** The
  re-read guard refuses them (no source covers `/memory`, and a row without the
  local-read marker cannot be told from a remote label), so they never refresh.
  Clear their owner to NULL, let one sweep re-read them, then reassign — or
  register a source for `/memory` and classify.
- **Maintenance cursors restart at the first path every tick.** `embed-stale`
  and `rechunk-sweep` page past refused rows within a tick (scan budget = 10×
  work cap), but more than that many permanently refused or missing rows ahead
  of the valid ones would still starve the cap. Persist the cursor between
  ticks or mark permanently refused rows. Tenants can no longer create such rows
  under a root, so only operator-side rows count.
- **A source prefix registered in its symlink-resolved spelling while the root
  is configured through the symlink** makes the sweep skip every new file
  (`(none) ≠ S`). Compare labels against canonicalised prefixes too, or warn at
  boot on a prefix/root spelling mismatch.
- **Sweep refusals reach the sweep result (`refused`) but not doctor.** Showing
  them there, and a way for the operator to reclaim a refused path, are still
  open; reclaiming is a design decision.
- **RFC 8707 with a derived issuer.** With `MEMEX_PUBLIC_URL` unset behind a
  TLS-terminating proxy the issuer reads `http://…` and a client's `https://`
  resource gets `invalid_target`. `serve` now warns at boot; relaxing the
  compare to host-only is not done on purpose.
- **An empty `resource=` still reads as absent** at `/authorize` and `/token`
  (`requestedResource` in `http/oauth-endpoints.ts`). Refusing it is stricter
  RFC 8707, but check what the Claude.ai and ChatGPT connectors send first.
- **Basic and body client credentials together are accepted, body winning**
  (`clientAuthFromRequest`). RFC 6749 §2.3 says to refuse; confirm neither
  production connector sends both before changing it.
- **`enroll --replaces` accepts a new source and keeps the spend key and budget**
  (`issueEnrollment` in `core/oauth-provider.ts`). The CLI help documents the
  override as intended; refusing it, or gating it on a flag, is an operator call.
- **A replacement keeps the predecessor's recorded client**, so an any-client
  code's successor is pinned to the connector that redeemed it. Supporting an
  any-client replacement needs a choice: derive it from the issue audit row, or
  add `--any-client` / `client_id: null` to the CLI and admin API.
- **`hnsw.scan_mem_multiplier` / `work_mem` may cap the iterative scan**
  (`core/search/vector.ts`). Unverified; needs `EXPLAIN (ANALYZE, BUFFERS)` on
  live RDS before any change.
- **The candidates-incomplete probe runs for every caller, and
  `max_scan_tuples` is fixed** (`hybrid.ts` always passes
  `onCandidatesIncomplete`). Skipping it for non-operators means plumbing
  caller identity into hybrid; changing the cap needs a p95 measurement on RDS.
- **Refresh reuse inside the grace window does not revoke even when the
  successor was already used** (`REFRESH_REUSE_GRACE_SECONDS`). Deliberate, and
  tightening it could log claude-web out on retry races; a design change.
- **A grant-scoped `invalidate-tokens` bumps the client-wide revision**, which
  retires other grants' pending codes and stops the client's agent jobs.
  Skipping the bump changes audit and agent-job semantics; moving codes to the
  new revision is a design choice. Otherwise document it.
- **The same bump affects other grants on `invalidate-tokens --grant`.** The
  grant-existence half is fixed (an unknown or foreign grant id is `not_found`);
  the cross-grant half waits on the bump decision above.
- **The root protected-resource metadata advertises its own `resource` value**
  (`http/oauth-metadata.ts`). Changing it affects discovery Claude.ai and
  ChatGPT may read; needs an operator decision and a live connector test.
- **`memex index <file outside the roots>` is refused** since `guardLocalIndex`
  falls back to `[sourcePath]` only with no roots configured. Kept as the safer
  behaviour and noted in the CHANGELOG; allowing it means guarding over
  `[canonicalPath]` from `commands/index.ts`, which is the operator's call.
- **`exchangeRefreshToken`/`exchangeAuthorizationCode` are now transactional**;
  the rest of token lifecycle (family ids, reuse detection, PAT `--source`,
  grant_types enforcement) is Batch C of the 2026-09-28 gap report.


## Docs overhaul — README, repository About and images (2026-09-19)

**Why.** The README is the project's front page and it undersells it: long,
text-only, and out of date against what shipped (tenancy, spend caps, secret
redaction, code graph, think). The GitHub About line ("Self-hosted personal AI
knowledge brain -- hybrid (vector + keyword + entity-graph) search over your
notes and code, served to any MCP agent …") is dense and reads as a feature
list rather than a promise.

**Scope.**
- Rewrite README.md top to bottom: a one-line pitch, a hero image, what it
  does in three or four scannable blocks, a diagram of how the pieces fit,
  quickstart, the MCP tool surface, deployment, security posture, and links
  into docs/ — every claim checked against the code.
- Refresh docs/ so nothing in it contradicts the README or the current code.
- Generated images (hero banner, architecture/flow diagram, feature tiles)
  in a consistent style, stored under docs/assets/ with alt text.
- A new repository About description and topics (`gh repo edit`).
- Advice gathered from several models (GPT/Codex, Gemini, Grok, and the
  OpenRouter models configured in deliberation) before writing.

**Done when.** README renders on GitHub with its images, every command in it
runs as written, `make audit` passes, and the About line and topics are set.

## The `[] = no grant` contract is enforced in some layers, not all (2026-09-08)

Tracked in RM-01 (Release A).

The rule is now: `undefined` is the operator (whole brain), an EMPTY array is a
caller granted nothing and must read nothing. It holds in `core/insights.ts`,
`core/synthesis/reads.ts`, `core/synthesis/think.ts`, `core/search/keyword.ts`
and `core/search/vector.ts` — each proved by a test.

It does NOT yet hold end to end in hybrid retrieval. Found by codex, verified
by file:line, deliberately left for its own pass rather than rushed:

- `core/search/query-cache.ts:246` — `queryCacheKey(..., [])` equals the
  unscoped key, so an empty grant can hit a cache entry built whole-brain.
- `core/search/hybrid.ts:548` — cached hydration drops the filter for `[]`.
- `core/search/title-arm.ts:141` — the default-on identifier arm drops it too.
- `core/search/hybrid.ts:971` — final hydration runs unfiltered.
- `mcp/dispatch.ts:3396` — `callThink` collapses an empty `readSources` before
  calling `runThink`, undoing the fix one layer down.

**Closed 2026-09-14 by `6b30d2c` (Release A).** All five sites now hold the
contract: `core/source-scope.ts` centralises it (`andSourceScope` emits
`AND FALSE` for a no-grant scope), `query-cache.ts` keys `[]` distinctly from
`undefined`, `title-arm.ts` and both hydration paths go through the helper, and
`dispatch.ts` forwards an empty `readSources` instead of collapsing it. The
paragraph above is kept as the record of what was open; it no longer describes
the code. The item stays under RM-01 until the full isolation matrix signs off.

## Derived writes carry the caller's source on three page paths (2026-09-08)

Tracked in RM-01 (Release B).

`page_put` now hands every derived writer the PAGE's source, so an unscoped
operator write cannot re-home a tenant's links, facts and watermark to
`default`. The same argument is still the caller's on:

- `mcp/dispatch.ts:1562` — `page_append`
- `mcp/dispatch.ts:1667` — `page_revert` (omits the source even when scoped)
- `mcp/dispatch.ts:1639` — `page_restore` (unscoped facts reconcile)

And the delete/restore version markers (`core/pages.ts:739`, `:807`) insert no
`source_id`, so a named-source page gets `default`-owned audit rows that its
own scoped version read then misses.

Also missing: a two-writer contention test for the indexer conflict predicate.
The NULL-owner refusal is covered; the race itself is argued from the SQL, not
demonstrated.

## Operator tags land in `default`, invisible to the page's owner (2026-09-08)

Tracked in RM-01 (Release B).

`addTag` stamps `source_id` only when the caller names one, so an UNSCOPED call
(local CLI, internal token, `add_tag` with no write source) writes the tag under
the column DEFAULT `'default'` — even when the page it tags belongs to another
source. Migration 059 makes that a second, legitimate row rather than a
collision, so nothing errors. The owning tenant then never sees the tag through
a scoped `getTags`, because the read filters on ITS source.

Harmless on this single-operator brain, where every page is `default` anyway.
It becomes wrong the moment a second tenant holds pages: the operator tags
something and the tag silently disappears from the tenant's view.

Decide which rule is intended before that happens — either an unscoped write
inherits the page's owning source, or it keeps stamping `default` and scoped
reads union in `default`-owned tags. Then test the chosen one explicitly. Found
by codex while reviewing the mig-059 test, 2026-09-08.

## Cross-tenant slug enumeration (2026-09-07)

`page_put` distinguishes "slug owned by another source" (`permission_denied`)
from "slug is free" (`ok`), so one tenant can probe which slugs exist in
another. Low severity on its own — it leaks the existence of a slug, never
content — but it is the discovery half of the `index` overwrite fixed in
v1.124.0, so it should not stand indefinitely.

Closing it properly means `pages.slug` stops being a global primary key
(migration 015) and becomes `(source_id, slug)`, which touches every read path
that resolves a slug plus `slug_aliases`, merge and rename. That is a schema
migration, not a patch — plan it deliberately rather than bolting a generic
error onto `putPage`, which would only move the oracle to a timing difference.

## Page mirror path collision (2026-09-08)

`pageSourcePath()` encodes the tenant only for a non-default source: a default
page mirrors to `page://<slug>`, a tenant page to `page://<src>/<slug>`. So a
default-tenant page slugged `<src>/<name>` produces the byte-identical mirror
path to source `<src>`'s page `<name>` — verified:
`pageSourcePath("a/secret", "default") === pageSourcePath("secret", "a")`.

Impact is availability, not disclosure: the document row still carries exactly
one `source_id`, so a scoped search never crosses over. What happens instead is
that the loser's page never gets a usable mirror and `reconcilePageMirrors`
retries it forever through its `d.source_id <> p.source_id` staleness arm.

The v1.124.0 index ownership fence is what blocks the overwrite, so do NOT
widen that fence to quiet the reconcile noise — that would reopen the hole. A
real fix either changes the path scheme (and re-mirrors the corpus) or refuses
a new default-tenant slug whose first segment names an existing source. The
second is cheap but would reject slugs that are legal today, so it needs a
migration-time audit of existing pages first.

## Spend ledger — remaining approximations (2026-09-08)

Enforcement landed in v1.126.0; these are the known edges, none of which
affects an uncapped client:

- While a `withClientSpend` op is in flight its reservation hold AND the rows
  its own paid calls book both count toward the day. The over-count is bounded
  by the op's estimate and clears at settle, and it errs toward refusing rather
  than overspending — but a client sitting exactly at its cap can be refused a
  few seconds early.
- `bookSpend` still swallows a failed ledger INSERT (accounting must never break
  a paid path). That spend is then invisible to the cap. Rare, but it means the
  cap is best-effort under database trouble, not a hard guarantee.
- The reservation's `actual_cents` is written and read by nothing. Either
  surface it in the admin spend report or drop the column.

## Multi-install audit follow-ups (2026-08-31)

Found by comparing a fresh `ingress_mode=caddy` install against the
reference `cloudflare` one. The compose-file-set, admin-token,
systemd-region and tunnel-secret defects from that audit are fixed in
v1.124.0; these are the ones left open on purpose.

- **Gate `cloudflared` behind a compose profile in the base file.** Today
  the parking lives only in the Caddy overlay bootstrap writes, so the
  base `deploy/docker-compose.yml` still declares a startable
  `cloudflared`. Giving it `profiles: ["cloudflare"]` and having
  bootstrap emit `COMPOSE_PROFILES=cloudflare` in that mode is the
  structurally correct fix — deferred because it changes what a bare
  `up -d` starts on every existing cloudflare install, which needs a
  deliberate deploy rather than a drive-by.
- **No alarm path on a fresh install.** `alarm_email` defaults to empty,
  which count-gates the SNS topic away, so `terraform/cloudwatch.tf`
  has nothing to notify. Neither memex instance carries a
  StatusCheckFailed alarm (the one in the reference account belongs to a
  sibling service). Decide the shape first — per CLAUDE.md, monitoring is
  not to be added unrequested.
- **No HTTP access logging on the Caddy path.** Reads cannot be
  attributed to a person, which a shared multi-user brain eventually
  needs. Caddy `log` block + a retention story.
- **Per-tenant sources for a shared brain.** A pilot with several users
  currently shares one `default` source: everyone reads everyone. Fine
  while that is the stated deal, but `auth register-client --source`
  already supports the split — document the migration before a brain
  accumulates content that has to be re-attributed.
- **The shipped systemd units hardcode `/opt/memrain`** in both `ExecStart`
  and the new `EnvironmentFile=`. With `project_name != memrain` the `-`
  prefix makes the env file silently absent — no region, no warning.
  Same class of bug as the hardcoded region they replaced; fixing it
  properly means templating the units at bootstrap rather than shipping
  them as static files.
- **`aws_efs_backup_policy` needs `backup:*` + `iam:CreateServiceLinkedRole`**
  on first use. An apply run by a least-privileged terraform principal
  will fail until those are granted.
- **S3 backend has no state locking** and `encrypt = true` is easy to
  omit — `backend.hcl.example` sets it, a hand-written one may not.
  Worth a preflight check in `scripts/init.sh`.

## Lint backlog (2026-08-13) — CLOSED 2026-08-14

A linter was run over the daemon source for the first time. The raw run reported
2375 problems; roughly 2000 were house conventions this codebase made
deliberately (bracket env access, import order, `require("process")` in an ESM
Bun daemon), and `eslint.config.js` turns each of those off with its reason
written next to it. That left 250, measurable with `make lint-ts`, and they are
now **0**.

**The entry that stood here said "zero defects" and it was wrong.** The reason is
worth more than the correction: the sample was eight patterns, measured in
isolation. Widening to 48 sites and driving the REAL exported functions instead
of the bare regexes found seven genuinely quadratic scans, all reachable at the
input sizes the code itself permits — the worst held the daemon for 243 seconds
on a 1 MB body. Finishing the sweep took the total to 70 sites measured: 38
linear, 32 quadratic and fixed.

Rules for anyone re-opening this:

- **A disable must carry a measurement, and the measurement must come from the
  exported function.** Isolated numbers are evidence of nothing. One site read
  7.8 s standalone and 12 ms in situ. Another was wrongly CLEARED because the
  benchmark used a `-` run that an earlier `.replace()` collapses — the
  alternating `-/-/` run that survives it takes 20 s at 200 K.
- **Bound the class; atomic groups do not help.** When a negated class does not
  exclude the characters the input is built from, the run walks to the end of
  the body from every start position. That forward walk is the cost, not the
  give-back. Tried twice on `links.ts`, measured as still quadratic both times.
- Most of the 32 needed no invented bound at all: a redundant `\s*` that the
  neighbouring unbounded run already subsumed, deleted. Equivalence was proved
  before each edit against curated plus fuzzed corpora, zero output differences.

The two super-linear rules stay at `error`. They earned it, and they earned it
again the same day: a super-linear pattern written in new bench code was caught
at the moment it was written.

The four `no-dupe-disjunctions` / `no-contradiction-with-assertion` findings were
checked against 3,019 targeted strings plus 300,000 fuzz cases: all four were
harmless redundancy, none changed an outcome. Three real slips were fixed: a
`timeout` alternative already covered by the `timed?\s?out` beside it, `round`
listed twice in one alternation, and a module imported on three separate lines.

Cost: +86 MB of node_modules, 28 top-level packages to 281.

## Open — push-bench follow-ups (2026-08-12)

The push benchmark (v1.119.0) shipped with one metric family. Recorded here
rather than left implied:

- **Two extraction blind spots it found**, pinned as expected misses in
  `src/core/bench/corpus/extraction-blind-spots.json`: an all-lowercase mention
  produces no entity candidates at all, and a sentence-opening capitalized
  stopword glues to the name (`"Did Dana ever hear back"` → candidate
  `"Did Dana"`), which fires for any `Did/Can/Will/Should <Name>` phrasing — a
  very common user shape. Fixing either SHOULD break the pinned scores; update
  the pin, not the label.
- **Two of the three missing families are now built** (2026-08-14, BENCH-1):
  cross-session continuity and write-back fidelity, both scored beside push and
  both reusing `scorePush` unchanged. Know-to-ask as a paired rate is covered by
  the existing miss/false-fire pair.
- **A CLI exists (`memex bench`); persistence deliberately does not.** A trend
  table with no reader, no doctor check and no advisor collector is a table that
  is only ever written to, so it waits until something would read it. The shape
  is sketched in the BENCH-1 spec if that day comes.
- **[BENCH-2, S] `memex bench` is not free on a host with fact dedup enabled.**
  The first live run booked 4 embedding calls, $0.0018, and reported it:
  `4 paid model call(s) were booked during a stub run — the arm that made them
  is not stubbed`. The guard works; the stub is incomplete. Only `sonnetFn` (the
  extractor) is injected, but `addFact` embeds each fact to fetch dedup
  neighbours whenever dedup resolves — `resolveDedup`, core/facts.ts:233-255,
  which fires on `input.dedup` OR `factsDedupEnabled()` (core/facts.ts:208).
  Local runs and CI are free because dedup is off there, which is exactly why
  the test suite did not catch it.
  The fix is an `embedFn` seam on `ExtractConvFactsOptions` beside `sonnetFn`,
  threaded to the `dedup` option `persistFacts` already forwards
  (core/facts-extract.ts:493, :552), and the bench passing its deterministic
  `benchEmbed`. Do NOT close it by disabling dedup for the run: dedup is part of
  the write behaviour being graded, and switching it off would make the score
  describe a pipeline nobody ships.
  Not done same-day on purpose — it lands in the path that decides whether a
  fact collapses into an existing one, and that is not a change to make without
  its own review and full suite.
- **Open call, with a number on it.** Widening the fixture reset from 3 tables
  to 14 (it had to widen — the old list left `entity_facts` rows behind, proved
  by replay) costs +135 ms on the push corpus and +17% on its test file, because
  PGLite rewrites relation files per table regardless of rows. A selective
  truncate that skips empty tables recovers essentially all of it (14.0 ms vs
  34.5 ms per call, measured) but skipping a table also skips its RESTART
  IDENTITY, and fidelity's `fact:<n>` handles depend on ids restarting. Not
  taken unilaterally.

## New candidates — 2026-08-11 sweep

Surfaced after the 2026-08-10 backlog was frozen. CLI-4 shipped in v1.112.0;
BENCH-1 SHIPPED 2026-08-14 — continuity and write-back fidelity now have
numbers beside the push family, run by `memex bench`. It MEASURES its own spend
rather than asserting zero, which is what surfaced BENCH-2 above on the first
live run.

- **[BENCH-1, L] SHIPPED.** Nothing measured the agent-facing behaviour of the
  brain — only its retrieval. `eval-probe` scores hit-rate and rank over a golden
  query set into `eval_snapshots`, which grades *search*. It says nothing about
  the four things an MCP client actually experiences: whether volunteered
  context is precise and complete (`push_precision` / `push_recall` over
  gold-labelled turns), whether the brain surfaces something when it should and
  stays silent when it should not (a failure rate paired with a false-fire rate,
  so "always inject" cannot game the score), whether a decision written in one
  session is recalled in a later session through a *different* client
  (continuity), and whether the conversation→memory write-back preserves the
  facts it claims to (fidelity, gradeable with a stubbed gold extractor so the
  shipped pipeline runs end to end at zero LLM cost, with an opt-in live-model
  mode for extraction precision/recall).
  - Why it matters here: memex already ships every mechanism being graded —
    `volunteer_context`, push-context, `extract-conversation-facts`,
    `source_session` — and none of them has a number attached. A regression in
    injection quality is currently invisible.
  - Shape: fixtures of labelled turns + one in-memory PGLite reused across the
    whole run with table resets between fixtures (per-fixture WASM cold boots
    blow any CI budget — the same heap-growth constraint that forces
    `test:sharded`), plus a scoreboard. Deterministic and free by default.

- **[CLI-4, S] SHIPPED v1.112.0.** `--help` on a subcommand errored instead of printing help.
  Verified 2026-08-11: `memex search --help` → "`<query>` is required",
  `memex jobs --help` → "subcommand required", `memex auth --help` → a usage
  line on stderr with a non-zero exit. `doctor --help` and `embed --help` are
  fine, so the handling is per-command rather than central. Intercept `--help`
  in `parseArgs` before required-argument validation.

---

## Open — no surface reports what the advisor counts (2026-08-11)

Two advisor findings count a condition no command or tool can list, which is why
both of their `fix_command` pointers were wrong twice over — every candidate
measures an adjacent but different set. The findings now state the condition in
`detail` and carry no fix_command. Closing this properly means giving each
condition a first-class surface:

- **Islanded pages.** Advisor counts a live page with no live inbound AND no
  live outbound link. `find_orphans` (core/insights.ts:117-127) checks only
  `NOT EXISTS (SELECT 1 FROM links WHERE target_slug = p.slug)` — it ignores
  outbound links entirely and does not require the linking source to be live.
  Either widen `find_orphans` with an opt-in `strict` mode matching the advisor
  definition (additive, no wire break), or add a dedicated surface.
- **Dead links.** Advisor counts a `links` row whose source is a live page and
  whose target has no live page. `memex reconcile-links` compares wikilink
  ENTITIES against DOCUMENTS — different tables, different condition, so it can
  report clean while the count stands. Needs its own check, most naturally a
  doctor probe (this is the DOC-1 shape).

Found by the cross-model review pass, after two in-house rounds had accepted the
wrong pointers.

## LOW backlog (CLI, 2026-08-11)

- **`-h` never reaches the short-help branch.** `src/cli.ts:536` tests
  `flags.has("-h")`, but `parseArgs` only collects `--`-prefixed tokens, so a
  bare `-h` lands in `positional` and the branch is dead. Either accept `-h` in
  the parser as an alias for `--help`, or drop the branch. Pre-existing.

## LOW backlog (millisecond-tie orderings, 2026-08-10)

`listFacts` was fixed to end every ordering in `id DESC` — `written_at` is
`DEFAULT NOW()` at millisecond resolution, so rows written in the same
millisecond tie and the scan decides the order. The same pattern is still
open in six sibling queries; none is asserted by a test today, so each is a
latent flake plus an agent-visible "most recent" that isn't stable:

- `core/hot_memory.ts:192` (`effective_confidence DESC, written_at DESC`) and
  `:237` (`written_at DESC`) — the latter feeds the `_meta.brain_hot_memory`
  injection, i.e. the "most recent" an MCP client sees.
- `core/links.ts:420`, `core/links-read.ts:74`, `:82` — `links.written_at`
  (migration 016).
- `core/cycle/embed-facts.ts:55` and `core/cycle/consolidate-facts.ts:225` —
  the exact `entity_facts.written_at DESC` pattern just fixed in `listFacts`.

Each is a one-line `, id DESC` append. Batch them rather than one at a time,
and note the same index caveat: `(entity_slug, written_at DESC)` no longer
satisfies the ordering on its own — immaterial at these table sizes.

---

## Open — legacy relative source_path rows (2026-08-14)

Ingest now canonicalizes a FILE path to absolute, so this cannot recur. Rows
written before that keep their old key, and `docId` hashes `source_path` — so
the next index of such a file writes a SECOND row and the first lingers,
searchable and invisible to the absolute-path disk probe.

No migration, and the reason is not laziness: the cwd an old relative path was
relative TO is unknowable after the fact, so resolving it would fabricate a
path that never existed.

`orphans-purge` now reports the candidates in `docs_with_relative_source_path`.
That list deliberately does NOT move the phase status. Path shape cannot tell a
legacy file row from a supported one — the inline MCP write (`index` with
`sourcePath` + `text`) keeps the caller's own label by design, and the live
brain holds three such rows today (`ops/…`, `memex/…md`). Escalating on shape
would pin the cycle at warn forever on a healthy corpus, which is the same
false-positive this phase was fixed for once already.

Closing it properly needs a signal the shape does not carry — an ingest-route
marker on the row, or an operator pass that re-indexes the file rows by
absolute path and drops the stale ones. Found by the cross-model review; the
warn-escalation version was written, measured against prod, and reverted.

## Review-accepted follow-ups (2026-08-02 triple review: security + retrieval + correctness)

Findings from the v1.106.0 review pass that were deliberately accepted or
deferred (everything CRITICAL/HIGH and one-touch MEDIUM was fixed in the
same batch):

- **Contextual re-embed uses the deterministic tier only.** The backfill
  re-wrap cannot reproduce an LLM-blurb prefix (the `contextual_embedded`
  marker records no tier), so a re-embed of an LLM-tier chunk downgrades it
  to the deterministic prefix. Recording the tier needs a column; until
  then `reindex --contextual --force` re-runs the configured tier.
- **Phantom flattened entity keys are not backfilled.** Facts previously
  keyed under `people-bob` (the flattened form of `people/bob`) stay under
  the old key until the source page's facts re-extract; a merge migration
  cannot distinguish genuinely-hyphenated entities from flattened paths.
- **ANN boost/max-pool orderings defeat HNSW.** The curation-boost and
  max-pool arm variants order by expressions the index cannot serve (full
  scan); the ef_search raise deliberately skips them. Emitting the plain
  `ORDER BY vector <=> $1` when the curation map is empty would restore
  index service for the common case — measurable, larger change.
- **Unpriced (non-Claude) synthesis model now skips paid phases** at the
  pre-flight with "budget exhausted" instead of running and failing at
  settle. Bedrock-Claude-only is the standing posture, so this is the
  intended fail-cheap direction; revisit only if the model roster widens.
- ~~**`pg_trgm` similarity over non-Latin slugs depends on DB locale**~~ —
  VERIFIED on the live RDS 2026-08-03: `similarity()` over a Cyrillic slug
  pair returned 0.46 (non-zero), so the trgm canonicalize stage works for
  Cyrillic slugs. Closed.
- **Alias claims are not fenced per client** — an in-prefix page can claim
  an alias norm an out-of-prefix page owns; `resolveAliasUnique` then
  returns null for both (silent mutual kill). Low blast radius; needs an
  ownership rule in `setPageAliases`.
- **DCR (`MEMEX_ENABLE_DCR_INSECURE=1`) mints unbounded clients** — with
  the flag on, self-registration sidesteps the slug fence by design.
  Default-off; the flag's name already carries the warning.
- **Chat importer emits no per-message ids** — the conversation-parser
  body format has no citation lane; `conversation_id` frontmatter is the
  provenance anchor for now.

## Deferred sweep tail (2026-07-27)

- **`set_take_status` can flip a zero-yield memo into a belief.** The memo the
  takes phase writes for a document that extracted no claims is fenced out of
  every read that lists or counts takes, but `set_take_status` addresses a row
  by `take_key`, so a caller that knows (or recomputes) a memo's key can mark it
  `accepted`; `recompute-salience` then counts it because it ignores `active`.
  No surface hands that key out, so this needs the caller to derive the hash
  itself — internal-only, not a leak. Closing it means either fencing the
  mutator or teaching salience the `active` axis, which widens the diff past the
  batch it was found in. Deferred deliberately.
- **A forced re-index re-pays one atom extraction.** The indexer replaces
  `documents.frontmatter` wholesale, so a rechunk or re-embed of unchanged
  content clears the `atoms_scan_hash` stamp and the phase scans that document
  once more. This fails in the safe direction (a re-scan, never permanent
  suppression); revisit only if
  forced re-indexes become routine.

## Chronicle follow-ups (2026-07-12 session, deferred small tail)

- **Chronicle CLI read commands.** `chronicle_day`/`chronicle_since`/
  `chronicle_last_seen`/`ontology_get`/`volunteer_chronicle` exist as MCP ops
  only; `memex day <date>`-style CLI wrappers deferred (MCP-first surface;
  add when terminal ergonomics matter). `memex eval chronicle` and
  `capture --type diary/event` DID land.
- **Ontology transaction-time history.** `valid_from`/`valid_until` model
  valid time; a superseded row's update is not itself versioned
  (`recorded_from`/`recorded_until`). Append-only revisions would allow
  "what did the brain believe last Tuesday" queries. Deliberately skipped —
  day-granularity valid time covers the agent use cases; revisit if a
  calibration/audit need appears.
- **`export.ts` containment via realpath.** Export path containment uses a
  lexical `resolve().startsWith` check; the shared realpath-both-sides guard
  would also defuse symlinked export targets. Low risk (operator-only
  surface), small change.
- **Empty-env hardening tail.** `MEMEX_PATTERNS_REFLECTION_PREFIX` (empty →
  empty prefix after trim) and `MEMEX_HOST`/`MEMEX_BRAIN_PORT` CLI reads
  tolerate `""` oddly; same class as the fixed AWS_REGION reads, lower blast
  radius.
- **Chronicle boost floor.** The temporal-mode chronicle lift rides the
  existing post-fusion multiplier chain without a separate floor threshold;
  memex's arm-survival gating is the equivalent guard today. If ranking
  regressions surface on temporal queries, add a floor before the multiplier.

---

## Prod-audit findings (2026-07-07 session 2)

A live prod audit (SSM → container + RDS) found prod **healthy and in sync**:
container healthy/running/restarts=0 (OOM resolved, cycle rss 122MB), doctor all
green (brain 12/0, ops 7/0), migrations prod hi=94 == code 094, 0 NULL-source
docs, 8 sources, no errors in 24h logs. Follow-ups surfaced:

- **[DONE 2026-07-10] Prod git is missing recent tags.** `git -C /opt/memex
  fetch --tags` run on the live host; `git describe` now reports `v1.98.0`.
- **[DONE 2026-07-10] Cycle soft warns — investigated, one real bug fixed.**
  `lint=warn` is accurate data reporting (700/712 vault docs lack `tags:`
  frontmatter, 89-91 lack title/created/updated) — working as intended, the
  warn IS the report; clear it by fixing vault frontmatter, not code.
  `orphans-purge=warn` was a real false-positive bug: the phase disk-probed
  EVERY `documents.source_path` including virtual rows (`page://`,
  `page-truth://`, `gmail:`, `gcal:`) that never exist on disk → perpetual
  flags. Fixed: only absolute paths are probed (orphans-purge.ts).
- **[RESOLVED 2026-07-13] `source_grants=0`.** Moot: the brain is
  single-person by decision — the second tenant was removed from prod and the
  `source_grants` table dropped (migration 098).
- **[DONE 2026-08-14] Relative-path docs skip orphan disk-probe.**
  `memex index foo.ts` persists the caller's relative source_path unchanged;
  the orphans-purge disk probe now only checks absolute paths, so a vanished
  relative-path file is never flagged. Right fix = normalize to absolute at
  ingest (indexFile/callIndex), not in the probe. Rare (operator ingests use
  absolute paths / schemes); do when touching the ingest path.
- **[DONE 2026-08-14] Legitimately-empty code files still produce
  zero-chunk docs** (fallback requires non-blank text), so a tracked empty
  file keeps `orphans-purge=warn` alive. Consider excluding 0-byte sources at
  sweep time or exempting empty-content docs from the zero-chunk flag. None
  exist on prod today.
- **[DONE 2026-08-14] Code sweep is not chunker-version-aware.**
  `sweepCodeRoots` mtime-skips unchanged files, so a CODE_CHUNKER_VERSION bump
  drains only via a manual `reindex --source code --all`. If bumps become
  regular, teach the sweep to force files whose doc rows are version-stale
  (listStaleChunkerDocIds ∩ walked paths, like the vault sweep's
  forceStaleChunker).
- **[LOW — re-scoped 2026-07-10] Typecheck debt is toolchain drift, not 2 files.**
  `bunx tsc --noEmit` now reports 56 errors across src+tests — `typescript` is
  pinned `^5.6.0` but bunx resolves 5.9.3, and `@types/bun: latest` floats
  (Dirent<NonSharedBuffer>, `toWellFormed` wants lib es2024, ParameterOrJSON).
  Runtime unaffected (bun strips types; CI has no tsc gate). The two
  real-looking smells were hand-verified false alarms: `subagent_ledger.ts:225`
  is a deliberate runtime guard against untyped callers; `jobs/dag.ts:273` is
  index-access strictness with correct bounds. Close by pinning typescript +
  bumping tsconfig lib to es2024 in one hygiene pass — not urgent.

---

## Test coverage follow-ups (2026-07-06)

- **Reranker candidate-window promotion — functional test.** `MEMEX_RERANK_WINDOW`
  widens the two-pass rerank window so a hit fused below `k` can be promoted into
  the returned set. The cache-signature plumbing is tested; the promotion itself
  is only verified by review. A functional test needs `hybridSearch` with both
  the query embedder AND `two-pass.rerank` stubbed (via `mock.module`) to inject
  a permutation that lifts an item originally at rank >k, <window into the top-k.
- **DB pool/statement-timeout factory branch.** `positiveIntEnv` +
  `MEMEX_PG_POOL_MAX` / `MEMEX_PG_STATEMENT_TIMEOUT_MS` wiring in
  `engine/factory.ts` has no direct test (trivial env-parse mirroring the
  existing `QUERY_EMBED_TIMEOUT_MS` pattern; would assert garbage → default).

## Deferred by stack — future upgrade paths (2026-07-04)

Capabilities memex deliberately does NOT
build today, because each is blocked by a stack constraint or a standing
architecture decision — NOT because they were overlooked. Documented here with
the exact condition that would unblock each, so a future session neither
re-litigates the decision nor accidentally builds it. Everything else that was
buildable has been shipped (see CHANGELOG).

| Capability | Why deferred (blocker) | What would unblock it |
|---|---|---|
| **Cross-encoder reranker tier** | Bedrock exposes no rerank API. A true cross-encoder needs a rerank model memex can't call under the AWS-Bedrock-only rule. | AWS shipping a Bedrock rerank model, OR relaxing the AWS/Anthropic-only rule to allow an external reranker. Today substituted by a paid Haiku index-reorder + Sonnet graph-rerank (both default-OFF) — capability present, mechanism different. |
| **Autocut** (score-cliff result sizing) | Depends on a real cross-encoder score cliff; RRF has only mechanical decay, no trustworthy separatrix. | Falls out for free once a cross-encoder tier exists (above). Substitute today: intent-capped adaptive-return. |
| **Image / multimodal + `search_by_image`** | Titan Text Embeddings v2 is text-only (1024-dim); the AWS-only stack has no multimodal embedder wired, and there is no image-asset substrate. | **AWS-buildable** — Titan Multimodal Embeddings G1 (native Bedrock, no rule change) + an image-asset page substrate + an image-embedding column + `search_by_image`. Worth doing IF an image corpus ever exists; no rule reversal needed. |
| **Anthropic-only constraint itself** | Operator decision (2026-07-01): only Anthropic via Bedrock (Haiku/Sonnet) + Titan embeddings. Any feature needing a non-Anthropic model (external embedder like ZeroEntropy/Voyage, external reranker) is out. | An explicit operator reversal of the Anthropic-only rule. Firm today. |
| **Minion / server-side subagent runtime** | memex has no multi-agent server runtime by design; it implements minion loops as a SINGLE Sonnet/Haiku call or onto memex's own durable job queue. | Only if a server-side multi-agent runtime is ever wanted (large architectural add). Approved 2026-09-19 as an opt-in, spend-capped runtime (RM-13, RM-22). |
| **Schema-pack "cathedral"** (9 MCP ops + `schema-suggest` phase: typed-schema authoring, lint, graph, mutations) | A whole typed-schema-authoring subsystem memex deliberately skipped; a personal AWS brain uses a fixed type list, so ~0 payoff for a large surface. | Only if memex ever exposes operator-authored schema packs to multiple tenants. Deferred by scope, not blocked by stack. |
| **File / S3 / raw-KV substrate + storage tiering** | memex is DB-canonical by design (RDS + EFS) rather than filesystem-first (a local markdown vault). | A decision to add an object-store tier (S3) for large/binary assets. Not needed for the DB-canonical model. |
| **git-sync / federation / federated reads** | Operator deferred (future, not now) — needs a sync/federation model memex hasn't provisioned. | Explicit go on multi-brain federation. Deferred. |
| **`skillopt` self-optimizing skill phase** | Adjacent to a skill-distribution subsystem memex doesn't run; default-OFF paid feature not ported. | Only if the skill subsystem grows a self-optimization loop. Low priority. |

Value-1 items intentionally left unbuilt (zero consumer on a text-only brain):
`image_of` `![[img]]` edges; calibration SVG charts / pattern drill-down admin.

---

## Deferred (v1.81 line-by-line review, 2026-07-06)

- **takes-fence.ts:415** — upsertTakeRow/supersedeRow re-render the fence from
  parseTakesFence output only, so a row the parser SKIPS (unknown kind,
  non-numeric weight, dup row_num, <6 cells) is silently dropped from the
  markdown source-of-truth. Preserve unparsed rows verbatim before deferring
  to the parser. (Low blast radius: operator hasn't authored fence takes yet.)
- **nudge.ts** — nudgeOnTakeCommit / evaluateAndFireNudge (mig-074) have NO
  production caller; the take-commit bias nudge is dead until wired to a commit
  hook. Default-off feature, no behavior today.
- **takes-canon.ts:125 / takes-fence.ts:395 (LOW)** — resolveTake source guard
  joins documents.id=source_ref (fence takes store a page slug there, not a doc
  id); renderTakesFence rounds resolvedValue via formatWeight (2 dp) — corrupts
  fractional resolution values. Fix when fence-authored takes go live.
- **conversation-facts-backfill.ts:155 (LOW)** — worth-gate `gate.kept.has(p.slug)`
  keys on slug only; two same-slug pages in different sources collide in the
  gate. Use a (slug, source_id) composite ref.
- **volunteer.ts:174 (LOW)** — priorContext suppression uses substring
  `includes(p.slug)`, so a short slug that is a substring of a longer one is
  wrongly suppressed. Match on token boundaries.
- **contradictions.ts:316 (LOW)** — Stream-3 orphan take coalesces missing doc
  tenant to 'default'; a foreign-tenant take could pair. Skip orphans instead.
- **search-stats.ts:267 (LOW)** — runSearchTune JSON prints applied commands
  before they run; label as "proposed" in report-only mode.

## LOW backlog (v1.81 cycle-3 verify, 2026-07-06)

- **mig 085 entity_facts_superseded_by_fkey has no ON DELETE action** — a
  hard-delete that removes a fact still referenced by a tombstoned row's
  superseded_by now FK-violates where it succeeded pre-085. Add ON DELETE SET
  NULL (or CASCADE) when a purge path exercises it.
- **postgres.ts onnotice is a no-op** — migration NOTICEs (082 RLS trigger
  skipped, 092 repaired/skipped counts) are invisible on live RDS deploys.
  Route NOTICE to the migrate log so the operator can confirm 082/092 outcomes.

## LOW backlog (v1.81.0 build review, 2026-07-06)

- **Budget caps are opt-in**: `oauth_clients.budget_usd_per_day` defaults NULL
  (unlimited); neither register-client nor the admin API sets one at mint.
  Consider a conservative default for new clients.
- **Spend settle trusts the handler's self-reported spentUsd**; error paths
  release the reservation without logging actuals — the daily ledger
  undercounts on failures. Settle from the tracker's actuals instead.
- **Cf-Connecting-Ip is trusted for rate-limit keys and public/internal
  classification** (ingest + public_guard). Safe only while the origin is
  reachable exclusively via the Cloudflare tunnel — the invariant is
  documented, not enforced.
- **/ingest limiter consumes a token before auth** — unauthenticated 401s can
  drain a shared-NAT bucket. Key on client_id post-auth.
- **set_take_status is not holder-gated** (write-source-scoped only): a token
  whose allow-list hides a take can still accept/reject it by key.
- **gradeTakes evidence for NULL-source takes runs an unscoped hybrid search**
  (operator fence/think takes) — judge sees whole-corpus text; reasoning rows
  are operator-visible only, so impact is contained.
- **Admin-minted PATs are tenant-unscoped by default** (Agents page /api-keys)
  — matches CLI default; mint with permissions.source_id when the Agents UI
  grows a tenant picker.
- **take-commit nudge module (mig 074) wired only to set_take_status accepts**
  via fence sync; fence-authored commits are not yet nudged —
  broaden when operator-authored takes become the primary path.

## LOW backlog (PAT port review, 2026-07-05)

- **`permissions.takes_holders` is stored but not yet enforced at read time**
  — per-token takes visibility is not enforced; memex currently gates
  takes ops operator-only, so the allow-list is dormant. Add the enforcement
  half if takes ever open to tenant tokens.
- **Legacy PAT verify grandfathers `['read','write','admin']`** ignoring the
  stored `scopes` column. Harmless while no MCP op
  requires `admin` and operator-only tools gate on `authInfo === undefined`;
  tighten both together if that changes.
- **`auth create` name uniqueness is check-then-insert** (no partial unique
  index on active names). Racy only
  under concurrent operator CLIs; add `CREATE UNIQUE INDEX ... ON
  access_tokens(name) WHERE revoked_at IS NULL` if it ever matters.
- **No `auth test <url> --token` command** (remote MCP
  smoke test; we verify via curl in the ship loop instead).
- **/mcp bearer verification does 2 unauthenticated hash lookups per garbage
  bearer** with no per-IP limiter (unlike /token, /register). Indexed lookups;
  add a limiter if abuse shows up in mcp_request_log.
- **Verifier DB outage surfaces as 401** (fall-through) rather than a
  500 — cosmetic error-path choice.

## LOW backlog (v1.78 review notes)

- **`insights.ts` `computeDriftScore` cosine length-mismatch → max drift.** A
  mixed-dimension embedding ledger (after a dim migration) would read mismatched
  pairs as drift_score 1. Harmless while the embedding dim is uniform; guard if
  `MEMEX_EMBED_DIM` is ever changed on a live corpus.
- **`remediation.ts` per-run budget: over-cap action `continue`s** (a cheaper
  later action can still enqueue) rather than stopping, and the "already pending"
  heuristic can double-count `est_usd`. Queue `ON CONFLICT` prevents real dup
  rows; refine to a hard stop + de-dup on est if remediation is used heavily.
- **`enrich_thin` / `drift` idempotency is a per-tenant cooldown, not per-item.**
  A 12h phase cooldown bounds repeated paid spend, but the fully-idempotent form
  is a per-item last-processed watermark (a small migration) so a resolved item
  is never re-judged even within the window.

## LOW backlog (v1.76 review notes)

- **`memex export` frontmatter round-trip is lossy.** The emitted header carries
  only `title` + `type`, and the title `needsQuote` check omits newlines, a
  leading `-`/`?`-space, and bare `true`/`false`/`null`/numeric titles — those
  don't re-parse to the same string/type. Rare; the export is a
  backup/portability dump, not a lossless serializer. Widen the quoting rule (or
  emit the full frontmatter) if round-trip fidelity ever matters.

---

## 2026-07-02 — capability + tiers session (v1.57 → v1.72) DONE

Shipped + live-verified this session (see CHANGELOG for each):
- Multi-tenant read+write isolation complete (leak-close, contract harness,
  destructive-op scoping, write-time canonicalizer, links/tags source_id keys
  mig 059, write fail-closed, gazetteer scoping).
- Only-Anthropic-via-Bedrock (Nova removed → Haiku utility, Sonnet paid).
- All paid slices live + a bug fixed (empty `MEMEX_FACTS_MODEL` refused spend).
- **Contextual retrieval complete**: deterministic wrapper + `reindex --contextual`
  whole-corpus re-embed + PAID per-chunk Haiku LLM tier (`MEMEX_CONTEXTUAL_LLM`) +
  **Bedrock prompt caching** (~3x cheaper re-embed).
- **Quality/cost tiers** documented (Free/Balanced/Max); `MEMEX_RERANK` allowlisted;
  `init.sh` defaults to Max; operator's prod on Balanced (`GRAPH_RERANK=0`+`RERANK=1`).
- Monthly cost forecast (~$80/mo Balanced prod; ~$141 Max). CI time-bomb fixed.

Remaining = **operator-gated only**: (a) live 2-tenant auth smoke (personal howto in
the maintainer vault; autonomous prod-mutation is classifier-blocked — hands-on);
(b) composite-PK slug drop (Codex: DEFER, use tenant slug prefixes); (c) terraform
apply only from the ops dir. No open build work.

---

## Roadmap decisions (2026-06-29) — cost-first

Three forward calls, settled (adapted for our
self-hosted + low-spend constraints):

- **Embeddings — stay on the current 1024-dim provider; no switch now.** Making
  the embedding dimension a config value (not hardcoded) is the only adaptation to
  carry over when embeddings are next touched, so a future model swap is a config
  change, not a rewrite. No provider switch / full re-embed without a measured
  retrieval-quality problem — the swap costs money and a corpus re-embed.
- **Agent/synthesis layer — FIRST SLICE DONE (v1.52.0).** `MEMEX_DREAM_SYNTHESIS=1`
  opts the existing Nova synthesis chain into quiet-hours cycle ticks (default-OFF,
  count-capped, writes the isolated `synth_*` store). memex already had the
  synthesis primitives + storage + MCP reads; this was the missing auto-run wiring.
  Deliberately did NOT build the Opus/USD-budget/`think` pipeline —
  conflicts with the Nova-only / synthesis-is-the-client's-job stance. Later slices
  (deferred): a dedicated slower synthesis cadence, surfacing `synth_*` into
  retrieval/answer context, a composite `auto-think` phase name.
- **Multi-tenant auth — DONE (v1.51.0): self-issued OAuth 2.1 `client_credentials`
  (no external IdP).** memex is its own authorization server
  (`/token` + `memex auth register-client` + `memex_at_` verify on `/mcp`). The
  earlier AWS Cognito path was built then removed — an external IdP is the wrong
  tool for an agent-served brain (more deps, wrong fit).

---

## Operator-only follow-ups (cannot be automated remotely)

- **Realign terraform state with renamed `memex-*` addresses.** Local
  `moved.tf` (gitignored historical scaffold) reduces the diff, but
  the plan still wants to *replace* the EFS and EC2 security groups
  in place — that recreates the SGs and risks momentary loss of EFS
  mount + EC2 traffic. Apply ONLY during a planned maintenance window
  and AFTER confirming the SG-replacement is safe in your environment.
  Live config is already functionally correct; this is cosmetics on
  the terraform state. While in the window, also audit whether
  `var.subdomain` (the legacy chat-UI slot, still consumed by
  `compute.tf` bootstrap) can be dropped — the chat UI is gone; the
  public MCP brain is served via `memex_subdomain`.
- **Reconcile the 2026-06-05 out-of-band changes into terraform state.**
  Two terraform-managed resources were changed live via the AWS CLI
  ahead of a proper apply (they already match the committed v1.2.10
  code, but the S3 state still lists them):
  1. the `993` / `587` Gmail egress rules were revoked from the live
     EC2 security group;
  2. the orphaned `memex/gateway-token` secret was scheduled for
     deletion (30-day recovery window, restore-able until ~2026-07-05).
  The next `terraform apply` from the ops dir refreshes and drops both
  from state with **no live change**. Per CLAUDE.md the S3 state is the
  single source of truth and infra changes go through terraform — this
  was a one-off the apply now cleans up; don't repeat the CLI shortcut.

---

## Schema / migration scale (deferred)

- **`CREATE INDEX` in migrations is non-`CONCURRENTLY` and the runner wraps
  each migration in one transaction.** `CONCURRENTLY` cannot run inside a
  transaction block, so index-creating migrations (e.g. 027
  `chunks_symbol_name_idx`) take a brief `SHARE` lock blocking writes for
  the build. Negligible at current scale (~1.3k chunks) and bounded by the
  v1.3.2 `lock_timeout`, but a large future `chunks`/`documents` table would
  stall indexing during the build. When that bites, split index creation
  out of the transactional runner into a separate `CONCURRENTLY` path (it
  must run outside a tx and handle the INVALID-index-on-failure case).
  Surfaced by the P1 chunk-symbol-metadata (migration 027) review.

## Cleanup (deferred)

- **Drop the now-unused `chunks.ts` generated column + `chunks_ts_idx`.**
  Migration 030 moved the keyword read path onto `search_vector`; the old `ts`
  column (migration 001, `to_tsvector('simple', content)` STORED GENERATED) is
  no longer read for ranking, but is left in place because dropping a generated
  column forces a table rewrite. Before dropping, grep `src/` for `\bts\b` /
  `chunks_ts` to confirm no diagnostic still references it (e.g. `doctor`,
  `snapshot`, eval), then drop the column + its GIN index in a single migration
  during a quiet window. Flagged by the v1.3.26 code-review.

## Defence-in-depth hardening (deferred)

- **[DONE 2026-08-14] `storage.init()` is called OUTSIDE the `try`/`finally` in most command
  handlers** (`commands/jobs.ts`, `sources.ts`, and siblings follow the same
  shape). If `init()` throws (failed migration/connect) the `finally`'s
  `storage.close()` never runs → a leaked engine/pool. `commands/cache.ts`
  (v1.3.12) moved `init()` INSIDE the try as the correct pattern; the
  pre-existing handlers should be swept to match. LOW (init failure is rare +
  the process usually exits anyway). Flagged by the v1.3.12 codex review.

- **`links.source_chunk_id` is non-sticky on a bare re-add** (`core/links.ts`
  `addLink`). Migration 029 made the new provenance columns sticky
  (`COALESCE`/`CASE` preserve prior values when a bare `link` re-call omits
  them), but `source_chunk_id` keeps its original 016 last-writer-wins
  behavior — an explicit re-`link` that omits it nulls it. Harmless today (the
  explicit `link` MCP tool callers don't set it, and only enrichment writes
  it). IF a future enrichment pass writes `source_chunk_id` AND an explicit
  re-link can follow, give it the same `COALESCE(EXCLUDED.x, links.x)`
  treatment for consistency. Flagged by the v1.3.9 code-review; left as
  pre-existing intentional semantics, not changed in that increment.

- **[DONE 2026-08-14] `publicSafeErrorMessage` logs the raw detail via `console.error`.** Fine
  for an on-host operator log, but the suppressed detail is a single
  `.message` line that could contain CRLF (cosmetic log-line splitting) or a
  Postgres error embedding a column value (PII). If the EC2 logs are ever
  forwarded off-host (CloudWatch shipping, log aggregation), strip CRLF and
  consider redacting the detail before logging. LOW; surfaced by the
  2026-06-09 fix review.

- **Public read existence-oracle on `page_get` / `jobs_get` /
  `page_versions`.** On a public-ingress miss these return `isError:true`
  echoing the slug/id, while a hit returns `ok:true` — so a public-bearer
  caller can probe-enumerate which slugs exist even with all bodies
  redacted (entity facts/timeline/recall already return a uniform empty
  shape). Rated LOW, not fixed: slugs are operator-chosen and *already
  public* across the surface (`search`/`backlinks`/`graph` all return
  paths), so the marginal leak is small, and changing a read tool's
  public-miss shape to uniform `{ok:true, …:null}` is an API-semantics
  change the operator's own single-holder client may rely on. If we ever
  tighten to a strict metadata-only posture, make public misses uniform
  (no slug echo, no `isError`). Surfaced by the 2026-06-09 security-engineer
  + bug-hunter audit.

- **[DECIDED 2026-08-15 — ACCEPTED] `graph_neighbors` / `graph_query`
  relationship dump.** These two read tools dispatch with no `redact` flag, so
  a caller on the public ingress receives raw `source_slug`/`target_slug` pairs
  — the whole edge graph, who-relates-to-whom, not just individual slugs. The
  2026-06-09 audit rated it LOW and left the call to the operator.

  Operator decision: ACCEPT. "Public" here names the INGRESS, not an audience.
  A request over the Cloudflare path still has to present the public bearer
  (`public_guard.ts` — `Cf-Connecting-Ip` only classifies it; the credential is
  required on both ingresses since v1.121.0). So the edge graph is visible to
  whoever holds the operator's own token, and this is a single-person brain.

  The decision rests on that premise, so the three things that would void it:
  - `MEMEX_ASSUME_PUBLIC=1` classifies every request public — it does not grant
    access, but it erases the internal/public distinction redaction keys off.
  - `MEMEX_ENABLE_DCR_INSECURE=1` lets clients self-register, at which point
    "who has access" is no longer a list anyone curated.
  - The public bearer's rotation is disabled on purpose, so the token is
    permanent. If it ever leaks, access leaks with it — and only then does the
    relationship dump become what the audit described.

  Revisit if the brain ever serves more than one person, or if the bearer
  starts being handed out.

- **Any future document-delete / prune path MUST bump
  `document_generation_clock`.** The live-model cache clock (migration 025)
  is bumped on document *writes* in `writeDocumentTransaction`. Today
  nothing hard-deletes a `documents` row (the sweep only adds/updates), so
  there is no staleness gap. But when a prune/GC path lands, it must call
  `bumpDocumentClock(tx)` in the same transaction — otherwise a query cache
  built on this clock would serve results referencing deleted chunks. Add a
  regression test alongside that path. Flagged by the migration-025 review.

- **Search `token_budget`: token estimate is `chars/4`, not a real
  tokenizer.** Good enough for a context cap, but a multibyte/CJK-heavy or
  code-heavy corpus will over- or under-count. The word-boundary truncation
  can also drop up to ~40% of the overflowing tail hit (the cut lands at the
  last whitespace past 60% of the limit). Acceptable today; revisit with a
  real tokenizer if budgets get tight. The trimmed hit is flagged
  `truncated: true` so callers can detect the cut. Surfaced by the P2
  token-budget review.


- **Public-ingress read redaction — COMPLETE.** All body-bearing /
  free-text read paths now redact on public ingress: `search` /
  `page_get` / `page_list` / `page_versions` (v1.2.0), `entity_facts` /
  `entity_timeline` / `entity_recall` (v1.2.9, 2026-06-01), and
  `backlinks` + `jobs_get` / `jobs_list` / `jobs_logs` (v1.2.9,
  2026-06-05). **Decision (2026-06-05): `graph_neighbors` /
  `graph_query` edge `type` STAYS public.** Rationale: the public
  bearer is single-holder (the operator's own MCP client) and rotated
  daily; slugs are already public; the edge `type` is a constrained
  enum (`KNOWN_LINK_TYPES`), not free-text note content; and it is core
  to graph-recall utility. Redacting it would cripple legitimate use
  for negligible marginal risk. No code change — behavior is
  intentional and now documented. Residual closed.

- **Jobs DAG: align FK delete behaviour between `jobs.parent_job_id`
  and the `job_children` / `child_done_inbox` tables.** Today
  `parent_job_id REFERENCES jobs(id) ON DELETE SET NULL` keeps the
  child row alive (with NULL parent) when the parent is purged, but
  `job_children` and `child_done_inbox` both `ON DELETE CASCADE` —
  the edge tables vanish while the child's `parent_job_id` column
  goes to NULL. `listChildren()` / `drainDoneInbox()` then see zero
  rows even though the children still exist. We have no
  job-delete endpoint exposed today so this is theoretical, but
  before we add one we either (a) make all three FKs CASCADE
  (purging a parent purges the subtree) or (b) explicitly reject
  deleting a parent that has children. Flagged in the migration
  comment of `019_jobs_dag.sql`.

- **Jobs DAG: inbox-during-cancel race.** `writeChildDoneInbox` runs
  with `engine.query` (its own implicit txn), `cancelJob` runs with
  `engine.transaction`. A child completing concurrently with a
  cascade-cancel BFS sees a non-snapshot view: a freshly inserted
  pending child added after the frontier read is missed by cancel,
  while its `writeChildDoneInbox` lands as an orphan pointing at a
  job whose status is by then `cancelled`. Mitigation today: the
  parent's drain logic should ignore inbox rows whose `parent.status`
  is terminal. Long-term fix: read the frontier with `FOR UPDATE` or
  switch the cancel txn to `SERIALIZABLE` isolation. PGLite supports
  `SERIALIZABLE` so we can prove it locally before shipping to RDS.

- **A.5 ledger: future supervisor must bind pending tool rows to a
  worker.** `subagent_tool_executions` records `status = 'pending'`
  rows BEFORE the tool runs, so a crash-recovery sweep can pick
  them up. The supervisor that lands in a future phase MUST bind
  each pending row to a `supervisor_run_id`/`worker_id` and only
  the originating worker may retry it; cross-worker pending rows
  must be `skipped`, NOT re-executed. Without this, anyone who can
  write a pending row (internal-token-gated today) causes the next
  sweep to invoke the named `tool_name` with their forged `input`
  -- a stored command injection into the agent loop. Flagged in
  the doc comment of `beginToolExecution`.

- **A.5 ledger: enforce internal-token-only when A.6 wires MCP.**
  `subagent_messages.content` carries the raw Bedrock Converse
  payload (system prompts, tool inputs with OAuth/Bearer tokens),
  `subagent_tool_executions.input/output/error` carry arbitrary
  tool payloads, `hot_memory.fact` is the unfiltered observation
  stream keyed by predictable slugs (`people/<name>`). A.6's
  forthcoming `subagent_messages`/`subagent_tool_executions`/
  `hot_list` MCP tools MUST go in the WRITE-tools allowlist
  (`FORBIDDEN_MCP_TOOLS_FROM_PUBLIC`) so the public-bearer never
  reaches them. If a public projection is ever needed it must
  drop `content` / `input` / `output` / `error` at the SQL layer,
  not the serializer, and return `404` uniformly on miss to
  prevent entity-existence enumeration. Documented inline in
  `core/hot_memory.ts` and `core/subagent_ledger.ts` headers.

---

## Brain capability roadmap (phased, deferred)

A long-horizon plan to grow memex's retrieval brain. memex stays **brain-only**
— a retrieval service over MCP — and the agent that drives it is the MCP client
(Claude Code). So this roadmap is about making the brain **sharper at returning
context**, not about turning it into an agent.

**Phases P0–P9 are brain-internal** (single `/health` + `/mcp` surface,
retrieval-only, no agent loop). **The near-term target is P0 → P1 → P2**
(data-model substrate + retrieval-quality core), optionally P3 (durable jobs)
and P6 (eval gate).

A second tier of capabilities from the broader landscape — public auth/HTTP,
LLM synthesis, an in-brain agent loop, multimodal/voice, self-upgrade
automation — is **explicitly out of scope**: it would rebuild what the MCP
client already provides. Listed at the end only so the boundary is on record.

Build list (brain-internal):

- **P0 — Schema cache substrate.** `pages.generation` + page-generation clock +
  triggers (cache-invalidation substrate); `tags` / `raw_data` / `config` /
  `ingest_log` tables; provenance columns on `pages`/`sources`/`links`. Pure
  DDL; live-RDS index migrations use `CONCURRENTLY`.
- **P1 — Chunk/code-metadata schema + FTS.** Expand chunks with code metadata +
  per-chunk `search_vector`; code-edge graph tables; `timeline_entries`;
  weighted page/chunk TSVECTOR triggers.
- **P2 — Retrieval quality core** *(highest value)*. Intent-weighted RRF,
  post-fusion salience/recency/graph signals, contextual retrieval, a
  cross-encoder reranker abstraction, a semantic query cache keyed off the P0
  generation clock, and token-budget enforcement.
- **P3 — Durable job system.** Supervisor (PID + DB lock + wedge detection),
  child-worker isolation, parent→child DAG fan-in, idempotency, timeout/cancel,
  budget + rate-lease metering, `pg_notify` job events. Prereq for any fan-out.
- **P4 — Cycle expansion.** Grow the maintenance cycle with the non-LLM phases:
  lint, backlinks-materialize, git sync, facts reconcile, symbol-edge resolve,
  hard purge, weight recompute, schema-suggest.
- **P5 — Enrichment primitives (LLM-free).** Entity-slug resolution, gazetteer
  auto-linking, NER typed-link inference, meeting→timeline extraction,
  completeness scoring, facts-fence format.
- **P6 — Eval gate.** nDCG/Jaccard + qrels + baselines + a CI correctness gate
  on retrieval quality (turns capture/replay into a real regression guard).
- **P7 — Skill catalog over MCP.** Frontmatter parser, trigger-index,
  `list_skills`/`get_skill`, resolver validation, skillpack installer.
- **P8 — Ops hardening.** Doctor category taxonomy + cause-ranking, quarantine
  markers, audit-writer JSONL trail, destructive-guard (soft-delete/restore),
  source-health metrics.
- **P9 — MCP/CLI parity.** Request-param redaction for logging, JSON-shaped MCP
  errors, type-enum validation, and the convenience CLI surface (page CRUD,
  graph traversal, cache/status dashboards).

Out of scope (rebuilds what the MCP client already does — recorded only to
mark the boundary, not planned work):

- HTTP/OAuth public auth surface + remote MCP federation.
- In-brain AI gateway + LLM enrichment pipeline (passive ingest recipes).
- In-brain agent layer (think pipeline, context engine, subagent runtime).
- Multimodal/voice/files + the 1024→1536 embedding upgrade.
- Self-optimization / self-upgrade / automation daemons.

Recommended start: **P0 → P1 → P2**. Each phase is one `/ship` batch
(local gates → push → SSM deploy → live verify → tag).

---

## Revival projects

These are intentionally archived. Pick them up if and when you want
the capability back.

_None currently — the Telegram/chat and life-integration capabilities
were intentionally removed; memex is a brain reached over MCP only._

---

## OSS scaffold polish

- Multi-arch CI matrix (amd64 + arm64) — currently arm64-only because
  the default `var.instance_type` is `t4g.medium`. Track in an issue;
  not a 1.0 blocker.
- GHCR image publishing for the `memrain` container — today the image is
  built on the EC2 host on every deploy. Issue first to agree on tag
  scheme + release cadence.
- GitHub Pages docs site — `ARCHITECTURE.md` + `deploy/*/docs/` would
  render as a small Docusaurus / mkdocs site. Out of scope until
  there's a second deployer.
- Standalone `memrain` npm publish — split the brain out of the stack
  if demand for it standalone materializes.

---

## How to add a TODO

Open an issue using the `Feature / enhancement` template. PRs are
welcome but please open the issue first so we can agree on shape.

### Cycle lock 5-min TTL — starvation-margin note (v1.48.0, review)
LOW/MEDIUM: with the lock TTL dropped 30→5 min, a cycle phase that blocks the
event loop SYNCHRONOUSLY for >5 min would stop the 30s refresher firing → the
TTL lapses → a concurrent same-host invocation (manual `memex cycle`, deploy
overlap) could steal the lock past the 100s steal-grace and run two cycles.
Narrow: phases are await-heavy (per-chunk Bedrock) so the loop yields, and the
deploy runs a single container with one loop; steal-grace is the backstop.
Acceptable for the single-instance deploy. Revisit (raise TTL or add a
worker-thread watchdog) only if a multi-instance or a known long-sync phase lands.

### Structural ingest + lock work — DONE (v1.48.0–v1.50.0, 2026-06-29)
Operator ask: "build it exactly to spec, don't freehand."
A dynamic-workflow structure map produced detailed build specs; shipped:
- **v1.48.0 (#1 ingest size cap)** — the ROOT CAUSE of the 30MB frontmatter:
  the cap covered the file path only, so anything arriving in memory was
  unbounded. Content is now capped at 5MB on BOTH paths; `indexDocument`
  rejects >5MB (covers the remote `index` tool / page mirror / embed-stale).
- **v1.48.0 (#2 lock TTL 30→5min)** — a short-TTL+sub-TTL-refresh model
  so a crashed cross-host holder's lock frees in 5min; skipped tick re-arms within TTL.
- **v1.49.0 (#3 frontmatter at ingest)** — infer per-file at import instead of
  in a recurring cycle phase. New `core/frontmatter-inference.ts` (empty
  DIRECTORY_RULES — that table is vault-specific) wired into `indexDocument`;
  the recurring DB phase DELETED (cycle now 12 phases). The OOM band-aids retired.
- **v1.50.0 (#4 incremental extract)** — extract only changed slugs. With no
  cycle sync phase to hang it off, migration 054 adds a
  `documents.entities_extracted_at` watermark that gates the cycle's extract to
  stale docs only. Extract RSS 1404MB→626MB, faster cycle. `extract --all`
  forces a full walk.
DATA cleanup — DONE (2026-06-29): 32 rows had `frontmatter` of `jsonb_typeof =
'string'` — a giant JSON scalar holding a whole file/email body (code docs,
`gmail:*`, `gcal`, `ops/*`), 420MB total. Reset to `'{}'::jsonb` in a txn (search
unaffected — metadata reads return NULL on a string anyway; bodies/chunks
untouched), then `VACUUM (ANALYZE)`. Max frontmatter 30MB→949KB, oversized rows 0.

### Frontmatter-as-scalar-string ingest bug — TODO (code, found 2026-06-29)
P2: the 32 cleaned rows prove an ingest path writes a whole file/email body into
`documents.frontmatter` as a JSON **scalar string** instead of a metadata object.
The v1.48 5MB cap only blocks rows ABOVE 5MB; the same parser path can still
mis-store sub-5MB content as a string frontmatter (post-cleanup max is already
949KB). Root cause is upstream of the cap — a frontmatter parser/fallback that
emits a scalar when YAML parse doesn't yield a mapping. Investigate the code-graph
indexer + gmail/gcal recipe ingest; reject/normalize non-object frontmatter at
`indexDocument` (coerce to `{}` or parse correctly). Harmless to the cycle today
(cap + incremental-extract + tags-only projection), so not urgent.

## Deferred real gap (2026-07-07) — page/timeline FTS
memex FTS indexes only chunks.search_vector; second-brain `pages`
(compiled_truth+markdown_body) and `timeline_events` text are NOT keyword/recall
searchable (only exact-slug or graph walk). Real blind spot. Build = pages.search_vector
(weighted title A / truth+body B / timeline C, trigger-maintained) + a new page arm in
core/search/hybrid.ts alongside the chunk arm. MEDIUM-HIGH risk (touches live ranking) —
needs its own spec + careful eval, not a schema-only change. HIGH value.
