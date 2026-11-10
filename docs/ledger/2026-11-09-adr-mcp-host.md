**2026-11-09 · Architecture (ADR) · MCP host ADR (A2), proposed for the owner's second-model review**
- What changed: docs/plans/mcp-host-adr-2026-11-09.md proposes Nova as an MCP client, with MCP servers as extensions of kind mcp-server. Everything a server says is screened as outside content, tool definitions are pinned and approved one at a time, credentials go only through the broker, and stdio servers run only inside Nova Computer. It reconciles this with the broker and the ingest gate. Docs only; claims about today's code cite file and line.
- What you can now do: review the decision, its 10 test-first PRs and its 16 open questions before anything is built.
- Still unfinished: nothing is implemented. Nova has no MCP host today. The ADR names two existing gaps: tools the runner doesn't name skip screening, and Codex may load the person's own MCP servers.
- Checked: docs only; ledger-files and check-changelog pass.
