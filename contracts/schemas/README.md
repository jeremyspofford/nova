# JSON Schemas

Authoritative JSON Schema (draft 2020-12) for the persisted and transported objects. These
mirror the Zod schemas in `packages/shared`; CI verifies they stay in sync.

| File | Object |
| --- | --- |
| [`event-envelope.json`](event-envelope.json) | Every event |
| [`policy-rule.json`](policy-rule.json) | Policy / custom rule |
| [`plugin-manifest.json`](plugin-manifest.json) | Plugin `.unison-plugin/plugin.json` |
| [`mcp-config.json`](mcp-config.json) | MCP server configuration |
| [`theme.json`](theme.json) | Theme file |
| [`tool-descriptor.json`](tool-descriptor.json) | Registered tool metadata |
| [`schedule.json`](schedule.json) | Recurring task definition |
| [`computer-exec.json`](computer-exec.json) | Sandbox exec request/result |
