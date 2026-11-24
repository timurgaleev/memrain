"""
The Claude Code and Codex plugin, in plugins/memrain, and the two
marketplaces at the repo root that point at it.

Both hosts connect to a Memrain server the user names (remote MCP over HTTP),
so the checks are: the fields each host needs are there, the marketplaces
install only the plugin folder (never the repo with its ignored local files),
the plugin ships exactly its three skills and each names only tools this build
serves, both manifests carry the version being released, the endpoint and
token come from the user's settings or environment, and no credential is
committed.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
import yaml

REPO = Path(__file__).resolve().parent.parent
PLUGIN = REPO / "plugins" / "memrain"
CLAUDE_PLUGIN = PLUGIN / ".claude-plugin" / "plugin.json"
CODEX_PLUGIN = PLUGIN / ".codex-plugin" / "plugin.json"
CODEX_MCP = PLUGIN / ".codex-plugin" / "mcp.json"
CLAUDE_MARKET = REPO / ".claude-plugin" / "marketplace.json"
CODEX_MARKET = REPO / ".agents" / "plugins" / "marketplace.json"
ALL = (CLAUDE_PLUGIN, CLAUDE_MARKET, CODEX_PLUGIN, CODEX_MCP, CODEX_MARKET)

PLUGIN_SKILLS = PLUGIN / "skills"
SHIPPED_SKILLS = {"connect-client", "ingest", "query"}
OPERATIONS = REPO / "deploy" / "memrain" / "src" / "mcp" / "operations.ts"
# Tools a 2.x skill named that this build no longer serves. A skill that
# mentions one in a code span is telling the agent to call a tool that is gone.
RETIRED_TOOLS = {
    "query", "think", "recall", "add_fact", "extract_facts", "forget_fact", "entity_facts",
    "entity_recall", "entity_timeline", "add_timeline_event", "graph_query", "graph_neighbors",
    "traverse_graph", "put_raw_data", "get_raw_data", "get_ingest_log", "log_ingest",
    "list_skills", "get_skill", "context_pack", "volunteer_context", "find_contradictions",
    "source_health", "takes_search", "code_def", "code_callers", "loops_list",
}

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


def served_tools() -> set[str]:
    names = set(re.findall(r'^    name: "([a-z_]+)",$', OPERATIONS.read_text(encoding="utf-8"), re.M))
    assert "search" in names and "page_put" in names, "operations.ts scan found no tools"
    return names


def skill_parts(name: str) -> tuple[dict, str]:
    text = (PLUGIN_SKILLS / name / "SKILL.md").read_text(encoding="utf-8")
    assert text.startswith("---\n"), f"{name}/SKILL.md has no frontmatter"
    end = text.index("\n---", 4)
    return yaml.safe_load(text[4:end]) or {}, text[end + 4:]


def test_plugin_ships_its_three_skills():
    shipped = {p.name for p in PLUGIN_SKILLS.iterdir() if p.is_dir()}
    assert shipped == SHIPPED_SKILLS
    for name in SHIPPED_SKILLS:
        assert (PLUGIN_SKILLS / name / "SKILL.md").is_file(), f"{name}/SKILL.md missing"


@pytest.mark.parametrize("name", sorted(SHIPPED_SKILLS))
def test_plugin_skill_names_only_served_tools(name: str):
    front, body = skill_parts(name)
    assert front["name"] == name
    assert front.get("description", "").strip()
    assert front.get("triggers"), f"{name} has no triggers"
    tools = set(front.get("tools") or [])
    assert tools, f"{name} lists no tools"
    unknown = sorted(tools - served_tools())
    assert not unknown, f"{name} lists tools this build does not serve: {unknown}"
    # MCP prompts are not served, so a prompt opt-in would be dead config.
    assert "prompt" not in front, f"{name} opts in to MCP prompts, which this build does not serve"
    spans = set(re.findall(r"`([a-z_]+)`", body))
    retired = sorted(spans & RETIRED_TOOLS)
    assert not retired, f"{name} tells the agent to call retired tools: {retired}"
    undeclared = sorted((spans & served_tools()) - tools)
    assert not undeclared, f"{name} uses tools its frontmatter does not list: {undeclared}"


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
