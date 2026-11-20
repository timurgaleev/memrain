# How to turn on connectors

This guide takes a running Memrain from "connectors off" to syncing your
calendar, mail and meetings into the brain: Google Calendar, Gmail, Outlook
mail and calendar (Microsoft 365 or a personal Microsoft account), Slack
channels, and Fireflies. It lists the switches
in the order they must be thrown. Each one is safe alone, and nothing is
fetched from a provider until every one of them is in place.

Connectors are off by default. Four gates stand between a fresh install and a
sync run, and all four must be open:

| Gate | Where it lives | What happens while it is closed |
|---|---|---|
| Connector key (`MEMRAIN_CONNECTOR_KEK`) | Secrets Manager, fetched into `deploy/.secrets/memrain.env` | Connectors stay closed; `memrain doctor` says why |
| `MEMRAIN_CONNECTORS_ENABLED=1` | `runtime_config` (`memrain config set`) | No account is connected, synced or queued |
| `MEMRAIN_DAILY_BUDGET_USD` | host `.env` | Paid daemons, `connector_sync` included, never start (`no_brain_cap`) |
| `MEMRAIN_DAEMONS=1` and `connector_sync` enabled | `runtime_config`, then `memrain daemons enable` | Nothing schedules a sync |

## Prerequisites

- A deployed stack that is healthy on the current release:
  `memrain auth doctor` and `/health` are clean.
- `MEMRAIN_PUBLIC_URL` is set (bootstrap writes it from your domain). Google
  and Microsoft send you back to an address built from it, and the connect
  flow refuses to start without it.
- Shell access to the host (SSM Session Manager) and an AWS profile that can
  run `terraform plan` against the stack's S3 state, from your private ops
  directory (the one with the filled `backend.hcl` and `terraform.tfvars`).

The commands below run on the host from `/opt/memrain` unless they start with
`terraform` or `aws` on your machine. `memrain` means
`docker exec deploy-memrain-1 bun run src/cli.ts`.

## Steps

### 1. Check the starting point

```bash
docker exec deploy-memrain-1 bun run src/cli.ts doctor
```

The `connector-accounts` line should read
`connectors are off (MEMRAIN_CONNECTORS_ENABLED is not set)`. Fix anything else
doctor flags before you go on.

### 2. Create the connector key

Follow [KEY.md](./KEY.md): create the secret with terraform (shown as a plan,
applied only after you agree to it), put 32 random bytes in it, then fetch it:

```bash
bash deploy/secrets/fetch-secrets.sh    # prints "[secrets] connector key fetched"
bash deploy/deploy.sh
```

Doctor still says connectors are off: it checks the key only once the switch
in the next step is on.

### 3. Turn connectors on

```bash
docker exec deploy-memrain-1 bun run src/cli.ts config set MEMRAIN_CONNECTORS_ENABLED 1
docker restart deploy-memrain-1
docker exec deploy-memrain-1 bun run src/cli.ts doctor     # connector-accounts: connectors on, no account connected
```

If doctor says `connectors requested but closed: <reason>` instead, the key did
not load; the reason names the problem (see Troubleshooting).

The setting is stored in the database, so it survives the `.env` rewrite that
every bootstrap run does, and it is read at start-up, hence the restart.
`deploy.sh` is not enough here: it leaves an unchanged container running, so the
process would never read the new setting. It
is deliberately not in the compose `environment:` allowlist: an entry there,
even an empty one, would hide the stored setting. With it on, the Connections
page in the admin console opens and you can store OAuth clients and connect
accounts. Nothing syncs yet.

### 4. Set the brain-wide daily budget

`connector_sync` embeds every new page it writes, so it is a paid daemon, and
paid daemons do not run at all without a brain-wide cap. Add the cap to the
host `.env` (the key is already in the compose allowlist) and redeploy:

```bash
echo 'MEMRAIN_DAILY_BUDGET_USD=1.00' >> /opt/memrain/.env
bash deploy/deploy.sh
docker exec deploy-memrain-1 sh -c 'echo "$MEMRAIN_DAILY_BUDGET_USD"'   # -> 1.00
```

`1.00` covers the whole brain, not only connectors: every paid call in a UTC
day counts against it. Pick a value you are happy to spend on a bad day.

