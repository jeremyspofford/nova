---
title: "Integrations load on demand — smaller prompts, sharper tool use"
date: 2026-07-12
---

- **Lazy MCP tool loading** — connected integrations no longer inject every tool schema into every LLM call. Each server now contributes a one-line capability index entry (~15 tokens: name, summary, tool count), and agents call a new `load_integration_tools` meta-tool to pull in a server's real schemas only when a task needs them. Three installed integrations used to cost 10–25k prompt tokens per agent call; now they cost a few dozen until actually used
- **Small local models pick tools better** — shrinking the tool list is a direct quality win for local models, which get measurably worse at tool selection as the list grows
- **"Always inject" opt-out per server** — expand a server card on the Integrations page to switch a hot integration back to schemas-in-every-call. Pods that pin specific `mcp__` tools in their allowlist also keep direct injection, no load step required
- **Nothing else changes** — consent gating for mutating MCP actions, the permission UI's per-server toggles, and the install/catalog flow all work exactly as before
- **Fixed: editing an MCP server wiped its metadata** — the edit form now round-trips server metadata instead of resetting it
- **Fixed: one bad session id wedged conversation scoring** — a non-UUID session id in usage events made every chat-scorer iteration fail; scoring now skips such rows
