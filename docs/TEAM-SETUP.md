# Running Memrain for a team

This page is for the person who runs Memrain and wants to put a team on it.
You get:

- **One connector for the whole team.** An Owner (Claude) or a workspace admin
  (ChatGPT) adds it once; each person joins
  with their own one-time code.
- **A private space per person.** Each person writes to their own source. Set
  `MEMRAIN_TENANT_FAIL_CLOSED=1` and read [Before you rely on this](#before-you-rely-on-this).
- **A daily spending cap per person.** Set it with one command, in US dollars.
- **Revoke one person without touching the others.** Everyone else keeps working.

If each person on your plan can add their own connector, you can also give each
of them a separate client. The first section helps you pick.

This page walks through the steps. Every setting is listed in
[CONFIGURATION.md](./CONFIGURATION.md), and the install is in
[DEPLOYMENT.md](./DEPLOYMENT.md).

Everything here assumes Memrain is already deployed and healthy. Per-client
checklists live in [docs/clients/](./clients/):
[Claude Team/Enterprise](./clients/CLAUDE_TEAM.md),
[claude.ai Pro/Max](./clients/CLAUDE_AI.md), [ChatGPT](./clients/CHATGPT.md),
[Claude Code](./clients/CLAUDE_CODE.md) and [Codex](./clients/CODEX.md).

`memrain …` below is the CLI on the host:
`sudo docker exec deploy-memrain-1 bun run src/cli.ts …` in an SSM session, or
`bun run src/cli.ts …` under `deploy/memrain` in a checkout.

---

## Pick the shape first

There are two ways a person's tenant gets decided, and the right one depends on
something outside Memrain: **who is allowed to add a connector in your chat
client.**

| | Per-person clients | One connector + enrollment codes |
|---|---|---|
| Each person adds their own connector | required | not possible |
| What the person types | client ID + secret | a one-time code |
| Works on a plan where only an Owner can add connectors | ✗ | ✓ |
| Operator work per person | register a client | issue a code |

On a plan where members add their own connectors (individual paid accounts),
**per-person clients** are simpler — the tenant comes from the client row and
there is nothing to type but the credentials.

On a Team or Enterprise plan **only an Owner can add a connector**, and every
member authorises against that one client. One connector would therefore be one
tenant for everybody. That is what **enrollment mode** exists for: the tenant is
bound to the *authorisation* instead of to the client.

Who adds the connector, and where (checked against the vendors' help pages on
2026-09-28; menu labels move, so treat these as a starting point):

| Plan | Who adds it | Where | Credentials go in |
|---|---|---|---|
| Claude Pro / Max | each person | **Customize → Connectors**, **+**, **Add custom connector** | **Advanced settings**: OAuth Client ID and Secret |
| Claude Team / Enterprise | an Owner, once | **Organization settings → Connectors**, **Add**, **Custom → Web**; members then click **Connect** | **Advanced settings**: OAuth Client ID and Secret |
| ChatGPT Plus / Pro | each person | **Settings → Security and login → Developer mode**, then create an app for the MCP server | the app's OAuth fields |
| ChatGPT Business / Enterprise | a workspace admin | enable custom MCP apps for the workspace, create the app, publish it (exact admin menu names unverified) | the app's OAuth fields |

Callbacks to register: `https://claude.ai/api/mcp/auth_callback` and
`https://claude.com/api/mcp/auth_callback` for Claude,
`https://chatgpt.com/connector_platform_oauth_redirect` for ChatGPT.

Publishing one connector per person into a shared organisation catalogue is not
a third option — every member sees all of them and can enable any one. That is
isolation on the honour system.

---

## Setup — one connector, many people

### 1. A source per person

```bash
memrain sources register alice --kind other --path-prefix tenant:alice
memrain sources register bob   --kind other --path-prefix tenant:bob
```

### 2. One connector, in enrollment mode

```bash
memrain auth register-client team-connector \
  --tenant-mode enrollment \
  --scopes 'read write' --source default \
  --redirect-uris 'https://<chat-host>/api/mcp/auth_callback,https://<alt-host>/api/mcp/auth_callback'
memrain auth set-budget <client_id|token_name|enrollment_id> 2.00
```

Prints the client ID and secret **once**. Register every callback origin the
client might use. `memrain auth set-redirect-uris <client_id> <uri>...` replaces
the list later without touching the secret or issued tokens.

`--source default` here is only the fallback for a grant that names nothing; an
enrolled session always overrides it.

### 3. A code per person

```bash
memrain auth enroll alice --label alice --client <client_id> --ttl 30d
memrain auth enroll bob   --label bob   --client <client_id> --ttl 30d
```

Each prints a code **once**. Single-use, expiring, revocable; only its SHA-256
is stored.

### 4. Hand it over

- The **Owner** gets the URL, client ID and secret, and adds the connector once
  at organisation level.
- **Each person** gets their own code, privately.

A code is a bearer credential: whoever types it first owns that space. Send them
person-to-person, never into a shared channel, and never reuse one for two
people.

### What the person then does

Clicks **Connect**, is shown a single field, pastes the code, and is returned to
the chat client. That is the whole experience — no account, no login, and never
again after the first time. The refresh token carries the binding, so the
connection renews itself indefinitely as long as it is used inside the refresh
window.

---

## Why sharing the connector secret is safe

The client ID and secret identify **the application**, not a person. They will
sit in an organisation's connector settings where every member can read them,
and that is fine — but only because of one specific property, which is worth
verifying rather than assuming:

```bash
memrain auth list-clients | grep -A6 '"client_name": "team-connector"'
# grant_types must be ["authorization_code","refresh_token"] — NOT client_credentials
```

**If `client_credentials` is present, the design collapses**: anyone holding the
secret could mint a token with no code at all. It is absent when the client is
registered with `--redirect-uris`, which makes it a browser client. Check it.

With that in place, the secret alone yields nothing:

| Attempt with the real secret | Result |
|---|---|
| `POST /token` with `grant_type=client_credentials` | `invalid_client` |
| `GET /authorize` | the code form; no code minted |
| `POST /authorize` with a guessed code | `400`, "not accepted" |

Someone who adds the same connector without a code gets a form and stops there.

Wrong, used, expired, revoked and issued-for-another-client codes all fail
identically, so the form cannot be used to probe which codes exist. The claim is
one atomic `UPDATE`, so two people racing the same code cannot both win.

---

## The login gate

`MEMRAIN_OAUTH_REQUIRE_LOGIN=1` — which bootstrap writes when the
`<prefix>/memrain-admin-bootstrap` secret exists (see DEPLOYMENT.md "Admin
surface and OAuth consent"; without it `/authorize` auto-approves) — gates `/authorize` on a
signed-in operator.

`/admin/login` accepts exactly one credential: the operator bootstrap token.
There is no per-user login. So with that flag on, a teammate can only complete a
connector flow by holding an operator session for the whole brain, which is
worse than what the flag was guarding against.

Enrollment mode does not consult the flag — the code *is* the resource-owner
authentication. But a `client`-mode connector behind it is unusable by anyone
but the operator. Keep the flag for a brain that serves one operator and nobody
else; take it off otherwise.

**Never hand out the admin panel or its token.** It opens the whole brain.

---

## Day-2 operations

```bash
memrain auth enrollments [--client <client_id>] # id, label, source, expiry, used/revoked, last token — never the code
memrain auth revoke-enrollment <id>      # kill a code that leaked before it was used
memrain auth revoke-grant <id>           # cut off one person who already redeemed a code
memrain auth enroll --replaces <id>      # new code for the same person; keeps source, spend key and cap
memrain auth enroll alice --label alice --client <client_id> --ttl 30d # a code for someone new
memrain auth list-clients                # who exists, in which mode, on which source
memrain auth who-can-read notes/example  # read-only access verdicts; no page body or credentials
memrain auth set-budget <client_id|token_name|enrollment_id> 2.00 # daily USD ceiling; 'none' removes it
memrain auth revoke-client <client_id>   # cut a connector off entirely
```

`who-can-read` checks current PATs and issued OAuth access tokens through
`page_get`, including source, scope, diary and quarantine rules. It groups
tokens by client or enrollment and reports the strongest current verdict.
Unredeemed invitations and clients without access tokens appear separately;
refresh tokens, future grants and static public/internal bearers are outside
this inventory. Set `MEMRAIN_PUBLIC_URL` to check resource-bound audiences.
The report flags truncation above 1,000 rows per credential category and does
not update credential-use or page-retrieval timestamps.

The admin panel does the same without an SSM session: **Agents** →
**Credentials** → **Members** on a browser connector's row lists each person (label, source,
redeemed, revoked, last token) with **Revoke code**, **Revoke grant**, **New
code** and **Issue code**. Every change is audited with who made it.

**Someone leaves.** `memrain auth revoke-grant <enrollment_id>` (or **Revoke
grant**) revokes their enrollment and deletes every token minted under it, in
one transaction; everyone else on the connector keeps working. For a code they
never used, `memrain auth revoke-enrollment <id>` is enough. Their source keeps
their notes, and `memrain sources delete` refuses while any content or live grant
still names it — it prints what is holding the reference rather than orphaning
a credential, so cleaning up data is deliberate work, not one command.

**Someone lost their connection.** A broken refresh chain or a new device
needs a new code: `memrain auth enroll --replaces <enrollment_id>` keeps their
source, read set, spend key and daily cap. The old grant keeps working until
the new code is redeemed, then it is revoked.

**Budgets are per person.** A token redeemed from an enrollment code spends
under that enrollment; `memrain auth set-budget <enrollment_id> <usd>` caps one
person. Without such a cap, the connector's `budget_usd_per_day` applies to each
person separately.

**Check who landed where.** Have the person run the `whoami` tool from their
client: it returns the write source and read set their token actually carries —
the fastest way to confirm an enrollment did what you meant.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `redirect_uri is not registered for this client` | the callback origin was never registered; hosts differ between a vendor's domains | `memrain auth set-redirect-uris <client_id> <uri>...` with every origin |
| Person sees an admin login, not a code field | the client is in `client` mode with the login gate on | `rescope-client … --tenant-mode enrollment`, or take the gate off |
| `That code was not accepted` | used, expired, revoked, or issued for another client — deliberately indistinguishable | `auth enrollments` shows which; re-issue |
| Person lands in the wrong space | codes were swapped at handover | revoke, re-issue, hand over again |
| `budget_exhausted` on search or think | that person's daily cap is spent (their enrollment cap, or the connector's cap applied per person) | `set-budget <enrollment_id>`, or wait for the UTC day to roll |
| Writes succeed but nothing is findable | budget ran out mid-index: the note is stored unembedded, on purpose | raise the cap, then `memrain embed` |

---

## Before you rely on this

- Set `MEMRAIN_TENANT_FAIL_CLOSED=1`. Without it, an authenticated principal
  carrying **no** grant falls back to the redacted whole brain rather than to
  nothing — and every rule above keys off the grant.
- Leave Dynamic Client Registration off. A self-registered client lands on the
  shared `default` tenant.
- Read the open items in [`TODO.md`](../TODO.md) before treating tenant
  isolation as absolute. The fences are real and tested, but the list is the
  honest edge of what has been proved.
