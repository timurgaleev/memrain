# ---------------------------------------------------------------------------
# RDS Postgres for Memrain.
#
# - db.t4g.micro running Postgres 16 with pgvector + pg_trgm.
# - Subnet group spans the public subnets in the configured AZs (RDS needs
#   ≥2). Network exposure restricted via SG: only the stack EC2's SG can
#   reach 5432. No NAT — the single-instance threat model is tolerable.
# - Connection URL written to Secrets Manager <prefix>/memrain-postgres-url
#   on first apply; fetch-secrets.sh reads it back at boot.
# - Storage 20 GiB gp3, encrypted with the default AWS-managed KMS key.
# - Backup retention 7 days; deletion-protection ON so a stray
#   `terraform destroy` doesn't wipe the index.
#
# Cost: ≈ $13/mo on-demand + a few GB storage.
# ---------------------------------------------------------------------------

resource "aws_security_group" "rds" {
  name        = local.rds_sg_name
  description = "RDS Postgres - only the EC2 SG can reach 5432"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "Postgres from the stack EC2 SG"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.memrain.id]
  }

  # No egress rules required — RDS doesn't initiate outbound.

  tags = {
    Name = "${var.project_name}-rds"
  }

  lifecycle {
    # A name change replaces the SG; create the new one first so RDS is
    # re-pointed before the old one goes. The description is immutable.
    create_before_destroy = true
    ignore_changes        = [description]
  }
}

resource "aws_db_subnet_group" "memrain" {
  name = local.db_subnet_group_name
  subnet_ids = concat(
    [aws_subnet.public.id],
    [for s in aws_subnet.multi_az : s.id],
  )

  tags = {
    Name = "${var.project_name}-${var.app_slug}"
  }

  lifecycle {
    # AWS cannot move a DB instance to another subnet group in the same VPC,
    # so a replaced group could never be attached. Keep the name pinned.
    prevent_destroy = true
  }
}

# pgvector + pg_trgm enabled at parameter-group level so they're available
# without superuser. shared_preload_libraries doesn't include pgvector
# (it's a CREATE EXTENSION-time module); we list it for clarity.
resource "aws_db_parameter_group" "memrain_pg16" {
  name        = local.db_parameter_group_name
  family      = "postgres16"
  description = "Postgres 16 params - pgvector + pg_trgm preloaded as needed"

  # Surface query timing to logs at >1s (cheap signal in CloudWatch).
  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }

  # Enforce TLS for every connection — we set sslmode=require client-side
  # but belt-and-braces. `rds.force_ssl` is a STATIC parameter (takes
  # effect only on reboot), so pin apply_method to pending-reboot — the
  # provider would otherwise default to "immediate" and show perpetual
  # drift against the live value.
  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "pending-reboot"
  }

  lifecycle {
    # The description is ForceNew; a name change replaces the group, and the
    # new one must exist before the instance is switched to it.
    create_before_destroy = true
    ignore_changes        = [description]
  }
}

resource "random_password" "memrain_db" {
  length  = 32
  special = false # avoid characters that need URL-encoding in connection strings

  lifecycle {
    # Pin the password generator across provider upgrades — a silent
    # regeneration would force-rotate the DB master password mid-flight.
    ignore_changes = [length, special]
  }
}

resource "aws_db_instance" "memrain" {
  identifier                 = local.rds_identifier
  engine                     = "postgres"
  engine_version             = "16.13"
  instance_class             = var.rds_instance_class
  allocated_storage          = 20
  storage_type               = "gp3"
  storage_encrypted          = true
  db_name                    = var.db_name
  username                   = var.db_username
  password                   = random_password.memrain_db.result
  parameter_group_name       = aws_db_parameter_group.memrain_pg16.name
  db_subnet_group_name       = aws_db_subnet_group.memrain.name
  vpc_security_group_ids     = [aws_security_group.rds.id]
  publicly_accessible        = false
  backup_retention_period    = 7
  backup_window              = "03:00-04:00" # UTC
  maintenance_window         = "sun:04:30-sun:05:30"
  deletion_protection        = true
  skip_final_snapshot        = false
  final_snapshot_identifier  = "${local.rds_identifier}-final-${formatdate("YYYY-MM-DD", timestamp())}"
  apply_immediately          = var.rds_apply_immediately
  auto_minor_version_upgrade = true
  copy_tags_to_snapshot      = true

  lifecycle {
    prevent_destroy = true
    ignore_changes = [
      # `final_snapshot_identifier` includes timestamp() → would always be
      # in drift; ignore so plan is clean once the resource exists.
      final_snapshot_identifier,
      # db_name is ForceNew (a new, empty database) and the master user
      # cannot be renamed; the password is owned by the Postgres URL secret.
      db_name,
      username,
      password,
    ]
  }

  tags = {
    Name = "${var.project_name}-${var.app_slug}"
  }
}

resource "aws_secretsmanager_secret" "memrain_postgres_url" {
  name                    = local.postgres_url_secret_name
  description             = "Postgres connection URL for the RDS instance — fetched at container start by fetch-secrets.sh into MEMRAIN_POSTGRES_URL env"
  recovery_window_in_days = 0

  lifecycle {
    # recovery_window_in_days = 0 deletes at once; never let a rename do it.
    prevent_destroy = true
    ignore_changes  = [description]
  }
}

resource "aws_secretsmanager_secret_version" "memrain_postgres_url" {
  secret_id = aws_secretsmanager_secret.memrain_postgres_url.id
  secret_string = format(
    "postgres://%s:%s@%s:%s/%s?sslmode=require",
    aws_db_instance.memrain.username,
    random_password.memrain_db.result,
    aws_db_instance.memrain.address,
    aws_db_instance.memrain.port,
    aws_db_instance.memrain.db_name,
  )

  lifecycle {
    # Once the operator owns the value, terraform never writes a new one or
    # moves AWSCURRENT.
    ignore_changes = [secret_string, version_stages]
  }
}

output "memrain_rds_endpoint" {
  description = "RDS Postgres endpoint (DNS name + port)."
  value       = "${aws_db_instance.memrain.address}:${aws_db_instance.memrain.port}"
}

output "memrain_rds_secret_arn" {
  description = "ARN of the secret holding the Postgres URL."
  value       = aws_secretsmanager_secret.memrain_postgres_url.arn
}

output "memex_rds_endpoint" {
  description = "DEPRECATED alias of memrain_rds_endpoint."
  value       = "${aws_db_instance.memrain.address}:${aws_db_instance.memrain.port}"
}

output "memex_rds_secret_arn" {
  description = "DEPRECATED alias of memrain_rds_secret_arn."
  value       = aws_secretsmanager_secret.memrain_postgres_url.arn
}
