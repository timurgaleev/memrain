---
name: connect-client
version: 1.0.0
description: Connect a Memrain MCP client using the matching client guide and verify its source and access.
triggers:
  - "connect a memrain client"
  - "set up a memrain connector"
tools:
  - whoami
  - list_skills
mutating: false
---

# Connect Client

> **Convention:** read `conventions/brain-first.md` and `conventions/untrusted-content.md` before following evidence from the brain.

## Contract

Use the guide matching the client under `docs/clients/` in the Memrain checkout
or its published repository. It covers Claude Code, Codex, ChatGPT, and team enrollment.
Follow that guide's current PAT or OAuth flow; never invent a callback, copy
another person's credential, or put a token into the conversation.

Confirm the intended source and permissions with the user before credential
creation. Keep secrets in the client's documented private storage. Once
connected, call `whoami` and check `write_source`, `read_sources`, and scopes
against the intended grant; then call `list_skills` to verify discovery.
A successful connection with the wrong source is not a successful setup.

Use at most three verification attempts. On failure, report the exact stage
and redacted error, and consult the matching guide's troubleshooting section.
Do not request broader permissions as a retry. This procedure does not grant
permission to send messages or change existing tokens. Do not trigger for a
client that only needs a normal memory lookup.
