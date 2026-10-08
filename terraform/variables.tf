variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "eu-west-1"
}

variable "aws_profile" {
  description = "AWS CLI profile name (matches the [profile-name] entry in ~/.aws/config)"
  type        = string
  default     = "default"
}

variable "tfstate_region" {
  description = "AWS region of the S3 bucket holding terraform state. Often differs from aws_region — terraform.tfstate has its own bucket policy."
  type        = string
  default     = "eu-central-1"
}

variable "domain" {
  description = "Public root domain (e.g. example.com). Used by Cloudflare Tunnel and OAuth flows."
  type        = string
  default     = ""
}

variable "subdomain" {
  description = "Subdomain serving the public MCP (e.g. 'brain' for brain.example.com)."
  type        = string
  default     = "brain"
}

variable "memex_subdomain" {
  description = "DEPRECATED: use `subdomain`. When set, it still wins over `subdomain`."
  type        = string
  default     = null
}

variable "github_owner" {
  description = "GitHub username/org that owns the public repo. Used to compose repo_url defaults and IAM annotations."
  type        = string
  default     = ""
}

variable "repo_name" {
  description = "Public repo name. Used for tagging, S3 keys, and tfstate path prefix."
  type        = string
  default     = "memrain"
}

variable "secrets_prefix" {
  description = <<-EOT
    AWS Secrets Manager prefix. Every secret created by this stack is named
    '<secrets_prefix>/<secret-name>'. Default 'memrain' aligns with the project
    name; override if you need a different namespace (e.g. per-environment).
  EOT
  type        = string
  default     = "memrain"
}

variable "use_ssh_deploy_key" {
  description = <<-EOT
    Set to true ONLY while migrating from a private SSH-clone deploy flow.
    When true, the stack provisions an aws_secretsmanager_secret for the
    GitHub deploy key and opens SSH egress (port 22) to github.com on the
    EC2 security group.

    For new public-template installs, leave at the default (false). Bootstrap
    falls back to HTTPS clone, which works without auth for public repos.

    The deploy-key secret is prevent_destroy: flipping this back to false
    fails at plan until the secret is dropped from state with
    `terraform state rm 'aws_secretsmanager_secret.github_deploy_key[0]'`.
  EOT
  type        = bool
  default     = false
}

variable "ssh_public_key" {
  description = <<-EOT
    Public key (ssh-rsa / ssh-ed25519) to register as the EC2 key pair.
    Empty string (default) skips key-pair creation entirely — SSM Session
    Manager replaces SSH for personal-deploy use cases.
  EOT
  type        = string
  default     = ""
}

variable "project_name" {
  description = "Project name used for AWS resource naming + on-host paths (/mnt/<project>-efs/<project>, /opt/<project>). Defaults to memrain; override if your install needs a different prefix. Changing it on an existing stack renames ~20 ForceNew resources; pin every name first (UPGRADING step 0)."
  type        = string
  default     = "memrain"
}

variable "instance_type" {
  description = <<-EOT
    EC2 instance type. Default is t4g.medium (Graviton ARM64) — ~25% cheaper than t3.medium.
    Must be ARM64-compatible (t4g, m7g, c7g, r7g families).
    To stay on x86: set to t3.medium and update ami filter in main.tf back to x86_64.
  EOT
  type        = string
  default     = "t4g.medium"
}

variable "ebs_volume_size" {
  description = "Root EBS volume size in GB"
  type        = number
  default     = 20
}

variable "vpc_cidr" {
  description = "VPC CIDR block"
  type        = string
  default     = "10.0.0.0/16"
}

variable "public_subnet_cidr" {
  description = "Public subnet CIDR block for the primary AZ"
  type        = string
  default     = "10.0.1.0/24"
}

variable "availability_zone" {
  description = "Availability zone for the primary subnet"
  type        = string
  default     = "eu-west-1b"
}

variable "multi_az_subnet_cidrs" {
  description = "CIDR blocks for additional subnets used to satisfy RDS multi-AZ subnet group requirements."
  type        = map(string)
  default = {
    "eu-west-1a" = "10.0.2.0/24"
    "eu-west-1c" = "10.0.3.0/24"
  }
}

