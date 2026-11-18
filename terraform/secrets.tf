# All secrets are created as empty placeholders.
# Fill them in AWS Console or CLI after deployment — never in Terraform state.
# Naming pattern: ${var.secrets_prefix}/<name>. Override secrets_prefix in
# terraform.tfvars to namespace per-environment (e.g. "stack-staging").
#
# recovery_window_in_days = 0 deletes a secret at once, so every secret is
# prevent_destroy: a rename that would replace one fails at plan instead.

# Only the Cloudflare Tunnel ingress needs a tunnel token. An
# ingress_mode="caddy" install has no tunnel, and a placeholder secret that
# nothing reads is an invitation to delete it by hand — which is exactly what
# happened on one install, leaving live and state disagreeing.
#
# Upgrade note: the `moved` block below re-addresses the existing (un-counted)
# resource so a cloudflare install plans a no-op state move, not a
# destroy+create of a live token. The secret is prevent_destroy, so a caddy
# install that still holds the placeholder in state (or any install switching
# ingress_mode away from cloudflare) fails at plan instead of deleting it.
# To retire it, drop it from state first — the secret itself stays in AWS:
#   terraform state rm 'aws_secretsmanager_secret.cloudflared_tunnel_token[0]'
# then delete it by hand only if nothing reads it. The same applies to the
# deploy-key secret below when use_ssh_deploy_key goes back to false.
resource "aws_secretsmanager_secret" "cloudflared_tunnel_token" {
  count = var.ingress_mode == "cloudflare" ? 1 : 0

  name                    = local.tunnel_token_secret_name
  description             = "Cloudflare Tunnel token for the MCP brain subdomain (brain.<domain>/mcp)"
  recovery_window_in_days = 0

  lifecycle {
    prevent_destroy = true
    ignore_changes  = [description]
  }
}

moved {
  from = aws_secretsmanager_secret.cloudflared_tunnel_token
  to   = aws_secretsmanager_secret.cloudflared_tunnel_token[0]
}

# Conditional — only when the stack uses the SSH deploy-key flow for a
# private repo. The default install leaves use_ssh_deploy_key=false and
# HTTPS-clones a public repo without auth.
resource "aws_secretsmanager_secret" "github_deploy_key" {
  count = var.use_ssh_deploy_key ? 1 : 0

  name                    = local.deploy_key_secret_name
  description             = "SSH private key (passphrase-less) the EC2 uses to git clone a private repo"
  recovery_window_in_days = 0

  lifecycle {
    prevent_destroy = true
    ignore_changes  = [description]
  }
}

# Bearer token for the public Cloudflare Tunnel ingress to Memrain
# (brain.<domain>). Read-side only — /index and /friction are blocked
# from public regardless of bearer; mutating MCP tools are filtered
# server-side. Generated as a random 48-char string at apply time and
# stored as the secret value in one shot.
resource "random_password" "memrain_public_bearer" {
  length  = 48
  special = false # URL-safe; carried in Authorization header

  lifecycle {
    # Daily rotation is owned by scripts/rotate-memrain-public-bearer.sh
    # via put-secret-value. Terraform must NOT regenerate-on-apply or it
    # clobbers whatever the rotation timer last wrote.
    ignore_changes = [length, special]
  }
}

resource "aws_secretsmanager_secret" "memrain_public_bearer" {
  name                    = local.public_bearer_secret_name
  description             = "Bearer token for the public Cloudflare Tunnel ingress (read-only routes)"
  recovery_window_in_days = 0

  lifecycle {
    prevent_destroy = true
    ignore_changes  = [description]
  }
}

resource "aws_secretsmanager_secret_version" "memrain_public_bearer" {
  secret_id     = aws_secretsmanager_secret.memrain_public_bearer.id
  secret_string = random_password.memrain_public_bearer.result

  lifecycle {
    # Daily rotation owns secret_string after first apply; never let
    # terraform drag the value back to the random_password seed or move
    # AWSCURRENT.
    ignore_changes = [secret_string, version_stages]
  }
}

# memrain-internal-token — shared secret authenticating any future peer
# container on the internal docker bridge to Memrain's MCP write tools.
# Without it, a compromised sibling container could write to the index
# with no auth — the gate keys on `Cf-Connecting-Ip` presence only,
# which is exactly the header those peers never send. See
# `deploy/memrain/src/http/public_guard.ts:evaluateInternalAuth`.
resource "random_password" "memrain_internal_token" {
  length  = 48
  special = false

  lifecycle {
    ignore_changes = [length, special]
  }
}

resource "aws_secretsmanager_secret" "memrain_internal_token" {
  name                    = local.internal_token_secret_name
  description             = "Shared bearer authenticating peer containers to the internal mutating routes"
  recovery_window_in_days = 0

  lifecycle {
    prevent_destroy = true
    ignore_changes  = [description]
  }
}

resource "aws_secretsmanager_secret_version" "memrain_internal_token" {
  secret_id     = aws_secretsmanager_secret.memrain_internal_token.id
  secret_string = random_password.memrain_internal_token.result

  lifecycle {
    ignore_changes = [secret_string, version_stages]
  }
}

# Connector key (KEK) and notification-webhook HMAC secret. Both are opt-in
# empty placeholders: terraform creates the secret, the operator puts the value
# in with `aws secretsmanager put-secret-value` (docs/connectors/KEY.md). No
# secret version and no random_password here: the KEK opens every connector
# token stored in the database, so it must not also live in terraform state.
# fetch-secrets.sh treats "no version yet" as not provisioned.
resource "aws_secretsmanager_secret" "connector_kek" {
  count = var.enable_connector_kek_secret ? 1 : 0

  name                    = local.connector_kek_secret_name
  description             = "Connector key (base64 of 32 random bytes) sealing connector OAuth tokens and client secrets"
  recovery_window_in_days = 0

  lifecycle {
    prevent_destroy = true
    ignore_changes  = [description]
  }
}

resource "aws_secretsmanager_secret" "notify_webhook" {
  count = var.enable_notify_webhook_secret ? 1 : 0

  name                    = local.notify_webhook_secret_name
  description             = "HMAC key signing outgoing notification webhooks"
  recovery_window_in_days = 0

  lifecycle {
    prevent_destroy = true
    ignore_changes  = [description]
  }
}

# ---- Hosting stack (docs/HOSTING.md) -----------------------------------------
# Empty containers only. `memrain tenant create` puts the values in with
# put-secret-value, and the host stages them with
# `deploy/secrets/fetch-secrets.sh --tenant <id>` / `--control`. A tenant
# container never reads Secrets Manager. Not prevent_destroy: deleting a
# tenant removes its secrets, after the 7-day recovery window.

resource "aws_secretsmanager_secret" "hosting_control_admin_url" {
  count = var.enable_hosting ? 1 : 0

  name                    = "${var.secrets_prefix}/hosting/control-admin-url"
  description             = "Control database URL under the master role (hosting tenant-ctl only)"
  recovery_window_in_days = 7

  lifecycle {
    ignore_changes = [description]
  }
}

resource "aws_secretsmanager_secret" "hosting_tenant" {
  for_each = local.hosting_tenant_secrets

  name                    = "${var.secrets_prefix}/tenants/${each.key}"
  description             = "Hosting tenant ${each.value.tenant}: ${each.value.kind}"
  recovery_window_in_days = 7

  lifecycle {
    ignore_changes = [description]
  }
}
