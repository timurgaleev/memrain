# Quickstart

This page takes you from an empty AWS account to an AI agent that searches your
notes.
It also covers running Memrain on your laptop, choosing a credential, and
day-to-day operation. For what Memrain is and why you would use it, start with the
[README](../README.md).

## Install with Terraform (recommended)

You need an **AWS account with Bedrock access**, **Terraform >= 1.6**, the
**AWS CLI**, an **existing S3 bucket for Terraform state** (create it by hand;
`terraform init` fails without it), and a **domain on Cloudflare** (or
`ingress_mode = "caddy"`, which needs the domain's Route53 public hosted zone
in this account, or `caddy_manage_dns = false` plus an A record to the instance
EIP that you create yourself). Docker is not needed locally; bootstrap installs
it on the host.

**1. Fork and clone the repo.** Fork it to your GitHub account and keep the
fork public. On first boot the instance clones your fork (`<owner>/<repo>` from
your `make init` answers) over anonymous HTTPS, so a missing or private repo
makes boot fail. For a private fork, answer `true` to the SSH deploy key prompt
in `make init` and set `repo_url = "git@github.com:<owner>/<repo>.git"` in
`terraform/terraform.tfvars`.

```bash
git clone https://github.com/<your-github-username>/memrain.git && cd memrain
```

**2. Write your config** (`.env`, `terraform/terraform.tfvars`, `terraform/backend.hcl`)

```bash
make init
```

`make init` does not ask about everything. Set these in
`terraform/terraform.tfvars` yourself when they apply:

- a region other than `eu-west-1`: `availability_zone` and
  `multi_az_subnet_cidrs` must name that region's zones;
