# @nova/hub

The Hub (FR-124): the always-on service that owns the database, serves the web UI and the API,
and streams events. M0 provides first-run setup (a one-time code printed on the console is
exchanged for an HttpOnly session cookie), token-guarded API routes with Host and Origin checks
(FR-192), settings with precedence (`docs/14` §1), and persisted events over SSE and WebSocket.

```bash
npm run build                     # builds apps/web, which the Hub serves
node apps/hub/src/main.ts         # http://127.0.0.1:7419 (falls back to the next free port)
node apps/hub/src/main.ts code    # print a new one-time setup code
```

Options: `--port`, `--host`, `--data-dir` (or `NOVA_PORT`, `NOVA_HOST`, `NOVA_DATA_DIR`).

M1 adds chat (FR-017, FR-018, FR-021, FR-023): provider accounts with keys in the encrypted vault
(`<dataDir>/secrets.vault`, key file `<dataDir>/vault.key`), models, threads, messages with
attachments, cancel, search, attachments download and a per-thread SSE stream. Routes are listed
in `contracts/hub-api.md` §1; the services live in `@nova/core`. On start the Hub marks replies
that were streaming during a crash as incomplete, and a new owner gets a "Mock (offline)"
provider so chat works with no network.

M2 adds the router (presets, fallback, compute nodes), projects and sources, memory, branches,
side chats and temporary chats. M3 adds the tool runtime and its routes, MCP servers
(`@nova/mcp`), the policy gate with approvals, rules, grants and profiles, the audit log,
notifications, diagnostics and logs, and memory consolidation; each area has its own setup file
(`ops.ts`, `policy.ts`, `mcp.ts`, `tools.ts`, `consolidation.ts`) receiving a `HubContext`.

More options: `NOVA_SECRETS=keychain|vault`, `NOVA_TLS_CERT` / `NOVA_TLS_KEY` (HTTPS),
`NOVA_SANDBOX=auto|docker|podman|off`, `NOVA_SANDBOX_IMAGE`, `NOVA_DETECT_URLS`.
