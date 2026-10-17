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

M4 adds:

- **Nova's own MCP server** (FR-044): `NovaMcpServer` hosts streamable HTTP sessions for external
  clients on the SDK's web-standard transport. The caller authenticates each request and names
  the client; the server lists and calls that client's `ServedTool`s, keeps each session bound to
  the client that opened it, caps sessions per client, and `closeClient()` ends a client's
  sessions at once (running calls are cancelled and still answered).
- **MCP bundles** (FR-199): `readBundle()` validates a bundle without extracting it (path checks,
  file-count and size caps before anything is inflated, manifest validated field by field against
  `mcp-bundle-manifest.json`, a trailing signature split off); `bundleSignature()` verifies only
  against trusted publishers (none yet, so bundles are unverified); `extractBundle()` writes into a
  fresh folder; `resolveUserConfig()` checks the user's settings; `bundleLaunch()` builds the argv
  (templates expanded without a shell, platform overrides, `node` on the Hub's runtime, `uv` only
  when it is installed) and reports which arguments and variables hold sensitive settings.
- **OAuth for remote servers** (FR-047): discovery, registration (a client metadata document when
  the authorization server accepts one and the Hub has an HTTPS URL, else dynamic registration),
  PKCE, refresh and revocation (`oauth.ts`), and `McpOAuthService`, which keeps the single-use
  state, stores tokens through a vault interface, refreshes before expiry or after a 401, and
  gives each connection an `AuthProvider` (`McpManagerOptions.authFor`).
- Launch arguments that reference the server's own vault entries (`secret://mcp/<id>/…`) are
  resolved at launch and redacted; any other reference is passed through as text.
- MCP Apps (FR-198): the client advertises the `io.modelcontextprotocol/ui` extension, a tool's
  `_meta.ui.resourceUri` becomes `descriptor.ui`, and `readResourceContents()` returns resources
  raw with their MIME type and `_meta`.

`test/oauth-fixture.ts` is an in-process authorization server with a protected MCP endpoint, and
`test/bundle-fixture.ts` builds bundle archives from `examples/bundles/hello` in memory.
