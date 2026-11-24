"""
Asserts the memrain project skeleton exists with expected layout.

Run: python3 -m pytest tests/test_memrain_skeleton.py -v
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
TB = REPO / "deploy" / "memrain"


def test_package_json_exists() -> None:
    assert (TB / "package.json").is_file(), f"missing {TB / 'package.json'}"


def test_package_name_is_memrain() -> None:
    pkg = TB / "package.json"
    if not pkg.is_file():
        pytest.skip("package.json missing — see test_package_json_exists")
    data = json.loads(pkg.read_text())
    assert data.get("name") == "memrain", f"name={data.get('name')!r}, expected 'memrain'"


def test_package_declares_bun_bin_and_legacy_alias() -> None:
    pkg = TB / "package.json"
    if not pkg.is_file():
        pytest.skip("package.json missing — see test_package_json_exists")
    data = json.loads(pkg.read_text())
    bins = data.get("bin", {})
    # `memex` stays as an alias through 0.1.x so existing shells keep working.
    assert bins.get("memrain") == "./src/cli.ts", "package.json must declare bin.memrain"
    assert bins.get("memex") == "./src/cli.ts", "package.json must keep the bin.memex alias"


def test_admin_package_name_is_memrain_admin() -> None:
    data = json.loads((TB / "admin" / "package.json").read_text())
    assert data.get("name") == "memrain-admin", f"name={data.get('name')!r}"


@pytest.mark.parametrize("pkg_dir", [TB, TB / "admin"], ids=["app", "admin"])
def test_lockfile_root_name_matches_package(pkg_dir: Path) -> None:
    # bun.lock is JSONC (trailing commas), so read the root workspace name by regex.
    name = json.loads((pkg_dir / "package.json").read_text())["name"]
    lock = (pkg_dir / "bun.lock").read_text()
    match = re.search(r'"workspaces":\s*\{\s*"":\s*\{\s*"name":\s*"([^"]+)"', lock)
    assert match, f"no root workspace name in {pkg_dir / 'bun.lock'}"
    assert match.group(1) == name, f"bun.lock name {match.group(1)!r} != package name {name!r}"


def test_package_declares_engines_bun() -> None:
    pkg = TB / "package.json"
    if not pkg.is_file():
        pytest.skip("package.json missing — see test_package_json_exists")
    data = json.loads(pkg.read_text())
    engines = data.get("engines", {})
    assert "bun" in engines, "package.json must declare engines.bun (Bun-only project)"


def test_tsconfig_exists() -> None:
    assert (TB / "tsconfig.json").is_file(), f"missing {TB / 'tsconfig.json'}"


def test_bunfig_exists() -> None:
    assert (TB / "bunfig.toml").is_file(), f"missing {TB / 'bunfig.toml'}"


def test_gitignore_exists() -> None:
    assert (TB / ".gitignore").is_file(), f"missing {TB / '.gitignore'}"


def test_gitignore_excludes_node_modules() -> None:
    gi = TB / ".gitignore"
    if not gi.is_file():
        pytest.skip(".gitignore missing — see test_gitignore_exists")
    text = gi.read_text()
    assert "node_modules" in text, "deploy/memrain/.gitignore must exclude node_modules"


def test_src_layout() -> None:
    expected = [
        "src/cli.ts",
        "src/commands/init.ts",
        "src/commands/serve.ts",
        "src/core/engine/interface.ts",
        "src/core/engine/factory.ts",
        "src/core/storage.ts",
        "src/core/embedding.ts",
        "src/core/config.ts",
        "src/http/server.ts",
        "src/http/health.ts",
    ]
    missing = [p for p in expected if not (TB / p).is_file()]
    assert not missing, f"missing source files: {missing}"


def test_readme_exists() -> None:
    assert (TB / "README.md").is_file(), f"missing {TB / 'README.md'}"
