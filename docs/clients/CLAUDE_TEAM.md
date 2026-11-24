# Connect a Claude Team or Enterprise organisation

At the end, every member of your organisation can search Memrain from Claude
and write to it, each in their own space. You need a running Memrain server, a
shell on its host, and an Owner of the Claude organisation to add the
connector.

On a Team or Enterprise plan only an Owner adds a custom connector, once, for
the whole organisation, and every member then connects to that same client. To
keep each member in their own space, register the client in **enrollment
mode**: each person redeems a one-time code on first connect, and that sign-in
is pinned to their source. This page is the checklist.

A connector set up before the rename to Memrain keeps working: the URL is
unchanged and so are its credentials. Renaming its display name is optional.

`memrain …` below is the CLI on the host:
`docker exec deploy-memrain-1 bun run src/cli.ts …` in an SSM session. Every
enrollment action except `invalidate-tokens` is also on the admin panel:
**Credentials → Members** on the connector's row, and **Revoke** on the row itself.

## Prerequisites

- Memrain is deployed, `curl -s <issuer>/health` returns `{"ok":true,...}`, and
  `MEMRAIN_PUBLIC_URL` is `<issuer>` (for example `https://brain.<domain>`).
- `MEMRAIN_TENANT_FAIL_CLOSED=1` on the host, so an authenticated caller with no
  grant reads nothing rather than the redacted whole brain.
- Dynamic Client Registration left off (`MEMRAIN_ENABLE_DCR` unset).

## Steps

1. A source per person:

   ```bash
   memrain sources register alice --kind other --path-prefix tenant:alice
   memrain sources register bob   --kind other --path-prefix tenant:bob
   ```

2. One connector, in enrollment mode:

   ```bash
   memrain auth register-client team-claude \
     --tenant-mode enrollment --scopes 'read write' --source default \
     --redirect-uris 'https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback'
   ```

   It prints `client_id` and `client_secret` once. `--source default` is only the
   fallback for a grant that names none; an enrolled session always overrides
   it. Confirm the client has no `client_credentials` grant — that is what makes
   sharing its secret with the Owner safe:

   ```bash
   memrain auth list-clients
   # grant_types: ["authorization_code","refresh_token"]
   ```

3. A code per person, printed once each:

   ```bash
   memrain auth enroll alice --label alice --client <client_id> --ttl 30d
   memrain auth enroll bob   --label bob   --client <client_id> --ttl 30d
   ```

4. Budgets, per person (optional):

   ```bash
   memrain auth set-budget <enrollment_id> 2.00   # one person
   memrain auth set-budget <client_id> 2.00       # default for everyone else, applied per person
   ```

5. The Owner adds the connector (click-path checked against Anthropic's help
   center on 2026-09-28):

   - **Organization settings → Connectors**, click **Add**, hover **Custom**,
     choose **Web**.
   - URL `<issuer>/mcp`; under **Advanced settings**, **OAuth Client ID** and
     **OAuth Client Secret** from step 2.

6. Each member, in their own account: find the connector, click **Connect**,
   paste their code into Memrain's form, and they are returned to Claude. The
   refresh token carries the binding, so they never see the form again unless
   the chain breaks.

Send each code person to person, never into a shared channel. A code is a
bearer credential until it is used.

## Manage members later

| Task | Command | Admin panel |
|---|---|---|
| List codes and grants | `memrain auth enrollments --client <client_id>` | the Members view |
| Issue a code | `memrain auth enroll <source> --client <client_id>` | **Issue code** in Members |
| Kill a code nobody has used | `memrain auth revoke-enrollment <enrollment_id>` | **Revoke code** in Members |
| Cut off one person after they connected | `memrain auth revoke-grant <enrollment_id>` — deletes that grant's tokens; everyone else keeps working | **Revoke grant** in Members |
| New code for the same person (lost device, broken refresh chain) | `memrain auth enroll --replaces <enrollment_id>` — keeps source, read set, label, spend key and cap; the old grant works until the new code is redeemed | **New code** in Members, shown once the code is redeemed |
| Sign everyone out, keep the connector | `memrain auth invalidate-tokens <client_id>` | CLI only |
| Sign one person out, keep their grant | `memrain auth invalidate-tokens <client_id> --grant <enrollment_id>` | CLI only |
| Retire the connector | `memrain auth revoke-client <client_id>` | **Revoke** on the Credentials row |

## Verify

Each member asks Claude to call Memrain's `whoami` tool: `write_source` must be
their own source. `memrain auth enrollments --client <client_id>` shows each
grant as redeemed, with the time a token was last minted.

## Troubleshooting

| Symptom | First check |
|---|---|
| Member sees the admin login instead of a code field | The client is in `client` mode and owner approval is on (the default). `memrain auth rescope-client <client_id> --source default --tenant-mode enrollment`. |
| "That code was not accepted." | Used, expired, revoked or issued for another client — deliberately indistinguishable. `memrain auth enrollments --client <client_id>` shows which. |
| `redirect_uri is not registered for this client` | The organisation uses a callback origin you did not register. `memrain auth set-redirect-uris <client_id> <uri> <uri>`; the secret stays. |
| `invalid_target` | The connector URL is not `<issuer>/mcp` on the host `MEMRAIN_PUBLIC_URL` names. |
| A member lands in someone else's space | Codes were swapped at handover. `revoke-grant` both, issue new codes, hand over again. |
| `401` with `Bearer error="invalid_token"` for one member | Their grant was revoked or their refresh chain broke. Issue `enroll --replaces <enrollment_id>` and have them reconnect. |
| `budget_exhausted` | That person's daily cap is spent: `memrain auth set-budget <enrollment_id> <usd>`. |
| Writes succeed but search does not find them | The budget ran out mid-index; the page is stored unembedded. Raise the cap, then `memrain embed`. |
