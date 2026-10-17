# JSON Schemas

Authoritative JSON Schema (draft 2020-12) for the persisted and transported objects. These
mirror the Zod schemas in `packages/shared`; CI verifies they stay in sync. Every schema's
`$id` is `https://arialabs.ai/schemas/<file>`, and cross-references use relative `$ref`s
between files in this folder.

| File | Object |
| --- | --- |
| [`event-envelope.json`](event-envelope.json) | Every event (`contracts/events.md`) |
| [`policy-rule.json`](policy-rule.json) | Tool/resource policy rule (FR-084, FR-099) |
| [`command-rule.json`](command-rule.json) | Command prefix rule with match / not-match examples (FR-191) |
| [`agent-rule.json`](agent-rule.json) | An always-on agent's custom rule: act, act on request, ask, hand off (FR-084, M6) |
| [`permission-profile.json`](permission-profile.json) | Sandbox filesystem + network profile (FR-190, ADR-059) |
| [`approval-decision.json`](approval-decision.json) | A decision on an approval (FR-100, ADR-060) |
| [`auto-review-verdict.json`](auto-review-verdict.json) | Strict auto-reviewer output (FR-085, ADR-061) |
| [`server-request.json`](server-request.json) | Hub-to-client request and its resolution (FR-188, ADR-072) |
| [`goal.json`](goal.json) | Budgeted goal on a run or agent (FR-181, ADR-058) |
| [`schedule.json`](schedule.json) | Recurring task, agent schedule or self-set wake (FR-055, FR-206, ADR-079) |
| [`hook-config.json`](hook-config.json) | Lifecycle hooks file, handler result and trust record (FR-197, ADR-068) |
| [`plugin-manifest.json`](plugin-manifest.json) | Plugin `.nova-plugin/plugin.json` (FR-045, FR-198) |
| [`skill-frontmatter.json`](skill-frontmatter.json) | `SKILL.md` front-matter (FR-046, ADR-067) |
| [`mcp-config.json`](mcp-config.json) | MCP server configuration (FR-042, FR-047) |
| [`mcp-bundle-manifest.json`](mcp-bundle-manifest.json) | MCP bundle manifest fields read, proposed permissions, install record (FR-199) |
| [`tool-descriptor.json`](tool-descriptor.json) | Registered tool metadata, including deferred loading (FR-196) |
| [`feature-flag.json`](feature-flag.json) | Feature flag with lifecycle stage (ADR-082) |
| [`relay-envelope.json`](relay-envelope.json) | Relay frame around sealed ciphertext (FR-137, ADR-071) |
| [`device-capability.json`](device-capability.json) | Device capability document reported by `novad` |
| [`automation.json`](automation.json) | Automation definition (triggers/conditions/actions) |
| [`ambient-record.json`](ambient-record.json) | Normalized ambient capture record |
| [`smart-home-entity.json`](smart-home-entity.json) | Normalized smart-home entity |
| [`theme.json`](theme.json) | Theme file |
| [`computer-exec.json`](computer-exec.json) | Sandbox exec request/result |
