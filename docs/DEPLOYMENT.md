# Deployment — zero to live

This page is the long, step-by-step path to running Memrain in your own AWS
account, with every setting and check explained. Read it when you want to know
exactly what each step does, or when something in the install goes wrong. The
short path is [QUICKSTART.md](./QUICKSTART.md); new to Memrain? Read
[HOW-IT-WORKS.md](./HOW-IT-WORKS.md) first.

A linear self-host guide: from an empty AWS account to a running MCP retrieval
brain your Claude Code (or any MCP client) can query at
`https://<subdomain>.<domain>/mcp`.

The stack is one small EC2 instance running Docker Compose (the `memrain`
container + a `cloudflared` sidecar), an RDS Postgres index, an EFS data tree,
and Secrets Manager for credentials. Public ingress is a **Cloudflare Tunnel**,
not an ALB — the instance opens no inbound web ports.

Throughout, replace placeholders: `example.com` (your domain), `<subdomain>`
(default `brain`), `<account-id>`, `<instance-id>`, `<your-profile>`,
`<your-region>` (default `eu-west-1`), `<prefix>` (secrets prefix, default
`memrain`), `<project>` (project name, default `memrain`), `<scripts-bucket>`
(default `<project>-scripts-<account-id>`, or `scripts_bucket_name` if set).

---

## 1. Prerequisites

- **An AWS account** with credentials configured locally (`aws configure` / an
  `~/.aws/config` profile).
