# How to connect Google Calendar

This guide sets up a Google Cloud OAuth client of your own and connects your
calendar to Memrain. When you finish, your meetings land in the brain as
calendar pages and show up in the chronicle.

Memrain asks Google for read access only: it never creates, changes or
deletes an event. The client is yours (bring your own, "BYO"): no Memrain
project sits between you and Google.

## Prerequisites

- Connectors are on: [ENABLE.md](./ENABLE.md) steps 1 to 3.
- `MEMRAIN_PUBLIC_URL` is your public `https://` address (bootstrap writes it
  from your domain). Google sends your browser back to an address built from
  it.
- A Google account that can create a Google Cloud project. For a company
  calendar, the Workspace admin may have to allow it.

## What Memrain asks for

| Scope | Why |
|---|---|
| `openid`, `email` | To learn which Google account connected; the account is labelled with its verified address |
| `https://www.googleapis.com/auth/calendar.readonly` | To read your calendars and events |

The connect flow requests exactly these and refuses a grant that adds or drops
one. `calendar.readonly` is a sensitive scope in Google's terms: fine for an
app in Testing with you as a test user, but it needs Google's verification
before an app in production can show it to anyone else.

## Steps

### 1. Find your redirect URI

Google only sends a sign-in back to an address you registered in advance. For
Memrain that address is the origin of `MEMRAIN_PUBLIC_URL` followed by
`/admin/connectors/callback/google`. For a brain at `brain.example.com`:

```
https://brain.example.com/admin/connectors/callback/google
```

Print yours on the host:

```bash
docker exec deploy-memrain-1 sh -c 'echo "${MEMRAIN_PUBLIC_URL%/}/admin/connectors/callback/google"'
```

Only the scheme, host and port of `MEMRAIN_PUBLIC_URL` count: a path on it is
dropped. Copy the line exactly: Google compares it character by character.

### 2. Create a Google Cloud project

