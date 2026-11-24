"""
Asserts terraform/iam.tf lets the instance role invoke exactly one Bedrock
model, the one the runtime calls: amazon.titan-embed-text-v2:0. No generative
model (Claude, Nova) is reachable, and nothing is granted by wildcard.

Run: python3 -m pytest tests/test_memrain_iam.py -v
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
IAM = REPO / "terraform" / "iam.tf"


def _read() -> str:
    if not IAM.is_file():
        pytest.skip(f"{IAM} missing — see test_iam_file_exists")
    return IAM.read_text()


def _invoke_statement() -> str:
    text = _read()
    m = re.search(r'sid\s*=\s*"BedrockInvoke".*?\n  }\n', text, re.S)
    assert m, "no BedrockInvoke statement"
    return m.group(0)


def test_iam_file_exists() -> None:
    assert IAM.is_file()


def test_invoke_allows_only_titan_embed_v2() -> None:
    stmt = _invoke_statement()
    arns = re.findall(r'"(arn:aws:bedrock:[^"]+)"', stmt)
    assert arns == ["arn:aws:bedrock:${var.aws_region}::foundation-model/amazon.titan-embed-text-v2:0"], arns


def test_invoke_has_no_streaming_or_profile_actions() -> None:
    actions = re.findall(r'"(bedrock:[A-Za-z]+)"', _invoke_statement())
    assert actions == ["bedrock:InvokeModel"], actions


def test_no_generative_model_is_allowed() -> None:
    stmt = _invoke_statement()
    for family in ("anthropic.", "amazon.nova", "inference-profile/"):
        assert family not in stmt, f"BedrockInvoke still grants {family}"


def test_no_bedrock_action_wildcard() -> None:
    text = _read()
    assert not re.search(r'"bedrock:\*"', text), "bedrock:* action wildcard not allowed"
    assert not re.search(r'foundation-model/\*"', text), "foundation-model/* wildcard not allowed"
