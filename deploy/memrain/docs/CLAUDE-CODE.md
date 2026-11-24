# Using Memrain as an MCP server in Claude Code

Memrain serves MCP at `POST /mcp`, at `https://brain.<your-domain>/mcp` behind
the Cloudflare Tunnel or the Caddy ingress. The step-by-step guide, with OAuth
and troubleshooting, is [docs/clients/CLAUDE_CODE.md](../../../docs/clients/CLAUDE_CODE.md).
Guides for the other clients sit next to it in
[docs/clients/](../../../docs/clients/).

## The short version

Mint a personal access token on the host (without `--source` it writes to
`default`):

```bash
docker exec deploy-memrain-1 bun run src/cli.ts auth create laptop
```

The token is printed once. Then, on your machine:

```bash
claude mcp add --transport http --scope user memrain https://brain.<your-domain>/mcp \
  --header "Authorization: Bearer <token>"
```

Ask Claude Code to call `whoami`; `write_source` should be `default`.

## Which credential

| Credential | Writes to | Reaches |
|---|---|---|
| PAT from `auth create <name> [--source <src>]` | the named source, or `default` | the tools its scopes cover (`read,write` by default), scoped to its sources |
| OAuth client from `auth register-client` | the client's source | the same, per client |
| Static public bearer (`<prefix>/memrain-public-bearer`) | nothing, unless `MEMRAIN_PUBLIC_WRITE=1` | the public read subset only |

The static public bearer is static: bootstrap does not install the optional
rotation timer. It reaches only `search`, `backlinks`, `page_get`,
`page_list`, `page_versions`, `get_brain_identity` and `whoami`, with page
bodies hidden by default (`FORBIDDEN_MCP_TOOLS_FROM_PUBLIC` in
`src/http/public_guard.ts`). With `MEMRAIN_PUBLIC_WRITE=1` it can also call the
constructive writes (`index`, `page_put`, `page_append`, `page_edit`,
`add_tag`, `link`); anyone holding it can then write, so prefer PATs.

## Check the connection

`memrain auth doctor` runs the path a client takes, from your machine: `/health`,
both OAuth discovery documents, MCP `initialize`, `tools/list` and `whoami`.
Put the token in a file only you can read, holding `{"token": "..."}`:

```bash
bun run src/cli.ts auth doctor https://brain.<your-domain> \
  --token-file ~/.config/memrain/laptop.json --expect-operator
```

## Local-only alternative: SSM port-forward

To reach the full tool set without any public credential, tunnel to the
container from your workstation. The container publishes no host port, and the
`memrain` name resolves only inside the Docker network, so forward to the
container's bridge IP. Read it on the host (it changes when the container is
recreated):

```bash
sudo docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' deploy-memrain-1
```

Then, from your workstation:

```bash
AWS_PROFILE=<your-profile> aws ssm start-session \
  --target <your-instance-id> \
  --region <your-region> \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters '{"host":["<container-ip>"],"portNumber":["18790"],"localPortNumber":["18790"]}'
```

While the session runs, point Claude Code at `http://localhost:18790/mcp`. A
request that arrives this way carries no `Cf-Connecting-Ip` header, so Memrain
treats it as an internal peer: every call, read or write, needs
`Authorization: Bearer <MEMRAIN_INTERNAL_TOKEN>`. A personal access token is
accepted on this path only when `auth.selfIssued.enabled: true` is set in
`memrain.yml`; with it off, anything but the internal token gets a 401:

```bash
claude mcp add --transport http --scope user memrain http://localhost:18790/mcp \
  --header "Authorization: Bearer <MEMRAIN_INTERNAL_TOKEN>"
```

Behind an ingress other than a Cloudflare Tunnel, `MEMRAIN_ASSUME_PUBLIC=1`
changes that classification; see
[docs/CONFIGURATION.md](../../../docs/CONFIGURATION.md).
