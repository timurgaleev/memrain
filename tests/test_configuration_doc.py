"""
docs/CONFIGURATION.md must have a table row for every MEMRAIN_* variable the
daemon source names, and no row for a variable the source no longer reads.
Legacy MEMEX_* names appear only in its "Legacy names" section.
"""
from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent
SRC_DIR = REPO_ROOT / "deploy" / "memrain" / "src"
DOC_PATH = REPO_ROOT / "docs" / "CONFIGURATION.md"

VAR_RE = re.compile(r"\bMEMRAIN_[A-Z0-9_]*[A-Z0-9]\b")
ROW_RE = re.compile(r"^\| `(MEMRAIN_[A-Z0-9_]+)`", re.MULTILINE)
LEGACY_HEADING = "## Legacy names"

# Names in the source that are not environment variables.
NOT_ENV = {
    "MEMRAIN_OPERATING_CONTRACT",  # exported constant (mcp/server-instructions.ts)
    "MEMRAIN_RESPONSE_VERSION",  # exported constant (mcp/response-contract.ts)
    "MEMRAIN_MAX_TOKENS",  # an example name in a comment (core/runtime-config.ts)
    "MEMRAIN_X",  # the placeholder in the legacy-name comments (core/env-compat.ts)
}

# Documented rows the source reads without spelling the full name:
# resolve-model.ts builds MEMRAIN_<FEATURE>_MODEL at run time, and
# search/ranking-flags.ts builds MEMRAIN_RANK_<FLAG>.
DOC_ONLY = {
    "MEMRAIN_THINK_MODEL",
    "MEMRAIN_DRIFT_MODEL",
    "MEMRAIN_CONCEPTS_MODEL",
    "MEMRAIN_EXPANSION_MODEL",
    "MEMRAIN_INTENT_MODEL",
    "MEMRAIN_RERANK_MODEL",
    "MEMRAIN_RANK_METADATA_GATE",
    "MEMRAIN_RANK_ENTITY_TRUTH_SOFT",
    "MEMRAIN_RANK_KEYWORD_OR_RETRY",
    "MEMRAIN_RANK_PAGE_FUSION",
    "MEMRAIN_RANK_KEYWORD_CONFIDENCE",
    "MEMRAIN_RANK_EXACT_LOOKUP",
}

QUIESCENCE_SWITCHES = (
    "MEMRAIN_MAINTENANCE",
    "MEMRAIN_BOOT_CODE_SWEEP",
    "MEMRAIN_JOBS_WORKER",
    "MEMRAIN_CYCLE",
)


def doc_text() -> str:
    return DOC_PATH.read_text(encoding="utf-8")


def split_at_legacy_section() -> tuple[str, str]:
    text = doc_text()
    start = text.index(LEGACY_HEADING)
    end = text.find("\n## ", start + len(LEGACY_HEADING))
    if end == -1:
        end = len(text)
    return text[:start] + text[end:], text[start:end]


def source_vars() -> set[str]:
    found: set[str] = set()
    for path in SRC_DIR.rglob("*.ts"):
        found.update(VAR_RE.findall(path.read_text(encoding="utf-8")))
    return found - NOT_ENV


def documented_vars() -> set[str]:
    return set(ROW_RE.findall(doc_text()))


def test_source_scan_finds_variables():
    # Guards the scan itself: an empty set would pass the checks below.
    assert "MEMRAIN_POSTGRES_URL" in source_vars()


def test_every_source_variable_has_a_row():
    missing = sorted(source_vars() - documented_vars())
    assert not missing, (
        "MEMRAIN_* variables read in deploy/memrain/src with no row in "
        f"docs/CONFIGURATION.md: {missing}"
    )


def test_no_row_for_an_unread_variable():
    stale = sorted(documented_vars() - source_vars() - DOC_ONLY)
    assert not stale, (
        "docs/CONFIGURATION.md documents MEMRAIN_* variables the source no "
        f"longer reads: {stale}"
    )


def test_doc_only_entries_are_still_documented():
    unused = sorted(DOC_ONLY - documented_vars())
    assert not unused, f"DOC_ONLY lists variables with no row: {unused}"


def test_legacy_section_states_removal_and_fail_closed():
    legacy = " ".join(split_at_legacy_section()[1].split())
    assert "removed in 1.1.0" in legacy
    assert "refuses to start while a legacy name is still in use" in legacy
    assert "MEMEX_NO_DB_CONFIG" in legacy


def test_legacy_env_names_only_in_legacy_section():
    rest, _ = split_at_legacy_section()
    hits = sorted(set(re.findall(r"\bMEMEX_\w*", rest)))
    assert not hits, f"MEMEX_ names outside the Legacy names section: {hits}"


def test_quiescence_switches_are_env_only():
    text = doc_text()
    section = text[text.index("### Maintenance mode"):]
    section = " ".join(section[: section.index("\n## ")].split())
    assert "environment only" in section
    assert "`runtime_config` row can never set them" in section
    for name in QUIESCENCE_SWITCHES:
        assert f"| `{name}` |" in section, f"{name} has no row in Maintenance mode"
