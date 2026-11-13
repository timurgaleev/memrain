"""
Shape of deploy/docker-compose.local.yml, the no-AWS local trial.

It must stay reachable from this machine only, keep its pages in a named
volume the image's non-root user can write, and run keyword-only so nothing
tries to reach Bedrock.
"""
from __future__ import annotations

from pathlib import Path

import pytest
import yaml

REPO = Path(__file__).resolve().parent.parent
LOCAL = REPO / "deploy" / "docker-compose.local.yml"
DOCKERFILE = REPO / "deploy" / "memrain" / "Dockerfile"
SCRIPT = REPO / "scripts" / "local-up.sh"
SMOKE = REPO / "scripts" / "local-smoke.sh"


@pytest.fixture(scope="module")
def svc() -> dict:
    compose = yaml.safe_load(LOCAL.read_text())
    return compose["services"]["memrain"]


def _env(svc: dict) -> dict[str, str]:
    return dict(str(e).split("=", 1) for e in svc["environment"])


def test_ports_bind_loopback_only(svc):
    ports = svc["ports"]
    assert ports
    for p in ports:
        assert str(p).startswith("127.0.0.1:"), f"port not bound to loopback: {p!r}"


def test_pages_live_in_a_named_volume(svc):
    compose = yaml.safe_load(LOCAL.read_text())
    data = [v for v in svc["volumes"] if isinstance(v, dict) and v.get("target") == "/home/bun/.memrain"]
    assert len(data) == 1 and data[0]["type"] == "volume"
    assert data[0]["source"] in compose["volumes"]


def test_image_creates_the_data_dir_for_the_bun_user():
    # An empty named volume copies ownership from the image path it mounts
    # over; without this directory it is created root-owned and init fails.
    text = DOCKERFILE.read_text()
    assert "/home/bun/.memrain" in text
    mkdir = text.index("/home/bun/.memrain")
    assert "chown" in text[mkdir - 200 : mkdir + 200]
    assert mkdir < text.index("USER bun")


def test_runs_keyword_only_with_a_token(svc):
    env = _env(svc)
    assert env["MEMRAIN_KEYWORD_ONLY"] == "1"
    assert env["MEMRAIN_INTERNAL_TOKEN"].startswith("${MEMRAIN_INTERNAL_TOKEN:?")
    assert "MEMRAIN_POSTGRES_URL" not in env


def test_hardened(svc):
    assert "ALL" in [str(c).upper() for c in svc["cap_drop"]]
    assert "no-new-privileges:true" in [str(s).replace(" ", "") for s in svc["security_opt"]]


def test_scripts_are_executable():
    for path in (SCRIPT, SMOKE):
        assert path.is_file(), f"{path} missing"
        assert path.stat().st_mode & 0o111, f"{path} not executable"
