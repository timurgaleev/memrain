# How to connect an Outlook calendar (Microsoft 365)

This guide registers a Microsoft Entra app of your own and connects an Outlook
calendar to Memrain: a work or school account (Microsoft 365) or a personal
Microsoft account (Outlook.com). When you finish, your meetings land in the
brain as calendar pages, the same pages Google Calendar makes, and an
invitation you have not answered shows up in `memrain waiting`
([LOOPS.md](./LOOPS.md)).

Memrain asks Microsoft for read access only: it never creates, changes,
answers or deletes an event. The app is yours (bring your own, "BYO"): no
Memrain app sits between you and Microsoft.

## Prerequisites

- Connectors are on: [ENABLE.md](./ENABLE.md) steps 1 to 3.
- `MEMRAIN_PUBLIC_URL` is your public `https://` address (bootstrap writes it
  from your domain). Microsoft sends your browser back to an address built
  from it.
- A source of kind `calendar` ([ENABLE.md](./ENABLE.md) step 5). One source
  can hold Google and Outlook calendars side by side.
- A Microsoft Entra tenant where you may register apps: your work tenant (if
  its settings let users register apps, or an admin does it), or the tenant
  that comes with an Azure account. A personal Microsoft account cannot
  register an app on its own; sign up for a free Azure account with it first
  ([register an app](https://learn.microsoft.com/entra/identity-platform/quickstart-register-app)).
  The app can still let personal accounts connect (step 2).

## What Memrain asks for

| Scope | Why |
|---|---|
| `openid`, `email`, `User.Read` | To learn which account connected; the account is labelled with its mail address from Microsoft Graph |
| `offline_access` | To get a refresh token, so syncing keeps working after the first hour |
| `Calendars.Read` | To read your calendars and events |

All of them are delegated permissions a user can consent to for themselves.
The connect flow refuses a grant that adds a Graph permission it did not ask
for (for example `Calendars.ReadWrite` added to the app later) or drops one.

### Personal and work accounts

- **Personal Microsoft account** (outlook.com, hotmail.com, live.com): the
  app's **Supported account types** must include personal accounts, and the
  tenant setting must be `common` (the default) or `consumers`.
- **Work or school account**: whether you can consent yourself depends on the
  tenant's user consent settings. Microsoft recommends allowing user consent
  only for apps from a verified publisher or registered in the tenant
  ([user consent settings](https://learn.microsoft.com/entra/identity/enterprise-apps/configure-user-consent)).
  An app registered in the same tenant as the account is fine under that
  policy. If the consent page says you need an admin's approval, an admin
  grants it once for the tenant: in the Entra admin center, open the app under
  **App registrations > API permissions** and choose
  **Grant admin consent for <tenant>**, or approve the request if the tenant
  runs the admin consent workflow. Then connect again.

## Steps

### 1. Find your redirect URI

Microsoft only sends a sign-in back to an address you registered in advance.
For Memrain that address is the origin of `MEMRAIN_PUBLIC_URL` followed by
`/admin/connectors/callback/microsoft`. For a brain at `brain.example.com`:

```
https://brain.example.com/admin/connectors/callback/microsoft
```

Print yours on the host:

```bash
docker exec deploy-memrain-1 sh -c 'echo "${MEMRAIN_PUBLIC_URL%/}/admin/connectors/callback/microsoft"'
```

Copy the line exactly: Microsoft compares it character by character.

### 2. Register the app

1. Open the [Microsoft Entra admin center](https://entra.microsoft.com/) and
   sign in with the account that will own the app.
2. Go to **Identity > Applications > App registrations** and choose
   **New registration**.
3. **Name**: anything, for example `Memrain on brain.example.com`.
4. **Supported account types**:
   - **Accounts in this organizational directory only** for the work accounts
     of one tenant; then set the tenant to its id or domain (step 6).
   - **Accounts in any organizational directory and personal Microsoft
     accounts** to connect both kinds; leave the tenant at `common`.
   - **Personal Microsoft accounts only** for Outlook.com alone; set the
     tenant to `consumers`.
5. **Redirect URI**: platform **Web**, and paste the line from step 1.
6. Choose **Register**. Copy the **Application (client) ID** from the
   overview.

### 3. Add the permissions

1. Open **API permissions** and choose **Add a permission > Microsoft Graph >
   Delegated permissions**.
2. Tick `openid`, `email`, `offline_access`, `User.Read` (usually there
   already) and `Calendars.Read`. Choose **Add permissions**.
3. Add nothing that writes. A permission added here later does not reach
   Memrain silently: the next connect sees it in the grant and refuses it.

### 4. Create a client secret

1. Open **Certificates & secrets > Client secrets** and choose
   **New client secret**. Pick an expiry; a secret that expires stops every
   connect and every token refresh until you store a new one.
2. Copy the secret's **Value** now (not its id). The center shows it only once.

Put the client id and secret in your password manager, not in a file in the
repository or on the host.

### 5. Store the app in Memrain

1. Open the admin console (`https://<your host>/admin/`) and sign in.
2. On the **Connections** page, in the **Microsoft** panel, open
   **Use your own OAuth app**. It shows the redirect URL from step 1 too.
3. Paste the client id and the secret value and choose **Save app**.

Memrain seals the secret with the connector key ([KEY.md](./KEY.md)) before it
is stored; it is never shown again, logged or returned by the API.

(Alternatively, `MEMRAIN_MICROSOFT_OAUTH_CLIENT_ID` and
`MEMRAIN_MICROSOFT_OAUTH_CLIENT_SECRET` in the process environment are used
when no app is stored. `memrain config set` refuses the secret, which a
settings row would hold in the clear. The form is the recommended path.)

### 6. Set the tenant (only if not `common`)

Memrain signs in through the `common` tenant, which serves work and personal
accounts. An app limited to one directory or to personal accounts needs its
own:

```bash
docker exec deploy-memrain-1 bun run src/cli.ts config set MEMRAIN_MICROSOFT_TENANT organizations   # or consumers, a tenant id, or contoso.onmicrosoft.com
docker restart deploy-memrain-1
```

The setting is read at start-up, hence the restart. A value that is not a
tenant name leaves the Microsoft panel out of the Connections page and logs
`MEMRAIN_MICROSOFT_TENANT is not ...` once.

### 7. Connect your calendar

1. On the **Connections** page, in the **Microsoft** panel, pick a source of
   kind `calendar` under **Into source** and choose **Connect Microsoft**.
2. Microsoft opens. Pick the account and allow the access it lists.
3. Microsoft sends you back to the redirect URI. Choose **Finish connecting**;
   the account appears as connected, sync off.
4. Choose **Turn sync on** for the account. Nothing is read before that.

With `connector_sync` enabled ([ENABLE.md](./ENABLE.md) step 6), the first
sync starts within 15 minutes.

### 8. Let your agents read it

A new source is not in any agent's read set. Add it as
[ENABLE.md](./ENABLE.md) step 5 shows (`auth rescope-client ... --dry-run`,
then without it), or for a member: `auth permissions <name> set-read-sources`.

### 9. Pick calendars and the history window (optional)

Memrain syncs the account's default calendar and reads the last 90 days of it
on the first sync. To add your other calendars or change the window, choose
**Calendars** on the account's row, tick them, and choose **Save calendars**.
The default calendar is always synced. The limits are those of Google Calendar
([GOOGLE.md](./GOOGLE.md) step 8): up to 19 calendars besides the default, and
a window of 1 to 3,650 days, never past the calendar retention window.

Only calendars the account owns are offered. A calendar a colleague shares
with you, or a Microsoft 365 group calendar, is not: reading another user's
calendar needs `Calendars.Read.Shared`, which Memrain does not ask for.

Graph offers change tracking for the default calendar only, so another
calendar is read whole, at most once an hour: its changes can be up to an hour
late, and an event deleted there goes at the next reading.

## What is stored

- One page per event, and one per recurring series with its occurrences in the
  window (the last 90 days to 90 days ahead), rendered exactly like a Google
  Calendar event: title, time, place, organizer, attendees and their answers,
  description.
- Rooms and equipment are not listed as attendees.
- An online meeting is noted as `Online meeting: yes`. Its join link is not
  stored: it is dropped from the event and cut out of the description.
- A cancelled or deleted event goes the way Google Calendar's do: its page is
  soft-deleted (restorable with `page_restore` until the usual purge), under
  the mass-delete guard.
- Your own answer comes from Outlook's record of it. An invitation you have not
  answered, for a meeting still ahead, opens an `rsvp_owed` loop to its
  organizer; accepting or declining in Outlook closes it on the next sync. An
  organizer who asked for no answer is owed none.

## How syncing works

Memrain reads the default calendar through Graph's calendar view delta
([delta-query-events](https://learn.microsoft.com/graph/delta-query-events)),
and other calendars as step 9 says:
a first pass over the window, then only what changed. Graph fixes the window
when a pass starts, so Memrain starts a fresh pass once a week to move it
forward, and whenever Graph says it lost the pass (`410` or
`syncStateNotFound`); events the fresh pass no longer has are deleted. Graph
limits an app to 10,000 requests per 10 minutes per mailbox
([Outlook service limits](https://learn.microsoft.com/graph/throttling-limits#outlook-service-limits));
a `429` is waited out for as long as `Retry-After` asks, and a run that still
cannot go on stops and resumes where it stopped.

A refresh token of a web app has no fixed lifetime, but Microsoft can end it
(a password reset, a revoked consent, a long idle stretch). The account then
turns `needs_reconnect` and syncing pauses with nothing lost; choose
**Reconnect** on its row.

## Verification

On the Connections page the account reads **Syncing** and, after the first
clean run, **Last sync** shows when. From the host:

```bash
docker exec deploy-memrain-1 bun run src/cli.ts connectors status
```

The Microsoft account is listed under `accounts:` and, after the first run,
with `last run success` or `nothing_new`. Search the brain for the title of a
meeting from this week.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Microsoft shows `AADSTS50011` (redirect URI mismatch) | The registered URI differs from what Memrain sent | Register the exact line from step 1 as a **Web** redirect URI |
| Microsoft shows `AADSTS50020` or says the account does not exist in the tenant | The app's supported account types or the tenant setting exclude this kind of account | Step 2 item 4 and step 6 |
| Microsoft says you need admin approval (`AADSTS65001`, `AADSTS90094`) | The tenant does not let users consent to this app | An admin grants consent for the tenant ([personal and work accounts](#personal-and-work-accounts)), then connect again |
| Back in Memrain, the page reports `provider_denied` | You cancelled, or Microsoft refused the consent | Connect again; for a refusal, see the row above |
| Back in Memrain, the page reports `scope_mismatch` | The app carries a Graph permission Memrain did not ask for, or one was not granted | Remove the extra permission in **API permissions** (step 3) and connect again |
| The Connections page answers `no_client` | No app is stored for Microsoft | Step 5 |
| No Microsoft panel on the Connections page | `MEMRAIN_MICROSOFT_TENANT` is not a tenant name | Fix it (step 6) and restart |
| The account turns `needs_reconnect` | Microsoft ended the refresh token, or the client secret expired | **Reconnect**; for an expired secret, create a new one (step 4) and store it (step 5) first |

## Disconnecting

Disconnect the account on the Connections page; Memrain deletes the stored
credential. The identity platform has no endpoint to revoke a delegated
refresh token, so remove the app's access on Microsoft's side too: for a work
account at [myapps.microsoft.com](https://myapps.microsoft.com) (or an admin
removes the app's grant), for a personal account at
[account.live.com/consent/Manage](https://account.live.com/consent/Manage).
Pages already synced stay in the brain unless you also remove the account's
data.

## Related

- [ENABLE.md](./ENABLE.md): the order to switch connectors on.
- [KEY.md](./KEY.md): the connector key that seals the client secret and the
  tokens.
- [GOOGLE.md](./GOOGLE.md): the same for Google Calendar.
- [LOOPS.md](./LOOPS.md): who is waiting on whom.
