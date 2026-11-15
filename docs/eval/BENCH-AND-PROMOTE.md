# Search bench, lme-r and promoting a ranking flag

A ranking change becomes a default only after it is measured. This page covers
the four instruments for that and how to run each one on the live host:

- the **search bench**: a synthetic corpus that ships with Memrain, scored on
  its own throwaway brain at no model spend;
- **lme-r**: LongMemEval in retrieval-only mode, which pays only for embeddings;
- **`eval promote`**: one verdict per ranking flag;
- the **live eval set**, labelled on the admin Labelling page, and **shadow
  ranking**, which measures a flag on real searches without changing results.

On the host every command runs inside the container. The CLI there is
`bun run src/cli.ts`, not `memrain`:

```bash
sudo docker exec deploy-memrain-1 bun run src/cli.ts eval bench
```

The container's config directory is `/home/bun/.memrain`, which is on EFS and
survives a rebuild. Write anything you want to keep there. `/tmp` and
`/home/bun/.cache` are lost when the container is recreated.

## The search bench

```bash
bun run src/cli.ts eval bench [--k12] [--json] [--write-snapshot]
```

The corpus is in `src/eval/bench/`. It holds 57 fictional pages (people,
projects, meetings, code notes, decisions, transcripts and five German pages)
and 20 mail-noise pages: newsletters, automatic replies, receipts and
invitations that repeat the same names and terms, indexed under a `mailbox`
source. `qrels.json` has 60 tagged queries (`kind:*`, `intent:*`, `noise:mail`,
plus a language), six questions the corpus cannot answer, and three decoys.

The command builds a temporary PGLite brain, embeds every page and query with
the deterministic embedder, runs each query through the real hybrid search
with every paid stage off, and deletes the brain. It never opens your brain and
needs no config. It reads its own spend ledger before and after, and any call
fails the run.

The report gives hit@5, MRR, nDCG@10 and recall@10 overall and per tag, and a
line `DECOYS: 0/3 passed`. A decoy is a planted wrong answer. If the scorer
accepts one, it would accept the same mistake from the search, and none of the
other numbers count. `snapshot.matches` says whether every query still ranks
the same pages as `src/eval/bench/snapshot.json`.

- `--k12` runs the bench a second time without the mail noise and reports
  whether the mailbox pushed any page people wrote off its rank. It fails when a
  mail page ranks first for any query, or when the `noise:mail` queries lose
  hit@5 or more than 0.01 MRR.
- `--write-snapshot` rewrites the snapshot. Run it in a checkout, not in the
  container (`cd deploy/memrain && bun run src/cli.ts eval bench
  --write-snapshot`): in the container it would write into the image's `/app/src`,
  which no commit sees and the next rebuild discards. Commit a new snapshot only
  for a ranking change you mean to make, in its own commit, so the diff shows
  which queries moved.

Exit 0 when every decoy was rejected, nothing was spent, no query threw and
(with `--k12`) K12 held; 1 otherwise; 2 when `MEMRAIN_CONTEXTUAL_LLM` is set,
because indexing would then call a model.

The deterministic embedder matches shared words, not meaning, and the corpus is
small, so the bench is easy: most queries hit. Its job is to catch regressions
and prove a refactor changed nothing. It cannot show small improvements.

### Holding a refactor to zero change

```bash
bun run src/cli.ts eval gate --bench --write-baseline   # before the change
bun run src/cli.ts eval gate --bench --max-drop 0       # after it
```

`--bench` runs the regression gate on the bench instead of the live brain. Its
baseline lives in `<config-dir>/eval-bench-baseline.json`, which is
`/home/bun/.memrain/eval-bench-baseline.json` in the container. A decoy the
scorer accepts fails the gate.

## lme-r: LongMemEval, retrieval only

```bash
bun run src/cli.ts eval longmemeval --retrieval-only --dry-run --dir /home/bun/.memrain/longmemeval
bun run src/cli.ts eval longmemeval --retrieval-only --max-usd 3 \
  --dir /home/bun/.memrain/longmemeval --out /home/bun/.memrain/lme-runs/base
```

Each question gets a fresh brain built from its history, and the question goes
through the same search as the judged run (see [LONGMEMEVAL.md](LONGMEMEVAL.md)).
Then it stops. Nothing answers and nothing judges. The score is whether the
evidence sessions came back:

- `recall_any_at_5`: at least one evidence session among the distinct sessions
  of the top five chunks. This is the lme-r headline figure.
- `recall_all_at_5`, `recall_any_at_10`, `recall_all_at_10`, `ndcg_at_10`.

Questions without evidence sessions (the abstention ones) are left out of the
averages; `recall_scored` says how many counted.

Only embeddings are paid, and they go through the same ledger as the judged
run: each call is reserved at its worst case before it is sent and settled
after. `--max-usd` is required. `--answer-model` and `--judge-model` are
refused because nothing would use them. Vectors are cached in
`<dir>/embed-cache.sqlite`, keyed by model and text, so a repeat run over the
same questions embeds nothing and costs nothing. Keep `--dir` on EFS, as above,
or the dataset download and the cache are lost with the container.

The summary (`<out>/summary.json`) is labelled `LongMemEval-retrieval-only`. A
judged run cannot resume in a retrieval-only directory, and the reverse is
refused too. All other options, exit codes, resume and `--settle` behave as in
the judged run.