> Use the host `.env` for this one, not `memrain config set`. The compose file
> passes the key into the container even when it is empty, and an empty value
> in the environment wins over a stored setting. A `scripts/bootstrap.sh`
> re-run rewrites `.env` and drops hand-added lines, so add it again after one.

### 5. Connect your accounts

Each connector writes into a source of its own kind, never into a source that
holds your notes: retention and upstream deletes only ever run in such a
source. The Connections page offers only sources of the right kind, so
register one first (the id and prefix are yours to choose):

```bash
docker exec deploy-memrain-1 bun run src/cli.ts sources register me-calendar --kind calendar --path-prefix calendar/
docker exec deploy-memrain-1 bun run src/cli.ts sources register me-mail --kind mailbox --path-prefix mail/        # Gmail
docker exec deploy-memrain-1 bun run src/cli.ts sources register me-meetings --kind meeting --path-prefix meeting/   # Fireflies
docker exec deploy-memrain-1 bun run src/cli.ts sources register team-chat --kind chat --path-prefix chat/           # Slack
```

Then let your agents read it. Add the new source to the read set of each OAuth
client that should see it. Preview with `--dry-run` (only the read set should
change), then run the same command without it:

```bash
docker exec deploy-memrain-1 bun run src/cli.ts auth rescope-client <client_id> --source <its write source> \
  --federated-read <its current read sources>,me-calendar --dry-run
docker exec deploy-memrain-1 bun run src/cli.ts auth rescope-client <client_id> --source <its write source> \
  --federated-read <its current read sources>,me-calendar
```

A personal access token keeps a read set of its own, so an agent that signs in
with one does not see the new source until you add it there too.
`set-read-sources` replaces the token's whole read set: list every source it
reads today and add the new one at the end. Preview first:

```bash
docker exec deploy-memrain-1 bun run src/cli.ts auth permissions <token-name> set-read-sources <current read sources>,me-calendar --dry-run
```

Check that `before` and `after` differ only by `me-calendar`: a source missing
from `after` is one the token would stop reading. Then run the same command
without `--dry-run`.

- Google Calendar: [GOOGLE.md](./GOOGLE.md) (a Google Cloud OAuth client of
  your own, then the Connect button).
- Gmail: [GMAIL.md](./GMAIL.md) (the same Google client, the Gmail API turned
  on, and a `mailbox` source).
- Outlook mail and Outlook calendar: [MICROSOFT.md](./MICROSOFT.md) (a
  Microsoft Entra app of your own, and a `mailbox` and a `calendar` source of
  their own, not the Google ones, each connected on its own).
- Slack: [SLACK.md](./SLACK.md) (a Slack app of your own, then the Connect
  button or its pasted bot token, and a `chat` source).
- Teams chats and meeting transcripts: [MICROSOFT.md](./MICROSOFT.md), Part 4
  (three more permissions on the same Entra app, one of them with admin
  consent, and a `chat` and a `meeting` source).
- Fireflies: [FIREFLIES.md](./FIREFLIES.md) (an API key).

Everything a connector writes is text from outside the brain: anyone can put
words in a meeting title or a transcript. It passes the write gate for outside
sources (`MEMRAIN_WRITE_GATE_EXTERNAL`, `flag` by default), and text that reads
like instructions to an AI is stored marked and read back inside a stronger
frame, never acted on.

### 6. Start the scheduler and enable `connector_sync`

```bash
docker exec deploy-memrain-1 bun run src/cli.ts config set MEMRAIN_DAEMONS 1
docker restart deploy-memrain-1
docker exec deploy-memrain-1 bun run src/cli.ts daemons enable connector_sync
docker exec deploy-memrain-1 bun run src/cli.ts daemons status
```

`status` lists `connector_sync` as enabled and paid. It runs every 15 minutes
for each source that has an enabled, active account, and skips quiet hours. To
enable it for one source only, add `--source <id>`.

### 7. Check the caps

Three caps apply to every sync run, and the lowest one wins:

