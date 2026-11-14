"""
Guards for the connector secrets in terraform (v1.18).

The connector key (KEK) seals every connector OAuth token and bring-your-own
client secret, so:
  - its secret and the notification webhook secret exist only when the
    operator opts in (count on a variable that defaults to false), so a plan
    against an existing stack shows no change until then;
  - terraform creates empty placeholders and never a secret version: the key
    must not sit in terraform state next to the database it unlocks;
  - both are prevent_destroy, like every other secret here;
  - the instance role gets an explicit read grant on exactly those ARNs, so the
    connectors keep working when secrets_read_prefixes stops covering
    secrets_prefix during a prefix move, and the grant names no wildcard.

Run: python3 -m pytest tests/test_connector_secrets_tf.py -v
"""
from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TF = REPO / "terraform"


def _block(text: str, header: str) -> str:
    """The body of the first block whose header line matches `header`."""
    m = re.search(header, text, re.MULTILINE)
    assert m, f"block not found: {header}"
    depth = 0
    for i in range(m.end() - 1, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return text[m.end():i]
    raise AssertionError(f"unterminated block: {header}")


def _variable_default(name: str) -> str:
    body = _block((TF / "variables.tf").read_text(), rf'^variable\s+"{name}"\s*\{{')
    assert re.search(r"^\s*type\s*=\s*bool\s*$", body, re.M), f"{name} must be a bool"
    m = re.search(r"^\s*default\s*=\s*(\S+)\s*$", body, re.M)
    assert m, f"{name} has no default"
    return m.group(1)


SECRETS = {
    # resource name -> (opt-in variable, derived secret name)
    "connector_kek": ("enable_connector_kek_secret", "memrain-connector-kek"),
    "notify_webhook": ("enable_notify_webhook_secret", "memrain-notify-webhook"),
}


def test_opt_in_variables_default_off() -> None:
    for var, _ in SECRETS.values():
        assert _variable_default(var) == "false", f"{var} must default to false"


def test_secret_resources_are_opt_in_placeholders() -> None:
    text = (TF / "secrets.tf").read_text()
    names = (TF / "names.tf").read_text()
    for res, (var, leaf) in SECRETS.items():
        body = _block(text, rf'^resource\s+"aws_secretsmanager_secret"\s+"{res}"\s*\{{')
        assert re.search(rf"^\s*count\s*=\s*var\.{var}\s*\?\s*1\s*:\s*0\s*$", body, re.M), res
        assert re.search(r"prevent_destroy\s*=\s*true", body), f"{res} must be prevent_destroy"
        local = re.search(r"^\s*name\s*=\s*local\.(\w+)\s*$", body, re.M)
        assert local, f"{res} must take its name from a local in names.tf"
        assert re.search(
            rf'^\s*{local.group(1)}\s*=\s*"\$\{{var\.secrets_prefix\}}/{leaf}"\s*$', names, re.M,
        ), f"{res} must be named <secrets_prefix>/{leaf}"
        # No value in state: neither a version resource nor a random value.
        assert not re.search(
            rf'aws_secretsmanager_secret_version"\s+"{res}"', text,
        ), f"{res} must not get a secret version from terraform"
        assert f"aws_secretsmanager_secret.{res}" not in "\n".join(
            l for l in text.splitlines() if "secret_id" in l
        ), f"{res} must not be written by terraform"


def test_instance_role_reads_exactly_the_connector_secrets() -> None:
    iam = (TF / "iam.tf").read_text()
    m = re.search(r'sid\s*=\s*"SecretsReadConnectors"', iam)
    assert m, "missing SecretsReadConnectors statement"
    start = iam.rfind("dynamic", 0, m.start())
    body = _block(iam[start:], r'dynamic\s+"statement"\s*\{')
    assert '"secretsmanager:GetSecretValue"' in body
    assert "PutSecretValue" not in body and "secretsmanager:*" not in body
    assert re.search(r"^\s*resources\s*=\s*local\.connector_secret_arns\s*$", body, re.M)
    # Never an empty Resource list: the statement exists only with an ARN.
    assert re.search(r"for_each\s*=\s*length\(local\.connector_secret_arns\)\s*>\s*0", body), \
        "statement must be skipped with no ARN"
    # Exactly the ARNs of the two (counted) resources, no wildcard pattern.
    m = re.search(r"connector_secret_arns\s*=\s*concat\(([^)]*)\)", iam)
    assert m, "connector_secret_arns must be a concat of the two resources' ARNs"
    entries = [e.strip() for e in m.group(1).split(",") if e.strip()]
    assert sorted(entries) == sorted(f"aws_secretsmanager_secret.{res}[*].arn" for res in SECRETS), entries


def test_outputs_name_the_connector_secrets() -> None:
    out = _block((TF / "outputs.tf").read_text(), r'^output\s+"secret_arns"\s*\{')
    for res in SECRETS:
        assert f"one(aws_secretsmanager_secret.{res}[*].arn)" in out, res
