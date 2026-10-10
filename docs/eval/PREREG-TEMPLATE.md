# Pre-registration: <flag or change>

Copy this file to `docs/eval/decisions/<id>.prereg.md` and fill it in
**before** the sealed run, then leave it unchanged. The sealed run takes it as
`--prereg`, stores its sha256 with the result, and runs once per
pre-registration: a second sealed run under the same file is refused. The
result and the decision go into a separate `docs/eval/decisions/<id>.md`, so
recording them does not change the pre-registration. Every sealed row stays in
`eval_snapshots` with its `sealed_ids_sha256`, so a sealed set scored again
under a new pre-registration is visible to anyone reading the history.

## Change under test

- Flag / change: `MEMRAIN_RANK_<FLAG>=1` (B) against the current default (A)
- Code commit: `<git sha>`
- Corpus: live brain, `<date>`

## Hypothesis

One or two sentences: what the change should improve, and on which queries.

## Metrics

- Primary: nDCG@5
- Secondary: hit@5, MRR
- Guards: B's p50 and p95 latency, query errors, expected_top1 queries

## Decision rule

Promote to default on only if the sealed run shows all of:

1. nDCG@5: Holm-adjusted p < 0.05 and lower95 > 0
2. hit@5 and MRR: upper95 >= 0 (no credible loss)
3. Latency: B's p50 and p95 at most 2.0x A's
4. Errors: 0 on either side
5. Every expected_top1 query answered at rank 1 by B

Otherwise the flag stays off, and the decision file records the result as
inconclusive or rejected.

## Dev evidence

- Qrels: `<path>`, qrels_sha256 `<...>`
- Dev receipt: eval_snapshots id `<...>`, ids_sha256 `<...>`
- Dev result per metric (delta, 95% interval, p, Holm p, wins/losses/ties):

## Sealed run

```
memrain eval --qrels <path> --split sealed --k 5 \
  --config-a '{"name":"off"}' \
  --config-b '{"name":"<FLAG>","env":{"MEMRAIN_RANK_<FLAG>":"1"}}' \
  --prereg docs/eval/decisions/<id>.prereg.md --record
```

---

# Decision file (`docs/eval/decisions/<id>.md`)

- Pre-registration: `<id>.prereg.md`, prereg_sha256 `<...>`
- Sealed receipt: eval_snapshots id `<...>`, sealed_ids_sha256 `<...>`
- Result per metric (delta, 95% interval, p, Holm p, wins/losses/ties):
- Latency (p50, p95, ratios), errors, expected_top1 misses:
- Decision: promoted | inconclusive | rejected, and why, against the rule.
