"""
CHANGELOG.md after the rename: `[Unreleased]` first, then the Memrain 1.0.0
release, then one divider above every release from before the rename, each
renamed to its archived `memex-v<version>` tag.
"""
from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent
CHANGELOG = REPO_ROOT / "CHANGELOG.md"
DIVIDER = "## Memex (pre-rename)"
PRE_RENAME_RELEASES = 252

HEADING_RE = re.compile(r"^## .*$", re.MULTILINE)
ARCHIVED_RE = re.compile(r"^## \[memex-v\d+\.\d+\.\d+\] — \d{4}-\d{2}-\d{2}$", re.MULTILINE)
# The same shape the restructure rewrote: a v1.x reference not already part of
# a longer token such as memex-v1.2.3.
BARE_VERSION_RE = re.compile(r"(^|[^-A-Za-z0-9.])v1\.\d+", re.MULTILINE)

DEPRECATED_ITEMS = (
    "`MEMEX_*`",
    "`~/.memex`",
    "`memex.yml`",
    "`x-memex-*`",
    "`<prefix>/memex-*`",
    "`memex` network alias",
    "`memex` command",
    "`STACK_MEMEX_SUBDOMAIN`",
    "`memex_subdomain`",
    "Terraform output names",
)


def text() -> str:
    return CHANGELOG.read_text(encoding="utf-8")


def split() -> tuple[str, str]:
    above, sep, below = text().partition(f"\n{DIVIDER}\n")
    assert sep, f"missing divider {DIVIDER!r}"
    return above, below


def section(body: str, heading: str) -> str:
    start = body.index(heading)
    nxt = body.find("\n## ", start + len(heading))
    return body[start : nxt if nxt != -1 else len(body)]


def test_one_divider():
    assert text().count(f"\n{DIVIDER}\n") == 1


def test_unreleased_is_first_and_empty():
    above, _ = split()
    headings = HEADING_RE.findall(above)
    assert headings[0] == "## [Unreleased]"
    assert re.match(r"^## \[\d+\.\d+\.\d+\] — \d{4}-\d{2}-\d{2}$", headings[1]), headings[1]
    assert section(above, "## [Unreleased]").strip() == "## [Unreleased]"


def test_release_1_0_0_holds_the_rename():
    above, _ = split()
    release = section(above, "## [1.0.0]")
    assert "**Renamed to Memrain.**" in release
    assert "### Deprecated" in release


def test_rename_entry_links_an_existing_upgrading_guide():
    release = section(split()[0], "## [1.0.0]")
    assert "[UPGRADING.md](UPGRADING.md)" in release
    assert (REPO_ROOT / "UPGRADING.md").is_file()


def test_deprecated_entry_names_1_1_0_and_every_legacy_name():
    release = section(split()[0], "## [1.0.0]")
    deprecated = " ".join(release[release.index("### Deprecated") :].split())
    assert "removed in 1.1.0" in deprecated
    for item in DEPRECATED_ITEMS:
        assert item in deprecated, item


def test_every_pre_rename_release_is_archived_below_the_divider():
    _, below = split()
    assert len(ARCHIVED_RE.findall(below)) == PRE_RENAME_RELEASES
    stray = [h for h in HEADING_RE.findall(below) if not ARCHIVED_RE.fullmatch(h)]
    assert not stray, stray


def test_no_bare_v1_reference_below_the_divider():
    _, below = split()
    hits = [m.group(0) for m in BARE_VERSION_RE.finditer(below)]
    assert not hits, hits[:10]


def test_no_archived_version_above_the_divider():
    above, _ = split()
    assert not re.search(r"memex-v\d", above)