variable "bedrock_allowed_regions" {
  description = <<-EOT
    Regions where the EC2 instance role may invoke the EXPENSIVE Claude
    foundation models directly. The IAM Deny statement
    (BedrockDenyOffRegion) blocks `anthropic.claude-*` invocations
    outside this list. Nova is NOT governed by this list — it is exempt
    from the deny so `global.amazon.nova-*` can route worldwide (see
    iam.tf). Removing entries shrinks Claude's blast radius; adding
    entries widens it.
  EOT
  type        = list(string)
  # Full EU region family + us-east-1 — the regions where Claude may be
  # invoked directly. Still blocks us-west/ap/etc. for Claude. Nova is
  # exempt from the deny entirely (cheap + credit-eligible), so this list
  # no longer affects Nova routing.
  default = [
    "eu-west-1", "eu-west-2", "eu-west-3",
    "eu-central-1", "eu-central-2",
    "eu-north-1", "eu-south-1", "eu-south-2",
    "us-east-1",
  ]
}

variable "bedrock_model_id" {
  description = <<-EOT
    Amazon Bedrock CRIS inference profile ID surfaced in the `bedrock_model`
    terraform output. Informational: Memrain's utility tier is pinned in code
    (eu.anthropic.claude-haiku-4-5, with Titan Embed V2 for embeddings and
    eu.anthropic.claude-sonnet-4-6 behind the paid feature flags) — this
    variable does not change what the brain calls. Keep it in sync with the
    deployed reality so `terraform output bedrock_model` tells the truth.

    Default: Haiku 4.5 (EU profile) — what the brain actually uses.

    Switch via: terraform apply -var='bedrock_model_id=...'

    === Anthropic Claude — what Memrain runs on ===
      eu.anthropic.claude-haiku-4-5-20251001  — Haiku 4.5, utility tier (default; ~$2-3/mo)
      eu.anthropic.claude-sonnet-4-6          — Sonnet 4.6, paid slices (~$15-25/mo)
      eu.anthropic.claude-haiku-5-5           — Haiku 5.5, ~10x cheaper than Haiku 4.5
      eu.anthropic.claude-sonnet-5-5          — Sonnet 5.5

    === Amazon Nova — credit-eligible alternates ===
      global.amazon.nova-2-lite-v1:0   — Nova 2 Lite (multi-turn-safe)
      eu.amazon.nova-2-lite-v1:0       — Nova 2 Lite, EU cross-region profile (EU data residency)
      global.amazon.nova-2-pro-v1:0    — Nova 2 Pro (when available in the account)
      eu.amazon.nova-pro-v1:0          — Nova Pro v1 (rejects multi-turn replays with
                                         "User messages cannot contain reasoning content" —
                                         do not use as primary for multi-turn cron jobs)
  EOT
  type        = string
  default     = "eu.anthropic.claude-haiku-4-5-20251001"

  validation {
    condition = contains([
      "global.amazon.nova-2-lite-v1:0",
      "global.amazon.nova-2-pro-v1:0",
      "eu.amazon.nova-2-lite-v1:0",
      "eu.amazon.nova-pro-v1:0",
      "eu.anthropic.claude-haiku-4-5-20251001",
      "eu.anthropic.claude-sonnet-4-6",
      "eu.anthropic.claude-haiku-5-5",
      "eu.anthropic.claude-sonnet-5-5",
    ], var.bedrock_model_id)
    error_message = "Must be a valid Bedrock CRIS inference profile ID. See variable description for the full list."
  }
}

variable "efs_backup" {
  description = <<-EOT
    Enable AWS Backup's built-in daily EFS backups (35-day retention in the
    AWS-managed default vault). Cheap at this data size and the only recovery
    point the file system has — RDS backups cover the corpus, not the config,
    identity files, skillpack or ACME key. Set false only if an external
    backup already covers the mount.
  EOT
  type        = bool
  default     = true
}

