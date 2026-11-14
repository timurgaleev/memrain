"""
The Claude Code and Codex plugin, in plugins/memrain, and the two
marketplaces at the repo root that point at it.

Both hosts connect to a Memrain server the user names (remote MCP over HTTP),
so the checks are: the fields each host needs are there, the marketplaces
install only the plugin folder (never the repo with its ignored local files),
the curated skills are exact copies of deploy/skills, both manifests carry the
version being released, the endpoint and token come from the user's settings
or environment, and no credential is committed.
"""
from __future__ import annotations

import filecmp
import json
import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
PLUGIN = REPO / "plugins" / "memrain"
CLAUDE_PLUGIN = PLUGIN / ".claude-plugin" / "plugin.json"
CODEX_PLUGIN = PLUGIN / ".codex-plugin" / "plugin.json"
CODEX_MCP = PLUGIN / ".codex-plugin" / "mcp.json"
CLAUDE_MARKET = REPO / ".claude-plugin" / "marketplace.json"
CODEX_MARKET = REPO / ".agents" / "plugins" / "marketplace.json"
ALL = (CLAUDE_PLUGIN, CLAUDE_MARKET, CODEX_PLUGIN, CODEX_MCP, CODEX_MARKET)

PLUGIN_SKILLS = PLUGIN / "skills"
SOURCE_SKILLS = REPO / "deploy" / "skills"
CURATED = {"query", "brain-ops", "capture", "briefing", "correction-pipeline", "connect-client"}

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


def semver(v: str) -> tuple[int, int, int]:
    major, minor, patch = (int(x) for x in v.split("."))
    return major, minor, patch


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


def test_both_manifests_carry_the_release_version():
    claude, codex = load(CLAUDE_PLUGIN)["version"], load(CODEX_PLUGIN)["version"]
    assert claude == codex, f"plugin versions differ: claude {claude}, codex {codex}"
    released = re.findall(r"^## \[(\d+\.\d+\.\d+)\]", (REPO / "CHANGELOG.md").read_text(encoding="utf-8"), re.M)
    assert released, "CHANGELOG.md has no released version"
    assert semver(claude) >= semver(released[0]), (
        f"plugin version {claude} is behind the latest release {released[0]}: "
        "bump both manifests in the release commit"
    )


def test_marketplaces_install_only_the_plugin_folder():
    claude = load(CLAUDE_MARKET)["plugins"]
    codex = load(CODEX_MARKET)["plugins"]
    assert [(p["name"], p["source"]) for p in claude] == [("memrain", "./plugins/memrain")]
    assert [(p["name"], p["source"]) for p in codex] == [
        ("memrain", {"source": "local", "path": "./plugins/memrain"}),
    ]


def test_plugin_folder_holds_only_the_plugin():
    top = {p.name for p in PLUGIN.iterdir()}
    assert top == {".claude-plugin", ".codex-plugin", "skills"}, sorted(top)
    stray = [p for p in PLUGIN.rglob("*") if p.name.endswith((".local.md", ".env")) or p.is_symlink()]
    assert not stray, stray


def test_codex_skills_is_one_folder():
    skills = load(CODEX_PLUGIN)["skills"]
    assert skills == "./skills/"
    assert (PLUGIN / skills).is_dir()


def test_claude_reads_the_same_skills_folder():
    # Claude Code discovers skills/ at the plugin root; a "skills" key would
    # add a second path on top of it.
    assert "skills" not in load(CLAUDE_PLUGIN)
    assert PLUGIN_SKILLS.is_dir()


def test_plugin_ships_the_curated_skills():
    shipped = {p.name for p in PLUGIN_SKILLS.iterdir() if p.is_dir()}
    assert shipped == CURATED
    for name in CURATED:
        assert (PLUGIN_SKILLS / name / "SKILL.md").is_file(), f"{name}/SKILL.md missing"


@pytest.mark.parametrize("name", sorted(CURATED))
def test_plugin_skill_matches_its_source(name: str):
    def differences(cmp: filecmp.dircmp) -> list[str]:
        out = [f"{cmp.left}/{f}" for f in cmp.left_only + cmp.right_only + cmp.diff_files + cmp.funny_files]
        for sub in cmp.subdirs.values():
            out += differences(sub)
        return out

    drift = differences(filecmp.dircmp(SOURCE_SKILLS / name, PLUGIN_SKILLS / name, ignore=[]))
    assert not drift, (
        f"plugins/memrain/skills/{name} differs from deploy/skills/{name}: {drift}; "
        f"copy it again: rm -r plugins/memrain/skills/{name} && cp -R deploy/skills/{name} plugins/memrain/skills/"
    )


def test_claude_server_comes_from_user_settings():
    m = load(CLAUDE_PLUGIN)
    server = m["mcpServers"]["memrain"]
    assert server["type"] == "http"
    assert server["url"] == "${user_config.mcp_url}"
    assert server["headers"] == {"Authorization": "Bearer ${user_config.token}"}
    assert m["userConfig"]["token"]["sensitive"] is True
    assert "default" not in m["userConfig"]["token"]


def test_codex_server_reads_the_token_from_the_environment():
    rel = load(CODEX_PLUGIN)["mcpServers"]
    assert rel == "./.codex-plugin/mcp.json"
    assert (PLUGIN / rel).resolve() == CODEX_MCP.resolve()
    server = load(CODEX_MCP)["mcpServers"]["memrain"]
    assert server["type"] == "http"
    assert server["url"].endswith("/mcp")
    assert server["bearer_token_env_var"] == "BRAIN_MCP_TOKEN"
    assert set(server) == {"type", "url", "bearer_token_env_var"}


def test_codex_docs_say_how_to_point_the_plugin_at_a_server():
    assert "[mcp_servers.memrain]" in load(CODEX_PLUGIN)["interface"]["longDescription"]
    doc = (REPO / "docs" / "clients" / "CODEX.md").read_text(encoding="utf-8")
    plugin_section = doc[doc.index("## Option C"):doc.index("## Verify")]
    assert "[mcp_servers.memrain]" in plugin_section
    assert "url = " in plugin_section
