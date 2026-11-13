"""
The Claude Code and Codex plugin manifests at the repo root.

Both connect to a Memrain server the user names (remote MCP over HTTP), so
the checks are: the fields each host needs are there, every listed skill
exists, the endpoint and token come from the user's settings or environment,
and no credential is committed.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
CLAUDE_PLUGIN = REPO / ".claude-plugin" / "plugin.json"
CLAUDE_MARKET = REPO / ".claude-plugin" / "marketplace.json"
CODEX_PLUGIN = REPO / ".codex-plugin" / "plugin.json"
CODEX_MCP = REPO / ".codex-plugin" / "mcp.json"
CODEX_MARKET = REPO / ".agents" / "plugins" / "marketplace.json"
ALL = (CLAUDE_PLUGIN, CLAUDE_MARKET, CODEX_PLUGIN, CODEX_MCP, CODEX_MARKET)

# A literal bearer value, a Memrain token, a long hex or base64 secret, an AWS key.
CREDENTIAL = re.compile(
    r"Bearer\s+(?!\$\{)\S"
    r"|\b(?:memrain|memex)_[A-Za-z0-9]{12,}"
    r"|\b[0-9a-f]{32,}\b"
    r"|[A-Za-z0-9+/]{40,}={0,2}"
    r"|\bAKIA[0-9A-Z]{16}\b"
)


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


@pytest.mark.parametrize("path", ALL, ids=lambda p: str(p.relative_to(REPO)))
def test_no_credential_is_committed(path: Path):
    hits = CREDENTIAL.findall(path.read_text(encoding="utf-8"))
    assert not hits, f"{path.name} carries what looks like a credential: {hits}"


@pytest.mark.parametrize("path", (CLAUDE_PLUGIN, CODEX_PLUGIN), ids=("claude", "codex"))
def test_plugin_metadata(path: Path):
    m = load(path)
    assert m["name"] == "memrain"
    assert re.fullmatch(r"\d+\.\d+\.\d+", m["version"])
    assert m["description"].strip()
    assert m["author"]["name"].strip()
    assert m["license"] == "MIT"


@pytest.mark.parametrize("path", (CLAUDE_PLUGIN, CODEX_PLUGIN), ids=("claude", "codex"))
def test_listed_skills_exist(path: Path):
    skills = load(path)["skills"]
    assert skills, "a plugin ships at least one skill"
    for rel in skills:
        assert rel.startswith("./deploy/skills/"), rel
        assert (REPO / rel / "SKILL.md").is_file(), f"{rel}/SKILL.md missing"


def test_both_hosts_ship_the_same_skills():
    assert load(CLAUDE_PLUGIN)["skills"] == load(CODEX_PLUGIN)["skills"]


def test_claude_server_comes_from_user_settings():
    m = load(CLAUDE_PLUGIN)
    server = m["mcpServers"]["memrain"]
    assert server["type"] == "http"
    assert server["url"] == "${user_config.mcp_url}"
    assert server["headers"] == {"Authorization": "Bearer ${user_config.token}"}
    assert m["userConfig"]["token"]["sensitive"] is True
    assert "default" not in m["userConfig"]["token"]


def test_codex_server_reads_the_token_from_the_environment():
    assert load(CODEX_PLUGIN)["mcpServers"] == "./.codex-plugin/mcp.json"
    server = load(CODEX_MCP)["mcpServers"]["memrain"]
    assert server["url"].endswith("/mcp")
    assert server["bearer_token_env_var"] == "BRAIN_MCP_TOKEN"
    assert set(server) == {"url", "bearer_token_env_var"}


def test_marketplaces_point_at_the_repo_root():
    claude = load(CLAUDE_MARKET)["plugins"]
    codex = load(CODEX_MARKET)["plugins"]
    assert [(p["name"], p["source"]) for p in claude] == [("memrain", "./")]
    assert [(p["name"], p["source"]) for p in codex] == [("memrain", {"source": "local", "path": "./"})]
