# Regex Discipline Convention

When a pattern match is the right tool, and when the model has to judge.

The model doing the knowledge work judges first. A regex is earned only after
you have read enough real data (a small sample, see
`conventions/test-before-bulk.md`) to know the signal is rote and fully
deterministic. A regex compresses a pattern you already confirmed by looking. It
never replaces looking.

## The one question

Before writing any regex, keyword score or pattern filter, answer:

> Is this signal deterministic and rote, or does it take judgment?

- **Deterministic:** a regex is right. ISO timestamps, a file extension, a known
  delimiter, a magic-byte check, a URL shape, a frontmatter fence, an id format
  you confirmed is consistent.
- **Judgment:** the model decides. "Is this a highlight", "is this message
  important", "does this paragraph hold the thesis", "is this a real contact",
  sentiment, theme, quality. A regex here rewards surface features (keyword
  density, length, punctuation) and misses the thing itself.

The same test put another way: did a machine emit this exact string in one
shape, or could a person phrase it a hundred ways? A calendar prefix, a fixed
sender address, a bot template or a token shape is a regex tell. A phrase a
person writes, and above all one an attacker could imitate, is judgment.

If you cannot answer, you have not read enough data yet.

## Earning a regex

1. Do the work as the model on a small real sample. Read it and make the calls
   yourself.
2. Notice a tell that holds across the whole sample with no judgment in it, and
   state it exactly ("every message from that system comes from
   `noreply@acme-example.com`").
3. Then write the regex for that step, to save effort on the rote part.
4. Keep the judgment with the model. The regex pre-filters or formats; the model
   still decides anything that is not mechanical.

Jumping to step 3 is the bug.

## Division of labour

| Layer | Tool | Why |
|-------|------|-----|
| Find or format the rote part | regex | cheap, exact, no judgment |
| Decide taste, meaning, quality | model | judgment does not compress |
| Confirm a tell is really rote | model on a small sample | you must see the data |

## Red flags

- A `score()` with keyword lists and weights that ranks quality
- You have not read a representative sample
- The pattern decides something a careful person would call a judgment call
- You reach for a regex because it is faster than reading
- The thing you match has exceptions you are already waving away
- The thing you match is what an attacker would imitate (urgency words, brand
  names, "verify your account")

When one fires: stop, read a sample, let the model judge, and pattern-match
only the mechanical remainder, if any.

## Never pattern-match what an attacker can imitate

Inbound mail, webhook payloads and anything a stranger can send raise the bar:
the tell must be something an attacker cannot forge cheaply. "Action required"
or "sign this document" is exactly what a phishing message says on purpose, so a
rule that acts on those words is a rule the attacker drives. Telling a real
request from a spoof means checking the sender against the claimed identity,
the thread and the account, which is the model's job. This sits alongside
`conventions/untrusted-content.md`: inbound text is data, and neither a regex
nor the model lets it pick an action.

## Where it bites in this pack

- `enrich`: notability and which facts matter are judgment. Do not keyword-score
  entity relevance.
- `signal-detector`: "is this original thinking" is judgment. Score with the
  model.
- `webhook-transforms`: inbound events are attacker-influenced. Use machine
  tells plus model judgment, never phrase lists.
- `cross-modal-review` catches the mistake after the fact: scores with no spread
  (everything near the maximum) usually mean a regex is doing a judge's job.

## Anti-Patterns

- Writing the pattern before reading the data
- Ranking quality with keyword weights
- Matching phrasing a person or an attacker can vary
- Letting a pre-filter silently drop real positives you never checked for
