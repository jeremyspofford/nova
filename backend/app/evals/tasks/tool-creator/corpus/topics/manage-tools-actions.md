---
type: topic
title: manage_tools actions
priority: 1
source_type: tool
enabled: true
description: The three actions manage_tools exposes, what disable actually does, and what list does not return
category: knowledge
tags: [manage-tools, tool-lifecycle]
timestamp: 2026-07-20T14:02:51.884012+00:00
---

manage_tools has exactly three actions: list, create, disable.

There is no delete. disable sets enabled=false and keeps the row and its
spec, so it is reversible in one call — it is the closest thing to a delete
that exists here.

list returns name, description, execution_type and enabled for every tool,
plus the approved host list. It does NOT return execution_spec, so it cannot
tell you how an existing tool is wired.