variable "ingress_mode" {
  description = <<-EOT
    How the public MCP endpoint reaches the internet.

    cloudflare (default) — the stock Cloudflare Tunnel sidecar. No inbound
      ports; requires the domain's DNS to live in a Cloudflare account and
      the tunnel token secret to be filled (docs/DEPLOYMENT.md step 5).

    caddy — Caddy terminates TLS on the instance (Let's Encrypt), no
      Cloudflare dependency. Opens inbound 80/443 (tcp+udp) on the SG,
      points <subdomain>.<domain> at the instance EIP via Route53
      (see caddy_manage_dns), and bootstrap runs Caddy as a compose
      override with MEMRAIN_ASSUME_PUBLIC=1 so bearer auth is enforced for
      every request. Use this when the domain's DNS cannot move to
      Cloudflare (e.g. it carries production email on Route53).
  EOT
  type        = string
  default     = "cloudflare"

  validation {
    condition     = contains(["cloudflare", "caddy"], var.ingress_mode)
    error_message = "ingress_mode must be \"cloudflare\" or \"caddy\"."
  }
}

variable "caddy_manage_dns" {
  description = <<-EOT
    caddy ingress only: create the <subdomain>.<domain> A record in
    the domain's Route53 public hosted zone (which must already exist in
    this account). Set false if DNS lives elsewhere — then create the A
    record to the instance EIP yourself before first boot, or the ACME
    issuance will retry until it resolves.
  EOT
  type        = bool
  default     = true
}

variable "alarm_email" {
  description = <<-EOT
    Email address to notify when the EC2 instance fails a status check.
    Leave empty to skip email alerts (alarm still fires in CloudWatch).
    Example: terraform apply -var='alarm_email=you@example.com'
  EOT
  type        = string
  default     = ""
}

variable "ssh_allowed_cidr" {
  description = <<-EOT
    CIDR block allowed to SSH to the instance. Empty string (default) disables SSH inbound entirely.
    Use SSM Session Manager instead: aws ssm start-session --target <instance-id>
    To allow SSH from your IP: terraform apply -var='ssh_allowed_cidr=1.2.3.4/32'
  EOT
  type        = string
  default     = ""
}

variable "enable_vpc_endpoints" {
  description = <<-EOT
    Enable VPC Interface Endpoints for Bedrock, Secrets Manager, SSM, and CloudWatch Logs.
    Keeps AWS API traffic on the private AWS network instead of the public internet.
    Cost: ~$7/month per endpoint × 6 endpoints = ~$43/month extra. Off by default for personal use.
  EOT
  type        = bool
  default     = false
}

variable "enable_cloudtrail" {
  description = "Enable CloudTrail for API call auditing. Logs stored in S3 for 90 days. The log bucket is prevent_destroy: turning this off on an existing install fails at plan until the bucket is dropped from state (terraform state rm 'aws_s3_bucket.cloudtrail[0]')."
  type        = bool
  default     = true
}

variable "repo_url" {
  description = <<-EOT
    Git URL the EC2 user_data clones at first boot. For a public repo, use
    the HTTPS form (no auth needed). For a private repo, use the SSH form
    AND set use_ssh_deploy_key = true.

    HTTPS form:  https://github.com/<owner>/<repo>.git
    SSH   form:  git@github.com:<owner>/<repo>.git
  EOT
  type        = string
  default     = ""

  validation {
    condition     = var.repo_url == "" || can(regex("^(https://github\\.com/|git@github\\.com:)", var.repo_url))
    error_message = "repo_url must be empty (no clone), an https://github.com/... URL, or a git@github.com:... URL."
  }
}

variable "app_slug" {
  description = "Application slug in the RDS names (<project_name>-<app_slug>). Pin it on an existing stack before changing it: the RDS identifier, subnet group and parameter group derive from it."
  type        = string
  default     = "memrain"
}

variable "db_name" {
  description = "Name of the Postgres database created with the RDS instance. ForceNew in the provider, so terraform ignores changes to it once the instance exists; rename an existing database in SQL."
  type        = string
  default     = "memrain"
}

variable "db_username" {
  description = "RDS master user name. AWS cannot rename a master user, so terraform ignores changes to it once the instance exists."
  type        = string
  default     = "memrain"
}

variable "rds_apply_immediately" {
  description = "Apply RDS modifications immediately instead of in the next maintenance window. Set true only for the apply that needs it."
  type        = bool
  default     = false
}

