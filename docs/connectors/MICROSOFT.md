# How to connect Outlook mail and calendar (personal and work accounts)

This guide connects a personal Microsoft account (outlook.com, hotmail.com,
live.com) and a work or school account (Microsoft 365) to Memrain, each with
its Outlook mail and its Outlook calendar, through **one** Microsoft app that
you own. When you finish, four sources fill up on their own: your personal
mail, your personal calendar, your work mail and your work calendar.

Memrain only ever reads. It never sends, moves, flags or deletes mail, and
never creates or changes an event. No Memrain company sits between you and
Microsoft: the app is registered in your own Microsoft directory, and your
server talks to Microsoft directly.

You do this once, in three parts:

1. [Register one app for both accounts](#part-1-register-one-app-for-both-accounts) (about 20 minutes).
2. [Create the four sources and decide who may read them](#part-2-four-sources-and-who-may-read-them) (10 minutes).
3. [Connect](#part-3-connect): your personal account first, then, after your IT
   administrator approves the app, your work account.

A section for your IT administrator, a copy-and-paste request to send them
([MICROSOFT-IT-REQUEST.md](./MICROSOFT-IT-REQUEST.md)) and a list of
[things never to do](#never-do-this) follow.

## Before you start

- **Connectors are on.** [ENABLE.md](./ENABLE.md) steps 1 to 4.
- **Your server has a public `https` address.** `MEMRAIN_PUBLIC_URL` holds it
  (bootstrap writes it from your domain). Microsoft sends your browser back
  to an address built from it.
- **A Microsoft directory that your personal account owns.** Microsoft no
  longer lets an app be registered outside a directory (also called a
  tenant). You register the app in a directory of your personal account, not
  in your company's: your company's directory belongs to your employer, and
  the app would go with your job.
  - To see whether your personal account already has one, sign in with it at
    the [Microsoft Entra admin center](https://entra.microsoft.com). If it
    opens a directory (often named **Default Directory**), you have one.
    With the [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli)
    on your own computer you can also list them:

    ```bash
    az login --allow-no-subscriptions        # sign in with your personal account
    az account show --query tenantId -o tsv  # the directory you are in now
    az account tenant list                   # every directory you can use
    ```

  - If you have none, create one for free by
    [signing up for Azure](https://azure.microsoft.com/pricing/purchase-options/azure-account)
    with your personal account. Nothing you do in this guide costs money.
  - Do **not** use a Microsoft 365 Developer Program sandbox for this: it is
    for testing only, lasts up to 90 days, and is deleted with everything in
    it ([Developer Program FAQ](https://learn.microsoft.com/office/developer-program/microsoft-365-developer-program-faq)).
  - The admin center asks for a second sign-in factor (an authenticator app
    or a passkey): Microsoft requires it for everyone who changes anything
    there ([mandatory MFA](https://learn.microsoft.com/entra/identity/authentication/concept-mandatory-multifactor-authentication)).
    Set it up when it asks.
- **Time for your IT administrator.** Your company almost certainly lets only
  an administrator approve an app that reads mail. Plan on sending them the
  request in [MICROSOFT-IT-REQUEST.md](./MICROSOFT-IT-REQUEST.md) and waiting
  for an answer before you connect the work account.

## The plan at a glance

| Account | What is read | Source (kind) |
|---|---|---|
| Personal (outlook.com) | Outlook mail | `outlook-mail` (mailbox) |
| Personal (outlook.com) | Outlook calendar | `outlook-calendar` (calendar) |
| Work (Microsoft 365) | Outlook mail | `work-mail` (mailbox) |
| Work (Microsoft 365) | Outlook calendar | `work-calendar` (calendar) |

All four use the same app, with **Who can sign in** set to `common`. Your
Gmail and Google Calendar sources (in these guides `me-mail` and
`me-calendar`) are not touched and never receive Outlook data.

## Part 1. Register one app for both accounts

### 1. Find your redirect URI

Microsoft only sends a sign-in back to an address registered in the app. For
Memrain it is your public address followed by
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
letter for letter, so copy it rather than typing it.

### 2. Register the app

1. Sign in to the [Microsoft Entra admin center](https://entra.microsoft.com)
   with your **personal** account. If you see several directories, use the
   **Settings** icon in the top menu to switch to your own.
2. Open **Entra ID > App registrations** and choose **New registration**.
3. **Name**: something you and your IT administrator will recognise, for
   example `Memrain for <your name>`. It is shown on every consent screen.
4. **Supported account types**: choose **Any Entra ID Tenant + Personal
   Microsoft accounts**. Older screens call it "Accounts in any
   organizational directory and personal Microsoft accounts". This is the
   only type that lets both your personal and your work account sign in.
5. Leave **Redirect URI** empty here; step 3 adds it with the right platform.
6. Choose **Register**. The app's **Overview** page opens. Note the
   **Application (client) ID**: Memrain and your IT administrator need it.

### 3. Add the redirect URI as a Web platform

1. In the app, under **Manage**, open **Authentication**.
2. Choose **Add Redirect URI** (or **Add a platform**) and pick the **Web**
   tile. Not **Single-page application**: Microsoft ends access granted to
   that platform after 24 hours
   ([refresh tokens](https://learn.microsoft.com/entra/identity-platform/refresh-tokens)).
3. Paste the line from step 1 as the **Redirect URI**, leave
   **Front-channel logout URL** empty, and choose **Configure**.

### 4. Create the client secret

1. In the app, open **Certificates & secrets > Client secrets** and choose
   **New client secret**.
2. Enter a description with the year (for example `memrain-2026`) and pick
   **12 months**.
3. Choose **Add**, then copy the **Value** column at once. Microsoft shows
   the value only now; after you leave the page it is hidden for good. The
   **Secret ID** next to it is **not** the secret.
4. Put the value in your password manager, never in a file on the server or
   in the repository.
5. Put a reminder in your calendar two weeks before the expiry date: when the
   secret expires, every Microsoft account stops syncing until you save a new
   one (see [Renewing the secret](#renewing-the-secret)).

An app of this type holds **at most two secrets** at a time
([validation differences by account type](https://learn.microsoft.com/entra/identity-platform/supported-accounts-validation)).
That is enough to add a new one before the old one is removed.

### 5. Add exactly six permissions

1. In the app, open **API permissions**. `User.Read` is already there.
2. Choose **Add a permission > Microsoft Graph > Delegated permissions**.
3. Tick `Mail.Read`, `Calendars.Read`, `offline_access`, `openid` and
   `email` (the last three sit under **OpenId permissions**).
4. Choose **Add permissions**. **Configured permissions** now lists exactly
   these six, all **Delegated**:

| Permission | Why Memrain asks for it |
|---|---|
| `openid`, `email` | To learn which account connected |
| `offline_access` | To keep syncing after you close the browser |
| `User.Read` | To read your own profile: the account's name and the address your mail arrives at |
| `Mail.Read` | To read your mail |
| `Calendars.Read` | To read your calendar |

Add **nothing else**: no `Mail.ReadWrite`, `Mail.Send`, `Calendars.ReadWrite`,
`Calendars.Read.Shared`, and no **Application permissions** at all. Memrain
does not use them, and they cost you twice:

- When your IT administrator approves the app, they approve every permission
  listed here. An extra permission then rides along in every access the work
  account grants, and Memrain refuses such a grant (`scope_mismatch`): the
  work account cannot connect. A personal account may still connect, which
  hides the problem until then.
- An application permission lets an app read **every** mailbox of an
  organization, without anyone signed in. No IT administrator should approve
  that for a personal tool, and Memrain has no use for it.

### 6. Save the app in Memrain

1. Open the admin console (`https://<your host>/admin/`) and sign in.
2. On the **Connections** page, in the **Microsoft** panel, open
   **Use your own OAuth app**.
3. Paste the **Application (client) ID** under **Client ID** and the secret
   **Value** under **Client secret**.
4. Under **Who can sign in**, choose **Work, school and personal accounts
   (common)**.
5. Choose **Save app**. The panel shows the saved client and who can sign in.

Why `common` and nothing else, when a personal and a work account share the
app:

- `organizations` and a company's directory ID or domain shut out personal
  accounts: your personal account could neither renew nor reconnect.
- `consumers` shuts out work and school accounts.
- `common` lets both in; the account's own directory still decides what the
  work account may do.

Memrain seals the secret with the connector key ([KEY.md](./KEY.md)); it is
never shown again, logged or returned. Once accounts are connected, the page
asks you to confirm before you change the app's ID or **Who can sign in**, or
remove the app, and every Microsoft account then has to be reconnected (see
[Never do this](#never-do-this)). A new secret for the same app and the same
**Who can sign in** needs no confirmation and no reconnect.

(A server-wide app can also come from the process environment,
`MEMRAIN_MICROSOFT_OAUTH_CLIENT_ID`, `_SECRET` and `_TENANT`; see
[CONFIGURATION.md](../CONFIGURATION.md). On a deployed stack use the form: it
keeps the secret out of files and shell history.)

## Part 2. Four sources, and who may read them

### 7. Look at the sources you have

```bash
docker exec deploy-memrain-1 bun run src/cli.ts sources list
```

If an id from [the plan](#the-plan-at-a-glance) is already taken, choose
another one for the new source: never register an existing id again (it
overwrites that source's settings).

### 8. Register the four sources

Each source holds one account's one service. There is no command to rename a
source, and read permissions name it by its id, so pick the ids once. On the
host:

```bash
docker exec deploy-memrain-1 bun run src/cli.ts sources register outlook-mail --kind mailbox --path-prefix outlook-mail/
docker exec deploy-memrain-1 bun run src/cli.ts sources register outlook-calendar --kind calendar --path-prefix outlook-calendar/
docker exec deploy-memrain-1 bun run src/cli.ts sources register work-mail --kind mailbox --path-prefix work-mail/
docker exec deploy-memrain-1 bun run src/cli.ts sources register work-calendar --kind calendar --path-prefix work-calendar/
```

Reload the Connections page afterwards so it lists them.

### 9. Decide which agents may read them

A new source is read by nobody yet, except credentials without any source
limit: an unscoped token or client reads **every** source, the new ones
included, from the moment they exist. Decide for each of your clients and
tokens whether it should see your personal mail, and separately whether it
should see `work-mail` and `work-calendar`: your employer may have rules
about where work mail goes.

See what each one reads now:

```bash
docker exec deploy-memrain-1 bun run src/cli.ts auth list-clients
docker exec deploy-memrain-1 bun run src/cli.ts auth list
```

For an OAuth client, the read list you give replaces the whole list. Name
every source it reads today, then the new ones. Preview first:

```bash
docker exec deploy-memrain-1 bun run src/cli.ts auth rescope-client <client_id> --source <its write source> \
  --federated-read <its current read sources>,outlook-mail,outlook-calendar --dry-run
```

Run the same command without `--dry-run` only if the preview's `changed` list
holds `federated_read` and nothing else, and every count under
`revoked_unbound` is `0`. Anything more means the command would also move the
client's write source or end its sessions: check `--source` and try again.

For a personal access token, the same with `set-read-sources`:

```bash
docker exec deploy-memrain-1 bun run src/cli.ts auth permissions <token-name> set-read-sources <current read sources>,outlook-mail,outlook-calendar --dry-run
```

Check that `before` and `after` differ only by the new sources (a source
missing from `after` is one the token would stop reading), then run it again
without `--dry-run`. Add `work-mail` and `work-calendar` the same way, only
to the clients and tokens you decided may read them.

## Part 3. Connect

Connect the personal account first. It needs nobody's approval, so it proves
the app works before you involve your IT administrator.

### 10. Connect your personal account

1. On the **Connections** page, in the **Microsoft** panel, choose
   **Outlook mail** under **Read** and `outlook-mail` under **Into source**,
   then choose **Connect Microsoft**.
2. Microsoft asks which account to use. Pick your personal account. If the
   same address shows twice, pick the one marked **Personal account**.
3. Microsoft shows the permissions, with the app marked **unverified**: the
   app has no verified publisher because it is your own. Choose **Accept**.
4. Back on your server, choose **Finish connecting**. The account appears,
   with sync off.
5. Choose **Turn sync on**. Nothing is read before that.
6. Repeat with **Outlook calendar** under **Read** and `outlook-calendar` under
   **Into source**.

With `connector_sync` enabled ([ENABLE.md](./ENABLE.md) step 6), the first
sync starts within 15 minutes.

### 11. Ask your IT administrator to approve the app

Send [MICROSOFT-IT-REQUEST.md](./MICROSOFT-IT-REQUEST.md), filled in with the
app's name, its client ID and your company's directory (its directory ID or
domain; IT knows it). The [section for your IT administrator](#for-your-it-administrator)
below has the details they may ask for. Do not try to connect the work
account before they confirm: Microsoft would only show **Need admin
approval**, or send you back to Memrain with "Ask your Microsoft 365 admin to
grant consent".

### 12. Connect your work account, on your company device

Your company may only allow sign-ins from its own devices, so do this on
your work computer, in its usual browser, signed in to the Memrain admin
console there.

1. Choose **Outlook mail** under **Read** and `work-mail` under **Into
   source**, then **Connect Microsoft**.
2. Pick your work account. If the same address shows twice, pick the one
   marked **Work or school account**.
3. After your administrator's approval Microsoft usually asks nothing more,
   or shows the permissions once more: choose **Accept**.
4. Choose **Finish connecting**, then **Turn sync on**.
5. Repeat with **Outlook calendar** and `work-calendar`.

### 13. Pick calendars and the history window (optional)

Each calendar account syncs its default calendar, and its first sync reads
the last 90 days and the next 90. To add your other calendars or change how
far back the first sync reads, choose **Calendars** on the account's row,
tick them, and choose **Save calendars**. Up to 19 calendars besides the
default, and a window of 1 to 3,650 days, never past the calendar retention
window.

Only calendars the account owns are offered. A calendar a colleague shares
with you, or a group calendar, is not: reading another user's calendar needs
`Calendars.Read.Shared`, which Memrain does not ask for. Microsoft tracks
changes for the default calendar only, so another calendar is read whole at
most once an hour: its changes can be up to an hour late.

## For your IT administrator

This part is written for the administrator of your company's Microsoft 365.
[MICROSOFT-IT-REQUEST.md](./MICROSOFT-IT-REQUEST.md) is the short version to
send.

**What the app is.** A personal memory that reads one employee's own Outlook
mail (Inbox and Sent Items) and calendar and keeps them searchable for that
employee. It runs on the employee's own server (in the standard setup at
AWS, region eu-west-1 in Ireland); data and access tokens stay there (the
tokens encrypted), and the server talks to Microsoft Graph directly. Nothing
goes to a third-party service in between.

**What it asks for.** Six **delegated** Microsoft Graph permissions, all
read-only: `openid`, `email`, `offline_access`, `User.Read`, `Mail.Read`,
`Calendars.Read`. No application permissions: it can only read what the
signed-in employee can read, and only while that employee's consent stands.

**Why it needs you.** The app is registered in the employee's own directory,
not yours, and its publisher is not verified. Your organization's consent
settings (Microsoft's managed default included) keep consent to an app that
reads mail for an administrator
([app consent policies](https://learn.microsoft.com/entra/identity/enterprise-apps/manage-app-consent-policies)).
Microsoft may also flag such an app as risky, which only an administrator can
consent to
([consent errors](https://learn.microsoft.com/entra/identity/enterprise-apps/application-sign-in-unexpected-user-consent-error)).

**Who can approve it.** A Privileged Role Administrator, Cloud Application
Administrator, Application Administrator or AI Administrator
([grant tenant-wide admin consent](https://learn.microsoft.com/entra/identity/enterprise-apps/grant-admin-consent)).

**How to approve it.** Open this address in a browser, signed in with an
administrator account, review the permissions and choose **Accept**:

```
https://login.microsoftonline.com/<company-tenant-id-or-domain>/v2.0/adminconsent?client_id=<client-id>&scope=https://graph.microsoft.com/.default&redirect_uri=https://<host>/admin/connectors/callback/microsoft
```

- `<company-tenant-id-or-domain>`: your directory ID, or one of your verified
  domains (for example `contoso.com`).
- `<client-id>`: the app's Application (client) ID.
- `https://<host>/admin/connectors/callback/microsoft`: the employee's
  redirect URI, exactly as registered in the app.

`.default` asks for exactly the permissions the app lists, the six above
([admin consent protocol](https://learn.microsoft.com/entra/identity-platform/v2-admin-consent)).
After **Accept**, Microsoft opens the employee's server, which shows **Admin
consent recorded at Microsoft**. Close that tab; there is nothing to do on
it.

**The two portal buttons do not work here.** **App registrations > API
permissions > Grant admin consent** only exists for apps registered in your
own directory, and **Enterprise apps > Permissions > Grant admin consent**
only for an app already present in it, which this one is not until someone
consents. Use the link above.

**Narrower options.** Tenant-wide consent lets every user of your
organization sign in to the app (each still sees only their own mail). To
keep it to the one employee:

- After granting consent, open **Entra ID > Enterprise apps > the app >
  Properties**, set **Assignment required?** to **Yes**, and under **Users and
  groups** assign only the employee.
- Or grant consent for that one user only, with Microsoft Graph PowerShell
  ([grant consent on behalf of a single user](https://learn.microsoft.com/entra/identity/enterprise-apps/grant-consent-single-user)):

  ```powershell
  Connect-MgGraph -Scopes "User.ReadBasic.All Application.ReadWrite.All DelegatedPermissionGrant.ReadWrite.All AppRoleAssignment.ReadWrite.All"
  $clientSp = Get-MgServicePrincipal -Filter "appId eq '<client-id>'"
  if (-not $clientSp) { $clientSp = New-MgServicePrincipal -AppId "<client-id>" }
  $graphSp = Get-MgServicePrincipal -Filter "displayName eq 'Microsoft Graph'"
  $user = Get-MgUser -UserId "<employee@company.example>"
  New-MgOauth2PermissionGrant -ClientId $clientSp.Id -ConsentType "Principal" -PrincipalId $user.Id `
    -ResourceId $graphSp.Id -Scope "openid email offline_access User.Read Mail.Read Calendars.Read"
  ```

**Conditional Access.** Your policies apply each time the server renews its
access, not only at sign-in. A policy that requires a compliant or managed
device, or a sign-in from your network or country, would block those
renewals from the server, which is neither. If such a policy covers all
cloud apps, please tell the employee: the app needs an exclusion, or the
server's public IP address as a trusted location, to keep working.

**Taking it back.** Delete the app under **Entra ID > Enterprise apps**, or
remove its permissions there, at any time. That ends its access for
everyone at once.

## Never do this

- **Change the app's ID or Who can sign in while accounts are connected.**
  Access granted to one app, or through one tenant, does not renew with
  another: every Microsoft account stops and must be reconnected. Memrain
  asks before it lets you.
- **Connect Outlook into the Gmail or Google Calendar sources** (`me-mail`,
  `me-calendar`) or any source a Google account writes into. Each provider
  keeps its own sources, so syncing and deleting stay apart.
- **Connect one Microsoft account into two sources of the same kind** (your
  personal mail into both `outlook-mail` and `work-mail`): you get every
  conversation twice.
- **Run `sources register` again with an id that exists.** It overwrites that
  source's settings. Check `sources list` first.
- **Pick the wrong account** when Microsoft shows the same address twice:
  personal mail into `work-mail` mixes your private mail with your work
  sources. Memrain refuses to reconnect a row with another account than the
  one it was connected with (`identity_mismatch`); a first connect it cannot
  check.
- **Reset the secret without `--append`.** `az ad app credential reset`
  deletes every existing secret unless you append, and Memrain's stops
  working at once.
- **Add application permissions, or any permission beyond the six.** See
  [step 5](#5-add-exactly-six-permissions).
- **Leave sync off for 90 days or more.** Microsoft ends access that has not
  been used for 90 days; the account then needs a reconnect.
- **Count on a password change to end Memrain's access.** Microsoft keeps
  access granted to a server-side app like Memrain alive when you change your
  password ([token revocation](https://learn.microsoft.com/entra/identity-platform/refresh-tokens#token-revocation)).
  To end it, follow [Withdrawing access](#withdrawing-access).

## Renewing the secret

The client secret expires (12 months in [step 4](#4-create-the-client-secret)).
When it does, Microsoft refuses the app, every Microsoft account stops
syncing, and Memrain shows one notification, **OAuth app refused by its
provider**. Nothing needs reconnecting: save a new secret and syncing resumes.
Better, renew it before the date:

1. Create the new secret, **added** to the old one. In the admin center:
   **Certificates & secrets > New client secret**. Or with the Azure CLI on
   your own computer, signed in to your personal directory:

   ```bash
   az ad app credential reset --id <client-id> --append --display-name memrain-2027 --years 1 --query password -o tsv
   ```

   The command prints the new secret: copy it into the next step and nowhere
   else. If the app already holds two secrets, delete the older one first
   (step 3).
2. In Memrain, under **Use your own OAuth app**, save the **same client ID**
   with the new secret and the same **Who can sign in**. No confirmation, no
   reconnect.
3. Delete the old secret: in the admin center, or with

   ```bash
   az ad app credential list --id <client-id>
   az ad app credential delete --id <client-id> --key-id <keyId of the old secret>
   ```

## What is stored

- **Mail:** Inbox and Sent Items, from 90 days before the first sync on. One
  page per conversation: subject, people, dates, the text of each message,
  and attachment names, types and sizes (never their contents). A
  conversation with a message in Inbox or Sent Items is read whole, and its
  messages in Junk, Deleted Items, Drafts or any other folder are dropped
  before the page is written. (`Mail.Read` itself covers the whole mailbox;
  Microsoft has no read permission limited to some folders.) A conversation
  that leaves both folders, or is deleted, is soft-deleted (restorable until
  the usual purge), under the mass-delete guard.
- **Calendar:** one page per event, and one per recurring series with its
  occurrences inside the window. Rooms and equipment are not listed as
  attendees. An online meeting is noted as `Online meeting: yes`; its join
  link is not stored. A cancelled or deleted event is soft-deleted the same
  way.
- **Loops** ([LOOPS.md](./LOOPS.md)): a message someone sent you that waits on
  your answer opens a reply-owed loop, and an invitation you have not
  answered opens an `rsvp_owed` loop to its organizer.

Everything stored is text from outside the brain: it passes the write gate
for outside sources, as Gmail's does ([ENABLE.md](./ENABLE.md)).

## Keeping access alive

Microsoft's access for an account lasts 90 days and renews each time it is
used ([refresh tokens](https://learn.microsoft.com/entra/identity-platform/refresh-tokens)).
Memrain renews it whenever a sync runs, about once an hour. So:

- While an account syncs, its access renews itself.
- While sync is off, nothing renews it. The account row shows **Access ends**
  90 days after it was last used, and from 15 days before that it turns into
  a warning with **Reconnect now**.
- If the access ends anyway, or an administrator revokes your sessions, or
  your company's sign-in rules now ask for a fresh sign-in, the account turns
  `needs_reconnect` and syncing pauses with nothing lost. Choose
  **Reconnect** on its row; the sync carries on from where it stopped.
- If the **app** is refused (an expired or wrong secret), see
  [Renewing the secret](#renewing-the-secret): no account needs reconnecting.

## Pausing and withdrawing access

**To pause, choose Turn sync off.** Nothing is read while it is off, and
**Turn sync on** carries on from where it stopped. Mind the 90 days above.

### Withdrawing access

1. **Disconnect** the account in Memrain (type its name to confirm). Memrain
   deletes the access it stored and stops syncing. Pages already synced stay
   until you also delete the account's data on the Connections page.
2. Remove the consent at Microsoft, since Microsoft gives an app no way to
   withdraw it for you:
   - **Personal account:** open
     [account.live.com/consent/Manage](https://account.live.com/consent/Manage)
     (or [account.microsoft.com/privacy/app-access](https://account.microsoft.com/privacy/app-access)),
     find the app by its name and remove its access.
   - **Work account:** ask your IT administrator to remove the app's
     permissions or delete it under **Enterprise apps**. You can remove your
     own consent at [myapplications.microsoft.com](https://myapplications.microsoft.com)
     (**...** on the app, **Manage your application**, **Revoke Permissions**),
     but not your administrator's.

Deleting the app registration in your directory ends every account's access
at once.

## Verification

On the Connections page each of the four accounts reads **Syncing** and,
after the first clean run, **Last sync** shows when. From the host:

```bash
docker exec deploy-memrain-1 bun run src/cli.ts connectors status
docker exec deploy-memrain-1 bun run src/cli.ts doctor
```

`connectors status` lists the four accounts as `sync on` with a recent clean
sync; `doctor` (`connector-accounts`, `connector-health`, `notifications`)
names any account that needs a reconnect and an app Microsoft refused. Search
the brain for the subject of a mail, or the title of a meeting, from this
week.

## Troubleshooting

Microsoft's sign-in errors start with `AADSTS`
([error codes](https://learn.microsoft.com/entra/identity-platform/reference-error-codes)).
Microsoft may change them; Memrain only uses them to choose a clearer
message.

| Symptom | Cause | Fix |
|---|---|---|
| Microsoft shows `AADSTS50011` (reply URL does not match) | The registered redirect URI differs from what Memrain sent | [Step 3](#3-add-the-redirect-uri-as-a-web-platform): paste the exact line from step 1 under the **Web** platform |
| Microsoft shows `AADSTS50194` (not configured as a multi-tenant application) | The app's account type is single tenant | [Step 2](#2-register-the-app): the app must be **Any Entra ID Tenant + Personal Microsoft accounts** (in the app, **Authentication**, **Supported account types**) |
| Microsoft shows `AADSTS50020` (account does not exist in tenant) | **Who can sign in** names one directory (an ID or a domain), and the account is not in it: a personal account, or another organization's | [Step 6](#6-save-the-app-in-memrain): choose `common`, confirm, then reconnect every account |
| Microsoft shows `AADSTS700016` (application not found in the directory) | The client ID is wrong, or the app was deleted | Check the client ID on the app's **Overview** page and save it again ([step 6](#6-save-the-app-in-memrain)) |
| Microsoft shows **Need admin approval**, or Memrain says to ask your Microsoft 365 admin (`admin_consent_required`) | Your company keeps consent to this app for an administrator, or Microsoft flagged the app as risky (`AADSTS90094`, `65001`, `90093`, `900941`, `900981`) | [Step 11](#11-ask-your-it-administrator-to-approve-the-app), then connect again |
| Memrain says the access was not granted (`consent_declined`) | You chose **Cancel**, or you asked an administrator for approval and chose **Back to app** (`AADSTS65004`) | After a Cancel, connect again and choose **Accept**. After a request, wait until IT has approved the app, then connect again |
| Memrain says you signed in with a different Microsoft account than this row (`identity_mismatch`) | A personal and a work account share the address, and you picked the other one | Reconnect and pick the account the row belongs to (**Personal account** or **Work or school account**). Nothing was changed |
| Memrain says the account came with no email address | The personal account signs in with a phone number | Nothing to fix: it is listed under its sign-in name or ID |
| Memrain reports `scope_mismatch` | A permission was declined, or the app lists permissions beyond the six (an administrator approved them all) | [Step 5](#5-add-exactly-six-permissions): keep exactly the six; then ask IT to approve again and connect again |
| Memrain reports `token_exchange` | Microsoft refused the sign-in code: most often the secret's **ID** pasted instead of its **Value**, or `offline_access` missing | Save the secret's value ([step 6](#6-save-the-app-in-memrain)), or add `offline_access` ([step 5](#5-add-exactly-six-permissions)), then connect again |
| A notification says **OAuth app refused by its provider**; accounts stop with `client_rejected` | The secret expired or is wrong (`invalid_client`, `AADSTS7000222` or `7000215`), or the app was deleted or disabled | [Renewing the secret](#renewing-the-secret); no reconnect needed |
| Your IT administrator's browser shows **Admin consent recorded at Microsoft** | That is the end of their approval | Nothing: close the tab and connect the work account ([step 12](#12-connect-your-work-account-on-your-company-device)) |
| The work account connects, then turns `needs_reconnect` within hours | A Conditional Access policy blocks the server's renewals | Ask IT about [Conditional Access](#for-your-it-administrator) |
| The account turns `needs_reconnect` after weeks | 90 days without use, or sessions revoked | **Reconnect** on its row; see [Keeping access alive](#keeping-access-alive) |
| **Into source** says "No source fits" | No source of the chosen kind | [Step 8](#8-register-the-four-sources), then reload the page |
| The Connections page answers `no_client` | No app is saved for Microsoft | [Step 6](#6-save-the-app-in-memrain) |
| The Connections page answers `redirect_uri` | `MEMRAIN_PUBLIC_URL` is unset or not `https` | Fix the domain in your stack settings and redeploy |
| You lost the client secret | Microsoft shows the value only when it is created | [Renewing the secret](#renewing-the-secret) |

## Related

- [MICROSOFT-IT-REQUEST.md](./MICROSOFT-IT-REQUEST.md): the request to send
  your IT administrator.
- [ENABLE.md](./ENABLE.md): the order to switch connectors on.
- [KEY.md](./KEY.md): the connector key that seals the client secret and the
  tokens.
- [GMAIL.md](./GMAIL.md) and [GOOGLE.md](./GOOGLE.md): the same for a Google
  account.
- [LOOPS.md](./LOOPS.md): who is waiting on whom, from your mail.
