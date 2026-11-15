# Who is waiting on whom

Memrain reads your mail, chat and calendar connector pages and lists the
conversations someone is waiting on: a reply you owe, a reply you are waiting
for, something you promised to do, an invitation you have not answered. It uses
fixed rules over the provider's own fields and the text of each message. No
model is called and nothing is spent.

You see the list with `memrain waiting`, and an agent sees it through the MCP
tool `loops_list`.

Which loops you get depends on the connectors you run:

| Connector | Loops |
|---|---|
| Google Calendar ([GOOGLE.md](./GOOGLE.md)) | RSVP owed, today |
| A mail connector (Gmail, then Outlook) | reply owed, waiting on them, your promise, once that connector is connected; until then there are no mail loops |
| A chat connector (Slack, Teams) | the same three for direct conversations, once its adapter marks direct conversations and your own messages |

Fireflies meeting notes carry no reply state and add nothing here.

## Prerequisites

- Connectors are on and at least one account syncs: [ENABLE.md](./ENABLE.md)
  steps 1 to 6.
- That account writes into a source of kind `mailbox`, `calendar` or `chat`.
  The Connections page only offers sources of the connector's kind, so register
  one first, for example
  `memrain sources register me-calendar --kind calendar --path-prefix calendar/`.
  A `meeting` source (Fireflies) has no reply state and is ignored.
- `MEMRAIN_DAEMONS=1` in the running process (ENABLE.md step 6).

`memrain` means `docker exec deploy-memrain-1 bun run src/cli.ts` on the host,
and `bun run src/cli.ts` in a checkout.

## What counts as a loop

| Loop | When it opens | When it closes |
|---|---|---|
| Reply owed (`unanswered_inbound`) | Their last message is to you (in To), 24 h old or more | You reply |
| Waiting on them (`unanswered_outbound`) | Your last message asks a question, 72 h old or more | They reply |
| Your promise (`commitment_owed_by_me`) | Your message says "I'll send…", "Let me check…", "Will do", 24 h old or more | You write again in the thread |
| RSVP owed (`rsvp_owed`) | You are invited, have not answered, and the meeting (or a listed occurrence of a series) is ahead | You answer, the last listed occurrence starts, or it is cancelled |

These never open a loop:

- newsletters and list mail (`List-Unsubscribe`, `List-Id`, `Precedence: bulk`,
  a no-reply `Reply-To`), and mail filed under promotions, social or forums
  from someone you never wrote to in the thread;
- auto-replies and tracker notices (`Auto-Submitted`), no-reply senders and chat
  bots; these also never count as an answer;
- calendar invitations and responses sent by mail;
- mail where you are only in Cc or Bcc;
- a thanks-only message from them, and their answer to your question that asks
  nothing back;
- your thanks-only reply to their question, which also does not count as your
  answer;
- a thread where you are the only participant;
- anything whose last activity is older than 14 days.

A chat conversation is judged only when the adapter marks it as a direct
conversation and says which messages are yours; channels are never judged.

## Turn it on

The reply state of each item is stored when the connector sync writes it. The
`loops_sweep` daemon turns those states into loops every 30 minutes. It is off
by default:

```sh
docker exec deploy-memrain-1 bun run src/cli.ts daemons enable loops_sweep
docker exec deploy-memrain-1 bun run src/cli.ts daemons status
```

The switch is read on every scheduler tick, so no restart is needed. To see
loops before the first window, sweep now:

```sh
docker exec deploy-memrain-1 bun run src/cli.ts waiting sweep
```

Items stored before this version get their reply state the next time they
change upstream.

## Read the list

```sh
docker exec deploy-memrain-1 bun run src/cli.ts waiting
docker exec deploy-memrain-1 bun run src/cli.ts waiting --type rsvp_owed --limit 20 --json
```

`waiting` refuses when the newest mail, chat or calendar sync is older than 24
hours, or when none ever ran. It prints the accounts that are behind and their
state (for example `needs_reconnect`). Fix the sync first; `--stale` shows the
list anyway, marked stale. When one account is fresh and another is behind, the
list is shown with a `behind:` line naming the one whose loops may be missing.

`loops_list` answers the same list for an MCP client, only from the sources the
client's grant can read, and refused on the public bearer. Each summary carries
a mail subject and a sender's name, so it comes framed as outside text, and the
answer says `stale: true` when no sync landed in 24 hours.

## Close and mute

```sh
docker exec deploy-memrain-1 bun run src/cli.ts waiting done 42      # handled
docker exec deploy-memrain-1 bun run src/cli.ts waiting drop 42      # not a real loop
docker exec deploy-memrain-1 bun run src/cli.ts waiting mute sender 42
docker exec deploy-memrain-1 bun run src/cli.ts waiting mute thread 42
docker exec deploy-memrain-1 bun run src/cli.ts waiting unmute sender 42
```

A loop you close stays closed until the thread moves on. A mute stops new loops
from that sender or thread; it does not close the loops already open.

## What is stored

Per connector item, a few flags and times: each message's sender as the page
shows it (name and address) and a hash of the address, whether you were in To,
and whether it was list mail, an auto-reply, a question, a promise or a thanks.
No message body is kept. A loop stores its type, a one-line summary (subject and
counterparty), and a pointer to the page. Mutes store a hash, never an address.

Thread states and loops are deleted with their page, and everything goes with
the source. A loop on a page that is deleted upstream is dropped on the next
sweep.

## Turn it off

```sh
docker exec deploy-memrain-1 bun run src/cli.ts daemons disable loops_sweep
```

Existing loops stay as they were; reply states keep being recorded by the sync.

## Related

- [ENABLE.md](./ENABLE.md): turning connectors and the scheduler on.
- [GOOGLE.md](./GOOGLE.md): connecting Google Calendar.
