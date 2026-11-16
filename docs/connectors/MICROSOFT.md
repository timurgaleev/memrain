# How to connect Outlook mail and calendar (Microsoft 365)

This guide sets up a Microsoft Entra app of your own and connects your
Outlook mailbox and your Outlook calendar to Memrain. It works for a work or
school account (Microsoft 365) and for a personal account (outlook.com,
hotmail.com, live.com). When you finish, your mail threads and meetings land
in the brain the same way Gmail and Google Calendar do.

Memrain asks Microsoft for read access only: it never sends, moves, flags or
deletes mail, and never creates or changes an event. The app is yours (bring
your own): no Memrain app sits between you and Microsoft.

You connect mail and calendar separately. Each one is its own account on the
Connections page, writing into its own source. One Entra app serves both.

## Prerequisites

- Connectors are on: [ENABLE.md](./ENABLE.md) steps 1 to 4.
- `MEMRAIN_PUBLIC_URL` is your public `https://` address (bootstrap writes it
  from your domain). Microsoft sends your browser back to an address built
  from it.
- A Microsoft Entra directory (also called a tenant) to register the app in:
  - **Work or school account:** your organization's directory. Members can
    register apps unless the organization turned that off. If registering
    is refused, your IT admin either does steps 2
    to 5 for you or gives you the Application Developer role.
  - **Personal account only:** since June 2024 Microsoft no longer lets a
    personal account register an app outside a directory
    ([breaking changes, "Applications must be registered in a directory"](https://learn.microsoft.com/entra/identity-platform/reference-breaking-changes)).
    Create a free directory by [signing up for Azure](https://aka.ms/signUpForAzure)
    or [joining the Microsoft 365 Developer Program](https://aka.ms/joinM365DeveloperProgram)
    with the same personal account, then register the app there. The mailbox
    you connect stays your personal one.

## What Memrain asks for

These are Microsoft Graph **delegated** permissions: Memrain acts as you,
and only on your own mailbox and calendar.

| Permission | Why |
|---|---|
| `openid`, `email` | To learn which account connected; the account is labelled with its address |
| `offline_access` | To keep syncing after you close the browser (a refresh token) |
| `User.Read` | To read your own profile: the address the account is labelled with |
| `Mail.Read` | Outlook mail: to read your messages |
| `Calendars.Read` | Outlook calendar: to read your events |

A mail connect asks for `Mail.Read` and a calendar connect for
`Calendars.Read`, each with the four above; a connect never asks for the
other service's permission. Microsoft answers every connect with all the
permissions this account has given the app, so a calendar connect after a
mail connect comes back holding `Mail.Read` too. That one is accepted, since
it is the other service's read permission. Any other difference (a write
permission such as `Mail.ReadWrite` or `Mail.Send`, a permission Memrain does
not use, or a requested one missing) makes the connect refuse the grant, and
it stores nothing then.

On a personal account you consent yourself when you connect. On a work or
school account you usually cannot: Microsoft's default consent setting for
organizations ("Let Microsoft manage your consent settings", also the default
for a new organization) keeps `Mail.Read` and `Calendars.Read` for an
administrator to approve
([app consent policies](https://learn.microsoft.com/entra/identity/enterprise-apps/manage-app-consent-policies),
"Microsoft recommended user consent policy"). Plan on an IT admin granting
consent once for the app: [step 6](#6-work-accounts-ask-an-admin-to-grant-consent).

## Steps

### 1. Find your redirect URI

Microsoft only sends a sign-in back to an address registered in the app. For
Memrain it is the origin of `MEMRAIN_PUBLIC_URL` followed by
`/admin/connectors/callback/microsoft`. For a brain at `brain.example.com`:

```
https://brain.example.com/admin/connectors/callback/microsoft
```

Print yours on the host:

```bash
docker exec deploy-memrain-1 sh -c 'echo "${MEMRAIN_PUBLIC_URL%/}/admin/connectors/callback/microsoft"'
```

The Connections page shows the same line with a **Copy** button, under
**Use your own OAuth app** in the **Microsoft** panel. Microsoft compares it
exactly, including upper and lower case, so copy it rather than typing it.

### 2. Register the app

1. Sign in to the [Microsoft Entra admin center](https://entra.microsoft.com).
   If your account sees several directories, use the **Settings** icon in the
   top menu to switch to the one you register the app in.
2. Open **Entra ID > App registrations** and choose **New registration**.
3. **Name**: anything you will recognise, for example
   `Memrain on brain.example.com`. People see it on the consent screen.
4. **Supported account types**: pick who may connect. This choice decides
   the **Who can sign in** value you enter in Memrain in step 7.

   | Supported account types | Use it when | Who can sign in, in Memrain |
   |---|---|---|
   | **Any Entra ID Tenant + Personal Microsoft accounts** | You connect a personal account, or both kinds | Work, school and personal accounts (`common`) |
   | **Personal accounts only** | Only personal accounts will connect | Personal accounts only (`consumers`) |
   | **Multiple Entra ID tenants** | Only work or school accounts, possibly of several organizations | Work or school accounts only (`organizations`) |
   | **Single tenant only - &lt;your directory&gt;** | Only accounts of the directory you register in | One organization: its directory ID or domain |

   Older screens name the first option "Accounts in any organizational
   directory and personal Microsoft accounts"; it is the same type.
5. Leave **Redirect URI** empty here; step 3 adds it with the right platform.
6. Choose **Register**. The app's **Overview** page opens. Note two values:
   **Application (client) ID**, and for a single-tenant app also
   **Directory (tenant) ID**.

### 3. Add the redirect URI as a Web platform

1. In the app, under **Manage**, open **Authentication**.
2. On the **Redirect URI configuration** tab, choose **Add Redirect URI**.
3. Pick the **Web** tile. Not **Single-page application**: Microsoft ends
   refresh tokens issued to that platform after 24 hours
   ([refresh tokens](https://learn.microsoft.com/entra/identity-platform/refresh-tokens)),
   and Memrain's connect is a server-side web flow.
4. Paste the line from step 1 as the **Redirect URI**, leave
   **Front-channel logout URL** empty, and choose **Configure**.

### 4. Create the client secret

1. In the app, open **Certificates & secrets > Client secrets** and choose
   **New client secret**.
2. Enter a description (for example `memrain`) and pick an expiry. Microsoft
   allows at most 24 months and recommends less than 12; note the date, the
   connect stops working when the secret expires.
3. Choose **Add** and copy the **Value** column right away. Microsoft shows
   the value once; after you leave the page it is masked for good. The
   **Secret ID** next to it is not the secret.

Put the value in your password manager, not in a file in the repository or on
the host.

### 5. Add the Microsoft Graph permissions

1. In the app, open **API permissions**. `User.Read` is already there.
2. Choose **Add a permission > Microsoft Graph > Delegated permissions**.
3. Search for and tick `Mail.Read`, `Calendars.Read`, `offline_access`,
   `openid` and `email` (the last three sit under **OpenId permissions**).
4. Choose **Add permissions**. The list under **Configured permissions** now
   shows the six from [What Memrain asks for](#what-memrain-asks-for).

Do not add `Mail.ReadWrite`, `Mail.Send`, `Calendars.ReadWrite` or any
**Application permissions**: Memrain does not ask for them, and a grant that
includes them is refused.

### 6. Work accounts: ask an admin to grant consent

Skip this step for a personal account.

Your organization decides what users may consent to themselves
([user consent settings](https://learn.microsoft.com/entra/identity/enterprise-apps/configure-user-consent)),
and its default keeps mail and calendar access for an administrator. Unless
your organization changed that, connecting in step 9 shows
**Need admin approval** until an admin grants consent for the app. If you are
that admin, do it now; otherwise ask your IT admin, and send them:

- the app's name and its **Application (client) ID**;
- the permissions: delegated `Mail.Read`, `Calendars.Read`, `User.Read`,
  `offline_access`, `openid`, `email`, all read-only, no application
  permissions;
- what it is for: a private memory of your own mail and calendar, run on your
  team's own server.

An admin with the Cloud Application Administrator, Application Administrator
or Privileged Role Administrator role can grant it in the app under
**API permissions > Grant admin consent for &lt;organization&gt;**, or under
**Entra ID > Enterprise apps > All applications > &lt;app&gt; > Security >
Permissions > Grant admin consent**
([grant admin consent](https://learn.microsoft.com/entra/identity/enterprise-apps/grant-admin-consent)).
Admin consent covers the whole organization and only an admin can take it
back; your own consent you can remove yourself. Granting it once for the app
covers both mail and calendar, since the app lists both permissions.

If you connect before consent is granted, Microsoft either shows **Need admin
approval** (with a request form, when the organization turned admin consent
requests on) or sends you back to Memrain, whose page then reports
`admin_consent_required`. Either way nothing is stored; connect again once
the admin has granted consent.

### 7. Store the app in Memrain

1. Open the admin console (`https://<your host>/admin/`) and sign in.
2. On the **Connections** page, in the **Microsoft** panel, open
   **Use your own OAuth app**.
3. Paste the **Application (client) ID** under **Client ID** and the secret
   **Value** under **Client secret**.
4. Under **Who can sign in**, pick the value from the table in step 2. For a
   single-tenant app choose **One organization: its directory ID or domain**
   and enter the **Directory (tenant) ID** from the app's Overview page (a
   verified domain such as `contoso.onmicrosoft.com` works too).
5. Choose **Save app**. The panel shows the saved client and who can sign in.

Memrain seals the secret with the connector key ([KEY.md](./KEY.md)) before
it is stored; it is never shown again, logged or returned by the API. Saving
a new app later replaces the stored one, tenant included. A new secret for
the same app (before the old one expires) is saved the same way: paste the
same client ID and the new value.

(The code also reads a server-wide app from the process environment,
`MEMRAIN_MICROSOFT_OAUTH_CLIENT_ID`, `MEMRAIN_MICROSOFT_OAUTH_CLIENT_SECRET`
and `MEMRAIN_MICROSOFT_OAUTH_TENANT`, when none is stored; see
[CONFIGURATION.md](../CONFIGURATION.md). On a deployed stack use the form:
the compose file does not pass these from the host `.env`, and the form keeps
the secret out of files and shell history.)

### 8. Register the sources and let your agents read them

Each service writes into a source of its own kind: Outlook mail into a
`mailbox` source, Outlook calendar into a `calendar` source. The ids and
prefixes are yours to choose. If you already connected Gmail or Google
Calendar, you can reuse those sources or register new ones. On the host:

```bash
docker exec deploy-memrain-1 bun run src/cli.ts sources register work-mail --kind mailbox --path-prefix work-mail/
docker exec deploy-memrain-1 bun run src/cli.ts sources register work-calendar --kind calendar --path-prefix work-calendar/
```

Then let your agents read them. For each OAuth client that should see the
new sources, add them to its read set. The list replaces the client's whole
read set, so name every source it reads today and the new ones at the end.
Preview with `--dry-run` (only the read set should change), then run the same
command without it:

```bash
docker exec deploy-memrain-1 bun run src/cli.ts auth rescope-client <client_id> --source <its write source> \
  --federated-read <its current read sources>,work-mail,work-calendar --dry-run
```

For a personal access token, `set-read-sources` works the same way:

```bash
docker exec deploy-memrain-1 bun run src/cli.ts auth permissions <token-name> set-read-sources <current read sources>,work-mail,work-calendar --dry-run
```

Check that `before` and `after` differ only by the new sources: a source
missing from `after` is one the client would stop reading. Then run it
without `--dry-run`. Reload the Connections page so it lists the new sources.

### 9. Connect Outlook mail

1. On the **Connections** page, in the **Microsoft** panel, choose
   **Outlook mail** under **Read**. **Outlook mail** and **Outlook calendar**
   are a single choice; each is connected on its own.
2. Pick `work-mail` under **Into source** (only `mailbox` sources are
   listed) and choose **Connect Microsoft**.
3. Microsoft opens. Sign in with the account whose mailbox you connect, read
   the list of permissions, and choose **Accept**. After an admin granted
   consent for the organization (step 6), a work account may go straight
   through without this screen.
4. Microsoft sends you back to Memrain. Choose **Finish connecting**; the page
   posts back to Memrain and the account appears as connected, sync off.
5. Choose **Turn sync on** for the account. Nothing is read before that.

With `connector_sync` enabled ([ENABLE.md](./ENABLE.md) step 6), the first
sync starts within 15 minutes.

### 10. Connect Outlook calendar

Repeat step 9 with **Outlook calendar** under **Read** and `work-calendar`
under **Into source**. Microsoft asks you to accept the calendar permission
if you have not given it yet (after an admin's consent it does not ask).
Choose **Turn sync on** for the calendar account too.

### 11. Pick calendars and the history window (optional)

The calendar account syncs its default calendar, and its first sync reads
the last 90 days and the next 90. To add your other calendars or change how
far back the first sync reads, choose **Calendars** on the account's row,
tick them, and choose **Save calendars**. The default calendar always syncs.
The limits are those of Google Calendar ([GOOGLE.md](./GOOGLE.md)): up to 19
calendars besides the default, and a window of 1 to 3,650 days, never past
the calendar retention window.

Only calendars the account owns are offered. A calendar a colleague shares
with you, or a Microsoft 365 group calendar, is not: reading another user's
calendar needs `Calendars.Read.Shared`, which Memrain does not ask for.
Graph tracks changes for the default calendar only, so another calendar is
read whole at most once an hour: its changes can be up to an hour late.

## What is stored

- **Mail:** Inbox and Sent Items, from 90 days before the first sync on.
  One page per conversation, rendered like a Gmail thread: subject, people,
  dates, the text of each message, and attachment names, types and sizes
  (never their contents). Junk, Deleted Items, Drafts and other folders are
  never read. A conversation that leaves both folders, or is deleted, is
  soft-deleted (restorable until the usual purge), under the mass-delete
  guard.
- **Calendar:** one page per event, and one per recurring series with its
  occurrences inside the window, rendered like a Google Calendar event.
  Rooms and equipment are not listed as attendees. An online meeting is noted
  as `Online meeting: yes`; its join link is not stored, and is cut out of
  the description. A cancelled or deleted event is soft-deleted the same way.
- **Loops** ([LOOPS.md](./LOOPS.md)): a message someone sent you that waits
  on your answer opens a reply-owed loop (`unanswered_inbound`), and a
  newsletter or other bulk mail does not. An invitation you have not answered, for a meeting still
  ahead, opens an `rsvp_owed` loop to its organizer; accepting or declining
  in Outlook closes it on the next sync.

Everything stored is text from outside the brain: it passes the write gate
for outside sources, as Gmail's does ([ENABLE.md](./ENABLE.md)).

## Keeping access alive

Microsoft refresh tokens last 90 days and are replaced with a fresh one each
time they are used
([refresh tokens](https://learn.microsoft.com/entra/identity-platform/refresh-tokens),
"Token lifetime"). Memrain uses one whenever a sync needs a new access token,
about once an hour while it runs. So:

- While an account syncs, its access renews itself; the account row shows no
  deadline.
- While sync is off, nothing renews it. The row shows **Access ends** with
  the day 90 days after it was last used, and from 15 days before that day it
  turns into a warning with **Reconnect now**. Choose **Turn sync on** or
  **Reconnect** before then.
- If the access ends anyway, or you change your password, or an admin
  revokes your sessions, the account turns `needs_reconnect` and syncing
  pauses with nothing lost. Choose **Reconnect** on its row; the sync carries
  on from where it stopped.

The client secret also expires (step 4). Add a new secret in Entra before the
old one's date and save it in Memrain (step 7); connected accounts keep
working.

## Pausing, disconnecting and removing the consent

**To pause, choose Turn sync off.** Nothing is read while it is off, the
access and the consent stay as they are, and **Turn sync on** carries on
from where it stopped. Mind the 90 days in
[Keeping access alive](#keeping-access-alive).

**Disconnect is not a pause.** Microsoft gives an app with read-only
permissions no way to withdraw its own consent, so a disconnect deletes the
access Memrain stored, stops syncing, and leaves the consent in place at
Microsoft. Connecting again later means signing in and accepting again.
Disconnecting the mail account does not touch the calendar account, and the
other way round. Pages already synced stay in the brain unless you also
delete the account's data from the Connections page.

To remove the consent too, after disconnecting both accounts:

- **Personal account:** open
  [account.microsoft.com/privacy/app-access](https://account.microsoft.com/privacy/app-access),
  find the app by its name from step 2, and remove its access.
- **Work or school account:** open
  [myapplications.microsoft.com](https://myapplications.microsoft.com),
  choose **...** on the app, then **Manage your application**, and
  **Revoke Permissions**
  ([edit or revoke application permissions](https://support.microsoft.com/account-billing/edit-or-revoke-application-permissions-in-the-my-apps-portal-169be2b4-ee26-4338-aea8-d19bb2f329ee)).
  Permissions your IT admin granted for the whole organization are listed
  separately and only the admin can remove them.

Deleting the app registration in Entra (step 2) ends every account's access
at once.

## Verification

On the Connections page each Microsoft account reads **Syncing** and, after
the first clean run, **Last sync** shows when. From the host:

```bash
docker exec deploy-memrain-1 bun run src/cli.ts connectors status
docker exec deploy-memrain-1 bun run src/cli.ts doctor
```

`connectors status` lists both accounts as `sync on` with a recent clean
sync; `doctor` (`connector-accounts`, `connector-health`) names any account
that needs a reconnect or has held items. Search the brain for the subject of
a mail, or the title of a meeting, from this week.

## Troubleshooting

Microsoft's sign-in errors start with `AADSTS`
([error codes](https://learn.microsoft.com/entra/identity-platform/reference-error-codes)).

| Symptom | Cause | Fix |
|---|---|---|
| Microsoft shows `AADSTS50011` (reply URL does not match) | The registered redirect URI differs from what Memrain sent | Step 3: paste the exact line from step 1 under the **Web** platform |
| Microsoft shows `AADSTS50194` (not configured as a multi-tenant application) | A single-tenant app with **Who can sign in** set to `common` or `organizations` | Step 7: choose **One organization** and enter the directory ID |
| Microsoft shows `AADSTS50020` (account does not exist in tenant) | The account is not one the app's supported account types allow, for example a personal account on a work-only app | Register an app with a type that allows it (step 2), or sign in with an allowed account |
| Microsoft shows `AADSTS700016` (application not found in the directory) | The client ID is wrong, or **Who can sign in** points at another directory | Check the client ID and the directory ID from the Overview page (step 7) |
| Microsoft shows **Need admin approval** | Your organization keeps mail and calendar consent for an admin | [Step 6](#6-work-accounts-ask-an-admin-to-grant-consent) |
| Back in Memrain, the page reports `admin_consent_required` | Your organization lets only an admin consent to the app | [Step 6](#6-work-accounts-ask-an-admin-to-grant-consent), then connect again |
| Back in Memrain, the page reports `token_exchange` | Microsoft refused the code; most often an expired secret, or the Secret ID pasted instead of the value. Also when no refresh token came back because `offline_access` is missing from the app | Add a new secret (step 4) and save it (step 7), or add `offline_access` (step 5), then connect again |
| Back in Memrain, the page reports `scope_mismatch` | A permission was declined, or the app has permissions Memrain does not ask for | Step 5: keep exactly the six permissions; connect again and accept |
| Back in Memrain, the page reports `provider_denied` | You chose **Cancel** on Microsoft's consent page | Connect again |
| The Connections page answers `no_client` | No app is stored for Microsoft | Step 7 |
| The Connections page answers `invalid_tenant` | **Who can sign in** holds something that is not an audience, a directory ID or a domain | Step 7 |
| The Connections page answers `redirect_uri` | `MEMRAIN_PUBLIC_URL` is unset or not `https` | Fix the domain in your stack settings and redeploy |
| **Into source** says "No source fits" | No source of the chosen service's kind | Step 8, then reload the page |
| The account turns `needs_reconnect` | 90 days unused, a password change, or revoked sessions | **Reconnect** on its row; see [Keeping access alive](#keeping-access-alive) |
| You lost the client secret | Microsoft shows the value only when it is created | Add a new secret (step 4), save it (step 7), then delete the old one in Entra |

## Related

- [ENABLE.md](./ENABLE.md): the order to switch connectors on.
- [KEY.md](./KEY.md): the connector key that seals the client secret and the
  tokens.
- [GMAIL.md](./GMAIL.md) and [GOOGLE.md](./GOOGLE.md): the same for a Google
  account.
- [LOOPS.md](./LOOPS.md): who is waiting on whom, from your mail.
