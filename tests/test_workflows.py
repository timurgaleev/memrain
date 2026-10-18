"""
Assertions on .github/workflows/*.yml shape: every action is SHA-pinned, and
the supply-chain scanners stay advisory (never a required check).
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).parent.parent
WORKFLOWS_DIR = REPO_ROOT / ".github" / "workflows"
WORKFLOW_PATHS = sorted(WORKFLOWS_DIR.glob("*.yml"))
ADVISORY_WORKFLOWS = ("supply-chain.yml", "deps-audit.yml")
SCANNER_WORDS = ("gitleaks", "actionlint", "osv", "bun audit", "bun-audit")
SHA_REF = re.compile(r"^[0-9a-f]{40}$")


def _load(name: str) -> dict:
    with (WORKFLOWS_DIR / name).open() as fh:
        return yaml.safe_load(fh)


def _triggers(wf: dict) -> dict:
    # PyYAML reads the bare `on:` key as the boolean True.
    return wf.get("on", wf.get(True))


def _steps(wf: dict):
    for job in wf["jobs"].values():
        yield from job.get("steps", [])


def test_expected_workflows_exist():
    names = {p.name for p in WORKFLOW_PATHS}
    assert {"ci.yml", *ADVISORY_WORKFLOWS} <= names


@pytest.mark.parametrize("path", WORKFLOW_PATHS, ids=lambda p: p.name)
def test_every_action_is_sha_pinned(path):
    wf = _load(path.name)
    for step in _steps(wf):
        uses = step.get("uses")
        if not uses or uses.startswith("./") or uses.startswith("docker://"):
            continue
        _, _, ref = uses.partition("@")
        assert SHA_REF.match(ref), f"{path.name}: `{uses}` is not pinned to a commit SHA"


@pytest.mark.parametrize("name", ADVISORY_WORKFLOWS)
def test_scanner_jobs_are_non_blocking(name):
    for job_id, job in _load(name)["jobs"].items():
        assert job.get("continue-on-error") is True, (
            f"{name}:{job_id} must be continue-on-error: true (CI stays advisory)"
        )


def test_ci_yml_has_no_scanner_job():
    ci = _load("ci.yml")
    for job_id, job in ci["jobs"].items():
        text = " ".join(
            [job_id, str(job.get("name", ""))]
            + [str(s.get("run", "")) + " " + str(s.get("uses", "")) for s in job.get("steps", [])]
        ).lower()
        for word in SCANNER_WORDS:
            assert word not in text, f"ci.yml:{job_id} runs `{word}`; scanners belong in advisory workflows"


@pytest.mark.parametrize("name", ADVISORY_WORKFLOWS)
def test_least_privilege_permissions(name):
    wf = _load(name)
    assert wf.get("permissions") == {"contents": "read"}
    for job_id, job in wf["jobs"].items():
        assert "permissions" not in job, f"{name}:{job_id} must not widen permissions"


@pytest.mark.parametrize("name", ADVISORY_WORKFLOWS)
def test_downloaded_binaries_are_checksum_verified(name):
    downloads = 0
    for step in _steps(_load(name)):
        run = step.get("run", "")
        fetch = re.search(r"\b(curl|wget)\b", run)
        if not fetch:
            continue
        downloads += 1
        check = run.find("sha256sum -c", fetch.start())
        assert check != -1, f"{name}: step `{step.get('name')}` downloads without `sha256sum -c`"
        # Nothing from the download may be unpacked or made executable first.
        between = run[fetch.end():check]
        assert "tar " not in between and "chmod" not in between
    assert downloads > 0


def test_deps_audit_triggers_on_lockfile():
    on = _triggers(_load("deps-audit.yml"))
    for event in ("push", "pull_request"):
        assert "deploy/memrain/bun.lock" in on[event]["paths"]
        assert "deploy/memrain/package.json" in on[event]["paths"]
    assert on.get("schedule"), "deps-audit.yml needs a scheduled run"
    assert "workflow_dispatch" in on


def test_gitleaks_scans_with_repo_config_and_full_history():
    job = _load("supply-chain.yml")["jobs"]["gitleaks"]
    assert job["steps"][0]["with"]["fetch-depth"] == 0
    runs = " ".join(s.get("run", "") for s in job["steps"])
    assert "--config .gitleaks.toml" in runs
    assert "--redact" in runs
    assert (REPO_ROOT / ".gitleaks.toml").exists()


def test_gitleaks_push_ranges_are_never_superseded():
    wf = _load("supply-chain.yml")
    group = wf["concurrency"]["group"]
    # Only PR runs may share a group (and so cancel each other); every push
    # run is keyed by its own run id.
    assert "github.run_id" in group
    assert "github.event_name == 'pull_request' && github.ref" in group
    assert _triggers(wf).get("schedule"), "supply-chain.yml needs a scheduled full-history run"
    runs = " ".join(s.get("run", "") for s in wf["jobs"]["gitleaks"]["steps"])
    assert 'RANGE="--all"' in runs


@pytest.mark.parametrize("name", ("ci.yml", "bun-arm64.yml"))
def test_bun_test_jobs_use_the_memrain_package(name):
    jobs = [
        job
        for job in _load(name)["jobs"].values()
        if "Bun tests" in str(job.get("name", ""))
    ]
    assert jobs, f"{name} has no Bun test job"
    for job in jobs:
        assert job["name"].startswith("Memrain Bun tests ("), job["name"]
        assert "memex" not in job["name"].lower()
        workdir = job.get("defaults", {}).get("run", {}).get("working-directory")
        assert workdir == "deploy/memrain", f"{name}:{job['name']} runs in {workdir!r}"


def test_postgres_job_is_a_gate():
    job = _load("ci.yml")["jobs"]["postgres-tests"]
    assert job.get("continue-on-error") is not True
    assert "advisory" not in str(job.get("name", "")).lower()
    assert any("make test-pg" in s.get("run", "") for s in job["steps"])


def test_sbom_workflow_publishes_to_releases():
    wf = _load("sbom.yml")
    on = _triggers(wf)
    assert on["release"]["types"] == ["published"]
    assert "tag" in on["workflow_dispatch"]["inputs"]
    assert set(on) == {"release", "workflow_dispatch"}, "never run on pull_request(_target)"
    assert wf.get("permissions") == {"contents": "read"}
    gen, pub = wf["jobs"]["generate"], wf["jobs"]["publish"]
    # The job that runs dependency installs keeps the read-only token.
    assert "permissions" not in gen
    assert pub.get("permissions") == {"contents": "write"}
    assert pub.get("needs") == "generate"
    gen_runs = " ".join(s.get("run", "") for s in gen["steps"])
    pub_runs = " ".join(s.get("run", "") for s in pub["steps"])
    assert "cyclonedx-json" in gen_runs
    assert gen_runs.count("--frozen-lockfile --production --ignore-scripts") == 2
    assert "-server.cdx.json" in gen_runs and "-admin.cdx.json" in gen_runs
    assert "sha256sum" in gen_runs
    assert "gh release upload" in pub_runs
    # The write job never checks out or installs anything.
    assert not any("actions/checkout" in s.get("uses", "") for s in pub["steps"])
    assert "install" not in pub_runs
    checkout = next(s for s in gen["steps"] if "actions/checkout" in s.get("uses", ""))
    assert checkout.get("with", {}).get("persist-credentials") is False
    # Only the upload step sees the token.
    assert "GH_TOKEN" not in str(gen)
    assert sum("GH_TOKEN" in str(s.get("env", {})) for s in pub["steps"]) == 1


def test_sbom_tag_is_validated_and_never_interpolated_into_scripts():
    for job in _load("sbom.yml")["jobs"].values():
        runs = " ".join(s.get("run", "") for s in job["steps"])
        assert "${{" not in runs, "pass event data through env, not into run:"
        assert "v[0-9]+" in runs, "every job validates the tag before using it"


def test_sbom_download_is_checksum_verified():
    test_downloaded_binaries_are_checksum_verified("sbom.yml")
