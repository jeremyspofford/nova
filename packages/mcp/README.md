# @nova/mcp

Nova's MCP client (FR-042, FR-043; docs/08 §2.1, §8, §9), built on the official TypeScript SDK.

- `McpManager` runs one supervised connection per configured server: stdio (spawned without a
  shell, env values resolved from the vault at launch, working directory `<workDir>/<serverId>`,
  stderr kept in a redacted ring of 500 lines), SSE and streamable HTTP (header values from the
  vault). It negotiates MCP 2025-11-25 or later and refuses older servers with an error naming
  both versions, lists tools, resources and prompts, refreshes them on list-changed
  notifications, calls tools with the server's `toolTimeoutMs` and an `AbortSignal`, and
  restarts a failed server with backoff: at most 5 restarts in 10 minutes, then `error` until a
  manual `restart()`. Status changes are reported through `onStatus`.
- `McpToolSource` offers the exposed tools of connected servers as a tool source (structurally a
  `ToolSourceProvider` from `@nova/core`): names `mcp:<server>.<tool>` (sanitized to the
  descriptor pattern, collisions suffixed `_2`, `_3` …), `loading: 'deferrable'`, `serverId` set,
  `enabledTools`/`disabledTools` applied. Server annotations are untrusted hints that only add
  restrictions (`destructiveHint` → destructive, `openWorldHint` → requires network); a server
  can never mark a tool read-only, and `effects` are never set from hints.
- Results map to Nova content: text and images as they are, structured content as JSON text
  (and in `meta.structuredContent`), other blocks described in text; `isError` becomes
  `{ok: false, error: {code: 'mcp.tool_error'}}`. Failures use `mcp.timeout`,
  `mcp.cancelled`, `mcp.unavailable`, `mcp.tool_not_found`, `mcp.tool_disabled`,
  `mcp.invalid_args`, `mcp.protocol_error` and `mcp.client_error`.

`test/fixtures/test-server.mjs` is a stdio MCP server for tests and the J3 journey
(`node packages/mcp/test/fixtures/test-server.mjs [--tools N] [--test-hooks]`); see its header for
the tools and options.
