# How to connect Gmail

This guide connects your Gmail mailbox to Memrain. When you finish, the last
90 days of your mail land in the brain, one page per thread, and new mail
follows every 15 minutes. Spam, Trash and drafts are left out, and so is a
thread whose every message sits in the Promotions or Social tab (a promotion
someone replied to, in a thread of your own, stays with it).

Memrain asks Google for read access only: it never sends, changes, labels or
deletes mail, and it never downloads attachments (a thread page lists each
attachment's name, type and size, nothing more).

## Prerequisites

- Connectors are on: [ENABLE.md](./ENABLE.md) steps 1 to 4.
- The Google OAuth client from [GOOGLE.md](./GOOGLE.md) steps 1 to 6. Gmail
  uses the same Google Cloud project and the same client as Google Calendar;
  you do not need a second one. If you have not set up Calendar, follow those
  steps first and skip its step 7.
- A source of kind `mailbox` (step 3 below). The Connections page only offers
  sources of the kind a service writes into, so Gmail has nowhere to go
  without one.

## What Memrain asks for

| Scope | Why |
|---|---|
| `openid`, `email` | To learn which Google account connected |
| `https://www.googleapis.com/auth/gmail.readonly` | To read your mail and labels |

If a Google Calendar is already connected with the same client, the Gmail
connect also asks for `calendar.readonly`, and a calendar reconnect asks for
`gmail.readonly`. Google merges every scope you granted one client into each
new grant, so Memrain asks for the merged set up front: the grant then matches
the request exactly, which is the check that refuses anything wider. The Gmail
account still reads only mail. If the Google account you connect is not the
one whose calendar is connected, untick the calendar box: a grant of exactly
Gmail's own scopes is accepted too. Anything else is refused and nothing is
stored. A refused grant is revoked at Google only when no other Google
account is connected here: Google revokes a grant as a whole, so revoking it
could end a connected Calendar's access too (an address alone cannot prove
it is another Google user). Otherwise it is left in place and the page
reports `scope_mismatch_not_revoked`.

