# How to connect Fireflies

Fireflies records and transcribes your meetings. Connected to Memrain, each
meeting lands in the brain as a meeting page with its transcript and summary. Fireflies has no OAuth sign-in for this: you give Memrain an API key.

## Prerequisites

- Connectors are on: [ENABLE.md](./ENABLE.md) steps 1 to 3.
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
2. Open the **Connections** page and choose **Fireflies**.
3. Pick the source the meetings should belong to, paste the key, and save.

Paste the key into that form only. Do not put it in `.env`, a chat with your
agent, or a brain page.

### 3. Let it sync

With `connector_sync` enabled ([ENABLE.md](./ENABLE.md) step 6), the account
syncs within 15 minutes. The first sync reads the last 90 days of meetings.
Every later run reads again the 48 hours before where it stopped, so a meeting
whose summary Fireflies had not produced yet is picked up once it has one.

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
docker exec deploy-memrain-1 memrain connectors status
```

The Fireflies account shows a recent clean run. Search the brain for the title
of a recent meeting.

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