- **Bedrock Anthropic access unlocked for the account.** Bedrock model access
  is now enabled by default (the console *Model access* page is gone), but
  Anthropic models additionally require a **one-time use-case form** per
  account (or once at the AWS Organization's management account) before the
  first invoke — until it is submitted, every Claude call fails with
  `Model use case details have not been submitted for this account` while
  embeddings work fine, so the brain looks half-broken. Submit it either from
  the Bedrock console model catalog (open any Anthropic model → use case
  details) or via the CLI (`aws bedrock put-use-case-for-model-access`), then
  verify with:

  ```bash
  aws bedrock get-foundation-model-availability \
    --model-id anthropic.claude-haiku-5-5 \
    --query agreementAvailability.status   # expect "AVAILABLE"
  ```

  The models the brain uses: **Amazon Titan Text Embeddings V2** (indexing —
  no form needed), **Claude Haiku 5.5** (utility tier), **Claude Sonnet 5.5**
  (only if you turn on any paid slice). See the AWS docs on
  [model access](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html)
  for the current procedure.
- **Terraform ≥ 1.6**.
- **A domain** you control, plus a **Cloudflare account** (free tier is fine) —
  the public MCP ingress runs over a Cloudflare Tunnel.

  > **Running behind a different reverse proxy (Caddy, nginx, an ALB)?**
  > Public-request detection keys on the `Cf-Connecting-Ip` header the
  > Cloudflare edge injects. Behind any other ingress you MUST either
  > inject that header at the proxy or set `MEMRAIN_ASSUME_PUBLIC=1` in the
  > container env — otherwise every request classifies as internal and
  > `/mcp` is served **without auth**. After any ingress change, verify:
  > an unauthenticated `POST /mcp` must return 401.
  >
  > If that proxy forwards the client IP only as `X-Forwarded-For` /
  > `X-Real-IP`, also set `MEMRAIN_HTTP_TRUST_PROXY=1`. Without it those headers
  > are ignored (they are caller-spoofable), so every public caller shares one
  > rate-limit bucket and the brute-force throttle on bearer verification is
  > skipped entirely. Set it **only** when the proxy overwrites the header it
  > forwards; a proxy that appends a client-supplied value lets callers mint a
  > fresh bucket per request.
- An **S3 bucket** for terraform state (any region; you'll name it during init).

---

## 2. Clone and initialize

```bash
git clone https://github.com/<your-github-username>/memrain.git
cd memrain
scripts/init.sh
```

`scripts/init.sh` is interactive. It prompts for your AWS account id, region,
profile, project name (default `memrain`; it drives AWS resource names and the
host path `/opt/<project>`), **domain**, subdomain (default `brain`), GitHub
owner/repo, secrets prefix (default `memrain`), the tfstate bucket + region +
key (default `<project>/terraform.tfstate`), optional alarm email / SSH CIDR,
whether to clone over an SSH deploy key (default `false`, for a public repo),
and a **feature tier** (default **Max quality** — the full paid Sonnet brain;
the installer opts you into the recommended tier). It then writes three
**gitignored** files atomically:

- `.env` — runtime config for compose + scripts (`PUBLIC_HOST` becomes
  `<subdomain>.<domain>`, `MEMRAIN_PUBLIC_WRITE=0`, plus the chosen tier's
  feature flags). The tier default is **Max**; pick `balanced` or `free` at the
  prompt, or set `MEMRAIN_INIT_TIER=free|balanced|max` for the non-interactive
  path. These flags only take effect once you recompose — a bare `git clone`
  (whose runtime code defaults stay OFF) never bills. See
  [CONFIGURATION.md](CONFIGURATION.md#quality--cost-tiers-pick-one).
  This `.env` stays on your machine: the host's `/opt/<project>/.env` is
  rendered by bootstrap without any tier flags, so the deployed brain runs
  with the code defaults until you copy the tier block into the host's `.env`
  and run `sudo bash deploy/deploy.sh` there (step 10; on a brain with no pages
  yet add `DEPLOY_ALLOW_EMPTY=1`).
- `terraform/terraform.tfvars` — terraform inputs.
- `terraform/backend.hcl` — the S3 partial-backend config.

Before `plan`, check two things init.sh does not write into
`terraform.tfvars`:

- **Region.** Only `aws_region` is written. `availability_zone` (default
  `eu-west-1b`) and `multi_az_subnet_cidrs` (default `eu-west-1a` /
  `eu-west-1c`) keep their defaults, so for any other region set both in
  `terraform.tfvars` to AZs of that region, or `apply` fails on the subnets.
  Pick an EU region: the IAM policy and the default Claude model ids use the
  `eu.*` cross-region inference profiles.
- **SSH.** Setting the SSH CIDR only opens port 22; no key pair exists unless
  you also set `ssh_public_key` in `terraform.tfvars` by hand. Without it, use
  SSM.

Run `make audit` afterward to confirm no identifier leaked into a tracked file.

---

## 3. Provision infrastructure (terraform)

```bash
terraform -chdir=terraform init -backend-config=backend.hcl
terraform -chdir=terraform plan       # review every resource before applying
terraform -chdir=terraform apply
```

This creates the VPC, the EC2 instance (Graviton `t4g.medium` by default), the
EFS filesystem, the RDS Postgres 16 instance (`db.t4g.micro`, private,
encrypted, deletion-protected), the Secrets Manager secrets, IAM roles scoped to
Bedrock + Secrets Manager, and (by default) CloudTrail.

The instance boots and runs its first-boot bootstrap (step 6) while `apply` is
still running, so anything bootstrap reads must exist before `apply` or be
followed by the refresh steps below. The instance id and a ready SSM command
come from the outputs:

```bash
terraform -chdir=terraform output -raw instance_id
terraform -chdir=terraform output -raw ssm_command
```

The RDS instance has `deletion_protection = true` and takes a final snapshot —
`terraform destroy` will not silently drop your index.

### Deletion protection

Terraform sets `lifecycle { prevent_destroy = true }` on every resource that
holds data or that clients depend on:

- the RDS instance (`aws_db_instance`) and its subnet group (`aws_db_subnet_group`),
- the EFS file system (`aws_efs_file_system`),
- the EC2 instance (`aws_instance`) and its Elastic IP (`aws_eip`, a caddy
  install's DNS points at it),
- every Secrets Manager secret (`aws_secretsmanager_secret`; they are created
  with `recovery_window_in_days = 0`, so a destroy would delete at once),
- the scripts and CloudTrail buckets (`aws_s3_bucket`).

A plan that would destroy or replace one of them **errors before apply**. That
is the intent: a renamed variable or a changed default must never delete the
database, the file system or a secret. When a plan fails this way, pin the
name that changed (UPGRADING step 0) instead of removing the guard.

`prevent_destroy` does not cover in-place updates. The RDS identifier is one:
an unpinned `rds_identifier` (or a changed `project_name`/`app_slug` behind it)
renames the instance in place, with no destroy for the guard to catch. The
endpoint changes, while the stored Postgres URL secret keeps the old host, so
the app loses its database. Read every plan before applying it; UPGRADING
step 0 lists the only changes an upgrade plan may show.

A deliberate teardown (`terraform destroy`, `make destroy`) needs a local edit
that is never committed:

1. Take a final backup first: an RDS snapshot, a copy of the EFS data
   directory, and a copy of every secret value you cannot regenerate.
2. Remove the `prevent_destroy` lines from the resources you are tearing down.
3. Set `deletion_protection = false` on the RDS instance and apply that change.
4. Run the destroy, then discard the local edit.

---

## 4. Fill the one empty secret

Terraform creates most secrets fully populated:

- `<prefix>/memrain-postgres-url` — **auto-filled** from the RDS instance
  (username, generated password, endpoint, port, db). No action needed.
- `<prefix>/memrain-public-bearer` — **auto-generated** 48-char token.
- `<prefix>/memrain-internal-token` — **auto-generated** 48-char token.

In the default install exactly one secret is created as an **empty
placeholder** you must fill by hand:

- `<prefix>/cloudflared-tunnel-token` — empty until you create the tunnel
  (step 5). The host has already booted by then, so step 5 ends with a secrets
  refetch on the host. Until that runs, the `cloudflared` container loops
  forever trying to authenticate and the public ingress never comes up.

With `use_ssh_deploy_key = true` terraform creates a second empty placeholder,
`<prefix>/github-deploy-key`. First boot needs it to clone the repo, and that
boot runs during `apply`: fill it with `put-secret-value` as soon as `apply`
has created it, or re-run bootstrap afterwards (step 6).

Read the auto-generated bearer (you'll need it for the MCP client in step 8):

```bash
aws secretsmanager get-secret-value \
  --secret-id <prefix>/memrain-public-bearer \
  --profile <your-profile> --region <your-region> \
  --query SecretString --output text
```

---

## 5. Create the Cloudflare Tunnel

1. In the Cloudflare **Zero Trust** dashboard → **Networks → Tunnels**, create a
   tunnel (connector type: *Cloudflared*).
2. Add a **public hostname** route: `<subdomain>.example.com` →
   `http://memrain:18790` (the container name + internal port; cloudflared shares
   the compose network with Memrain).
3. Copy the tunnel **token** and store it in the placeholder secret:

   ```bash
   aws secretsmanager put-secret-value \
     --secret-id <prefix>/cloudflared-tunnel-token \
     --secret-string '<tunnel-token>' \
     --profile <your-profile> --region <your-region>
   ```

4. The host booted during step 3 with an empty token. In an SSM session on the
   host, refetch the secrets and recreate `cloudflared` (a plain `restart`
   keeps the old, empty env):

   ```bash
   cd /opt/<project>
   sudo bash deploy/secrets/fetch-secrets.sh
   sudo docker compose --env-file .env up -d cloudflared
   ```

The tunnel runs with `--protocol http2` (see `deploy/docker-compose.yml`) so it
works even when the security group only allows TCP egress on 7844.

### Alternative: Caddy ingress (no Cloudflare)

If the domain's DNS cannot live in Cloudflare (a common case: the zone
already serves production email from Route53 and its nameservers must not
move), set `ingress_mode = "caddy"` in `terraform.tfvars` and skip this
step entirely. Then:

- terraform opens inbound 80/443 (tcp + udp for HTTP/3) on the instance SG
  and — with `caddy_manage_dns = true` (default) — points
  `<subdomain>.<domain>` at the instance EIP in the domain's Route53 zone
  (the public hosted zone must already exist in the account);
- bootstrap runs **Caddy** as a hardened compose override
  (`/etc/<project>/compose.caddy.yml`): automatic Let's Encrypt issuance
  and renewal, certificate state on EFS (survives instance replacement),
  the `cloudflared` service parked behind an unused compose profile;
- the container gets `MEMRAIN_ASSUME_PUBLIC=1`, so bearer auth is enforced
  for **every** request — do not remove it; without it a request that
  reaches Memrain without the `Cf-Connecting-Ip` header would be treated as
  internal and served without auth;
- bootstrap ends with an auth smoke test: an unauthenticated `POST /mcp`
  must return 401. Repeat that check after any ingress change;
- bootstrap records the resolved compose file set as `COMPOSE_FILE` in
  `/opt/<project>/.env`. Run compose from that directory **without** a
  hand-passed `-f` — an explicit `-f` overrides `COMPOSE_FILE` and drops the
  overlay, which makes `docker compose ... --remove-orphans` delete the only
  ingress container and lets a bare `up -d` start the parked `cloudflared`
  with an empty token. `deploy/deploy.sh` reads the same variable.

In this mode terraform creates no cloudflared tunnel-token secret at all
(`aws_secretsmanager_secret.cloudflared_tunnel_token` is `count`-gated on
`ingress_mode`). Upgrading an existing caddy install that already has the
empty placeholder will plan a destroy of it — expected. If that secret was
previously deleted by hand it sits in scheduled-deletion limbo and AWS
rejects the destroy; run `aws secretsmanager restore-secret --secret-id
<prefix>/cloudflared-tunnel-token` first, then apply.

### Admin surface and OAuth consent

Create `<prefix>/memrain-admin-bootstrap` with a 32+ character value from
`[A-Za-z0-9_-]` (`openssl rand -hex 32`). Terraform does not
create this secret; do it by hand, ideally **before** `terraform apply`:

```bash
aws secretsmanager create-secret \
  --name <prefix>/memrain-admin-bootstrap \
  --secret-string "$(openssl rand -hex 32)" \
  --profile <your-profile> --region <your-region>
```

Bootstrap reads it and writes both `MEMRAIN_ADMIN_BOOTSTRAP` and
`MEMRAIN_OAUTH_REQUIRE_LOGIN=1` into `.env`, which gates `/authorize` on an
operator being signed in. Bootstrap only reads it on a run, so a secret created
after first boot has no effect until you re-run bootstrap (step 6) and then
`sudo bash deploy/deploy.sh` from `/opt/<project>` (on a brain with no pages
yet: `sudo DEPLOY_ALLOW_EMPTY=1 bash deploy/deploy.sh`, see step 10). Leave the secret empty and
the server mints a fresh token every restart and auto-approves every consent
request instead — on a caddy install that consent screen is directly on the
public internet.

**If anyone but the operator will connect, that flag has to come off.**
The bootstrap token and the panel owner's passkeys (below) are the only admin
credentials; there is no per-user login, so with the gate on a teammate can only finish
a connector flow by holding an operator session for the whole brain. Use an
enrollment-mode client instead: the one-time code IS the resource-owner
authentication, the gate is not consulted for it, and each person is pinned to
her own source. See "Connecting a whole team through ONE connector" in
[CONFIGURATION.md](./CONFIGURATION.md). Keep the flag on only for a brain that
serves one operator and nobody else.

### Passkey sign-in for the panel owner

The person who runs the panel (on a hosted install, the client's admin) signs
in with a passkey: Touch ID, Face ID, Windows Hello or a hardware key. No
password and no email are involved, and the bootstrap token stays the
operator's emergency way in.

Passkeys need `MEMRAIN_PUBLIC_URL` set to the `https://` address people open
the panel on; the passkey is bound to that hostname. Without it the panel shows
the bootstrap login only and `serve` logs why at boot.

Give the owner a one-time setup link:

```bash
# on the host, inside the app container (or wherever the CLI reaches the DB)
memrain admin setup-link            # valid 24 h
memrain admin setup-link --ttl 72   # up to 72 h
```

Or, with the bootstrap token, from anywhere:

```bash
curl -X POST -H "Authorization: Bearer $MEMRAIN_ADMIN_BOOTSTRAP" \
  https://<host>/admin/api/setup-links
```

On a PGLite install the CLI cannot open the database while the server runs;
use the API call. Send the link over a channel only the owner reads. It works
once; minting a new link revokes every unused one.

Opening the link creates the passkey and shows ten recovery codes once. Each
code works once and lets the owner register a new passkey after losing every
device; keep them offline.

A passkey created from a recovery code, or from a setup link while another
passkey already exists, starts in a 24-hour cooldown: it can use the panel but cannot
mint API keys, register or change OAuth clients, approve connector requests,
rename or revoke passkeys, replace recovery codes, mint links or sign everyone out.
That limits what a stolen link or code can do before the owner notices the
"new passkey" warning, which only an older passkey or the operator can dismiss.
The owner's first passkey created from a setup link has no cooldown, so a new
client can connect agents right away. That also holds after every passkey has
been revoked: whoever opens the next live setup link becomes the owner with no
cooldown, so mint links only when you mean to hand them over. If a link or code may have leaked: sign in with the
bootstrap token, revoke the unknown passkey on the Security page, mint a new
link and replace the recovery codes.

A setup link or recovery code can be reserved at most five times. A redeem
holds it for one browser for 15 minutes; retrying in that browser within those
15 minutes is free and does not extend them, but a redeem after they lapse, or
from another browser, counts. The fifth reservation raises a notice on the
Security page; after that the link or code is refused. Mint a new link if that
happens. Sign-out-everywhere releases every reserved recovery code.

Operator sessions (bootstrap token or magic link) can do sensitive actions,
such as minting a setup link or revoking a passkey, for 10 minutes once a
passkey exists. After that, step up with a passkey or sign in again with the
bootstrap token.

### Scheduled units

`deploy/systemd/` ships the nightly retrieval-quality probe and the daily
bearer rotation. Bootstrap does **not** install them; do it deliberately:

```bash
cd /opt/memrain
sudo install -m 644 deploy/systemd/*.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now memrain-eval-probe.timer
```

Both read `AWS_REGION` from `/opt/memrain/.env`. The units hardcode
`/opt/memrain` and the `deploy-memrain-1` container, so they assume
`project_name = "memrain"`; edit the paths first for any other name. Enable
`memrain-rotate-bearer.timer` only once you know what consumes the public
bearer — rotation breaks any client holding the old value.

---

## 6. First boot

The EC2 `user_data` runs `scripts/bootstrap.sh` once, on first boot
(cloud-init runs user_data once per instance; after a reboot the stack comes
back through docker's restart policies, and `.env` and secrets are not
refreshed). On that boot it:

- installs Docker + the pinned Docker Compose v2 plugin (sha256-verified),
- mounts EFS and seeds the canonical data dirs,
- HTTPS-clones the repo into `/opt/memrain` (SSH only when
  `use_ssh_deploy_key = true`),
- renders `/opt/memrain/.env` from the terraform env contract,
- runs `deploy/secrets/fetch-secrets.sh` to pull secrets into
  `deploy/.secrets/`,
- `docker compose … up -d --build`.

Memrain runs its DB migrations at container start — no manual migrate step. The
tunnel token is filled after this boot, so the ingress comes up only after the
refetch at the end of step 5.

Connect to the host with SSM (no SSH needed; `terraform output -raw
ssm_command` prints this with the instance id filled in):

```bash
aws ssm start-session --target <instance-id> \
  --profile <your-profile> --region <your-region>
```

The SSM session runs as `ssm-user`, and the repo, `.env` and `deploy/.secrets/`
are root-owned, so host commands need `sudo`. Bootstrap is idempotent; to re-run
it (after creating a secret it reads, or to re-render `.env`):

```bash
aws s3 cp s3://<scripts-bucket>/scripts/bootstrap.sh /tmp/b.sh && sudo bash /tmp/b.sh
```

A re-run rewrites `/opt/<project>/.env` from scratch, so any line you added to
it by hand (tier flags, other feature flags) is lost and has to be added again.

---

### Self-issued auth after a config reset

The first boot runs `memrain init --postgres` on an empty config volume and
writes `memrain.yml` with `auth.selfIssued.enabled: true`. The database keeps
its OAuth clients and personal access tokens across a volume reset, so
recreating or wiping the config volume turns every client and token that is
still valid in the database back on. Revoked and expired ones stay dead.
Before resetting the volume, list what is live with `memrain auth
list-clients` and `memrain auth list`, and revoke anything you no longer want.

## 7. Index your first content

The container mounts your content read-only at `/memory`
(`MEMRAIN_VAULT_PATHS`) and the code checkout at `/repo-source`
(`MEMRAIN_CODE_PATHS`). Content written through MCP (`page_put`, `add_fact`, …)
is indexed immediately. Markdown *files* dropped into the EFS
`workspace/memory` tree are indexed with one directory-level command (there is
no `memrain` alias inside the container — go through the CLI entry point):

```bash
sudo docker exec deploy-memrain-1 bun run src/cli.ts reindex --source vault --vault /memory
```

It is incremental (unchanged files are skipped); add `--all` to force a full
pass and `--reconcile-deletes` to drop pages whose files were removed. Code
roots (`MEMRAIN_CODE_PATHS`) are swept at serve boot; `reindex --source code`
re-sweeps them after a `git pull`.

To rebuild the code graph (definitions, references, callers, callees) in
place, force a full code pass:

```bash
sudo docker exec deploy-memrain-1 bun run src/cli.ts reindex --source code --all
```

It is graph-only (tree-sitter, no Bedrock calls, no spend). Run it once after
upgrading past the release that stopped the entity re-extract from deleting
code symbol mentions, or whenever an empty `code_def` reports readiness
`no_symbols` while code documents exist.

The 6-hour maintenance cycle maintains the existing corpus (re-embeds stale
documents, housekeeping) — it does **not** ingest new files on its own in
the DB-canonical design. If search misses content you expect, check the
embed backlog on the host: `sudo docker exec deploy-memrain-1 bun run src/cli.ts embed --dry-run`.

---

## 8. Hook up an MCP client (Claude Code)

Add the server to `~/.claude.json` (global) or a project `.claude.json`:

```jsonc
{
  "mcpServers": {
    "memrain": {
      "type": "http",
      "url": "https://<subdomain>.example.com/mcp",
      "headers": {
        "Authorization": "Bearer <token-from-step-4>"
      }
    }
  }
}
```

Or via the CLI:

```bash
claude mcp add --transport http memrain https://<subdomain>.example.com/mcp \
  --header "Authorization: Bearer <token-from-step-4>"
```

Restart Claude Code. The read tools appear under `memrain.*` (`search`,
`backlinks`, `page_{get,list,versions}`, `graph_{neighbors,query}`,
`traverse_graph`, `entity_{facts,timeline,recall}`, `source_health`,
`whoami`). Write tools are filtered from the public surface unless
`MEMRAIN_PUBLIC_WRITE=1`. The static public bearer is also denied `query`,
`think`, every `code_*` tool, `volunteer_context`, the `find_*` analytics, the
takes/calibration tools, `recall`, `get_chunks`, `get_tags`,
`relational_recall`, `stats`, the `jobs_*` tools and more
(`FORBIDDEN_MCP_TOOLS_FROM_PUBLIC` in `http/public_guard.ts`); use a personal
access token (`memrain auth create <name>`) or an OAuth client for those. The
bearer is static unless you install the optional `memrain-rotate-bearer` timer
(section 5).

---

## 9. Verify

```bash
# Health — expect {"ok":true,...}
curl -s https://<subdomain>.example.com/health

# One search through the public MCP
curl -s https://<subdomain>.example.com/mcp \
  -H "Authorization: Bearer <token-from-step-4>" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"search","arguments":{"q":"hello","k":3}}}'
```

On the host you can also check container health directly:

```bash
sudo docker inspect deploy-memrain-1 --format '{{.State.Health.Status}}' # healthy
```

---

## 10. Updates

Deploy is via SSM to the live host, not platform CI. In an SSM session on the
instance:

```bash
cd /opt/memrain
sudo git pull --ff-only
sudo bash deploy/deploy.sh # stamps the image with git describe, waits for healthy
sudo docker inspect deploy-memrain-1 --format '{{.State.Health.Status}}'
sudo docker exec deploy-memrain-1 wget -qO- http://localhost:18790/health    # {"ok":true,...,"version":"<new stamp>"}
```

Check that `version` in `/health` matches the stamp `deploy.sh` just built.

`deploy.sh` refuses a brain with 0 pages: it stops `memrain` and leaves the
ingress down. On a fresh install that has indexed nothing yet, run
`sudo DEPLOY_ALLOW_EMPTY=1 bash deploy/deploy.sh`. The other knobs, all shell
env: `DEPLOY_MIN_PAGES` (page floor), `DEPLOY_ALLOW_PGLITE=1` (accept a PGLite
database), `DEPLOY_ALLOW_INGRESS_IN_MAINTENANCE=1` (rehearsal only) and
`DEPLOY_STATUS_TIMEOUT` (seconds per status read, default 60).

The container's memory cap is `MEMRAIN_MEM_LIMIT` in the host `.env` (compose
`mem_limit`, default `3000m`); compose reads it, the app does not. Size it to
the instance.

Then check the brain from outside, the way a client reaches it. From a checkout
on your own machine, with a token in a private file (the command refuses a file
that group or others can read, a symlink, or a secret passed on the command
line):

```bash
mkdir -p ~/.config/memrain && umask 077; printf '{"token":"%s"}' "$PAT" > ~/.config/memrain/doctor-token.json
cd deploy/memrain
bun run src/cli.ts auth doctor https://brain.example.com \
  --token-file ~/.config/memrain/doctor-token.json \
  --expect-operator --expect-version "$(git describe --tags)"
```

The remote doctor checks `/health` and its build stamp, both OAuth discovery
documents, a `client_credentials` mint (with `--client-file` holding
`{client_id, client_secret}`; a token file skips it), MCP `initialize` (its
`serverInfo.version` must equal the `/health` stamp, which catches a stale
container still answering), `tools/list`, `whoami`, and the caller's scope
(`--expect-source ID` for a tenant client; `--expect-operator` for the
operator's PAT, which passes only when `whoami` reports `is_public: false` and
a read scope that covers the `default` source — the static public bearer
fails it). Redirects are never followed: any 3xx fails the check and names
where it pointed, so neither the client secret nor the bearer is re-sent. It exits 0 when every check passes, 1 on any failure and 2
on a usage error; `--json` prints the full report.

For
a service other than `memrain`: `sudo docker compose --env-file .env up -d --build
<service>` (no `-f`: it would override the `COMPOSE_FILE` line in `.env` and
drop the Caddy overlay).

Rebuild only the service(s) that changed. Infrastructure changes go through
`terraform plan` / `apply` against the S3 state — never mutate a
terraform-managed resource with ad-hoc CLI/console calls.

To enable optional features (synthesis, paid Sonnet slices, tenancy flags,
retrieval tuning), see [CONFIGURATION.md](./CONFIGURATION.md) — remember a flag
must be in **both** `.env` and the compose `environment:` allowlist to take
effect. A bootstrap re-run rewrites the host's `.env` and drops hand-added
flags; keep a copy of them and add them back after every re-run.
