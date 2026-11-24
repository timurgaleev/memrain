# Connect ChatGPT

At the end, ChatGPT can search your Memrain memory and write to it; ChatGPT
asks you to confirm write actions. You need a running Memrain server, a shell on its host
to register a client, and a ChatGPT plan with developer mode.

ChatGPT reaches Memrain as a remote MCP server through **developer mode**,
where you create an app for your own account. It uses OAuth with a client you
register ahead of time: Memrain keeps Dynamic Client Registration off and does
not support Client ID Metadata Documents, so paste a static client ID and
secret into the app's OAuth settings.

A connector set up before the rename to Memrain keeps working: the URL is
unchanged and so are its credentials. Renaming its display name is optional.

`memrain …` below is the CLI on the host:
`docker exec deploy-memrain-1 bun run src/cli.ts …` in an SSM session.
`<issuer>` is your public origin, for example `https://brain.<domain>`.

## Prerequisites

- Memrain is deployed, `curl -s <issuer>/health` returns `{"ok":true,...}`, and
  `MEMRAIN_PUBLIC_URL` is `<issuer>`.
- A source for ChatGPT, so its writes stay apart from your other pages:

  ```bash
  memrain sources register chatgpt --kind other --path-prefix agent:chatgpt
  ```

## Pick the callback URL

Memrain returns `iss` on every authorization response and advertises
`authorization_response_iss_parameter_supported: true`. OpenAI documents that
an authorization server meeting that requirement gets the stable redirect URI
`https://chatgpt.com/connector_platform_oauth_redirect`; without it ChatGPT uses
a per-connection `https://chatgpt.com/connector/oauth/{callback_id}`. Register
the stable one. If the browser ever reports the per-connection form, add that
exact URL with `memrain auth set-redirect-uris`.

## Connect (developer mode)

1. Register a confidential client bound to that source:

   ```bash
   memrain auth register-client chatgpt \
     --scopes 'read write' --source chatgpt \
     --redirect-uris 'https://chatgpt.com/connector_platform_oauth_redirect'
   ```

   It prints `client_id` and `client_secret` once. The secret is a credential;
   keep it private and use the client for this app only.

2. In ChatGPT (checked against OpenAI's developer-mode guide on 2026-09-28;
   labels in this area move often):

   - **Settings → Security and login**, turn on **Developer mode**.
   - Create an app for a remote MCP server (the **+** in the apps/plugins
     list), URL `<issuer>/mcp`, authentication **OAuth**, and enter the client
     ID and secret in its OAuth fields.
   - Connect; the browser goes to Memrain's `/authorize` and back.

With owner approval on (the default) the browser is sent to `/admin/login`
first: sign in with your passkey (or the bootstrap token) and approve the
client.

## Which tools ChatGPT sees

`tools/list` returns every Memrain tool to an OAuth caller, each with
`annotations`: `readOnlyHint: true` on the read tools, and on the others
`readOnlyHint: false`, `destructiveHint` (true for tools that delete or
overwrite, such as `page_put` and `page_delete`) and `idempotentHint` where it
holds. ChatGPT asks you to confirm write actions. The list is not narrowed by
scope: a call the token's scope does not cover is refused with
`insufficient_scope`, and the operator tools (`stats`, `run_doctor`) with
`permission_denied`.

Memrain has a `search` tool but no `fetch` tool. Whether a given ChatGPT surface
(deep research, company knowledge) needs that pair is not verified here.

## Verify

Ask ChatGPT to call Memrain's `whoami` tool: `write_source` should be
`chatgpt`. On the host, `memrain auth list-clients` shows the client.

## Troubleshooting

| Symptom | First check |
|---|---|
| `redirect_uri is not registered for this client` | ChatGPT sent a per-connection callback. Add the URL the error shows: `memrain auth set-redirect-uris <client_id> https://chatgpt.com/connector_platform_oauth_redirect <that-url>`. |
| `invalid_target` | ChatGPT sends `resource=<the URL you configured>`. Memrain accepts `<issuer>` and `<issuer>/mcp` only; fix the app's URL or `MEMRAIN_PUBLIC_URL`. |
| Callback carries `error=unauthorized_client` | The client lacks the `authorization_code` grant, or it is public (no secret) in `client` mode. Register it as above. |
| Connect fails with `invalid_client` | Secret mistyped, or the client was revoked. |
| Connect lands on the admin login | Owner approval is on (the default). Sign in with your passkey and approve the client. |
| Tools fail with `401`, `Bearer error="invalid_token"` | The token was revoked or its refresh chain broke. Reconnect. |
| A tool returns `insufficient_scope` | The client was registered read-only. The result's `_meta["mcp/www_authenticate"]` names the scope to ask for. |
| `budget_exhausted` | The daily cap is spent: `memrain auth set-budget <client_id> <usd>`. |
