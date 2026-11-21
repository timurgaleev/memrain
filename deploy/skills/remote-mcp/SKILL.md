---
name: remote-mcp
version: 1.1.0
description: |
  Make the user's own Memrain reachable over MCP from their other devices,
  desktop apps and cloud agents, without moving the data or putting the
  database on the internet. Picks the reach (loopback, the AWS install's
  Cloudflare Tunnel or Caddy ingress), then registers one least-privilege
  credential per client and verifies the connection from that client.
triggers:
  - "use my brain over mcp"
  - "serve my brain over mcp"
  - "expose my brain over mcp"
  - "remote mcp access to my brain"
  - "reach my brain from my phone"
  - "connect claude desktop to my brain"
  - "connect claude.ai to my brain"
  - "use my brain from another device"
  - "put my brain online"
tools:
  - whoami
  - list_skills
  - search
mutating: true
---

# Remote MCP

> The brain runs on one host. This skill makes it reachable over MCP from the
> user's other devices and the agents they use elsewhere, with one scoped
> credential per client. The database never faces the internet: only the
> server's HTTPS endpoint does, behind its own authentication.

## Contract

- **Reach and authentication are separate choices.** The ingress decides who
  can reach `/mcp`; the credential decides what a caller may do. A public
  endpoint is protected by OAuth or bearer tokens and per-client grants, not
  by the network.
- **Consent before host changes.** Starting a server, changing ingress,
  creating secrets or running terraform changes the host. Show the plan (for
  terraform, the `plan` output) and get a yes first. This skill never applies
  infrastructure itself, and never changes a terraform-managed resource by
  hand.
- **Least privilege.** One credential per client, scoped to the source it
  needs, read-only where the client only reads. Broader access only when the
  user asks for it; never operator scope to make a check pass.
- **No secrets in chat.** Tokens go to a file only the user can read
  (`chmod 600`) or to the client's own secret store. The admin bootstrap value
  and setup links are delivered privately and never opened by the agent.
- **A server check is not client activation.** A healthy `/health` or a
  passing `memrain auth doctor` proves the server; only an authenticated call
  from inside the intended client proves the client loaded the tools.

## Decision table: who is connecting?

| Client | Reach | Where it is set up |
|---|---|---|
| An agent on the same machine as a local brain (Claude Code, Codex) | loopback `http://127.0.0.1:18790/mcp` | `make local-up` (Docker, keyword-only) or `serve --http` from a checkout (`docs/QUICKSTART.md`) |
| The user's own other devices and desktop apps | the AWS install's public HTTPS name | `docs/DEPLOYMENT.md`: Cloudflare Tunnel (default, no inbound ports) or `ingress_mode = "caddy"` (Let's Encrypt on 80/443) |
| Cloud agents (claude.ai, ChatGPT connectors) | the same public HTTPS name, with OAuth | `docs/clients/CLAUDE_AI.md`, `docs/clients/CHATGPT.md` |
| A whole team through one connector | the same public name, an enrollment-mode client | `docs/TEAM-SETUP.md`, `docs/clients/CLAUDE_TEAM.md` |
| This machine has no brain at all | none | Stop: run this skill on, or against, the brain's host |

A loopback server cannot be reached by cloud agents; for them the brain needs
the deployed HTTPS endpoint. Never bind a local server to `0.0.0.0` to
"share" it: without `MEMRAIN_INTERNAL_TOKEN` set, local requests are not
authenticated at all.

## Phases

### 1. Detect

- `whoami` from a client that already connects shows the identity, scopes,
  `write_source` and `read_sources`.
- On the host: `memrain status` and `memrain engine status` show what runs
  and on which engine.
- Ask which clients should reach the brain and what each needs to do (read
  only, or write). Do not re-ask what the user already said.

### 2. Publish

Follow the matching guide; do not improvise ingress:

- **Local only:** `make local-up` prints the MCP URL and an operator token;
  `scripts/local-up.sh token <name>` mints a read/write token per client.
- **AWS install:** `docs/DEPLOYMENT.md` sections 3-5: terraform plan, then
  the tunnel token (Cloudflare) or `ingress_mode = "caddy"`, then the admin
  bootstrap secret. Create the admin bootstrap secret before anyone but the
  operator connects, so OAuth consent needs a signed-in owner instead of
  auto-approving.
- **Panel owner sign-in:** `memrain admin setup-link` (24 h; `--ttl` up to
  72) gives the owner a one-time passkey link. Send it over a channel only the
  owner reads.

Verify the server from the operator's machine, with the token in a `0600`
file:

```bash
memrain auth doctor https://<host> --token-file <0600 file> --expect-operator
```

It checks `/health` and its build stamp, OAuth discovery, minting (with
`--client-file`), MCP `initialize` and `tools/list`, `whoami` and the token's
scope in one report. For a tenant credential use `--expect-source <id>`
instead of `--expect-operator`.

### 3. One credential per client

Owner actions, on the host or through the admin panel (`mcp-access` owns the
full set):

| Client kind | Credential |
|---|---|
| A person or machine with a bearer header | `memrain sources register <src> --kind <kind> --path-prefix <prefix>`, then `memrain auth create <name> --source <src> --scopes read,write` (or `read`) |
| A browser connector (claude.ai, ChatGPT) | `memrain auth register-client <name> --scopes <scopes> --source <src> --redirect-uris <the client's callback from its guide>` |
| A team through one connector | an enrollment-mode client (`--tenant-mode enrollment`), then `memrain auth enroll <source>` per person |
| Any paid use | a daily cap: `memrain auth set-budget <id> <usd>` |

Static public bearer: it is denied writes and many read tools (`query`, the
`code_*` and `find_*` tools, the jobs tools and more). A client that needs
those gets a personal access token or an OAuth client, not the public bearer.

### 4. Connect and verify inside the client

Configure the client from its guide under `docs/clients/` (the
`connect-client` skill walks it). Then, inside that client:

1. `whoami` shows the intended `write_source`, `read_sources` and scopes.
2. `list_skills {"query": "remote access"}` answers.
3. One authorized read returns data, e.g. `search {"q": "<a topic the user knows is in the brain>", "k": 3}`.

A right connection to the wrong source is not a working setup. Report server
checks and in-client checks separately.

### 5. Withdraw reach (when asked)

- One client: `memrain auth revoke-client <id>` for an OAuth client,
  `memrain auth revoke <name>` for a personal access token, or
  `memrain auth invalidate-tokens <id>` to end its sessions but keep it
  registered.
- The public endpoint itself: an ingress change through terraform (plan
  shown, then apply against the S3 state), never by hand.

Withdrawing reach does not erase brain data.

## PGLite single-writer note

On PGLite one process owns the database. While `serve` runs, CLI commands
that open the database refuse instead of waiting. Mint credentials through
the running server's admin panel or API, or stop the server briefly (the
local script does this for `token`). If several clients need concurrent
host-side work, route to `postgres-adopt`. Never delete the lock.

