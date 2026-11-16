# How to connect a Microsoft account

This guide registers a Microsoft Entra app of your own and connects a
Microsoft 365 work or school account, or a personal Outlook.com account, to
Memrain for Outlook mail and Outlook calendar.

Memrain asks Microsoft for read access only: it never sends, moves or deletes
a message, and never changes an event. The app is yours (bring your own,
"BYO"): no Memrain app sits between you and Microsoft.

This guide covers the app and the connect. Until the Outlook mail and
calendar sync is in your build, a connected Microsoft account is listed and
kept but not read: `connector_sync` skips it (`provider_cannot_sync`).

## Prerequisites

- Connectors are on: [ENABLE.md](./ENABLE.md) steps 1 to 3.
- `MEMRAIN_PUBLIC_URL` is your public `https://` address. Microsoft sends your
  browser back to an address built from it.
- An account that can register an app in the
  [Microsoft Entra admin center](https://entra.microsoft.com) (at least the
  Application Developer role in a work tenant; any personal Microsoft account
  can create a tenant of its own for this).
- For a work or school account: an organization that lets users consent to
  apps, or an administrator who grants the consent ([Work accounts and admin
  consent](#work-accounts-and-admin-consent)).

## What Memrain asks for

All are delegated Microsoft Graph permissions: Memrain reads as the signed-in
user, never as the app on its own.

| Scope | Asked for | Why |
|---|---|---|
| `openid`, `email` | Every connect | To sign the user in |
| `offline_access` | Every connect | A refresh token, so sync keeps working after the one-hour access token |
| `User.Read` | Every connect | To read who connected (Graph `/me`); the account is labelled with its user principal name |
| `Mail.Read` | Outlook mail (`outlook_mail`) | To read mail |
| `Calendars.Read` | Outlook calendar (`outlook_calendar`) | To read calendar events |

A connect asks only for the service it connects. Microsoft keeps consent per
user and app, so once a user has allowed `Mail.Read`, their later calendar
grant carries `Mail.Read` too; Memrain accepts that, because both are read
scopes it asks for itself. Any other scope in a grant, such as `Mail.ReadWrite`
granted to the app by an administrator, makes Memrain refuse the grant
(`scope_mismatch`) and store nothing.

## Steps

### 1. Find your redirect URI

The origin of `MEMRAIN_PUBLIC_URL` followed by
`/admin/connectors/callback/microsoft`. Print it on the host:

```bash
docker exec deploy-memrain-1 sh -c 'echo "${MEMRAIN_PUBLIC_URL%/}/admin/connectors/callback/microsoft"'
```

For a brain at `brain.example.com`:

```
https://brain.example.com/admin/connectors/callback/microsoft
```

### 2. Register the app

1. Sign in to the [Microsoft Entra admin center](https://entra.microsoft.com).
   With several tenants, switch to the one that should own the app (the
   **Settings** icon in the top menu).
2. Open **Entra ID > App registrations** and choose **New registration**.
3. **Name**: for example `Memrain on brain.example.com`. Users see it on the
   consent screen.
4. **Supported account types** decides who can connect, and the tenant you
   give Memrain in step 5:

   | Supported account types | Who can connect | Tenant in Memrain |
   |---|---|---|
   | **Single tenant only** | Accounts of your organization | Your **Directory (tenant) ID** from the app's **Overview** |
   | **Multiple Entra ID tenants** | Any work or school account | `organizations` |
   | **Any Entra ID Tenant + Personal Microsoft accounts** | Work, school and personal accounts | `common` (the default) |
   | **Personal accounts only** | Personal accounts (Outlook.com) | `consumers` |

5. Under **Redirect URI**, pick the platform **Web** (not "Single-page
   application": that platform cannot use a client secret and its refresh
   tokens end after 24 hours) and paste the line from step 1.
6. Choose **Register**. On **Overview**, copy the **Application (client) ID**
   and, for a single-tenant app, the **Directory (tenant) ID**.

### 3. Create a client secret

1. In the app, open **Certificates & secrets > Client secrets** and choose
   **New client secret**.
2. Pick an expiry. Note the date: when the secret expires, connecting and
   token renewals fail (`AADSTS7000222`) until you add a new one (step 5
   again).
3. Copy the secret's **Value** now (not the **Secret ID**). The admin center
   shows it only once.

Keep it in your password manager, not in a file in the repository or on the
host.

### 4. Add the API permissions

1. In the app, open **API permissions** and choose **Add a permission >
   Microsoft Graph > Delegated permissions**.
2. Add `Mail.Read`, `Calendars.Read`, `offline_access`, `openid` and `email`.
   `User.Read` is already there.
3. In an organization that does not let users consent, an administrator
   chooses **Grant admin consent for <tenant>** here (see below).

Do not add write permissions: a grant that carries one is refused.

### 5. Store the app in Memrain

1. Open the admin console (`https://<your host>/admin/`) and sign in.
2. On the **Connections** page, in the **Microsoft** panel, open **Use your
   own OAuth app**. It shows the redirect URL from step 1 with a copy button.
3. Paste the **Client ID** and **Client secret**, and the **Tenant** from the
   table in step 2 (leave it empty for `common`). Choose **Save app**.

Memrain checks that the tenant is a tenant ID, a domain, `common`,
`organizations` or `consumers` (otherwise `invalid_tenant`), seals the secret
and the tenant with the connector key ([KEY.md](./KEY.md)) and never shows the
secret again. Saving a new app later replaces the stored one.

(Alternatively, `MEMRAIN_MICROSOFT_OAUTH_CLIENT_ID`,
`MEMRAIN_MICROSOFT_OAUTH_CLIENT_SECRET` and `MEMRAIN_MICROSOFT_OAUTH_TENANT`
in the process environment are used when no app is stored. They belong in
`.secrets/memrain.env`; after changing that file, run `bash deploy/deploy.sh`.
`memrain config set` refuses the secret. The form is the recommended path.)

### 6. Register the sources

Outlook mail goes into a `mailbox` source and Outlook calendar into a
`calendar` source, never into a source that holds your notes. Skip a line if
you already have that source (one source may hold Gmail and Outlook mail
alike):

```bash
docker exec deploy-memrain-1 bun run src/cli.ts sources register me-outlook-mail --kind mailbox --path-prefix outlook-mail/
docker exec deploy-memrain-1 bun run src/cli.ts sources register me-outlook-calendar --kind calendar --path-prefix outlook-calendar/
```

Then add them to the read set of each agent that should see them, as in
[ENABLE.md](./ENABLE.md) step 5 (`auth rescope-client ... --dry-run`, then
without it).

### 7. Connect

1. On the **Connections** page, in the **Microsoft** panel, tick
   `outlook_mail` or `outlook_calendar`, pick the source under **Into
   source** and choose **Connect Microsoft**.
2. Microsoft shows its account picker even when you are signed in: pick the
   account to connect. Allow the access it lists.
3. Microsoft sends you back to the redirect URI. Choose **Finish connecting**;
   the account appears as connected, sync off.
4. Connect the other service the same way, into its own source. Each service
   is its own account row with its own token.

Nothing is read before you choose **Turn sync on** for the account.

## Work accounts and admin consent

Many organizations let only an administrator consent to apps. Then:

- Microsoft shows **Need admin approval** (or **Approval required**) instead of
  the consent screen. Ask your administrator. Going back without consent from
  there reaches Memrain as `provider_denied`.
- Or Memrain reports `admin_consent_required` when it redeems the code
  (Microsoft's `AADSTS65001`, `AADSTS90094` or `AADSTS90095`).

The administrator grants consent once for the organization: in the app
registration (or under **Entra ID > Enterprise apps** for an app registered in
another tenant), **API permissions > Grant admin consent for <tenant>**. Then
connect again. An administrator's consent covers what the app registration
lists, so keep that list to the permissions in step 4.

## Staying connected

Microsoft issues a new refresh token on every renewal; Memrain stores it and
drops the old one. The account turns `needs_reconnect` and syncing pauses, with
no data lost, when Microsoft will not renew it:

| Reason shown | Cause |
|---|---|
| `invalid_grant, code 700082` | The refresh token went unused for 90 days |
| `invalid_grant, code 50173` | The password was reset or an administrator revoked the user's sessions |
| `invalid_grant, code 65001` | The consent was withdrawn |
| `interaction_required, code 50076` | The organization now requires multifactor sign-in for this access |

Choose **Reconnect** on the row; the sync carries on from where it stopped.

## Verification

On the Connections page the Microsoft account appears with its user principal
name (for a guest account, its mail address). From the host:

```bash
docker exec deploy-memrain-1 bun run src/cli.ts connectors status
```

The account is listed under `accounts:` with provider `microsoft`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Microsoft shows `AADSTS50011` | The redirect URI in the app differs from what Memrain sent | Register the exact line from step 1 under the **Web** platform (step 2) |
| Microsoft shows `AADSTS50194` | A single-tenant app signed in through `common` | Save the app's **Directory (tenant) ID** as its tenant (step 5) |
| Microsoft shows `AADSTS700016` | The tenant does not hold the app | Check the client ID, and the tenant saved with it |
| Microsoft shows **Need admin approval** | The organization lets only admins consent | [Work accounts and admin consent](#work-accounts-and-admin-consent) |
| Back in Memrain, `admin_consent_required` | Same | Same |
| Back in Memrain, `scope_mismatch` | The grant held a permission Memrain does not ask for, often one an administrator granted to the app | Remove the extra permission from the app registration and its admin consent, then connect again |
| Back in Memrain, `token_exchange` | The secret is wrong or expired (`AADSTS7000215`, `AADSTS7000222`), or the app's platform is not **Web** | Add a new client secret and save the app again (step 5); check the platform |
| Back in Memrain, `identity` | Graph `/me` named no address for the account | Connect with an account that has a mailbox |
| Back in Memrain, `provider_denied` | You cancelled, or declined the consent | Connect again |
| The Connections page answers `no_client` | No app is stored, or `MEMRAIN_MICROSOFT_OAUTH_TENANT` is not a tenant | Step 5 |
| Saving the app answers `invalid_tenant` | The tenant is not a tenant ID, domain or keyword | Use a value from the table in step 2 |

## Disconnecting

Disconnect the account on the Connections page. Microsoft offers apps no way
to revoke a user's delegated grant, so Memrain deletes the stored credential,
stops syncing and parks the account as disconnected; it calls nothing at
Microsoft. The consent stays with Microsoft until you remove it:

- Work or school account: [myapps.microsoft.com](https://myapps.microsoft.com),
  the app's **...** menu, **Manage your application**, then **Revoke
  Permissions**. A new app registration is hidden there until an administrator
  sets **Visible to users?** to **Yes** under **Entra ID > Enterprise apps >
  the app > Properties**. Permissions an administrator consented to can only be
  revoked by an administrator, under **Enterprise apps > the app >
  Permissions**.
- Personal account:
  [account.live.com/consent/Manage](https://account.live.com/consent/Manage),
  the app, then **Remove these permissions**.

Deleting the client secret in the app registration also stops every token of
the app from renewing. Pages already synced stay in the brain unless you also
remove the account's data.

## Related

- [ENABLE.md](./ENABLE.md): the order to switch connectors on.
- [KEY.md](./KEY.md): the connector key that seals the client secret and the
  tokens.
- [GOOGLE.md](./GOOGLE.md): the same flow for a Google account.
