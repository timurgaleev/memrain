# How to connect Slack

Connected to Memrain, the Slack channels you pick land in the brain as one
page per channel per day: who said what, and when, with each thread's replies
under the message that started it. Memrain reads with a bot of a Slack app you
create for your own workspace. It only reads: it never posts, reacts or joins
a channel by itself.

## Prerequisites

- Connectors are on: [ENABLE.md](./ENABLE.md) steps 1 to 3.
- A source of kind `chat` to hold the channels. The Connections page offers
  only sources of that kind, so register one first:

  ```bash
  docker exec deploy-memrain-1 bun run src/cli.ts sources register team-chat --kind chat --path-prefix chat/
  ```

  Then add it to the read sources of the agents that should see it
  ([ENABLE.md](./ENABLE.md) step 5).
- `MEMRAIN_PUBLIC_URL` set to the brain's https address, if you connect with
  the Connect button (option A below). Slack sends you back to it.
- You can create apps in the Slack workspace, or a workspace admin does it for
  you. Some workspaces only let admins install apps; then an admin approves
  the install.

## What Memrain reads, and what it never reads

- **Only the channels you pick.** Nothing syncs until you tick channels in the
  channel picker, and the bot must be a member of each one: Slack does not let
  a bot read a channel it was not invited to.
- **Public channels** need three bot scopes: `channels:history` (the
  messages), `channels:read` (the channel's name, for the picker) and
  `users:read` (people's names instead of ids).
- **Private channels** are off by default. They need two more scopes,
  `groups:history` and `groups:read`, ticking **Private channels too** when you
  connect, and the bot invited to each private channel.
- **Direct messages are never read.** A bot only sees messages sent to the bot
  itself, so there is nothing useful there, and Memrain does not ask for the
  `im:` scopes.
- Files are listed by name only (`[file: report.pdf]`). Their contents are
  never downloaded.
- Memrain refuses a token or a grant with any other scope, such as
  `chat:write`. A write scope means the app could post as the bot, and Memrain
  never needs that.

## Step 1. Create the Slack app

1. Open [api.slack.com/apps](https://api.slack.com/apps) and sign in to the
   workspace.
2. Choose **Create New App**, then **From scratch**.
3. **App Name**: anything you like, for example `Memrain`. **Pick a workspace**:
   the workspace whose channels you want. Choose **Create App**.

Keep the app in this one workspace. Do not turn on distribution under
**Manage Distribution**: Slack gives apps distributed to other workspaces
outside the Slack Marketplace much lower limits on reading channel history,
while an app installed only in your own workspace keeps the normal limits.

If you prefer, choose **From a manifest** instead and paste this, with your
brain's address in place of `<host>` (leave out the `groups:` lines to stay
with public channels):

```yaml
display_information:
  name: Memrain
features:
  bot_user:
    display_name: Memrain
    always_online: false
oauth_config:
  redirect_urls:
    - https://<host>/admin/connectors/callback/slack
  scopes:
    bot:
      - channels:history
      - channels:read
      - users:read
      - groups:history
      - groups:read
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

With the manifest, the scopes and the redirect URL are already set: go on to
step 3.

## Step 2. Give the bot its scopes and the redirect URL

1. In the app's left menu, open **OAuth & Permissions**.
2. Under **Redirect URLs**, choose **Add New Redirect URL**, enter
   `https://<host>/admin/connectors/callback/slack` (your brain's address in
   place of `<host>`; the Connections page shows the exact URL with a copy
   button under **Use your own OAuth app**), choose **Add**, then **Save URLs**.
3. Under **Scopes**, in **Bot Token Scopes** (not User Token Scopes), choose
   **Add an OAuth Scope** and add `channels:history`, `channels:read` and
   `users:read`. For private channels add `groups:history` and `groups:read`
   too.
4. Leave **token rotation** off. Memrain stores the bot token and uses it as it
   is; with rotation on, Slack expires the token every 12 hours.

## Step 3. Connect Memrain

Pick one of the two ways. Both end the same: one sealed bot token for the
workspace and a Slack account on the Connections page, with its sync off.

### Option A: the Connect button (your app's client ID and secret)

1. In the Slack app, open **Basic Information**. Under **App Credentials**,
   copy the **Client ID**, then choose **Show** next to **Client Secret** and
   copy it.
2. Open the admin console (`https://<host>/admin/`), sign in, and go to
   **Connections**.
3. In the **Slack** panel, open **Use your own OAuth app**, paste the client ID
   and the client secret, and choose **Save app**. The secret is sealed with
   the connector key and never shown again. (Instead of the form, an operator
   can set `MEMRAIN_SLACK_OAUTH_CLIENT_ID` and `MEMRAIN_SLACK_OAUTH_CLIENT_SECRET`
   in the server's environment; an app saved in the form wins.)
4. Back at the top of the **Slack** panel, keep **Public channels** ticked, tick
   **Private channels too** only if you want them, pick the `chat` source under
   **Into source**, leave **Slack bot token (optional)** empty, and choose
   **Connect Slack**.
5. Slack shows what the app may read. Choose **Allow**. Slack sends you back to
   the brain; choose **Finish connecting** on the page that opens.

### Option B: paste the bot token

1. In the Slack app, open **OAuth & Permissions** and choose **Install to
   Workspace** (or **Reinstall to Workspace**), then **Allow**.
2. Copy the **Bot User OAuth Token**. It starts with `xoxb-`.
3. On the **Connections** page, in the **Slack** panel, pick the `chat` source,
   paste the token into **Slack bot token (optional)** and choose
   **Connect Slack**.

Paste the token into that form only. Do not put it in `.env`, a chat with your
agent, or a brain page. Memrain checks it with Slack (`auth.test`) before it
stores anything: a user token (`xoxp-`) is refused, and so is a token that
holds any scope beyond the read scopes above. Whether private channels are
offered follows from the token's scopes.

A script can call the same route with an admin session cookie and the brain's
own `Origin`:

```
POST /admin/api/connectors/slack/key
{"source_id": "<chat source>", "api_key": "<the bot token>"}
```

## Step 4. Invite the bot to each channel

In Slack, open each channel you want in the brain and type:

```
/invite @Memrain
```

(use your app's name). Or open the channel's details, then **Integrations**,
then **Add apps**. For a private channel, invite the bot the same way.

## Step 5. Pick the channels and switch sync on

1. On the **Connections** page, find the Slack row (it is named after the
   workspace) and choose **Channels**.
2. Tick the channels to sync. A channel the bot is not in yet says so and
   cannot be ticked: invite the bot (step 4), then open **Channels** again.
3. **History window in days**: how far back a channel's first sync reads, 1 to
   365 days, 14 by default. Choose **Save channels**.
4. Choose **Turn sync on**. The next sync run (every 15 minutes by default)
   reads the channels.

## How syncing works

- Each channel day is one page in the `chat` source, in UTC days. A thread
  reply stays with the message that started the thread, with its own date
  when it came on a later day.
- Every run reads each channel's last three days again, and today, with one
  history request per day. A day whose messages did not change costs that one
  request: its threads are not read and nothing is written. An edited or
  deleted message, or a new reply, rebuilds that day's page at once. An edit
  to a thread reply does not change the messages Slack lists for the day, so
  each of those days also reads its threads once a day; such an edit shows up
  by the next UTC day.
- A reply to a thread older than those three days is not picked up, unless it
  was also sent to the channel.
- A day whose messages were all deleted in Slack is deleted from the brain the
  way any connector deletion is (recoverable for 30 days, see
  [PRIVACY.md](../../PRIVACY.md)).
- Taking a channel off the list stops reading it. Its pages stay. To remove
  them, use **Delete its data…** on the account (everything the account
  brought in).
- A channel the bot was removed from, or a private channel the account was not
  granted, is held as one failing item on the account; the other channels keep
  syncing. The hold clears by itself once the channel can be read again.
- Slack's rate limits are waited out when Slack says how long to wait (up to a
  minute). A longer wait ends the run as partial, and the next run carries on
  from where it stopped.
- Everything synced is outside text: it is marked untrusted, credentials found
  in it are cut out, and it never counts as an instruction to an agent.
  Reading costs nothing in model calls; only the usual embeddings of new pages
  are paid, under the account's daily cap.

## Disconnecting

**Disconnect…** on the account revokes the bot token at Slack (`auth.revoke`)
and drops it from the brain. A pasted token is revoked too: to connect again,
reinstall the app in Slack and paste the new token. The synced pages stay
until you delete them with **Delete its data…**. To remove the app from Slack
altogether, open the app's **Basic Information** page and choose
**Delete App** at the bottom.

## Troubleshooting

| What you see | Why | Fix |
|---|---|---|
| `no_client` when you choose Connect Slack | No Slack app saved and none in the environment | Save the app's client ID and secret (option A, step 3), or paste a bot token (option B) |
| Slack says the redirect URL does not match | The app's Redirect URLs lack the brain's callback address | Add `https://<host>/admin/connectors/callback/slack` exactly (step 2) |
| `scope_mismatch` | The token or grant has a scope beyond the read scopes, such as `chat:write` | Remove the extra scope under **OAuth & Permissions**, reinstall the app, connect again |
| `key_invalid` when pasting | Not a bot token (a user token starts with `xoxp-`) | Copy the **Bot User OAuth Token** (`xoxb-`) |
| A channel cannot be ticked in the picker | The bot is not in the channel | `/invite @<your app>` in the channel (step 4) |
| No private channels in the picker | The account has no private-channel scopes | Add `groups:history` and `groups:read`, reinstall, connect again with **Private channels too** |
| The account shows `needs_reconnect` | Slack no longer accepts the token (revoked, app removed or reinstalled) | Connect again: option A, or paste the new token (option B) |
| A held item `slack_not_in_channel` | The bot was removed from a picked channel | Invite it back; the hold clears on the next run |

## Related

- [ENABLE.md](./ENABLE.md): turn connectors on.
- [KEY.md](./KEY.md): the connector key that seals the token.
- [CONFIGURATION.md](../CONFIGURATION.md): `MEMRAIN_SLACK_OAUTH_CLIENT_ID`,
  `MEMRAIN_SLACK_OAUTH_CLIENT_SECRET` and the shared connector settings.
