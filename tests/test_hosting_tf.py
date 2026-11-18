"""
Guards for the hosting additions in terraform.

A hosting stack is the same terraform with its own state and tfvars. Every
hosting knob defaults to what the single-tenant stack has today, so a plan
against an existing stack shows no change:
  - `enable_hosting` (false) creates the empty control admin URL secret;
  - `hosting_tenants` ([]) creates three empty secrets per tenant under
    <prefix>/tenants/<id>/; provisioning writes their values, terraform never
    holds a version. They are not prevent_destroy (a deleted tenant's secrets
    go away) and keep a 7-day recovery window;
  - `rds_instance_class` (db.t4g.micro) replaces the literal;
  - `instance_metadata_hop_limit` (2) lets a hosting stack set 1, so no
    container reaches IMDS.

Run: python3 -m pytest tests/test_hosting_tf.py -v
"""
from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TF = REPO / "terraform"


def _block(text: str, header: str) -> str:
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


def _var(name: str) -> str:
    return _block((TF / "variables.tf").read_text(), rf'^variable "{name}" \{{')


def test_hosting_variables_default_to_the_single_tenant_stack() -> None:
    assert re.search(r"type\s*=\s*bool", _var("enable_hosting"))
    assert re.search(r"default\s*=\s*false", _var("enable_hosting"))
    tenants = _var("hosting_tenants")
    assert re.search(r"type\s*=\s*set\(string\)", tenants)
    assert re.search(r"default\s*=\s*\[\]", tenants)
    assert "^[a-z][a-z0-9-]{1,30}$" in tenants, "tenant ids validated with the control-plane pattern"
    assert re.search(r'default\s*=\s*"db\.t4g\.micro"', _var("rds_instance_class"))
    hop = _var("instance_metadata_hop_limit")
    assert re.search(r"default\s*=\s*2\b", hop)
    assert "validation" in hop


def test_rds_and_imds_read_the_variables() -> None:
    rds = (TF / "rds.tf").read_text()
    assert re.search(r"instance_class\s*=\s*var\.rds_instance_class", rds)
    assert '"db.t4g.micro"' not in rds
    compute = (TF / "compute.tf").read_text()
    assert re.search(r"http_put_response_hop_limit\s*=\s*var\.instance_metadata_hop_limit", compute)
    assert re.search(r'http_tokens\s*=\s*"required"', compute), "IMDSv2 stays required"


def test_tenant_secrets_are_empty_containers_per_tenant() -> None:
    secrets = (TF / "secrets.tf").read_text()
    body = _block(secrets, r'^resource "aws_secretsmanager_secret" "hosting_tenant" \{')
    assert re.search(r"for_each\s*=\s*local\.hosting_tenant_secrets", body)
    assert "${var.secrets_prefix}/tenants/" in body
    assert re.search(r"recovery_window_in_days\s*=\s*7", body)
    assert "prevent_destroy" not in body, "a deleted tenant's secrets must be destroyable"
    names = (TF / "names.tf").read_text() + secrets
    for kind in ("postgres-url", "control-url", "internal-token"):
        assert f'"{kind}"' in names, f"tenant secret {kind} missing"
    control = _block(secrets, r'^resource "aws_secretsmanager_secret" "hosting_control_admin_url" \{')
    assert re.search(r"count\s*=\s*var\.enable_hosting \? 1 : 0", control)
    assert "/hosting/control-admin-url" in control


def test_terraform_never_holds_a_hosting_secret_value() -> None:
    for path in TF.glob("*.tf"):
        text = path.read_text()
        for m in re.finditer(r'resource "aws_secretsmanager_secret_version" "(\w+)"', text):
            assert "hosting" not in m.group(1) and "tenant" not in m.group(1), f"{path.name}: {m.group(1)}"


def test_tfvars_example_documents_the_hosting_knobs() -> None:
    example = (TF / "terraform.tfvars.example").read_text()
    for name in ("enable_hosting", "hosting_tenants", "rds_instance_class", "instance_metadata_hop_limit"):
        assert re.search(rf"^#?\s*{name}\s*=", example, re.MULTILINE), f"{name} not in terraform.tfvars.example"
