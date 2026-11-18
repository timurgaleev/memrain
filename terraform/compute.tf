# Single on-demand EC2 host that runs the Docker Compose stack.

resource "aws_instance" "memrain" {
  ami                    = data.aws_ami.amazon_linux_2023.id
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.memrain.id]
  iam_instance_profile   = aws_iam_instance_profile.memrain.name
  key_name               = length(aws_key_pair.memrain) > 0 ? aws_key_pair.memrain[0].key_name : null

  # The filesystem ID alone is not enough to mount: `mount -t efs` resolves
  # <fs-id>.efs.<region>.amazonaws.com, and that name only answers once a
  # mount target exists in the VPC. Without this the instance can boot first,
  # bootstrap exhausts its mount retries against an unresolvable host, and
  # cloud-init reports a failed run on an otherwise healthy stack.
  # user_data also `aws s3 cp`s the bootstrap script with no retry, and the
  # first boot reads secrets through the instance role — the script object, the
  # policies granting those reads, and the Postgres URL's secret *version* all
  # have to exist first. Without the version, fetch-secrets finds an empty
  # secret and the brain silently comes up on PGLite instead of RDS.
  depends_on = [
    aws_efs_mount_target.main_az,
    aws_efs_mount_target.multi_az,
    aws_s3_object.bootstrap_script,
    aws_iam_role_policy.memrain_custom,
    aws_iam_role_policy.efs_client,
    aws_secretsmanager_secret_version.memrain_postgres_url,
    aws_secretsmanager_secret_version.memrain_public_bearer,
    aws_secretsmanager_secret_version.memrain_internal_token,
  ]

  user_data = templatefile("${path.module}/user_data.sh.tftpl", {
    bootstrap_script_url = "s3://${aws_s3_bucket.scripts.id}/scripts/bootstrap.sh"
    efs_id               = aws_efs_file_system.memrain.id
    repo_url             = var.repo_url
    project_name         = var.project_name
    use_ssh_deploy_key   = var.use_ssh_deploy_key
    secrets_prefix       = var.secrets_prefix
    aws_region           = var.aws_region
    domain               = var.domain
    subdomain            = local.subdomain
    ingress_mode         = var.ingress_mode
  })

  user_data_replace_on_change = false

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
    # 2 is the minimum hop_limit that still lets Docker containers
    # reach IMDSv2: container → docker bridge (hop 1) → host → IMDS
    # (hop 2). At hop_limit=1 the IMDS response packet's IP TTL is
    # decremented to 0 at the docker bridge and dropped, so every
    # containerised AWS SDK call (Bedrock invoke, Secrets Manager
    # get-secret-value) fails with "Unable to locate credentials".
    # The bare-metal threat model that motivates hop_limit=1 (untrusted
    # host-side processes exfiltrating role creds) does not apply here:
    # the whole workload IS containerised. A hosting stack sets 1 instead:
    # there the containers are tenants, and none may take the instance role.
    http_put_response_hop_limit = var.instance_metadata_hop_limit
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = var.ebs_volume_size
    encrypted   = true
  }

  tags = {
    Name = var.project_name
  }

  lifecycle {
    prevent_destroy = true
    # instance_type stays out of ignore_changes — terraform should surface
    # drift if the live size diverges from intent.
    ignore_changes = [ami, user_data]
  }
}

resource "aws_eip" "memrain" {
  instance = aws_instance.memrain.id
  domain   = "vpc"

  tags = {
    Name = "${var.project_name}-eip"
  }

  lifecycle {
    # A caddy install's DNS points at this address.
    prevent_destroy = true
  }
}

resource "aws_s3_object" "bootstrap_script" {
  bucket = aws_s3_bucket.scripts.id
  key    = "scripts/bootstrap.sh"
  source = "${path.module}/../scripts/bootstrap.sh"
  etag   = filemd5("${path.module}/../scripts/bootstrap.sh")
}

output "public_ip" {
  value = aws_eip.memrain.public_ip
}

output "instance_arn" {
  value = aws_instance.memrain.arn
}

output "ssm_command" {
  value = "aws ssm start-session --target ${aws_instance.memrain.id} --profile ${var.aws_profile} --region ${var.aws_region}"
}
