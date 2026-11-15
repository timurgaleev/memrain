# How to connect Fireflies

Fireflies records and transcribes your meetings. Connected to Memrain, each
meeting lands in the brain as a meeting page with its transcript and summary. Fireflies has no OAuth sign-in for this: you give Memrain an API key.

## Prerequisites

- Connectors are on: [ENABLE.md](./ENABLE.md) steps 1 to 3.
- A source of kind `meeting` to hold the meetings. The Connections page offers
  only sources of that kind, so its list is empty until you register one
  ([ENABLE.md](./ENABLE.md) step 5).
- A Fireflies account whose meetings you want in the brain.

## What the key can do

A Fireflies API key belongs to one Fireflies user and is sent as a bearer
token (`Authorization: Bearer <key>`) to `https://api.fireflies.ai/graphql`.
Fireflies documents no read-only or scoped key: the same key can also call the
API's write operations (deleting a transcript the user owns, for example).
Memrain only sends read queries with it, never a mutation, and stores it sealed with the connector key
([KEY.md](./KEY.md)), like an OAuth token. It is never shown again after you
save it, and never written to a log.

Anyone who has the key can act as that Fireflies user through the API, so
treat it like a password.

## Steps

### 1. Copy your API key from Fireflies

1. Sign in at [app.fireflies.ai](https://app.fireflies.ai).
2. Open **Integrations**, then **Fireflies API**.
3. Copy the API key.

(Source: [Fireflies API authorization](https://docs.fireflies.ai/fundamentals/authorization).)

### 2. Paste it into Memrain

1. Open the admin console (`https://<your host>/admin/`) and sign in.
2. On the **Connections** page, in the **Fireflies** panel, pick the
   `meeting` source under **Into source**.
3. Paste the key into **Fireflies API key** and choose **Connect Fireflies**.

Paste the key into that form only. Do not put it in `.env`, a chat with your
agent, or a brain page.

The form posts to the admin API, which a script can call the same way with an
admin session cookie and the brain's own `Origin` (admin writes refuse any
other origin):

```
POST /admin/api/connectors/fireflies/key
{"source_id": "<meeting source>", "api_key": "<your key>"}
```

Memrain asks Fireflies who owns the key (the `user` query), seals the key, and
answers with the account; the key is never echoed back. A new account starts
with its sync off: switch it on from the Connections page. Saving a working
key again for the same Fireflies user replaces the sealed key and resumes an
account paused as `needs_reconnect` from where it stopped.

### 3. Let it sync

With `connector_sync` enabled ([ENABLE.md](./ENABLE.md) step 6), the account
syncs within 15 minutes. The first sync reads the last 90 days of meetings.
Every later run reads again the 48 hours before where it stopped, so a meeting
whose summary Fireflies had not produced yet is picked up once it has one.

## What lands in the brain

Each transcript becomes one meeting page in the source you picked:
participants, the Fireflies summary and action items once Fireflies has
produced them, and the transcript as speaker turns with the time each turn
began. A long transcript is stored whole across part pages. Participants who
already have a `people/` page in that source or the default source get an
`attended` link; everyone else becomes a wanted entry, never a page.

Everything a transcript holds is outside text from whoever spoke in the
meeting. It is secret-scanned, marked untrusted and passes the write gate as
outside text; nothing in it is ever acted on.

## How a sync works

- The first run lists transcripts created in the last 90 days; later runs list
  the window since the previous run plus 48 hours. A transcript whose title,
  time, length, people or summary status changed is fetched again, and one
  younger than 48 hours is read again once a day so an edit to its text lands.
  Fireflies reports no edit time, so an edit made later than that is not
  picked up.
- About once a day every transcript id the key can see is listed. A stored
  transcript missing from that list is asked for by id, and only a "not found"
  answer deletes it: its page and parts are soft-deleted with a receipt that
  holds no meeting text, out of search at once and restorable with
  `page_restore` for 30 days, after which the purge removes them for good
  (see [PRIVACY.md](../../PRIVACY.md)). More than the
  mass-delete threshold at once is held for you to confirm on the Connections
  page.
- A key Fireflies refuses pauses the account as `needs_reconnect`, opens a
  notice and keeps every page and cursor.

## Rate limits

Fireflies limits API calls per plan (checked against
[Fireflies API limits](https://docs.fireflies.ai/fundamentals/limits)):

| Plan | Per minute | Per day |
|---|---|---|
| Free | 30 | 500 |
| Pro | 60 | 5,000 |
| Business | 60 per paid seat, pooled, up to 1,200 | no daily cap |
| Enterprise | 60 per paid seat, pooled, up to 2,400 | no daily cap |

The daily quota resets at midnight UTC. Past a limit Fireflies answers
`429 Too Many Requests` with a `Retry-After` header; the run stops `partial`
and the next run continues from where it stopped. Memrain spaces its calls at
least two seconds apart, under every plan's per-minute limit. On the Free plan
a first sync of a busy 90 days can take more than one day.

## Verification

```bash
docker exec deploy-memrain-1 bun run src/cli.ts connectors status
```

The Fireflies account is listed under `accounts:` with a recent clean sync and
its last run. Search the brain for the title of a recent meeting.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| The account shows `needs_reconnect` | Fireflies refused the key (revoked or regenerated) | Copy the current key from Fireflies and save it again on the Connections page |
| Runs stop `partial` every day | The daily quota of your plan is used up | Wait for midnight UTC; the backlog drains over the next days |
| A meeting has no summary | Fireflies had not finished it when the run read it | Runs within the next 48 hours pick it up |
| The Connections page answers `connectors_disabled` | Connectors are off or the connector key did not load | [ENABLE.md](./ENABLE.md) step 3 |

## Disconnecting

Disconnect the account on the Connections page. Memrain deletes the stored key.
The key itself stays valid in Fireflies: regenerate it there if you want it
dead. Pages already synced stay in the brain unless you also remove the
account's data.

## Related

- [ENABLE.md](./ENABLE.md): the order to switch connectors on.
- [KEY.md](./KEY.md): the connector key that seals the API key.
- [GOOGLE.md](./GOOGLE.md): Google Calendar, which Fireflies meetings link to.
