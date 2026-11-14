"""
Guards for the operator guides in docs/connectors/.

An operator follows these guides by copy and paste, so the facts they pin
must match the code they describe:
  - the Google redirect URI the guide tells you to register is the one the
    connect flow sends (connectorCallbackUri: origin + CALLBACK_PATH + provider);
    a mismatch fails every connect with redirect_uri_mismatch at Google;
  - the secret names match terraform (names.tf) and fetch-secrets (lib.sh);
  - every relative link between the guides resolves.

Run: python3 -m pytest tests/test_connector_guides_doc.py -v
"""
from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
GUIDES = REPO / "docs" / "connectors"
OAUTH_CONNECT = REPO / "deploy" / "memrain" / "src" / "core" / "connectors" / "oauth-connect.ts"


def _callback_path() -> str:
    m = re.search(r'^const CALLBACK_PATH = "([^"]+)";$', OAUTH_CONNECT.read_text(), re.M)
    assert m, "CALLBACK_PATH not found in oauth-connect.ts"
    return m.group(1)


def test_guides_exist() -> None:
    for name in ("GOOGLE.md", "FIREFLIES.md", "KEY.md", "ENABLE.md"):
        assert (GUIDES / name).is_file(), name


def test_google_redirect_uri_matches_the_connect_flow() -> None:
    text = (GUIDES / "GOOGLE.md").read_text()
    expected = f"https://brain.example.com{_callback_path()}/google"
    assert expected in text, f"GOOGLE.md must show the redirect URI {expected}"
    # Any other callback-shaped URI in the guide would send the operator wrong.
    for uri in re.findall(r"https://[^\s`)]+/callback/[^\s`)]*", text):
        assert uri == expected, uri


def test_secret_names_match_terraform_and_fetch_secrets() -> None:
    names = (REPO / "terraform" / "names.tf").read_text()
    lib = (REPO / "deploy" / "secrets" / "lib.sh").read_text()
    key = (GUIDES / "KEY.md").read_text()
    enable = (GUIDES / "ENABLE.md").read_text()
    for leaf in ("memrain-connector-kek", "memrain-notify-webhook"):
        assert f'"${{var.secrets_prefix}}/{leaf}"' in names, leaf
        assert f"new={leaf}" in lib, leaf
    assert "<secrets_prefix>/memrain-connector-kek" in key
    assert "<secrets_prefix>/memrain-notify-webhook" in enable
    assert "enable_connector_kek_secret = true" in key
    assert "enable_notify_webhook_secret = true" in enable


def test_relative_links_resolve() -> None:
    for doc in sorted(GUIDES.glob("*.md")):
        for target in re.findall(r"\]\(([^)\s]+)\)", doc.read_text()):
            if re.match(r"[a-z]+:", target):
                continue
            path = target.split("#", 1)[0]
            if path == "":
                continue
            assert (doc.parent / path).resolve().exists(), f"{doc.name}: broken link {target}"
