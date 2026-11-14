output "instance_id" {
  description = "EC2 instance ID running the Docker Compose stack"
  value       = aws_instance.memrain.id
}

output "instance_type" {
  description = "EC2 instance type"
  value       = aws_instance.memrain.instance_type
}

output "efs_id" {
  description = "EFS filesystem ID backing persistent stack data"
  value       = aws_efs_file_system.memrain.id
}

output "ssm_connect_hint" {
  description = "Connect to the instance via SSM Session Manager"
  value       = "aws ssm start-session --target ${aws_instance.memrain.id} --profile ${var.aws_profile} --region ${var.aws_region}"
}

output "ssh_access" {
  description = "SSH inbound status"
  value       = var.ssh_allowed_cidr != "" ? "Enabled from ${var.ssh_allowed_cidr}" : "Disabled — use SSM Session Manager"
}

output "bedrock_model" {
  description = "Active Bedrock model (CRIS inference profile)"
  value       = var.bedrock_model_id
}

output "alarm_notifications" {
  description = "CloudWatch alarm notification status"
  value       = var.alarm_email != "" ? "Email alerts → ${var.alarm_email} (confirm the SNS subscription in your inbox)" : "Silent — set alarm_email variable to receive alerts"
}

output "vpc_endpoints" {
  description = "VPC endpoint status"
  value       = var.enable_vpc_endpoints ? "Enabled (Bedrock, SM, SSM, Logs + S3 gateway)" : "S3 gateway only (interface endpoints disabled — see enable_vpc_endpoints)"
}

output "cloudtrail" {
  description = "CloudTrail status"
  value       = var.enable_cloudtrail ? "Enabled — logs in s3://${local.cloudtrail_bucket_name}" : "Disabled"
}

output "secret_arns" {
  description = "Secrets Manager ARNs — fill the empty placeholders after deploy"
  value = {
    cloudflared         = one(aws_secretsmanager_secret.cloudflared_tunnel_token[*].arn)
    github_deploy_key   = var.use_ssh_deploy_key ? aws_secretsmanager_secret.github_deploy_key[0].arn : null
    postgres_url        = aws_secretsmanager_secret.memrain_postgres_url.arn
    public_bearer       = aws_secretsmanager_secret.memrain_public_bearer.arn
    connector_kek       = one(aws_secretsmanager_secret.connector_kek[*].arn)
    notify_webhook      = one(aws_secretsmanager_secret.notify_webhook[*].arn)
    memex_postgres_url  = aws_secretsmanager_secret.memrain_postgres_url.arn
    memex_public_bearer = aws_secretsmanager_secret.memrain_public_bearer.arn
    # memex_* are deprecated aliases of postgres_url / public_bearer.
  }
}

output "cloudwatch_log_group" {
  description = "CloudWatch log group for stack logs"
  value       = aws_cloudwatch_log_group.memrain.name
}
