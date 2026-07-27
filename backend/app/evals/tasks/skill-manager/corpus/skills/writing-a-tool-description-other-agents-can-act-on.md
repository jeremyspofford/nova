---
type: skill
title: Writing a Tool Description Other Agents Can Act On
priority: 0
source_type: tool
enabled: true
description: A tool description is read by a model deciding whether to call it, so write the decision rather than the implementation.
category: tool-use
tags: [tool-descriptions, agent-toolsets, prompt-craft]
timestamp: 2026-07-18T11:26:05.913370+00:00
---

# Writing a Tool Description Other Agents Can Act On

## Say what it DOES, not what it IS
"Weather lookup helper" gives a model nothing to act on. "Return current
conditions and a three-day forecast for a named place" tells it both when to
reach for the tool and when the question is not one this tool answers.

## Say what comes back
Name the shape of the result: a plain string, a JSON object rendered as a
string, a list of ids. Every builtin returns a string, so an agent that
assumed an object writes a parse that fails on its first call.
