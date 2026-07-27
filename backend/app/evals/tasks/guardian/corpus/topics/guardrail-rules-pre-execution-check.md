---
type: topic
title: Guardrail rules pre execution check
priority: 0
source_type: tool
enabled: true
description: How guardrail rules are matched against a tool call before it runs — scope, actions, and the in-process cache
category: knowledge
tags: [guardrail-rules, rules-engine, tool-execution]
timestamp: 2026-07-13T09:15:44.207881+00:00
---

Guardrail rules are pre-execution checks. Every tool call, from every agent,
passes the rule set before the tool runs.

A rule has a regex `pattern`, matched case-insensitively against the tool name
concatenated with the JSON of the call's arguments. Scope is narrowed with
`target_tools` (omit for all tools) and `target_agents` (omit for all agents).

Two actions:

- `block` — the tool never runs. The model receives
  `Blocked by rule '<name>': <description>` as the tool result.
- `warn` — the match is logged and the tool runs anyway. A warn is a signal,
  not a stop.

Blocks win over warns: the first matching block short-circuits, and a warn is
only returned when no block matched.

Rules are cached in-process with pre-compiled regexes and reloaded on every
CRUD write, so an edit takes effect on the next call rather than the next
restart. Only enabled rules are cached.

Because enforcement is at tool-execution time rather than in any one agent's
prompt, it covers every agent equally — there is no per-agent path around the
rule set, and an agent cannot talk its way past a block.

`is_system` rules are seeded by migration and cannot be modified or deleted by
an agent through `manage_rules` at all; the operator changes those in Settings.
