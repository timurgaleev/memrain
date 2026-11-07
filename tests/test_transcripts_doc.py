"""
The SessionEnd hook documented in docs/TRANSCRIPTS.md must run bun from / by
absolute path: bun loads bunfig.toml preloads and .env from the current
directory, so a hook started in the session's directory would run a cloned
repository's code with the push token.
"""
from __future__ import annotations

import re
from pathlib import Path

DOC_PATH = Path(__file__).parent.parent / "docs" / "TRANSCRIPTS.md"

HOOK_RE = re.compile(r'^\s*"command": "cd / && exec (?:/\S+ )+transcripts push --hook-stdin')


def test_hook_command_runs_from_root_with_absolute_paths() -> None:
    lines = [
        line
        for line in DOC_PATH.read_text(encoding="utf-8").splitlines()
        if '"command":' in line and "--hook-stdin" in line
    ]
    assert lines, "no SessionEnd hook command found in docs/TRANSCRIPTS.md"
    for line in lines:
        assert HOOK_RE.match(line), f"hook command must start with `cd / && exec /abs/...`: {line.strip()}"
