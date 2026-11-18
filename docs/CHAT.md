# Ask: chat with your brain

The admin panel's **Ask** page answers a question from what is in the brain.
Each answer comes with numbered links to the pages it rests on, a list of what
the brain does not know (gaps), the model that wrote it and what it cost. While
the answer is prepared, the page shows how it was found: what was searched,
how much was found, the money held and the model call.

An answer is one `think` synthesis over your pages and takes. The model gets
no tools: it writes text and changes nothing in the brain. A follow-up in the
same conversation is first rewritten into a question that stands on its own,
by one short call; the earlier turns go to that call as data, never as
instructions.

Only the operator can use it today. Conversations are keyed by owner, so team
members can get their own later without a schema change.

## Turning it on

Chat is off by default and costs nothing while off. To turn it on, set both:

```bash
MEMRAIN_CHAT=1
MEMRAIN_DAILY_BUDGET_USD=1.00   # chat refuses to run without a brain-wide day cap
```

Every other setting has a safe default; see the chat rows in
[CONFIGURATION.md](./CONFIGURATION.md#4-paid-opt-in-bedrock-sonnet-slices).

## Money

- **Per answer.** `MEMRAIN_CHAT_ANSWER_MAX_USD` (default $0.02) is the most one
  answer may cost, the follow-up rewrite included. It is held in the spend
  ledger before the first call and enforced on every call. A larger value is
  lowered to `MEMRAIN_CHAT_ANSWER_MAX_USD_CAP` (default $0.50).
- **Per day.** Each owner has a day of `MEMRAIN_CHAT_USER_DAY_USD` (default
  $0.50), and the brain-wide `MEMRAIN_DAILY_BUDGET_USD` still applies. A
  question that would not fit is answered `budget` and no model is called.
- **Models.** `MEMRAIN_CHAT_MODELS` lists the models offered (default: one
  cheap Haiku model). A model without a price is never offered. The model list
  shows, for each model, the most an answer can cost on it.
- **Stopping.** Closing the tab or pressing stop releases the held money.
- **Where it shows.** `memrain spend` and the Spend page have a `chat` slice:
  chat calls by model, by owner and by day. The cost shown under an answer is
  its model calls; the slice also counts the search embeddings (a fraction of
  a cent).

## Privacy

Chat history is personal data.

- Deleting a conversation deletes it outright.
- The cycle's purge phase deletes messages older than
  `MEMRAIN_CHAT_RETENTION_DAYS` (default 90; `0` keeps them).
- `memrain erase chat --owner operator` shows what one owner has; add
  `--apply` to delete it.
- `memrain export` writes conversations to `_chat/<thread>.json` beside the
  pages; `--owner KEY` narrows them to one owner.
- The progress trace stores counts and page names only, never page text.

## Saving an answer

**Save as page** writes the answer to `chats/<date>-<question>` through the
normal page write: the secret scanner, the write gate and the grant all apply.
The page quotes the question and links each source with a wikilink.

## HTTP API

All routes need an admin session; writes must come from the panel's own
origin.

| Route | Returns |
|---|---|
| `POST /admin/api/chat` `{message, thread_id?, model?}` | `text/event-stream`: `trace` events, then one `answer`, then `done`. A turn that cannot answer sends `error` then `done`. |
| `GET /admin/api/chat/models` | `{enabled, default, answer_cap_usd, models: [{id, label, input_usd_per_m, output_usd_per_m, estimate_usd}]}` |
| `GET /admin/api/chat/threads` | `{threads: [{id, title, updated_at, message_count}]}` |
| `GET /admin/api/chat/threads/:id` | `{thread, messages}`; another owner's or an unknown id is 404 |
| `DELETE /admin/api/chat/threads/:id` | `{ok: true}` |
| `POST /admin/api/chat/messages/:id/save` | `{slug}` |

`answer.status` is `ok`, `refused` (nothing in the brain answers it),
`budget`, `error` or `disabled`. Error codes are a closed list: `timeout`,
`rate_limited`, `network`, `provider_error`, `budget_exhausted`,
`chat_disabled`, `invalid_params`, `db_busy`. A send refused before any work
(an empty question, an unknown model or conversation) is a 400 whose body is
the `error` and `done` events.
