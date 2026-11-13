# LongMemEval harness

`memrain eval longmemeval` measures how well Memrain's retrieval supports
answering questions about long conversation histories. It runs the
LongMemEval-S benchmark (500 questions, each with roughly 50 earlier chat
sessions as its history) against Memrain's own indexer and search, then has
Bedrock Claude answer and grade.

Results are labelled **Bedrock-Claude-judged**. The judge model and prompts
differ from the ones the benchmark authors used, so the accuracy is not
directly comparable to published LongMemEval scores. Compare runs only when
they share the dataset checksum, prompt hash and model ids. Each summary
records all three.

## Dataset

- Source: the cleaned LongMemEval release, file `longmemeval_s_cleaned.json`,
  pinned to dataset revision `98d7416c24c778c2fee6e6f3006e7a073259d48f`
  (`https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned`).
- Checksum: sha256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`,
  277,383,467 bytes.
- License: MIT, as declared in the dataset card's metadata (checked against
  the pinned revision).
- Paper: Wu et al., *LongMemEval: Benchmarking Chat Assistants on Long-Term
  Interactive Memory*, ICLR 2025.

The file is cached outside the repository, in `$XDG_CACHE_HOME/memrain/longmemeval`
(default `~/.cache/memrain/longmemeval`), or under `--dir`. Downloads go to a
temporary file that is hashed while it streams and renamed into the cache only
when its size and sha256 match the pin. A network error or a checksum mismatch
leaves nothing behind. A network error exits 75, so the command can be retried.
A cached copy is hashed again on every run, and a mismatch is refused; delete
the file to download it again.

## What a question goes through

1. A fresh PGLite brain is created in a temporary directory.
2. Each session of the question's history becomes one markdown document
   (`# Conversation on <date>` followed by the turns). It is indexed through
   the normal indexer, embeddings included. The dataset's session ids and
   evidence labels are never indexed, and paths carry only a position.
3. The question goes through `hybridSearch` with the query cache, telemetry,
   reranking and query expansion turned off. Those last two would be paid calls
   outside the ledger. The run records the top 10 excerpts and the sessions
   they came from.
4. The answer model reads the excerpts, each headed by its session date, plus
   the question date and the question. It answers in at most 400 tokens.
5. The judge model compares that answer with the gold answer under a rule for
   the question type (temporal, knowledge update, preference, abstention or
   default). It replies `yes` or `no`. Any other reply counts as wrong and is
   reported as `judge_unparseable`.
6. The brain is deleted.

The defaults are `eu.anthropic.claude-sonnet-5-5` for answering,
`eu.anthropic.claude-haiku-5-5` for judging, so the judge is a different model
from the answerer, and Titan v2 for embeddings. Override them with
`--answer-model` and `--judge-model`. A reasoning model may spend its 400
output tokens before it answers.

Evidence recall is reported for questions that have gold evidence sessions. It
is the share of those sessions that appear among the retrieved excerpts.

## Cost controls

```bash
# Price the run: no paid call, no run directory.
memrain eval longmemeval --dry-run --max-usd 40 [--limit 50]

# Run, or resume the run already in DIR.
memrain eval longmemeval --out DIR --max-usd 40 [--limit 50]
```

- `--max-usd` is required for a paid run. `--dry-run` prints the worst case for
  each stage: calls, input bytes, output tokens and dollars. It also says
  whether the cap covers that worst case.
- Every paid call is reserved in `DIR/ledger.jsonl` before it is sent. That
  covers each chunk embedding, the query embedding, the answer and the judge.
  The reservation is the call's worst-case price at the current Bedrock rates
  in `src/core/budget.ts`. Each record is flushed to disk before the call goes
  out. After the call returns, a settle record replaces the reservation with
  the usage the provider reported.
- The run refuses before the call when a model has no price, when an input is
  over its fixed bound (a 50 KB embedding input, a 48 KB answer prompt or a
  24 KB judge prompt), or when the cap cannot cover the call. Before each
  question, it also checks that the cap covers that question's whole worst
  case.
- The run also refuses when `MEMRAIN_CONTEXTUAL_LLM` is on. The indexer would
  then make paid calls the ledger cannot see.

### Crashes and resume

Only one process can use a run directory at a time. It holds `DIR/run.lock`,
and a lock left by a process that has exited is taken over. Running the same
command again with the same `--out` resumes. A finished
question is never re-run. If a question has a reserved call but no result, the
process died or a call failed while it was running. That question is recorded
as `interrupted` and is never re-run, because repeating it could pay twice.
Its open reservations stay charged in full against the cap. To release one,
record what the provider actually billed (for example from Cost Explorer):

```bash
memrain eval longmemeval --out DIR --settle <reservation-id> --usd 0.0123
```

`summary.json` lists the open reservations. A ledger written with a different
dataset, prompt hash, models or bounds will not resume. Start a new `--out`
instead.

### Exit codes

`0` every selected question was scored. `1` the run was refused or stopped
(cap, unknown price, oversized input, unsafe setting, bad dataset), or some
questions were interrupted and can never be scored in this run directory. `2`
usage error, a ledger that does not match, or a run directory another process
is using. `75` a download or paid call failed; try again later. The question
that was running is not repeated.

## Output

`DIR/summary.json` records:

- the label, dataset URL and sha256, prompt hash, model ids and retrieval k
- `selected`, `scored` (the accuracy denominator) and `correct`
- `accuracy`, and accuracy by question type, with abstention questions as
  their own type
- `judge_unparseable`, `evidence_recall_mean`, the `interrupted` question ids
  and `not_run`
- `spent_usd`, which includes open reservations at their full worst case, and
  `unsettled_reservations`

Per-question results, with the answer, the verdict, the retrieved session ids
and the cost, are the `result` records in `ledger.jsonl`.

The routine test suite never makes a paid call. `tests/longmemeval_*.test.ts`
run the whole pipeline offline, with a stub at the Bedrock boundary.
