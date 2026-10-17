---
status: accepted
date: 2026-10-17
supersedes: the UI part of ADR-013 (Nova-specific panel bridge)
---

## Context
`docs/08` §3.1 and `docs/14` §4 defined a Nova-specific bridge for plugin panels. The MCP
ecosystem now has an open UI extension, MCP Apps, used by two reference applications (APP-1
row 13, APP-2 row 28).

## Decision
Plugin and MCP-server UI follows MCP Apps (FR-198): `ui://` HTML resources in sandboxed
iframes, a JSON-RPC bridge over `postMessage`, CSP domain lists from resource metadata, display
modes inline / fullscreen / picture-in-picture, and entry points global / thread / file. Nova's
extension SDK panels use the same bridge. Every tool call from a UI passes the policy engine.

## Consequences
Servers written for other hosts render in Nova without changes. Nova-specific extras (private
widget state) are offered as namespaced extensions that components must feature-detect.
