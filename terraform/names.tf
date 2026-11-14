# Resolved AWS resource names. Every name variable defaults to null, which
# means "derive it from project_name / app_slug / secrets_prefix as before".
# Pin a variable to keep an existing resource's name when project_name or
# app_slug changes — most of these names are ForceNew.

locals {
  rds_identifier          = coalesce(var.rds_identifier, "${var.project_name}-${var.app_slug}")
  db_subnet_group_name    = coalesce(var.db_subnet_group_name, "${var.project_name}-${var.app_slug}")
  db_parameter_group_name = coalesce(var.db_parameter_group_name, "${var.project_name}-${var.app_slug}-pg16")

  ec2_sg_name           = coalesce(var.ec2_sg_name, "${var.project_name}-sg")
  rds_sg_name           = coalesce(var.rds_sg_name, "${var.project_name}-rds")
  efs_sg_name           = coalesce(var.efs_sg_name, "${var.project_name}-efs-sg")
  vpc_endpoints_sg_name = coalesce(var.vpc_endpoints_sg_name, "${var.project_name}-vpc-endpoints-sg")

  iam_role_name          = coalesce(var.iam_role_name, "${var.project_name}-role")
  instance_profile_name  = coalesce(var.instance_profile_name, "${var.project_name}-instance-profile")
  custom_policy_name     = coalesce(var.custom_policy_name, "${var.project_name}-custom-policy")
  efs_client_policy_name = coalesce(var.efs_client_policy_name, "${var.project_name}-efs-client")

  log_group_name = coalesce(var.log_group_name, "/${var.project_name}/app")
  sns_topic_name = coalesce(var.sns_topic_name, "${var.project_name}-alarms")

  scripts_bucket_name    = coalesce(var.scripts_bucket_name, "${var.project_name}-scripts-${data.aws_caller_identity.current.account_id}")
  cloudtrail_bucket_name = coalesce(var.cloudtrail_bucket_name, "${var.project_name}-cloudtrail-${data.aws_caller_identity.current.account_id}")
  cloudtrail_name        = coalesce(var.cloudtrail_name, "${var.project_name}-trail")

  key_pair_name = coalesce(var.key_pair_name, "${var.project_name}-key")

  postgres_url_secret_name   = coalesce(var.postgres_url_secret_name, "${var.secrets_prefix}/memrain-postgres-url")
  public_bearer_secret_name  = coalesce(var.public_bearer_secret_name, "${var.secrets_prefix}/memrain-public-bearer")
  internal_token_secret_name = coalesce(var.internal_token_secret_name, "${var.secrets_prefix}/memrain-internal-token")
  tunnel_token_secret_name   = coalesce(var.tunnel_token_secret_name, "${var.secrets_prefix}/cloudflared-tunnel-token")
  deploy_key_secret_name     = coalesce(var.deploy_key_secret_name, "${var.secrets_prefix}/github-deploy-key")
  connector_kek_secret_name  = "${var.secrets_prefix}/memrain-connector-kek"
  notify_webhook_secret_name = "${var.secrets_prefix}/memrain-notify-webhook"

  # Secret prefixes the instance role may read. Defaults to the one prefix
  # this stack writes; list a second one while secrets move between prefixes.
  secrets_read_prefixes = coalescelist(var.secrets_read_prefixes, [var.secrets_prefix])

  subdomain = var.memex_subdomain != null ? var.memex_subdomain : var.subdomain
}

check "memex_subdomain_deprecated" {
  assert {
    condition     = var.memex_subdomain == null
    error_message = "memex_subdomain is deprecated and will be removed; set subdomain instead."
  }
}
