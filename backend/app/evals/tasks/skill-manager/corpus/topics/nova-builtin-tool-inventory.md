---
type: topic
title: Nova Builtin Tool Inventory
priority: 0
source_type: chat
enabled: true
description: Count of builtin tools by area as of 2026-07-24, taken while working out which descriptions needed rewriting before the next agent audit.
category: knowledge
tags: [nova-toolset, tool-inventory]
timestamp: 2026-07-24T16:03:19.774812+00:00
---

# Nova Builtin Tool Inventory

As of 2026-07-24 there are 41 builtin tools. By area: memory 5, web 2, media
and sources 6, models 4, agents and tools management 7, rules and
automations 5, notifications 3, voice 2, weather 1, dispatch 1, misc 5.

Every builtin returns a plain string; structured results are JSON dumped with
`default=str`. Fourteen descriptions still open with a noun phrase naming the
tool rather than a verb phrase naming the decision, which is the pattern the
description skill is meant to stop.
