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
  # Bedrock invoke — limited to the models the stack actually calls
  # (Titan embed + Nova family + Claude Haiku 4.5/5.5 + Claude Sonnet 4.6/5.5).
  # Region-scoped where
  # possible. Cross-region inference profiles ("eu." / "global.") are
  # listed explicitly so a compromised instance role cannot invoke
  # arbitrary paid models.
  statement {
    sid    = "BedrockInvoke"
    effect = "Allow"
    actions = [
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
      "bedrock:GetInferenceProfile",
    ]
    resources = [
      # Titan embed is region-pinned (no cross-region profile).
      "arn:aws:bedrock:${var.aws_region}::foundation-model/amazon.titan-embed-text-v2:0",

      # Foundation-model ARNs for the cross-region inference profiles.
      # The `eu.*` profiles dispatch to a foundation model in any EU
      # region; the `global.*` profiles dispatch globally. Bedrock
      # authorises the request against the foundation-model ARN
      # *without* the region segment, so the region must be `*` here.
      # We compensate with an explicit Deny statement below that
      # blocks direct `bedrock:InvokeModel` against any region that is
      # not on the configured allowlist (default: the stack's own
      # `var.aws_region` plus the EU + US regions backing `eu.*` and
      # `global.*` inference profiles).
      "arn:aws:bedrock:*::foundation-model/amazon.nova-*",
      "arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5*",
      # Claude Sonnet 4.6 — the paid model behind the opt-in, default-OFF
      # conversation->facts extractor (MEMRAIN_FACTS_MODEL). Stays region-locked
      # via the BedrockDenyOffRegion statement below, same posture as Haiku.
      "arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6*",
      # The 5.5 generation, selectable per tier via MEMRAIN_UTILITY_MODEL /
      # MEMRAIN_FACTS_MODEL. Region-locked by the same Deny below.
      "arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-5-5*",
      "arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-5-5*",

      # Cross-region inference profiles — enumerated, no wildcards.
      "arn:aws:bedrock:${var.aws_region}:${data.aws_caller_identity.current.account_id}:inference-profile/eu.amazon.nova-*",
      "arn:aws:bedrock:${var.aws_region}:${data.aws_caller_identity.current.account_id}:inference-profile/eu.anthropic.claude-haiku-4-5*",
      "arn:aws:bedrock:${var.aws_region}:${data.aws_caller_identity.current.account_id}:inference-profile/eu.anthropic.claude-sonnet-4-6*",
      "arn:aws:bedrock:${var.aws_region}:${data.aws_caller_identity.current.account_id}:inference-profile/eu.anthropic.claude-haiku-5-5*",
      "arn:aws:bedrock:${var.aws_region}:${data.aws_caller_identity.current.account_id}:inference-profile/eu.anthropic.claude-sonnet-5-5*",
      "arn:aws:bedrock:${var.aws_region}:${data.aws_caller_identity.current.account_id}:inference-profile/global.amazon.nova-*",
    ]
  }

  # Deny direct off-region Bedrock invocations of the EXPENSIVE Claude
  # models. A compromised container could otherwise call Claude directly
  # in, e.g., us-east-1 and silently burn the operator's credits.
  #
  # Nova is deliberately NOT covered here: the `global.amazon.nova-*`
  # inference profile routes the underlying foundation-model call
  # region-less (worldwide), so `aws:RequestedRegion` never matches a
  # fixed allowlist and the call is denied. Nova 2 Lite is cheap and
  # credit-eligible, so we let it invoke in any region; only Claude
  # stays region-locked.
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

resource "aws_iam_role_policy" "memrain_custom" {
  name   = local.custom_policy_name
  role   = aws_iam_role.memrain.id
  policy = data.aws_iam_policy_document.memrain_custom.json
}

resource "aws_iam_instance_profile" "memrain" {
  name = local.instance_profile_name
  role = aws_iam_role.memrain.name
}