`gmail.readonly` is a **restricted** scope in Google's terms
([Gmail API scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)).
An app that serves the public with it needs Google's verification and a
security assessment. A brain of your own does not: Google exempts an app used
only by you, or by a few people you know, and an app left in the **Testing**
publishing status
([restricted scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification),
"Exceptions to verification requirements"). Keep the app in Testing with your
own account as a test user. Google then shows a warning screen on connect and
limits the refresh token to 7 days: see [the weekly reconnect](#the-weekly-reconnect).

## Steps

### 1. Turn on the Gmail API

In the same Google Cloud project as your client:

1. Open **APIs & Services > Library**.
2. Search for **Gmail API**, open it and choose **Enable**.

Without this, the connect works but every sync stops with an
`accessNotConfigured` error.

### 2. Add the Gmail scope to the consent screen

1. Open **Google Auth platform > Data Access** and choose **Add or remove scopes**.
2. Filter by `gmail.readonly`, tick `.../auth/gmail.readonly`, and choose
   **Update**. Google lists it under restricted scopes.
3. Choose **Save**.
4. External apps: open **Audience** and check that the Google account whose
   mail you connect is a test user, and that the publishing status is
   **Testing**.

### 3. Register a mailbox source

The id and prefix are yours to choose; `mail/` matches the slugs thread pages
are written under:

```bash
docker exec deploy-memrain-1 bun run src/cli.ts sources register me-mail --kind mailbox --path-prefix mail/
```

Then let your agents read it, as for any connector source
([ENABLE.md](./ENABLE.md) step 5): add `me-mail` to the read set of each OAuth
client that should see your mail, with `auth rescope-client ... --dry-run`
first.

For a personal access token, `set-read-sources` replaces the token's whole
read set, so list every source it reads today and add `me-mail` at the end.
Preview first:

```bash
docker exec deploy-memrain-1 bun run src/cli.ts auth permissions <token-name> set-read-sources <current read sources>,me-mail --dry-run
```

Check that `before` and `after` differ only by `me-mail`: a source missing from
`after` is one the token would stop reading (your calendar, say). Then run the
same command without `--dry-run`.

Reload the Connections page after registering, so it lists the new source.

### 4. Connect Gmail

1. On the **Connections** page, in the **Google** panel, choose **Gmail**
   under **Read**. **Google Calendar** and **Gmail** are a single choice: the
   two go into sources of different kinds and are connected one at a time.
2. Pick `me-mail` under **Into source** and choose **Connect Google**.
3. Google opens. Sign in with the test user and allow the access it lists
   (with a calendar connected, that includes your calendar; see
   [What Memrain asks for](#what-memrain-asks-for) if this is another Google
   account). On an app in
   Testing, Google first warns that it has not verified the app; continue,
   since it is your own.
4. Back on Memrain, choose **Finish connecting**. The Gmail account appears as
   connected, sync off.
5. Choose **Turn sync on** for it. Nothing is read before that.

If you connected the Calendar before this step, it keeps working: its stored
grant is untouched.

### 5. Wait for the first backfill

With `connector_sync` enabled ([ENABLE.md](./ENABLE.md) step 6), the first run
starts within 15 minutes. It notes where your mailbox's change feed stands,
then reads the last 90 days newest first, one thread at a time. Mail that
arrives meanwhile comes in through the change feed.

A run stops at the first of these, and the next one carries on from where it
stopped, so a large mailbox backfills over several days on its own:

| Limit | Default | Where it is set |
|---|---|---|
| Threads per run | 500 | `MEMRAIN_CONNECTOR_MAX_ITEMS_PER_RUN` |
| Threads per account per UTC day | 5,000 | the account's item cap |
| Spend per account per UTC day | $1.00 | the account's spend cap |
| Spend of `connector_sync`, every account together, per day | $5 | `MEMRAIN_DAEMON_CONNECTOR_SYNC_MAX_USD_PER_DAY` |
| Spend of the whole brain per UTC day | none; sync does not run without it | `MEMRAIN_DAILY_BUDGET_USD`, shared with Calendar and every other paid job |
| Quiet hours | 06:00 to 08:00 Europe/Berlin | no run starts in the window |

Requests to Gmail go out at most one every 1.25 seconds, which keeps a run
under Gmail's per-user quota (about 50 full thread reads a minute), so 500
threads take a run at least ten minutes and runs start every 15 minutes. In
practice the daily thread cap is what a backfill meets first: about 5,000
threads a day, reached within a few hours, after which runs stop with
`item_cap_reached` until the next UTC day. A mailbox with 12,000 threads in
the window therefore takes about three days. Embedding is cheap (90 days of 35
threads a day costs well under a quarter of the $1.00 account cap), but a
brain-wide cap set low, or spent by other work first, stops the sync sooner:
runs then end `cap_reached` and resume the next day. `connectors status` and
`spend --days 2` ([ENABLE.md](./ENABLE.md) step 8) show which limit stopped
the last run.

A thread larger than 10 MiB is not read: it is held with the reason
`too_large`, and `doctor` lists it among held items.

The window never reaches past mail retention: pages are hard-deleted 180 days
after a thread's last message by default
(`MEMRAIN_CONNECTOR_RETENTION_DAYS_MAIL`, see [PRIVACY.md](../../PRIVACY.md)).

## What lands in the brain

- One page per thread, under `mail/`, titled with the subject. Each message
  shows From, To, Cc, date, attachment receipts and its own text: quoted
  history, a `-- ` signature and a closing "Sent from my iPhone" style line
  are cut, a forwarded message is kept whole,
  and a message longer than 20,000 characters is cut with a marker. New
  replies are appended to the same page. Nothing older than the first sync's
  window is stored: a recent reply in an old thread brings in only the
  messages from that point on.
- The thread's labels (Inbox, Sent, categories, your own labels by id) in the
  page's truth. Read, starred and important flags are left out, so reading
  mail does not rewrite pages or spend Gmail quota.
- People: a sender or recipient whose address is an alias on an existing
  people page is linked to it; nobody new is created. Newsletters, auto-replies,
  mailing lists and machine senders (no-reply, postmaster, notification
  addresses) link nobody.
- Your send-as aliases (Gmail settings, "Send mail as") count as your own
  address: mail to an alias can owe you a reply on the open-loops list, and
  an alias is never linked as a person. Memrain reads the alias list on the
  first run and again at most once a day; if Google refuses the list, the one
  it has keeps being used. Learning an alias rewrites no page; a thread picks
  it up the next time it changes.
- Everything is outside text: stored marked as untrusted, passed through the
  write gate for outside sources, and read back inside a trust frame. A
  credential in a mail (a sign-in token, a reset link with a key) is cut out
  before the page is written, whatever `MEMRAIN_SECRET_SCAN_DISPOSITION` says.

## When mail changes at Google

- Mail you delete, or move to Trash or Spam, takes its thread page with it
  on the next run when nothing of the thread is left: the page is
  soft-deleted and stays restorable with `page_restore` for 30 days. If only
  part of a thread goes, the page is rewritten without it. A run that would
  delete more than the mass-delete guard allows is held until you confirm it
  on the Connections page.
- Google keeps the change feed for about a week. If Memrain was off longer, it
  takes a new starting point and reads the 90-day window again; unchanged
  threads are not rewritten. Deletions made while it was off are not seen;
  retention ages those pages out.

## The weekly reconnect

An External app in Testing gets refresh tokens that expire after 7 days
([OAuth 2.0, "Refresh token expiration"](https://developers.google.com/identity/protocols/oauth2#expiration)).
About a week after you connect, the account turns `needs_reconnect`, the
`doctor` command in [Verification](#verification) names it, and syncing
pauses with nothing lost. Choose **Reconnect** on the account on the
Connections page (it asks for the same scopes) and the sync carries on from
where it stopped.

The Internal user type (a Google Workspace organization that owns the
project) has no 7-day limit. Publishing the app to production with
`gmail.readonly` means Google's verification and a yearly security
assessment, which a brain of your own does not need.

## Verification

On the Connections page the Gmail account reads **Syncing** and, after the
first clean run, **Last sync** shows when. From the host:

```bash
docker exec deploy-memrain-1 bun run src/cli.ts doctor
```

`connector-accounts` reports every account active (a parked one is named with
its status), and `connector-health` names any open notice (a reconnect, held
items, deletions held by the mass-delete guard). Search
the brain for the subject of a mail from this week.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| The **Into source** list says "No source fits" with Gmail chosen | No `mailbox` source | Step 3, then reload the page |
| Back in Memrain, the page reports `scope_mismatch` | The Gmail box was unticked on Google's consent page | Connect again and allow the Gmail access |
| Back in Memrain, the page reports `scope_mismatch_not_revoked` | A box was unticked on Google's consent page; a Google account is already connected here, so Memrain left the grant in place rather than risk the Calendar's access | Connect again and allow every listed access; the Calendar keeps working meanwhile |
| Back in Memrain, the page reports `source_kind` | The source picked is not a mailbox | Pick a `mailbox` source |
| Syncs stop with `accessNotConfigured` | The Gmail API is off in the project | Step 1 |
| Google shows `Error 403: access_denied` | The account is not a test user | Step 2.4 |
| The account turns `needs_reconnect` after about a week | The Testing-mode 7-day token limit | [The weekly reconnect](#the-weekly-reconnect) |
| Runs end `partial` with `rate_limited` | Gmail's per-user quota | Nothing: the next run resumes |

## Disconnecting

**To stop Gmail alone, choose Turn sync off on the Gmail account; do not
disconnect it.** Disconnect is not a Gmail-only rollback: Google revokes the
whole grant, so a Calendar of the same Google account loses its access too
and has to be reconnected. With sync off nothing is read from the mailbox,
the grant stays as it is and the Calendar keeps syncing.

Disconnect the account on the Connections page when you are done with it. Memrain revokes the token at
Google and deletes the stored credential. Google revokes a grant as a whole:
the scopes of every account connected with the same client and Google
account go together, so a connected Google Calendar of the same Google
account turns `needs_reconnect` too, and you reconnect it to keep it
syncing. Pages already synced stay in the brain unless you also delete the
account's data from the Connections page.

## Related

- [GOOGLE.md](./GOOGLE.md): the Google Cloud project, client and Calendar.
- [ENABLE.md](./ENABLE.md): the order to switch connectors on.
- [PRIVACY.md](../../PRIVACY.md): what is stored and for how long.