## Output Format

Report the stage reached and the one next action, keeping the stages apart:

```
Reach:      <loopback | tunnel | caddy> at <url>          [server verified: auth doctor ok]
Credential: <pat | oauth client | enrollment> <name> → source <src>, scopes <...>
Client:     <name> — whoami: <write_source>, <scopes>     [verified in client | pending]
Next:       <one action, and who does it>
```

Name every unverified step; a passing server check never stands in for an
observed call inside the client.

## When it fails

- `insufficient_scope` or `permission_denied` from the client: a grant
  problem only the owner can change. Name the missing scope; do not request
  broader scopes as a retry.
- `invalid_token` or 401 from the client: the credential expired, was revoked
  or was copied wrong. Issue a new scoped one; never hand out an admin
  credential to make it connect.
- `redirect_uri is not registered for this client`: the client uses a
  callback you did not register. `memrain auth set-redirect-uris <id> <uri> [uri...]`.
- `memrain auth doctor` exits 1: fix the stage its report names before
  touching the client; exit 2 is a usage error in the command itself.
- The `cloudflared` container restarts in a loop: the tunnel token secret is
  still empty; finish `docs/DEPLOYMENT.md` section 5.
- A teammate stops at the admin login during OAuth consent: that gate admits
  only the operator. Use an enrollment-mode client for people other than the
  operator.
- A local CLI command refuses because `serve` holds PGLite: see the
  single-writer note.

## Anti-Patterns

- Binding a local server to every interface to share it.
- One shared token for several clients.
- Operator or admin scope for a client that only reads.
- Turning off the consent login gate on a brain that faces the internet.
- Treating a passing server check as proof the client works.
- Pasting tokens, client secrets or setup links into chat or a logged command
  line.
- Running terraform apply without a reviewed plan, or editing ingress by hand.

## Dedup (sharp boundaries)

- `mcp-access` owns the owner's administration (panel login, clients, grants,
  revocation); this skill decides the reach and hands credential work there.
- `connect-client` configures one client from its guide.
- `chat-connectors` imports conversations from chat apps; it does not make
  the brain reachable.
- `postgres-adopt` moves the engine; concurrency across many clients is often
  the reason to.
- `install` sets up the host the first time.