## eval promote

```bash
bun run src/cli.ts eval promote EXACT_LOOKUP
bun run src/cli.ts eval promote EXACT_LOOKUP --live \
  --lme-r-base /home/bun/.memrain/lme-runs/base/summary.json \
  --lme-r /home/bun/.memrain/lme-runs/exact-lookup/summary.json
```

`<FLAG>` is one of the ranking flags (`METADATA_GATE`, `ENTITY_TRUTH_SOFT`,
`KEYWORD_OR_RETRY`, `PAGE_FUSION`, `KEYWORD_CONFIDENCE`, `EXACT_LOOKUP`), with
or without the `MEMRAIN_RANK_` prefix. The command scores the bench three
times on one brain: the baseline twice and `MEMRAIN_RANK_<FLAG>=1` once. The
noise floor of each metric is the larger of 0.01 and twice the gap between the
two baseline runs. It then compares the flag with the baseline query by query:

| Verdict | When |
|---|---|
| `FAIL` | a metric drops by more than its noise overall; a tag with 10 or more queries drops by more than 0.05; a decoy passes; a query loses the expected top-1 it held; a query throws; the bench spends anything; or lme-r recall@5 falls by more than 0.01 |
| `PASS` | nothing failed, nDCG@10 or MRR improved by at least the noise with a Holm-adjusted paired p-value below 0.05, and the lme-r figures were supplied |
| `INCOMPLETE` | it would pass, but the lme-r figures are missing |
| `NEUTRAL` | nothing failed and nothing improved beyond the noise; the flag stays opt-in |
| `REFUSED` | the inputs cannot support a verdict, such as LongMemEval summaries that are not retrieval-only or cover different questions |

- `--lme-r-base` and `--lme-r` take the `summary.json` of two `eval longmemeval
  --retrieval-only` runs over the same questions. For the second run, set the
  flag for that command only:
  `sudo docker exec -e MEMRAIN_RANK_EXACT_LOOKUP=1 deploy-memrain-1 bun run src/cli.ts eval longmemeval --retrieval-only ...`.
  The cached vectors make that run free.
- `--live` adds your labelled dev queries (see below), run three times against
  the live brain. That costs one query embedding per query per run.

The report is printed and written to `<config-dir>/promote/<FLAG>-<time>.json`
(`/home/bun/.memrain/promote/` in the container), or to `--out DIR`. Exit 0
`PASS`, 1 `FAIL`, 2 `REFUSED` or bad usage, 3 `NEUTRAL` or `INCOMPLETE`.

The sealed split and, for a paid stage, the judged LongMemEval run remain
separate steps. Run them once, under a pre-registration
([PREREG-TEMPLATE.md](PREREG-TEMPLATE.md)).

## The live eval set

Real queries are collected only while capture is on. Add this to
`/home/bun/.memrain/memrain.yml` on the host's EFS mount (the file sits next to
`config.json`), then restart the container:

```yaml
evalCapture:
  enabled: true
```

```bash
sudo docker restart deploy-memrain-1
```

The server reads `memrain.yml` only at start, and `deploy.sh` does not recreate
a container whose image did not change, so a restart is the step that applies
it. Captured queries are scrubbed of personal data before they are stored
unless you also set `scrub: false`.

Then open **Labelling** in the admin panel (Operations section). For each
captured query, click Review. You see the top ten documents the current search
returns; mark every one that answers the query, add tags such as
`intent:topic kind:alias`, and save. Leave Split on `auto`: three in ten
queries then go to the sealed set, chosen by a hash of the query, so your own
choices cannot tilt it. Dismiss captures that are not worth a label. The page
shows how many dev and sealed labels exist against the target of 150.

Labelled dev queries feed `eval promote --live`. Sealed ones are scored only by
the sealed A/B run, once per pre-registration. That run reads a qrels file, so
export the labels first; the file keeps each label's split and every document
you marked:

```bash
sudo docker exec deploy-memrain-1 bun run src/cli.ts eval qrels build \
  --out /home/bun/.memrain/qrels.live.local.json
```

Then pass `--qrels /home/bun/.memrain/qrels.live.local.json --split sealed` to
the sealed run described in [PREREG-TEMPLATE.md](PREREG-TEMPLATE.md).

## Shadow ranking

```bash
sudo docker exec deploy-memrain-1 bun run src/cli.ts config set MEMRAIN_RANK_SHADOW EXACT_LOOKUP
sudo docker restart deploy-memrain-1
# a few days later
sudo docker exec deploy-memrain-1 bun run src/cli.ts search stats --days 7
```

With `MEMRAIN_RANK_SHADOW=<FLAG>`, every search with telemetry on also ranks
its candidates a second time with that flag flipped, after its own result is
ready. It records only daily counts per flag in `search_telemetry_shadow`: how
many searches were compared, how often the first page would have changed, and
the mean overlap of the top five pages. The results people get do not change,
and no query text is stored. `search stats` prints one line per shadowed flag.

Only flags read after fusion can be shadowed: `METADATA_GATE`,
`ENTITY_TRUTH_SOFT` and `EXACT_LOOKUP`. Any other value is ignored. A search
that could spend (the two-pass rerank or the graph rerank) is never shadowed.
The setting is stored in the database and read at server start, which is why
the restart is needed. Remove it with `config unset MEMRAIN_RANK_SHADOW` and
another restart.