| Cap | Default | Change it with |
|---|---|---|
| Brain-wide, per UTC day | none (step 4 set it) | `MEMRAIN_DAILY_BUDGET_USD` in the host `.env` |
| `connector_sync`, all sources, per day | `$5` | `memrain config set --force MEMRAIN_DAEMON_CONNECTOR_SYNC_MAX_USD_PER_DAY 2`, then `docker restart deploy-memrain-1` |
| One account, per day | `$1.00` and 5,000 items | the account's own settings |

A run also stops after 500 items (`MEMRAIN_CONNECTOR_MAX_ITEMS_PER_RUN`) and
picks up where it stopped on the next run. Each page asked of a provider is
sized to fit in one run, so a lower cap makes a backfill take more runs
instead of reading the same first page again every run. A provider deletion of more than
200 items in one run, or of at least 10 items that are more than 5% of the
account's items, is held for you rather than applied
(`MEMRAIN_CONNECTOR_MASS_DELETE_*`). Every one of these is described in
[CONFIGURATION.md](../CONFIGURATION.md).

### 8. Watch the first two days

Look at these at least daily for 48 hours before you rely on the data:

```bash
docker exec deploy-memrain-1 bun run src/cli.ts doctor             # connector-accounts, connector-health, spend-wallet
docker exec deploy-memrain-1 bun run src/cli.ts connectors status  # every account: state, last clean sync, last run
docker exec deploy-memrain-1 bun run src/cli.ts daemons status
docker exec deploy-memrain-1 bun run src/cli.ts spend --days 2     # where the money went, against the daily caps
```

`connectors status --json` prints the same, with each account's last run
(status, stop reason, HTTP status, counts) for a script to read.

## Meeting credentials in pages stored earlier

Mail and calendar pages are stored without online-meeting credentials: meeting
ids, passcodes, dial-in PINs, one-tap dial strings, SIP addresses and Teams,
Zoom, Webex and Google Meet join links (with the Teams "Meeting options" and
dial-in links, which carry the same ids), plus a password or PIN a mail spells
out under a label. A page stored before a release that stripped them keeps them until its
item changes upstream, which for mail is never. Clean those pages in place:

```bash
docker exec deploy-memrain-1 bun run src/cli.ts connectors redact-meetings            # dry run: pages and credentials per source
docker exec deploy-memrain-1 bun run src/cli.ts connectors redact-meetings --apply --yes
```

`--source ID` limits either run to one source. Each changed page gets a new
version written by `meeting-redact` and is mirrored into search again; the
pages still age out under connector retention. Earlier versions in the
page's history keep the text they had. A page the output reports as not
re-indexed yet is re-indexed by the cycle's mirror-pages phase; until then
search can still return its old text. A second dry run should report 0
pages.

## Optional: the notification webhook secret

Memrain can sign the notifications it posts to a webhook of yours with an
HMAC secret. Skip this section if you do not use a webhook; nothing else
depends on it.

1. In your private ops directory set the opt-in variable and plan:

   ```hcl
   enable_notify_webhook_secret = true
   ```

   ```bash
   terraform plan -var-file=terraform.tfvars
   ```

   Expect one `aws_secretsmanager_secret.notify_webhook[0]` to create and an
   in-place update of the instance role's inline policy (the
   `SecretsReadConnectors` statement now names this secret too). Apply only
   when the plan shows exactly that.

2. Generate a secret of 64 hex characters into a private file and store it in
   `<secrets_prefix>/memrain-notify-webhook`:

   ```bash
   umask 077
   openssl rand -hex 32 > webhook.secret
   aws secretsmanager put-secret-value \
     --secret-id <secrets_prefix>/memrain-notify-webhook \
     --secret-string file://webhook.secret \
     --region <region>
   ```

   Give the same value to the receiver so it can check signatures, then delete
   the local file. Hex keeps the value free of `$` and quotes, which compose
   would otherwise read specially in an env file.

3. Fetch it and redeploy:

   ```bash
   bash deploy/secrets/fetch-secrets.sh     # [secrets] notification webhook secret fetched
   bash deploy/deploy.sh
   ```

The secret lands in `memrain.env` as `MEMRAIN_NOTIFY_WEBHOOK_SECRET`. Delivery
also needs the receiver's `https` address in `MEMRAIN_NOTIFY_WEBHOOK_URL`
(see [CONFIGURATION.md](../CONFIGURATION.md)); with a secret and no address,
webhook delivery stays off.