- Caddy instead of Cloudflare: `ingress_mode = "caddy"` (and
  `caddy_manage_dns = false` if the domain's zone is not in Route53 here);
- a private fork: `make apply` creates an empty `<prefix>/github-deploy-key`
  secret and boots the host at once. Fill the secret as soon as it exists, or
  re-run bootstrap afterwards (see [DEPLOYMENT.md](./DEPLOYMENT.md) steps 4
  and 6).

**3. Plan** (runs the audit gate and `terraform init`)

```bash
make plan
```

**4. Apply** (does not run `terraform init`, so plan first)

```bash
make apply
```

**5. Cloudflare mode: give the tunnel its token**, then create the tunnel route
to the service in the Cloudflare dashboard.

```bash
aws secretsmanager put-secret-value --profile <your-profile> --region <your-region> \
  --secret-id <prefix>/cloudflared-tunnel-token --secret-string '<tunnel-token>'
```

The host fetched secrets at first boot, before the token existed, so pull it
again and recreate the tunnel container (in an SSM session on the host):

```bash
cd /opt/<project>
sudo bash deploy/secrets/fetch-secrets.sh
sudo docker compose --env-file .env up -d cloudflared
```

**6. Submit the Bedrock Anthropic use-case form** once in the AWS console.
Without it every Claude call fails.

**7. Add your notes.** The notes folder is empty on a fresh install. Either:

- copy your markdown to `/mnt/<project>-efs/<project>/workspace/memory` on the
  host (it is `/memory` inside the container), then index it in an SSM session
  with the command below; or
- or, once your agent is connected (step 9), have it save notes with
  `page_put`.

Details are in [DEPLOYMENT.md](./DEPLOYMENT.md) section 7.

```bash
sudo docker exec deploy-memrain-1 bun run src/cli.ts reindex --source vault --vault /memory
```

**8. Check health** (expect `{"ok":true,"db":...,"version":...}`)

```bash
curl -s https://<subdomain>.<domain>/health
```

**9. Connect your agent.** Mint a personal access token for yourself on the
host (it is printed once; without `--source` it writes to `default`, the
operator's space), then add the server to your agent:

```bash
sudo docker exec deploy-memrain-1 bun run src/cli.ts auth create my-laptop
claude mcp add --transport http --scope user memrain https://<subdomain>.<domain>/mcp \
  --header "Authorization: Bearer <PAT>"
```

Use this token, not the auto-generated public bearer: the public bearer is
read-only and, by default, hides note bodies, so searches through it return no
passages. For other people and other clients, see the credential table below
and [clients/](./clients/).

## Try it locally

Run Memrain on your laptop with an embedded database and no servers. You still
need AWS credentials with Bedrock Titan access, because every note is embedded
before it is stored.

```bash
cd deploy/memrain
bun install --frozen-lockfile
bun run src/cli.ts init --pglite
bun run src/cli.ts sources register laptop --kind vault --path-prefix /abs/path/to/notes
bun run src/cli.ts reindex --source vault --vault /abs/path/to/notes
bun run src/cli.ts auth create laptop --source laptop --scopes read,write
MEMRAIN_INTERNAL_TOKEN=$(openssl rand -hex 32) \
  bun run src/cli.ts serve --http --port 18790
```

Then connect your agent to the local server with the PAT `auth create` printed,
and call `whoami` to check it:

```bash
claude mcp add --transport http memrain http://127.0.0.1:18790/mcp \
  --header "Authorization: Bearer <PAT from auth create>"
```

The CLI runs as `bun run src/cli.ts`; a `memrain` command is on your PATH only
after you link it yourself (for example with `bun link`).

- `init` creates `~/.memrain` with an embedded PGLite database, a `config.json`
  and a `memrain.yml` that turns on `auth.selfIssued`, which the server needs to
  accept the tokens `auth create` and `auth register-client` mint.
- The Bedrock region comes from `AWS_REGION`, or `eu-west-1` when it is unset;
  set it before running the CLI or `serve` to change it.
- Register the source before you create a token for it: `auth create --source`
  refuses a source that does not exist.
- `--path-prefix` is a filesystem path: files indexed from under it belong to
  that source, which is what makes imported notes visible to the source's PAT.
  Notes you write later through MCP `page_put` with that PAT land in its source
  too.
- Run the CLI commands before `serve`. PGLite is single-process, so while
  `serve` holds the database open every other CLI command refuses to start.
- Local requests arrive on the internal path. With `MEMRAIN_INTERNAL_TOKEN`
  unset they are **not authenticated at all**: anyone who can reach the port
  on this machine can read and write everything, and a bearer token you send
  is ignored. The server binds to 127.0.0.1 by default; with `--host 0.0.0.0`
  (or `MEMRAIN_HOST`) that means anyone on the network. Set `MEMRAIN_INTERNAL_TOKEN` as above and every request needs
  either that token or a PAT, and a PAT is scoped to its source (`whoami`
  shows it).
- Embeddings call Bedrock (Titan), and a note is embedded before it is written.
  Without AWS credentials with Titan access, `index` and `reindex` fail on every
  file and nothing becomes searchable.


Everything else (Caddy ingress, secrets, updates, verification) is in
[docs/DEPLOYMENT.md](./DEPLOYMENT.md).

## Connect your agent and pick a credential

Every client connects to the same `/mcp` URL, with a bearer token or through
OAuth. What the caller can do depends on the credential:

| Credential | How you get it | What it unlocks |
|---|---|---|
| Personal access token | `memrain sources register <src> ...`, then `memrain auth create <name> --source <src>` | One person or machine, writing to its own source, with an optional daily cap. |
| OAuth 2.1 client | `memrain auth register-client ...` | Browser connectors (claude.ai, ChatGPT) and CLI sign-ins through `/authorize`, machine clients through client credentials, and enrollment mode for one connector shared by a team. |
| Static public bearer | Auto-generated in Secrets Manager as `<prefix>/memrain-public-bearer` | No tenant. Read tools such as `search`, `page_get`, `backlinks` and graph/entity reads; no `code_*`, `think`, `query`, `get_chunks` or `volunteer_context`. A small set of writes only with `MEMRAIN_PUBLIC_WRITE=1`. |

Run the `whoami` tool to see the scopes, write source and read sources of the
credential you are using. Step-by-step guides, each with a troubleshooting table:

| Client | Guide |
|---|---|
| Claude Code | [docs/clients/CLAUDE_CODE.md](./clients/CLAUDE_CODE.md) |
| Codex CLI | [docs/clients/CODEX.md](./clients/CODEX.md) |
| claude.ai (Pro, Max) | [docs/clients/CLAUDE_AI.md](./clients/CLAUDE_AI.md) |
| Claude Team, Enterprise | [docs/clients/CLAUDE_TEAM.md](./clients/CLAUDE_TEAM.md) |
| ChatGPT (developer mode, workspace apps) | [docs/clients/CHATGPT.md](./clients/CHATGPT.md) |

## Deploy and operate

- **Ingress.** The default is a Cloudflare Tunnel with no inbound ports.
  `ingress_mode = "caddy"` serves Let's Encrypt TLS on 80/443 instead.
- **Access.** Reach the host through SSM (`aws ssm start-session --target <instance-id>`). No SSH.
- **Update.** `cd /opt/<project> && sudo git pull --ff-only && sudo bash deploy/deploy.sh`. It
  stamps the build, and `/health` must report the new stamp.
- **Upgrading from before the rename.** See [UPGRADING.md](../UPGRADING.md); a
  plain pull and deploy is not enough.
- **Operate.** `memrain doctor`, `memrain spend --days 7` and the `/admin` panel.
- **Optional units.** `deploy/systemd` ships a nightly eval probe and a bearer
  rotation timer. Bootstrap installs neither, and the static public bearer is
  meant to stay fixed; hand people PATs or OAuth clients instead.

See [docs/DEPLOYMENT.md](./DEPLOYMENT.md) and [docs/CONFIGURATION.md](./CONFIGURATION.md).

## Security and tenancy

- Every route except `GET /health`, the OAuth metadata and flow endpoints and
  `/admin` (which has its own sign-in) needs a credential. `/mcp` is the agent contract.
- A built-in OAuth 2.1 server. Dynamic client registration is off unless
  `MEMRAIN_ENABLE_DCR=1`, and then the server boots only with
  `MEMRAIN_OAUTH_REQUIRE_LOGIN=1` (or the explicit `MEMRAIN_ENABLE_DCR_INSECURE=1`).
- Enrollment codes are single-use, and only their SHA-256 is stored.
- Credentials pasted into pages, facts, timeline entries, indexed files or
  `/ingest` are redacted before storage by default
  (`MEMRAIN_SECRET_SCAN_DISPOSITION=flag|reject` changes that).
- For a capped caller, a paid call reserves its worst-case cost against the
  daily cap under a lock before it is sent.
- RDS is encrypted, deletion-protected and keeps a final snapshot. CloudTrail is
  on by default. No vendor analytics or third-party telemetry; Memrain's own search telemetry, request and spend logs stay in your account.

Details: [docs/TEAM-SETUP.md](./TEAM-SETUP.md) and [SECURITY.md](../SECURITY.md).
