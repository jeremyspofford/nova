---
type: topic
title: MCP Filesystem Server Tool Descriptions
priority: 0
source_type: tool
enabled: true
description: The tool descriptions the reference MCP filesystem server advertises, captured while auditing which of them a model can actually act on.
category: knowledge
tags: [model-context-protocol, mcp-filesystem-server]
source_url: https://mcp.example.dev/servers/filesystem
timestamp: 2026-07-21T08:15:44.102934+00:00
---

# MCP Filesystem Server Tool Descriptions

Captured 2026-07-21 from the reference server's `tools/list` response. These
are the strings a model sees when deciding whether to call one.

- `read_text_file` — "Read the complete contents of a file from the file
  system as text. Handles various text encodings and provides detailed error
  messages if the file cannot be read."
- `list_directory` — "Get a detailed listing of all files and directories in
  a specified path. Results clearly distinguish between files and directories
  with [FILE] and [DIR] prefixes."
- `move_file` — "Move or rename files and directories. If the destination
  exists the operation will fail."

Two of the three say what comes back. None of them says when the caller
should reach for a different tool instead, and none names what an error from
the tool actually means for the caller's next step.