1. Open the [Google Cloud console](https://console.cloud.google.com/) and sign
   in with the Google account that owns the calendar (or a Workspace admin
   account).
2. In the project picker, choose **New project**, name it (for example
   `memrain-connectors`) and create it. Make sure it is selected.

### 3. Turn on the Google Calendar API

1. Open **APIs & Services > Library**.
2. Search for **Google Calendar API**, open it and choose **Enable**.

Without this, the connect works but every sync fails with an
`accessNotConfigured` error.

### 4. Configure the consent screen

1. Open **Google Auth platform > Branding**. If it says the platform is not
   configured yet, choose **Get started**.
2. Under **App information**, enter an app name (for example
   `Memrain on brain.example.com`) and your address as **User support email**.
   Choose **Next**.
3. Under **Audience**, pick the user type:
   - **Internal** if the project belongs to a Google Workspace organization and
     only accounts of that organization will connect. Internal apps have no
     test-user list and no 7-day token limit.
   - **External** for a personal `gmail.com` account, or any account outside
     your organization. The app starts in **Testing**.
4. Enter a contact address, accept the Google API Services User Data Policy,
   and create.
5. External only: open **Audience**, and under **Test users** choose
   **Add users**, add the Google account whose calendar you will connect, and
   save. An External app in Testing refuses every account not on this list
   (at most 100).
6. Open **Data Access**, choose **Add or remove scopes**, and add
   `openid`, `.../auth/userinfo.email` and `.../auth/calendar.readonly`
   (filter by "calendar.readonly" to find it). Save.

Leave the app in Testing. Publishing it to production with
`calendar.readonly` sends it into Google's verification review, which a brain
of your own does not need. Read [the 7-day reconnect](#the-7-day-reconnect)
before you decide.

### 5. Create the OAuth client

1. Open **Google Auth platform > Clients** and choose **Create client**.
2. **Application type**: **Web application**. **Name**: anything, for example
   `memrain`; only you see it.
3. Under **Authorized redirect URIs**, choose **Add URI** and paste the line
   from step 1. Add nothing under **Authorized JavaScript origins**.
4. Choose **Create**.
5. Copy the **Client ID** and the **Client secret** from the dialog now.
   Google shows the full secret only at creation; afterwards the console masks
   it, and a lost secret means adding a new one to the client.

Put both in your password manager, not in a file in the repository or on the
host.

### 6. Store the client in Memrain

1. Open the admin console (`https://<your host>/admin/`) and sign in.
2. Open the **Connections** page and choose **Google**.
3. Paste the client ID and client secret into the OAuth client form and save.

Memrain seals the secret with the connector key ([KEY.md](./KEY.md)) before it
is stored; it is never shown again, logged or returned by the API. Saving a
new client for Google later replaces the stored one.

(Alternatively, `MEMRAIN_GOOGLE_OAUTH_CLIENT_ID` and
`MEMRAIN_GOOGLE_OAUTH_CLIENT_SECRET` in the process environment are used when
no client is stored. The form is the recommended path: it keeps the secret out
of `.env` files and shell history.)

### 7. Connect your calendar

1. On the **Connections** page, choose **Connect** for Google, pick the source
   the calendar should belong to and the **calendar** service.
2. Google opens. Sign in with the test user from step 4, and allow the access
   it lists. On an app in Testing, Google first warns that it has not verified
   the app; continue, since it is your own.
3. Google sends you back to the redirect URI. The page posts back to Memrain
   and the account appears with status `active`.

With `connector_sync` enabled ([ENABLE.md](./ENABLE.md) step 6), the first
sync starts within 15 minutes.

### 8. Pick calendars and the history window (optional)

Memrain syncs your primary calendar and reads the last 90 days of it on the
first sync. To add other calendars the account can read (busy-only ones are
not offered) or change the window, use the admin API with your admin session:

```
GET  /admin/api/connectors/accounts/<account id>/calendars
POST /admin/api/connectors/accounts/<account id>/calendars
{"calendars": ["<calendar id>", ...], "history_days": 365}
```

The list is checked against what Google returns for the account; primary is
always synced. Up to 19 calendars besides primary, and a window of 1 to 3,650
days, never past the retention window. A new window applies to calendars that
have not had their first sync yet.

## The 7-day reconnect

Google limits refresh tokens for apps that are not published. From Google's
[OAuth 2.0 documentation](https://developers.google.com/identity/protocols/oauth2#expiration),
"Refresh token expiration": an app with an **External** user type and a
publishing status of **Testing** is issued a refresh token that expires in
7 days, unless the only scopes are name, email address and profile.
`calendar.readonly` is not one of those, so this applies.

What you see: about a week after you connect, the account turns
`needs_reconnect`, `memrain doctor` names it, and syncing pauses. No data is
lost. Choose **Connect** again on the Connections page; the sync carries on from
where it stopped.

Ways out, from least to most effort:

| Option | When it fits |
|---|---|
| Reconnect weekly | A personal brain; it takes a minute |
| **Internal** user type | The calendar belongs to a Google Workspace organization that owns the project |
| Publish the app | You need it to keep working for External accounts; `calendar.readonly` then needs Google's verification |

Two more Google rules can end a token early: a token unused for six months
expires, and Google keeps at most 100 refresh tokens per Google account per
client, silently revoking the oldest past that. Memrain asks for a fresh
consent on every connect, so reconnecting does not pile up tokens beyond that.

## Verification

```bash
docker exec deploy-memrain-1 memrain connectors status
```

The Google account shows status `active` and, after the first run, a recent
clean run. Search the brain for the title of a meeting from this week.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Google shows `Error 400: redirect_uri_mismatch` | The registered URI differs from what Memrain sent | Register the exact line from step 1 in the client (step 5), including `https` and no trailing slash |
| Google shows `Error 403: access_denied` | The account is not a test user of an External app in Testing | Add it under **Audience > Test users** (step 4) |
| Back in Memrain, the page reports `scope_mismatch` | A scope box was unticked on Google's consent page | Connect again and allow every listed access |
| Back in Memrain, the page reports `provider_denied` | You chose **Cancel** on Google's consent page | Connect again |
| The Connections page answers `no_client` | No OAuth client is stored for Google | Step 6 |
| The Connections page answers `redirect_uri` | `MEMRAIN_PUBLIC_URL` is unset or not `https` | Fix the domain in your stack settings and redeploy |
| Syncs fail with `accessNotConfigured` | The Google Calendar API is off in the project | Step 3 |
| The account turns `needs_reconnect` after about a week | The Testing-mode 7-day token limit | [The 7-day reconnect](#the-7-day-reconnect) |
| You lost the client secret | Google shows it only at creation | Add a new secret to the client in **Clients**, store it with step 6, then delete the old secret in Google |

## Disconnecting

Disconnect the account on the Connections page. Memrain revokes the token at
Google, then deletes the stored credential. If Google cannot be reached, the
account is parked as `error` (`revoke_failed`) and the credential is kept so
the disconnect can be retried. You can also remove the access from
the Google side at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).
Pages already synced stay in the brain unless you also remove the account's
data.

## Related

- [ENABLE.md](./ENABLE.md): the order to switch connectors on.
- [KEY.md](./KEY.md): the connector key that seals the client secret and the
  tokens.
- [FIREFLIES.md](./FIREFLIES.md): meeting transcripts.
