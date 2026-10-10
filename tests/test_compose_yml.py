"""
Assertions on deploy/docker-compose.yml shape.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).parent.parent
COMPOSE_PATH = REPO_ROOT / "deploy" / "docker-compose.yml"
EXPECTED_SERVICES = {
    "memrain",
    "cloudflared",
}

# The app's `environment:` keys before the rename, without their brand
# prefix. The renamed file must pass exactly these (as MEMRAIN_<suffix>)
# plus the documented additions, and drop none: a key missing here is a
# setting that silently stops reaching the container.
PRE_RENAME_UNBRANDED = {"AWS_REGION", "AWS_PROFILE", "SECRETS_PREFIX", "HOME"}
PRE_RENAME_SUFFIXES = {
    "SKILLS_DIR", "VAULT_PATHS", "SWEEP_DELAY_MS", "SWEEP_MAX_FILES",
    "CODE_PATHS", "CODE_SWEEP_DELAY_MS", "DREAM_INTERVAL_S", "DREAM_STALE_DAYS",
    "CYCLE_PHASE_TIMEOUT_MS", "CYCLE_SKIP_PHASES", "DREAM_SYNTHESIS",
    "DOCTOR_PER_SOURCE", "TENANT_FAIL_CLOSED", "PUBLIC_WRITE", "OPERATOR",
    "RERANK", "RERANK_WINDOW", "THINK", "THINK_BUDGET_USD", "RELATIONAL_LLM",
    "RELATIONAL_LLM_BUDGET_USD", "GRAPH_RERANK", "GRAPH_RERANK_BUDGET_USD",
    "DEEP_SYNTH", "DEEP_SYNTH_BUDGET_USD", "DEEP_SYNTH_MAX_QUESTIONS",
    "TAKE_ENSEMBLE", "TAKE_ENSEMBLE_BUDGET_USD", "TAKE_ENSEMBLE_JUDGES",
    "FACTS_EXTRACTION", "FACTS_BUDGET_USD", "CONTEXTUAL_RETRIEVAL",
    "CONTEXTUAL_LLM", "CONTEXTUAL_LLM_BUDGET_USD", "EMBED_MAX_INFLIGHT",
    "PAGE_MIRROR_SYNC", "BODY_TIMELINE", "LLM_TIMEOUT_MS",
    "LLM_UTILITY_TIMEOUT_MS", "LLM_REASONING_TIMEOUT_MS", "EMBED_TIMEOUT_MS",
    "FACTS_MODEL", "SECRET_SCAN_DISPOSITION", "SECRET_SCAN_ALLOW",
    "TRANSCRIPT_MAX_FILE_BYTES", "GITHUB_TOKEN", "CONNECTOR_GAP_HEAL_MINUTES",
    "CONNECTOR_STALL_DAYS", "CONTENT_SANITY_DISABLE", "THINK_MODEL",
    "DRIFT_MODEL", "CONCEPTS_MODEL", "EXPANSION_MODEL", "INTENT_MODEL",
    "RERANK_MODEL", "PUBLIC_URL", "ASSUME_PUBLIC", "OAUTH_REQUIRE_LOGIN",
    "OAUTH_REFRESH_REUSE_REVOKE", "ENABLE_DCR", "ENABLE_DCR_INSECURE",
    "HTTP_CORS_ORIGIN", "MCP_RATE_LIMIT_PER_TOKEN_PER_MINUTE",
    "DEPLOYMENT_IDENTITY", "MCP_INSTRUCTIONS", "MCP_LENIENT_ARGS",
    "JOB_TIMEOUT_MS", "AGENT_ENABLED", "AGENT_MAX_USD", "AGENT_TENANT_ENABLED",
    "SKILLOPT_ENABLED", "SKILLOPT_MAX_USD", "HNSW_ZOMBIE_SWEEP",
    "MAX_BODY_BYTES", "INGEST_MAX_BYTES", "ADMIN_BOOTSTRAP", "HTTP_TRUST_PROXY",
}
QUIESCENCE_SWITCHES = {"MAINTENANCE", "BOOT_CODE_SWEEP", "JOBS_WORKER", "CYCLE"}
ADDED_SUFFIXES = {
    "INGEST_TRANSCRIPT_MAX_BYTES",
    "REQUIRE_POSTGRES",
    "UTILITY_MODEL",
    "WORKER_DRAIN_MS",
    "OWNER_ENTITY",
    "FACTS_JUNK_FILTER",
    "FACTS_MAX_WINDOWS",
    "THINK_QUOTE_VERIFY",
    "TIMEZONE",
} | QUIESCENCE_SWITCHES
NESTED_ENTRY = re.compile(r"^MEMRAIN_(\w+)=\$\{MEMRAIN_\1:-\$\{MEMEX_\1:-[^}]*\}\}$")


@pytest.fixture(scope="module")
def compose() -> dict:
    assert COMPOSE_PATH.exists(), f"docker-compose.yml not found at {COMPOSE_PATH}"
    with COMPOSE_PATH.open() as fh:
        return yaml.safe_load(fh)


def test_compose_file_exists():
    assert COMPOSE_PATH.exists(), "deploy/docker-compose.yml must exist"


def test_compose_is_valid_yaml(compose):
    assert isinstance(compose, dict), "docker-compose.yml must parse as a YAML dict"


def test_no_version_key(compose):
    """Compose v2 modern syntax: no top-level 'version:' key."""
    assert "version" not in compose, (
        "docker-compose.yml must not have a 'version:' key (Compose v2 modern syntax)"
    )


def test_services_declared(compose):
    services = set(compose.get("services", {}).keys())
    assert services == EXPECTED_SERVICES, (
        f"Expected services {EXPECTED_SERVICES}, got {services}"
    )


def test_each_service_has_restart_policy(compose):
    for name, svc in compose["services"].items():
        assert "restart" in svc, f"Service '{name}' is missing a 'restart:' policy"


def test_no_ports_host_loopback(compose):
    """
    Services must use expose: (not ports:) to stay off the host network.
    Only exception: cloudflared uses upstream image and no ports: is fine too.
    """
    for name, svc in compose["services"].items():
        assert "ports" not in svc, (
            f"Service '{name}' must not use 'ports:' — use 'expose:' to keep ports "
            "off the host network (host-loopback safety)"
        )


def test_memrain_has_healthcheck_hitting_health(compose):
    svc = compose["services"]["memrain"]
    assert "healthcheck" in svc, "memrain must declare a healthcheck"
    hc = svc["healthcheck"]
    test_cmd = " ".join(hc.get("test", []))
    assert "/health" in test_cmd, (
        f"memrain healthcheck must target /health endpoint, got: {test_cmd}"
    )


def test_cloudflared_depends_on_memrain(compose):
    """Public ingress (brain.<domain>/mcp) terminates at memrain, so the
    tunnel must wait for memrain's /health probe to pass before
    accepting traffic."""
    svc = compose["services"]["cloudflared"]
    depends = svc.get("depends_on", {})
    assert set(depends) == {"memrain"}, "cloudflared must depend_on memrain only"
    assert depends["memrain"].get("condition") == "service_healthy", (
        "cloudflared depends_on memrain must use condition: service_healthy"
    )


def test_internal_network_declared(compose):
    networks = compose.get("networks", {})
    assert "internal" in networks, (
        "A network named 'internal' must be declared in the compose file"
    )


def test_all_services_on_internal_network(compose):
    for name, svc in compose["services"].items():
        nets = svc.get("networks", [])
        if isinstance(nets, dict):
            assert "internal" in nets, f"Service '{name}' must be on the 'internal' network"
        else:
            assert "internal" in nets, f"Service '{name}' must be on the 'internal' network"


def test_memrain_has_expose(compose):
    svc = compose["services"]["memrain"]
    assert "expose" in svc, "memrain must declare expose: [18790]"
    assert "18790" in [str(p) for p in svc["expose"]], (
        "memrain must expose port 18790"
    )


def test_cloudflared_uses_pinned_image(compose):
    svc = compose["services"]["cloudflared"]
    assert "image" in svc, "cloudflared must use upstream image (no build:)"
    img = svc["image"]
    assert ":" in img, f"cloudflared image must use a pinned tag, got: {img}"
    tag = img.split(":")[-1]
    assert tag != "latest", f"cloudflared image must not use ':latest', got: {img}"


def test_memrain_build_context(compose):
    svc = compose["services"]["memrain"]
    assert "build" in svc, "memrain must declare a build: block"
    assert svc["build"]["context"] == "./memrain"
    assert svc["build"]["args"] == {
        "MEMRAIN_VERSION": "${MEMRAIN_VERSION:-${MEMEX_VERSION:-dev}}"
    }


def test_serve_time_env_vars_reach_the_container(compose):
    """Every MEMRAIN_* the server reads at boot must be in the compose allowlist.

    The `environment:` block is an allowlist, not a passthrough — a variable set
    in .env but missing here never reaches the process, and the failure is
    silent: the flag simply appears to do nothing.
    """
    src = REPO_ROOT / "deploy" / "memrain" / "src"
    required = {
        "MEMRAIN_PUBLIC_URL",
        "MEMRAIN_ASSUME_PUBLIC",
        "MEMRAIN_OAUTH_REQUIRE_LOGIN",
        "MEMRAIN_OAUTH_REFRESH_REUSE_REVOKE",
        "MEMRAIN_ENABLE_DCR",
        "MEMRAIN_ENABLE_DCR_INSECURE",
        "MEMRAIN_ADMIN_BOOTSTRAP",
        "MEMRAIN_HTTP_CORS_ORIGIN",
        "MEMRAIN_REQUIRE_POSTGRES",
        "MEMRAIN_MAINTENANCE",
        "MEMRAIN_BOOT_CODE_SWEEP",
        "MEMRAIN_JOBS_WORKER",
        "MEMRAIN_CYCLE",
    }
    # Guard the list itself: a name that no longer exists in the source is a
    # stale assertion, not a real requirement.
    sources = "\n".join(
        p.read_text() for p in src.rglob("*.ts") if ".test." not in p.name
    )
    for name in sorted(required):
        assert name in sources, f"{name} is asserted here but read nowhere in src/"

    declared = _env_keys(compose)

    missing = required - declared
    assert not missing, (
        "these env vars are read by the server but never passed through "
        f"docker-compose.yml, so setting them has no effect: {sorted(missing)}"
    )


def _env_entries(compose: dict) -> list[str]:
    return [str(e) for e in compose["services"]["memrain"].get("environment", [])]


def _env_keys(compose: dict) -> set[str]:
    return {e.split("=", 1)[0] for e in _env_entries(compose)}


def test_no_top_level_name(compose):
    """The project name stays `deploy` (the checkout's directory), so the
    container is deploy-memrain-1 and the network stays deploy_internal."""
    assert "name" not in compose
    assert "container_name" not in compose["services"]["memrain"]


def test_memex_network_alias(compose):
    """A tunnel or Caddy origin that still says memex:18790 keeps resolving."""
    nets = compose["services"]["memrain"]["networks"]
    assert isinstance(nets, dict)
    assert nets["internal"]["aliases"] == ["memex"]


def test_binds_are_long_syntax_without_host_path_creation(compose):
    """A missing host directory must fail the start, never be created empty
    and mounted over the place the data was expected."""
    vols = compose["services"]["memrain"]["volumes"]
    assert vols
    for v in vols:
        assert isinstance(v, dict), f"short-syntax volume: {v!r}"
        assert v["type"] == "bind"
        assert v["bind"]["create_host_path"] is False, v
    by_target = {v["target"]: v for v in vols}
    for ro in ("/memory", "/skills", "/repo-source", "/home/bun/.aws"):
        assert by_target[ro].get("read_only") is True, ro
    for rw in ("/home/bun/.memrain", "/home/bun/.memex"):
        assert not by_target[rw].get("read_only"), rw


def test_config_dir_and_compat_path_share_one_source(compose):
    by_target = {v["target"]: v for v in compose["services"]["memrain"]["volumes"]}
    new = by_target["/home/bun/.memrain"]["source"]
    old = by_target["/home/bun/.memex"]["source"]
    assert new.endswith("}/memrain") and old.endswith("}/memrain")
    assert new.startswith("${EFS_MOUNT") and old.startswith("${EFS_MOUNT")


def test_env_entries_are_memrain_with_legacy_fallback(compose):
    """Interpolated entries read the new name, then the legacy one, then the
    old default; fixed entries carry the new name. No MEMEX_ key is passed."""
    for entry in _env_entries(compose):
        key, value = entry.split("=", 1)
        assert not key.startswith("MEMEX_"), entry
        if not key.startswith("MEMRAIN_"):
            assert key in PRE_RENAME_UNBRANDED, entry
            continue
        if "$" in value:
            assert NESTED_ENTRY.match(entry), f"not the nested fallback form: {entry}"
    by_key = dict(e.split("=", 1) for e in _env_entries(compose))
    assert by_key["MEMRAIN_PUBLIC_WRITE"] == "${MEMRAIN_PUBLIC_WRITE:-${MEMEX_PUBLIC_WRITE:-0}}"
    assert by_key["MEMRAIN_CYCLE_PHASE_TIMEOUT_MS"].endswith(":-900000}}")


def test_quiescence_switches_default_empty(compose):
    by_key = dict(e.split("=", 1) for e in _env_entries(compose))
    for sw in sorted(QUIESCENCE_SWITCHES | {"REQUIRE_POSTGRES"}):
        assert by_key[f"MEMRAIN_{sw}"] == f"${{MEMRAIN_{sw}:-${{MEMEX_{sw}:-}}}}", sw


def test_env_key_set_is_the_pre_rename_set_plus_additions(compose):
    expected = PRE_RENAME_UNBRANDED | {
        f"MEMRAIN_{s}" for s in PRE_RENAME_SUFFIXES | ADDED_SUFFIXES
    }
    keys = _env_keys(compose)
    assert len(keys) == len(_env_entries(compose)), "duplicate environment key"
    assert keys == expected, (
        f"missing: {sorted(expected - keys)}; unexpected: {sorted(keys - expected)}"
    )


def test_no_secret_or_host_in_environment(compose):
    """An empty `environment:` entry blanks the env_file value of the same
    name, so the secret-bearing keys and the bind host never appear here."""
    forbidden = re.compile(r"_(POSTGRES_URL|PUBLIC_BEARER|INTERNAL_TOKEN|HOST)$")
    bad = sorted(k for k in _env_keys(compose) if forbidden.search(k))
    assert not bad, bad


def test_env_file_is_memrain_only(compose):
    assert compose["services"]["memrain"]["env_file"] == [
        {"path": ".secrets/memrain.env", "required": False}
    ]


def _compose_config(tmp_path: Path, env_text: str) -> dict:
    env = tmp_path / "fixture.env"
    env.write_text(
        "AWS_REGION=eu-west-1\nEFS_MOUNT=/mnt/fixture-efs/stack\nEFS_REPO=/mnt/fixture-efs/repo\n"
        + env_text
    )
    out = subprocess.run(
        ["docker", "compose", "--env-file", str(env), "-f", str(COMPOSE_PATH),
         "config", "--format", "json"],
        capture_output=True, text=True, timeout=60,
    )
    if out.returncode != 0 and "Cannot connect" in out.stderr:
        pytest.skip("docker daemon not reachable")
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout)


@pytest.mark.skipif(shutil.which("docker") is None, reason="docker not installed")
def test_compose_config_legacy_env(tmp_path):
    """A pre-rename host .env keeps working: its MEMEX_ keys reach the
    container under the MEMRAIN_ names, the new name wins when both are set,
    and an empty new name falls through to the legacy value."""
    cfg = _compose_config(
        tmp_path,
        "MEMEX_PUBLIC_WRITE=1\n"
        "MEMEX_MAINTENANCE=1\n"
        "MEMRAIN_OAUTH_REQUIRE_LOGIN=\nMEMEX_OAUTH_REQUIRE_LOGIN=1\n"
        "MEMRAIN_RERANK=new\nMEMEX_RERANK=old\n"
        "MEMEX_VERSION=legacy-stamp\n",
    )
    assert cfg["name"] == "deploy"
    env = cfg["services"]["memrain"]["environment"]
    assert not [k for k in env if k.startswith("MEMEX_")]
    assert env["MEMRAIN_PUBLIC_WRITE"] == "1"
    assert env["MEMRAIN_MAINTENANCE"] == "1"
    assert env["MEMRAIN_OAUTH_REQUIRE_LOGIN"] == "1"
    assert env["MEMRAIN_RERANK"] == "new"
    assert env["MEMRAIN_JOBS_WORKER"] == ""
    assert cfg["services"]["memrain"]["build"]["args"]["MEMRAIN_VERSION"] == "legacy-stamp"
    vols = {v["target"]: v["source"] for v in cfg["services"]["memrain"]["volumes"]}
    assert vols["/home/bun/.memrain"] == vols["/home/bun/.memex"] == "/mnt/fixture-efs/stack/memrain"
