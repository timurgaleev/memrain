# Connect ChatGPT

At the end, ChatGPT can search your Memrain memory and write to it; ChatGPT
asks you to confirm write actions. You need a running Memrain server, a shell on its host
to register a client, and a ChatGPT plan with developer mode, or a Business or
Enterprise workspace whose admin can publish an app. For anyone but the
operator in developer mode, the admin login gate must be off or the client must
use enrollment mode.

ChatGPT reaches Memrain as a remote MCP server in two ways:

- **Developer mode**, where a person creates an app for their own account;
- **a workspace app** on Business or Enterprise, which an admin creates and
  publishes for the workspace.

Both use OAuth with a client you register ahead of time: Memrain keeps Dynamic
Client Registration off and does not support Client ID Metadata Documents, so
paste a static client ID and secret into the app's OAuth settings.

A connector set up before the rename to Memrain keeps working: the URL is
unchanged and so are its credentials. Renaming its display name is optional.

`memrain …` below is the CLI on the host:
`docker exec deploy-memrain-1 bun run src/cli.ts …` in an SSM session.
`<issuer>` is your public origin, for example `https://brain.<domain>`.

## Prerequisites

- Memrain is deployed, `curl -s <issuer>/health` returns `{"ok":true,...}`, and
  `MEMRAIN_PUBLIC_URL` is `<issuer>`.
- A source per person:

  ```bash
  memrain sources register alice --kind other --path-prefix tenant:alice
  ```

## Pick the callback URL

Memrain returns `iss` on every authorization response and advertises
`authorization_response_iss_parameter_supported: true`. OpenAI documents that
an authorization server meeting that requirement gets the stable redirect URI
`https://chatgpt.com/connector_platform_oauth_redirect`; without it ChatGPT uses
a per-connection `https://chatgpt.com/connector/oauth/{callback_id}`. Register
the stable one. If the browser ever reports the per-connection form, add that
exact URL with `memrain auth set-redirect-uris`.

## Connect one person (developer mode)

1. Register a confidential client bound to the person's source:

   ```bash
   memrain auth register-client chatgpt-alice \
     --scopes 'read write' --source alice \
     --redirect-uris 'https://chatgpt.com/connector_platform_oauth_redirect'
   ```

   It prints `client_id` and `client_secret` once. The secret is Alice's
   credential; do not reuse the client for anyone else.

2. In ChatGPT (checked against OpenAI's developer-mode guide on 2026-09-28;
   labels in this area move often):

   - **Settings → Security and login**, turn on **Developer mode**.
   - Create an app for a remote MCP server (the **+** in the apps/plugins
     list), URL `<issuer>/mcp`, authentication **OAuth**, and enter the client
     ID and secret in its OAuth fields.
   - Connect; the browser goes to Memrain's `/authorize` and back.

With owner approval on (the default) the browser is sent to `/admin/login` first,
which only the operator can pass. For anyone else, turn the flag off or use
enrollment mode as below.

## Connect a Business or Enterprise workspace

One app serves the whole workspace, so bind each person at sign-in with
enrollment codes, exactly as for a Claude organisation:

```bash
memrain auth register-client chatgpt-team \
  --tenant-mode enrollment --scopes 'read write' --source default \
  --redirect-uris 'https://chatgpt.com/connector_platform_oauth_redirect'
memrain auth enroll alice --label alice --client <client_id> --ttl 30d
```

Confirm with `memrain auth list-clients` that its `grant_types` are
`["authorization_code","refresh_token"]` only; the admin will hold the secret,
and it mints nothing without a code.

The admin enables developer mode or custom MCP apps for the workspace, creates
the app with the URL, client ID and secret, tests it as a draft and publishes
it; members then connect and paste their code. OpenAI's guide confirms
developer mode on Business and Enterprise; the exact admin menu names
(workspace settings for permissions, then the apps list to publish) come from
third-party write-ups and are **unverified**. Day-2 commands are the same as
for Claude: see [CLAUDE_TEAM.md](./CLAUDE_TEAM.md#manage-members-later).

## Which tools ChatGPT sees

`tools/list` returns every Memrain tool to an OAuth caller, each with
`annotations`: `readOnlyHint: true` on the read tools, and on the others
`readOnlyHint: false`, `destructiveHint` (true for tools that delete or
overwrite, such as `page_put`, `page_delete`, `forget_fact`) and
`idempotentHint` where it holds. ChatGPT asks the person to confirm write
actions. The list is not narrowed by scope: a call the token's scope does not
cover is refused with `insufficient_scope`, and operator tools (`stats`,
`run_doctor`, `get_status_snapshot`, …) with `permission_denied`.

Memrain has a `search` tool but no `fetch` tool. Whether a given ChatGPT surface
(deep research, company knowledge) needs that pair is not verified here.

## Verify

Ask ChatGPT to call Memrain's `whoami` tool: `write_source` should be the
person's source. On the host, `memrain auth list-clients` shows the client and
`memrain auth enrollments --client <client_id>` shows redeemed codes.

## Troubleshooting

| Symptom | First check |
|---|---|
| `redirect_uri is not registered for this client` | ChatGPT sent a per-connection callback. Add the URL the error shows: `memrain auth set-redirect-uris <client_id> https://chatgpt.com/connector_platform_oauth_redirect <that-url>`. |
| `invalid_target` | ChatGPT sends `resource=<the URL you configured>`. Memrain accepts `<issuer>` and `<issuer>/mcp` only; fix the app's URL or `MEMRAIN_PUBLIC_URL`. |
| Callback carries `error=unauthorized_client` | The client lacks the `authorization_code` grant, or it is public (no secret) in `client` mode. Register it as above. |
| Connect fails with `invalid_client` | Secret mistyped, or the client was revoked. |
| Connect lands on the admin login | Owner approval is on (the default) and the client is in `client` mode. Use enrollment mode, or turn approval off with `MEMRAIN_OAUTH_REQUIRE_LOGIN=0`. |
| "That code was not accepted." | Used, expired, revoked or another client's code. `memrain auth enrollments --client <client_id>`; issue a new one. |
| Tools fail with `401`, `Bearer error="invalid_token"` | The token was revoked or its refresh chain broke. Reconnect; for an enrolled member, issue `enroll --replaces <enrollment_id>`. |
| A tool returns `insufficient_scope` | The client was registered read-only. The result's `_meta["mcp/www_authenticate"]` names the scope to ask for. |
| `budget_exhausted` | The daily cap is spent: `memrain auth set-budget <client_id|enrollment_id> <usd>`. |
