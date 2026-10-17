---
status: accepted
date: 2026-10-17
amends: docs/12 §5 (injection via environment variables or ephemeral headers)
---

## Context
Injecting network credentials into a sandbox through environment variables puts them where a
compromised or prompt-injected process can read them. One reference application injects its API
token at a host-side proxy instead (APP-2 row 12).

## Decision
For allowed hosts, the egress proxy adds credentials to outgoing requests (FR-193). Credentials
never enter the sandbox. Environment-variable injection remains only for tools that cannot use a
proxy, is declared per tool, and is audited.

## Consequences
The proxy must terminate TLS for hosts that receive injected credentials, using a per-Hub CA that
sandboxes trust. Requests that cannot be inspected cannot receive injected credentials.
