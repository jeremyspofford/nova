# @nova/mcp

Nova's MCP client (FR-042, FR-043): connects to MCP servers over stdio, SSE and streamable HTTP
using the official TypeScript SDK, lists their tools, resources and prompts, calls tools with a
timeout and cancellation, and reports health (status, restarts, logs). The Hub exposes the
servers' tools to the tool runtime as `mcp:<server>.<tool>`.
