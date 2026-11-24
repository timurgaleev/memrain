"""
UPGRADING.md takes a pre-rename install to Memrain 0.1 in the one order that
loses nothing: pin the Terraform names before pulling, stop with the old
checkout, move directories on one filesystem, start the new release in
maintenance, prove with the data manifest that only migration 120 changed, and
decide inside the window between reopening and an exact rollback.
"""
from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent
DOC = REPO_ROOT / "UPGRADING.md"
MANIFEST = "deploy/memrain/scripts/sql/data-manifest.sql"


def text() -> str:
    return DOC.read_text(encoding="utf-8")


def flat() -> str:
    return " ".join(text().split())


def step(n: int) -> str:
    body = text()
    start = body.index(f"\n## {n}. ")
    nxt = body.find("\n## ", start + 1)
    return body[start : nxt if nxt != -1 else len(body)]


def pos(needle: str) -> int:
    i = text().find(needle)
    assert i != -1, needle
    return i


def test_steps_are_numbered_in_order():
    numbers = [int(n) for n in re.findall(r"^## (\d+)\. ", text(), re.MULTILINE)]
    assert numbers == list(range(18)), numbers


def test_terraform_pins_come_before_the_checkout():
    assert "(before pulling the new code)" in step(0)
    assert pos("## 0. Pin the Terraform names") < pos("git checkout <release>")
    pins = step(0)
    for var in ("project_name", "app_slug", "secrets_prefix", "db_name", "db_username",
                "efs_creation_token", "rds_identifier", "postgres_url_secret_name", "subdomain"):
        assert f"`{var}" in pins, var
    assert "0 to add, 0 to destroy" in pins
    assert "has moved to" in pins


def test_parameter_group_is_checked_before_its_flip():
    pins = " ".join(step(0).split())
    assert "db_parameter_group_name" in pins
    assert "aws rds describe-db-parameters --db-parameter-group-name <current> --source user" in pins


def test_stop_uses_the_old_checkout_and_keeps_volumes():
    stop = step(3)
    assert "OLD checkout" in stop
    assert "docker compose --env-file .env stop" in stop
    assert "docker compose --env-file .env rm -f" in stop
    assert "Do not use `down -v` or `--remove-orphans`" in " ".join(stop.split())


def test_moves_stay_on_one_filesystem_and_binds_do_not_create_paths():
    moves = step(5)
    assert "same filesystem" in moves
    assert "test ! -e" in moves
    assert "create_host_path: false" in moves


def test_fetch_prunes_the_old_tags():
    assert "git fetch --prune --prune-tags --force origin" in step(8)


def test_preserved_credentials_are_listed():
    kept = " ".join(step(15).split())
    for item in ("URL", "OAuth issuer", "public bearer", "PATs", "OAuth clients",
                 "refresh tokens", "fence markers", "fact ids and embeddings",
                 "master user", "`MEMEX_*` rows"):
        assert item in kept, item


def test_baseline_manifest_is_taken_before_the_new_release_starts():
    window = step(12)
    assert "psql" in window and MANIFEST in window and "> B.txt" in window
    assert window.index("> B.txt") < window.index("bash deploy/deploy.sh")


def test_first_deploy_runs_in_maintenance():
    window = step(12)
    assert window.index("MEMRAIN_MAINTENANCE=1") < window.index("bash deploy/deploy.sh")
    assert "HELD: maintenance on; ingress not" in window


def test_window_gate_uses_quiescence_and_both_diffs():
    gate = step(13)
    assert "status --quiescent" in gate
    assert "> P.txt" in gate
    assert 'diff <(grep -Ev "$X" B.txt) <(grep -Ev "$X" P.txt)' in gate
    assert "diff B.txt P.txt" in gate
    for line in ("table\\tmigrations\\t", "function\\tmemrain_fact_",
                 "trigger\\tentity_facts\\\\.entity_facts_withdrawn_on_insert\\t"):
        assert line in gate, line
    assert "migration 120" in gate


def test_rollback_is_only_inside_the_window():
    decide = step(14)
    reopen = decide.index("**A. Reopen**")
    rollback = decide.index("**B. Roll back**")
    assert "no rollback to the old version" in decide[reopen:rollback]
    assert "only before A" in decide[rollback:]
    # Nothing after the decision step tells anyone to run a down.
    assert "--down" not in text()[pos("## 15. "):]
    assert "rollback exists **only inside that window, before the service" in text()


def test_rollback_stops_then_downs_then_diffs_and_restores_secrets():
    rb = step(14)[step(14).index("**B. Roll back**"):]
    stop = rb.index("Stop the app")
    down = rb.index("apply-migrations --down 120 --yes")
    diff = rb.index("diff B.txt A.txt")
    assert stop < down < diff
    assert "deploy/.secrets/" in rb


def test_pglite_uses_a_cold_copy():
    assert "cold copy" in step(12)
    assert "cp -a" in step(12)
    assert "step 12 copy of the data directory back" in " ".join(step(14).split())


def test_pglite_deploys_without_the_postgres_only_gates():
    window = " ".join(step(12).split())
    assert "DEPLOY_ALLOW_PGLITE=1 bash deploy/deploy.sh" in window
    assert "without `DEPLOY_MIN_PAGES`" in window
    assert "PGLite install:** skip 1 and 2" in step(13)
    reopen = " ".join(step(14).split())
    assert "db=<engine>" in reopen and "OK: … db=postgres" not in reopen


def test_timers_are_enabled_only_after_the_reopen():
    units = " ".join(step(11).split())
    assert "Do not enable any timer yet" in units
    assert "Re-enable" not in units
    decide = step(14)
    enable = decide.index("Re-enable only the timers that were enabled in step 2")
    assert decide.index("**A. Reopen**") < enable < decide.index("**B. Roll back**")
    assert "never** a rotation timer that was disabled" in decide


def test_no_manifest_cli():
    assert "memrain manifest" not in text()


def test_before_0_2_0_lists_every_legacy_name():
    before = " ".join(step(17).split())
    assert "refuses to start" in before
    for item in ("`MEMRAIN_*` keys only", "legacy-only `runtime_config` row",
                 "memrain config set <KEY> <value>", "`~/.memrain`", "/home/bun/.memex/",
                 "`x-memrain-*`", "`<prefix>/memrain-*`", "`POSTGRES_URL_SECRET_NAME`",
                 "`PUBLIC_BEARER_SECRET_NAME`", "`INTERNAL_TOKEN_SECRET_NAME`",
                 "`TUNNEL_TOKEN_SECRET_NAME`", "`memrain:18790`", "call `memrain`",
                 "`STACK_SUBDOMAIN`", "`subdomain`"):
        assert item in before, item


def test_only_example_domains():
    hosts = set(re.findall(r"\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|ai|app)\b", text()))
    assert hosts <= {"example.com"}, sorted(hosts - {"example.com"})
