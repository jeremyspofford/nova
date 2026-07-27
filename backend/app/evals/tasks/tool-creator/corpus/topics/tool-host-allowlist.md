---
type: topic
title: Tool host allowlist
priority: 1
source_type: tool
enabled: true
description: The operator-approved host table that gates every http_call tool, and why no agent can write to it
category: knowledge
tags: [tool-host-allowlist, manage-tools, host-approval]
timestamp: 2026-07-20T14:11:07.512884+00:00
---

tool_host_allowlist is why an agent cannot reach an arbitrary host:
manage_tools create parses the hostname out of url_template and refuses
unless that exact host has a row. Only the operator adds one, in Settings →
Tools — no agent has an action that writes this table, because a tool that
approved its own host would make the allowlist decorative.

Approved: api.github.com, api.open-meteo.com. The match is the full hostname,
so air-quality-api.open-meteo.com is a different host and is refused.