## Verification

- `memrain connectors status` shows each account with a recent clean run.
- A meeting from your calendar appears in the brain: `search` for its title.
- `memrain daemons status` shows a recent run of `connector_sync` and no
  failures in a row.

## Turning it off

| How fast | Command | Effect |
|---|---|---|
| Now, no restart | `memrain daemons pause connector_sync` | No new sync runs; `resume` undoes it |
| Now, no restart | `memrain daemons pause all` | Every daemon stops scheduling |
| On restart | `memrain config set MEMRAIN_CONNECTORS_ENABLED 0`, then `docker restart deploy-memrain-1` | Connectors closed: no account is synced, no token is opened |

Pages already written stay in the brain in every case. Removing an account's
data is a separate, explicit action.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| doctor: `connectors requested but closed: no connector key: ...` | The secret has no value yet, or fetch-secrets ran before you filled it | Fill it ([KEY.md](./KEY.md)), rerun `fetch-secrets.sh`, redeploy |
| doctor: `... MEMRAIN_CONNECTOR_KEK must decode to 32 bytes` (or `is not base64`) | The value is not base64 of exactly 32 bytes | Put a new value in with [KEY.md](./KEY.md) step 3 before any account is connected |
| `daemons status` shows `connector_sync` but it never runs | `MEMRAIN_DAEMONS` is not `1` in the running process, or no daily budget | Recheck steps 4 and 6; `status` says `MEMRAIN_DAEMONS is not 1` when that is it |
| The admin Connections page answers `connectors_disabled` | Step 3 not applied, or the key failed to load | `docker exec deploy-memrain-1 bun run src/cli.ts doctor` names the reason |
| An account shows `needs_reconnect` | The provider refused its token (expired or revoked). A reason with `unauthorized_client` (`connectors status` and `doctor` show it) means the provider would not renew this one account with the app: for a work account, its organization most likely disabled or removed the app, and only that account stops | Choose **Reconnect** on its row on the Connections page (after `unauthorized_client`, once that organization's administrator has restored the app); the sync resumes from where it stopped. For Google in Testing mode, see [GOOGLE.md](./GOOGLE.md#the-7-day-reconnect); for Microsoft, [MICROSOFT.md](./MICROSOFT.md#keeping-access-alive) |
| A notification says **OAuth app refused by its provider**, and the provider's accounts stop with `client_rejected` | The provider refused the app itself on a renewal (`invalid_client`: an expired or wrong client secret, or a deleted app). Every account of the app would fail alike, so they wait without a reconnect and try once an hour | Create a new client secret for the app and save it with the same client ID under **Use your own OAuth app** on the Connections page; syncing resumes at once. For Microsoft, see [MICROSOFT.md](./MICROSOFT.md#renewing-the-secret) |
| `connectors status` lists an account as `sync on` with `no run recorded yet` | `connector_sync` has not run for it since this release, or connectors are off (the first line says `connectors: off (...)`) | Fix the reason on that first line (step 3); otherwise wait for the next 15-minute window and check `daemons status` (step 6) if it stays |
| `memrain config set MEMRAIN_CONNECTORS_ENABLED 1` prints `WARN — environment ... overrides this stored value` | The variable is also set in the container environment, which wins | Remove it from wherever it is set (a compose override or the `.env`) |
| The daily budget vanished after a host rebuild | A bootstrap run rewrote `.env` | Add `MEMRAIN_DAILY_BUDGET_USD` again (step 4) |

## Related

- [KEY.md](./KEY.md): create, back up and rotate the connector key.
- [GOOGLE.md](./GOOGLE.md): Google Cloud project and OAuth client for Calendar.
- [GMAIL.md](./GMAIL.md): Gmail with the same Google client.
- [MICROSOFT.md](./MICROSOFT.md): Microsoft Entra app for Outlook mail and calendar.
- [SLACK.md](./SLACK.md): Slack app, bot token and channel picker.
- [FIREFLIES.md](./FIREFLIES.md): Fireflies API key.
- [LOOPS.md](./LOOPS.md): who is waiting on whom (`memrain waiting`, `loops_sweep`).
- [CONFIGURATION.md](../CONFIGURATION.md): every connector and daemon setting.
