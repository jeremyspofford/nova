---
status: accepted
date: 2026-10-17
supersedes: ADR-083 (the hooks bullet, on failures)
---

## Context
M4 built plugins, skills, lifecycle hooks, MCP Apps, Nova's own MCP server, bundles, OAuth for
remote servers, the multi-pane workspace, profile and usage, and import. Building them settled
choices the spec left open, and one of them changes how ADR-083 treated failing hooks. The full
list is the ADR-091 entry in [`../20-decisions-and-defaults.md`](../20-decisions-and-defaults.md).

## Decision
- Hooks fail closed. A hook that errors, times out or cannot start (no sandbox, unknown MCP tool)
  blocks at `tool.pre` and denies at `permission.request`, whatever `failClosed` says;
  `failClosed: true` also blocks `prompt.submit`. ADR-083 left the decision unchanged on failure
  unless `failClosed: true`. The 30 s default timeout and 10 min maximum stay.
- Every plugin install is a sideload until publishers are verified (FR-049): the API refuses an
  install without `confirmSideload: true`.
- A plugin's own permissions apply at step 4 below the user's defaults: its per-tool default, then
  its per-action default, then its server's manifest `defaultApproval`. An undeclared host is
  denied at step 1, and the plugin is turned off with an attention notification.
- A plugin's MCP servers change only through the plugin (409 `plugin_owned` on the generic
  routes); `plugin_install.manifest_json` keeps env and header values only as `secret://`
  references.
- An action the signed-in user performs directly in a Nova client (actor `user`, their own
  instruction, no taint) needs no card; tier floors, the network allowlist, rules, denies, policy
  changes and secret access still apply. An MCP App's own tool call carries no user instruction.

## Consequences
A broken or slow hook stops the actions it guards instead of letting them through, so a hook
author sees failures at once; without a container sandbox, command hooks cannot run and their
events block. Installing any plugin takes one more confirmation until signing ships (M8). A
plugin that oversteps once is disabled and must be turned back on by the user. MCP servers,
including bundle servers, still run unsandboxed until M6 (R-012). The items listed as "Not in
M4" in the docs/20 entry are follow-ups.
