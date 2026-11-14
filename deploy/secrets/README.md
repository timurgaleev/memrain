# deploy/secrets — credential plumbing

This directory holds **the script that fetches secrets at boot**. It
does NOT hold any secrets in tracked content.

## Files

- `fetch-secrets.sh` — runs at container-host boot via
  `scripts/bootstrap.sh`. Reads each `<secrets_prefix>/*` AWS Secrets
  Manager secret and writes it to `deploy/.secrets/` (gitignored) so
  containers can `env_file` or bind-mount the directory.

## Output layout (gitignored, EC2-only)

```
deploy/.secrets/                # dir mode 0711 (non-root descend-only)
├── cloudflared.env           TUNNEL_TOKEN=... + CLOUDFLARE_TUNNEL_TOKEN=...0400
└── memrain.env               MEMRAIN_POSTGRES_URL=... + MEMRAIN_PUBLIC_BEARER + connector key + config  0400
```

`cloudflared.env` and `memrain.env` are consumed via `env_file`. Memrain
reads `MEMRAIN_PUBLIC_BEARER` from `memrain.env` to validate incoming public
`/mcp` bearers. The directory is `0711` so a non-root container UID can
descend into it without the host exposing the full file list.

Re-fetched on every `bootstrap.sh` run; existing files are overwritten.

## Secrets in AWS Secrets Manager

The default prefix is `<var.secrets_prefix>` (configured in
`terraform.tfvars`; default `memrain`).

In 1.0.x a stack created before the rename keeps its secret names:
`fetch-secrets.sh` tries `<prefix>/memrain-<name>` first and falls back to
`<prefix>/memex-<name>` when the new name is missing or empty. When both hold a
value the values must match, or the fetch exits 1 and changes nothing. A `.env`
without `SECRETS_PREFIX` means the prefix `memex`. The optional `*_SECRET_NAME` keys in `.env` name a secret exactly
(docs/CONFIGURATION.md, "Secret names").

| Name | Format | Used by |
|---|---|---|
| `<prefix>/cloudflared-tunnel-token` | string | cloudflared |
| `<prefix>/memrain-postgres-url` | string (URL) | Memrain |
| `<prefix>/memrain-public-bearer` | string | Memrain — validates public `/mcp` bearers |
| `<prefix>/github-deploy-key` | OpenSSH private key | `bootstrap.sh` `git clone` (SSH deploy-key mode only) |
| `<prefix>/memrain-connector-kek` | base64 of 32 random bytes | Memrain — `MEMRAIN_CONNECTOR_KEK`, seals connector tokens (optional; [docs/connectors/KEY.md](../../docs/connectors/KEY.md)) |
| `<prefix>/memrain-notify-webhook` | string, 32+ characters | Memrain — `MEMRAIN_NOTIFY_WEBHOOK_SECRET`, signs notification webhooks (optional) |

Terraform creates the last two only when `enable_connector_kek_secret` /
`enable_notify_webhook_secret` is true, and creates them empty: you put the
value in with `aws secretsmanager put-secret-value`, so it never sits in
terraform state. Until then `fetch-secrets.sh` reports them as not provisioned
and writes no line for them.

When `use_ssh_deploy_key = true`, the deploy key lets the EC2 clone a
private repo over SSH. It's `chmod 600` after fetch and used via
`GIT_SSH_COMMAND="ssh -i $key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"`.
Public-template installs skip this entirely.

## Adding a new secret

1. Create the secret in AWS:
   ```bash
   aws secretsmanager create-secret \
     --name <secrets_prefix>/<name> \
     --secret-string '<value>' \
     --profile <your-profile> --region <your-region>
   ```
2. Add the corresponding `fetch_text` (or specialised) line in
   `fetch-secrets.sh`.
3. Wire the file into the container that consumes it via
   `docker-compose.yml` (`volumes:` for files, `env_file:` for `.env`).
4. Commit + push.
5. SSM into EC2; `git pull && bash deploy/secrets/fetch-secrets.sh
   && docker compose up -d --build <service>`.

Never commit anything from `deploy/.secrets/` itself.
