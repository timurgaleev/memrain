data "aws_iam_policy_document" "ec2_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "memrain" {
  name               = local.iam_role_name
  assume_role_policy = data.aws_iam_policy_document.ec2_assume_role.json
}

# SSM Session Manager — no SSH port needed
resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.memrain.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# CloudWatch agent
resource "aws_iam_role_policy_attachment" "cloudwatch" {
  role       = aws_iam_role.memrain.name
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"
}

data "aws_iam_policy_document" "memrain_custom" {
  # Bedrock invoke — limited to the one model the stack calls: Titan text
  # embeddings v2, region-pinned (it has no cross-region profile). No
  # generative model is reachable, so a compromised instance role cannot
  # invoke a paid chat model.
  statement {
    sid    = "BedrockInvoke"
    effect = "Allow"
    actions = [
      "bedrock:InvokeModel",
    ]
    resources = [
      "arn:aws:bedrock:${var.aws_region}::foundation-model/amazon.titan-embed-text-v2:0",
    ]
  }

  # Deny direct off-region Bedrock invocations of the Claude models. The
  # Allow above grants none of them; this stays as a second wall should a
  # broader grant ever be attached to the role.
  statement {
    sid    = "BedrockDenyOffRegion"
    effect = "Deny"
    actions = [
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
    ]
    resources = ["arn:aws:bedrock:*::foundation-model/anthropic.claude-*"]
    condition {
      test     = "StringNotEqualsIfExists"
      variable = "aws:RequestedRegion"
      values   = var.bedrock_allowed_regions
    }
    # CalledVia=bedrock.amazonaws.com identifies a profile-routed
    # invocation (Bedrock service is the actual caller). Skip the deny
    # in that case so cross-region inference profiles still work.
    condition {
      test     = "Null"
      variable = "aws:CalledVia"
      values   = ["true"]
    }
  }

  # Bedrock list/discovery — these are account-level actions, require * resource
  statement {
    sid    = "BedrockList"
    effect = "Allow"
    actions = [
      "bedrock:ListFoundationModels",
      "bedrock:ListInferenceProfiles",
    ]
    resources = ["*"]
  }

  # Secrets Manager: read every secret under the configured prefix.
  statement {
    sid    = "SecretsRead"
    effect = "Allow"
    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
    ]
    resources = [
      for p in local.secrets_read_prefixes :
      "arn:aws:secretsmanager:${var.aws_region}:${data.aws_caller_identity.current.account_id}:secret:${p}/*"
    ]
  }

  # Secrets Manager: read the secret-store key (still named connector_kek; it
  # seals the originals the secret scan redacts) and the notification webhook
  # secret by exact ARN. SecretsRead above already covers them while
  # secrets_read_prefixes includes secrets_prefix; this grant keeps them
  # readable when it does not (a prefix move), without widening that list.
  # Only present once one of the two secrets exists: a statement with no
  # Resource is a malformed policy.
  dynamic "statement" {
    for_each = length(local.connector_secret_arns) > 0 ? [1] : []
    content {
      sid    = "SecretsReadConnectors"
      effect = "Allow"
      actions = [
        "secretsmanager:GetSecretValue",
        "secretsmanager:DescribeSecret",
      ]
      resources = local.connector_secret_arns
    }
  }

  # Secrets Manager: write only the public-bearer secret, used by the
  # daily rotation timer (deploy/systemd/memrain-rotate-bearer.timer).
  # Scoped to this single ARN — every other secret stays read-only.
  statement {
    sid    = "SecretsRotatePublicBearer"
    effect = "Allow"
    actions = [
      "secretsmanager:PutSecretValue",
    ]
    resources = [
      "arn:aws:secretsmanager:${var.aws_region}:${data.aws_caller_identity.current.account_id}:secret:${local.public_bearer_secret_name}-*",
    ]
  }

  # S3: read install script from dedicated scripts bucket
  statement {
    sid    = "S3ScriptRead"
    effect = "Allow"
    actions = [
      "s3:GetObject",
    ]
    resources = [
      "${aws_s3_bucket.scripts.arn}/*",
    ]
  }

  # CloudWatch Logs: write to the stack log group only
  statement {
    sid    = "CloudWatchLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:DescribeLogStreams",
    ]
    resources = [
      "${aws_cloudwatch_log_group.memrain.arn}:*",
    ]
  }
}

locals {
  connector_secret_arns = concat(
    aws_secretsmanager_secret.connector_kek[*].arn,
    aws_secretsmanager_secret.notify_webhook[*].arn,
  )
}

resource "aws_iam_role_policy" "memrain_custom" {
  name   = local.custom_policy_name
  role   = aws_iam_role.memrain.id
  policy = data.aws_iam_policy_document.memrain_custom.json
}

resource "aws_iam_instance_profile" "memrain" {
  name = local.instance_profile_name
  role = aws_iam_role.memrain.name
}