variable "efs_creation_token" {
  description = "EFS creation token. null derives <project_name>-data. Immutable on an existing file system: pin the current value before changing project_name."
  type        = string
  default     = null
}

variable "secrets_read_prefixes" {
  description = "Secrets Manager prefixes the instance role may read (<prefix>/*). Empty means [secrets_prefix]."
  type        = list(string)
  default     = []
}

# ---------------------------------------------------------------------------
# Resource name overrides. null derives the name from project_name, app_slug
# or secrets_prefix (see names.tf). Pin every name of an existing stack before
# changing project_name: most of these names are ForceNew.
# ---------------------------------------------------------------------------

variable "rds_identifier" {
  description = "RDS instance identifier. null derives <project_name>-<app_slug>."
  type        = string
  default     = null
}

variable "db_subnet_group_name" {
  description = "RDS subnet group name. null derives <project_name>-<app_slug>."
  type        = string
  default     = null
}

variable "db_parameter_group_name" {
  description = "RDS parameter group name. null derives <project_name>-<app_slug>-pg16."
  type        = string
  default     = null
}

variable "ec2_sg_name" {
  description = "EC2 security group name. null derives <project_name>-sg."
  type        = string
  default     = null
}

variable "rds_sg_name" {
  description = "RDS security group name. null derives <project_name>-rds."
  type        = string
  default     = null
}

variable "efs_sg_name" {
  description = "EFS security group name. null derives <project_name>-efs-sg."
  type        = string
  default     = null
}

variable "vpc_endpoints_sg_name" {
  description = "VPC interface endpoints security group name. null derives <project_name>-vpc-endpoints-sg."
  type        = string
  default     = null
}

variable "iam_role_name" {
  description = "EC2 instance IAM role name. null derives <project_name>-role."
  type        = string
  default     = null
}

variable "instance_profile_name" {
  description = "EC2 instance profile name. null derives <project_name>-instance-profile."
  type        = string
  default     = null
}

variable "custom_policy_name" {
  description = "Inline role policy name (Bedrock, secrets, S3, logs). null derives <project_name>-custom-policy."
  type        = string
  default     = null
}

variable "efs_client_policy_name" {
  description = "Inline role policy name for EFS client access. null derives <project_name>-efs-client."
  type        = string
  default     = null
}

variable "log_group_name" {
  description = "CloudWatch log group name. null derives /<project_name>/app."
  type        = string
  default     = null
}

variable "sns_topic_name" {
  description = "SNS alarm topic name. null derives <project_name>-alarms."
  type        = string
  default     = null
}

variable "scripts_bucket_name" {
  description = "S3 scripts bucket name. null derives <project_name>-scripts-<account_id>."
  type        = string
  default     = null
}

variable "cloudtrail_bucket_name" {
  description = "S3 CloudTrail bucket name. null derives <project_name>-cloudtrail-<account_id>."
  type        = string
  default     = null
}

variable "cloudtrail_name" {
  description = "CloudTrail trail name. null derives <project_name>-trail."
  type        = string
  default     = null
}

variable "key_pair_name" {
  description = "EC2 key pair name (only with ssh_public_key). null derives <project_name>-key."
  type        = string
  default     = null
}

variable "postgres_url_secret_name" {
  description = "Full Secrets Manager name of the Postgres URL secret. null derives <secrets_prefix>/memrain-postgres-url."
  type        = string
  default     = null
}

variable "public_bearer_secret_name" {
  description = "Full Secrets Manager name of the public bearer secret. null derives <secrets_prefix>/memrain-public-bearer."
  type        = string
  default     = null
}

variable "internal_token_secret_name" {
  description = "Full Secrets Manager name of the internal token secret. null derives <secrets_prefix>/memrain-internal-token."
  type        = string
  default     = null
}

variable "tunnel_token_secret_name" {
  description = "Full Secrets Manager name of the Cloudflare Tunnel token secret. null derives <secrets_prefix>/cloudflared-tunnel-token."
  type        = string
  default     = null
}

variable "deploy_key_secret_name" {
  description = "Full Secrets Manager name of the GitHub deploy key secret. null derives <secrets_prefix>/github-deploy-key."
  type        = string
  default     = null
}
