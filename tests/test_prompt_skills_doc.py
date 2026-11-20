"""
Guards for what the docs say about skills served as MCP prompts.

A skill opts in with top-level `prompt: true` frontmatter. HOW-IT-WORKS.md and
CONFIGURATION.md must name exactly the bundled skills that do, so a reader is
not told none opt in while four are served.

Run: python3 -m pytest tests/test_prompt_skills_doc.py -v
"""
from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SKILLS = REPO / "deploy" / "skills"
DOCS = (REPO / "docs" / "HOW-IT-WORKS.md", REPO / "docs" / "CONFIGURATION.md")


def _prompt_skills() -> list[str]:
    out = []
    for skill in sorted(SKILLS.glob("*/SKILL.md")):
        front = skill.read_text().split("\n---", 1)[0]
        if re.search(r"^prompt: true$", front, re.M):
            out.append(skill.parent.name)
    return out


def test_some_bundled_skill_opts_in() -> None:
    assert _prompt_skills(), "no bundled skill has prompt: true"


def test_docs_name_every_prompt_skill() -> None:
    for doc in DOCS:
        text = doc.read_text()
        assert "No bundled skill opts in" not in text, f"{doc.name} says no bundled skill opts in"
        for slug in _prompt_skills():
            assert f"`{slug}`" in text, f"{doc.name} does not name the prompt skill {slug}"
