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

M4 adds six areas. `app.ts` sets up ops → policy → mcp → plugins → hooks → tools →
consolidation → mcpServer → mcpApps → workspace → profile. Routes are under `/api/v1` unless noted; decisions are
in ADR-091.

| File | Area | Routes |
| --- | --- | --- |
| `plugins.ts` | Plugins, catalogs, skills and slash commands (FR-045, FR-046, FR-049). The built-in sample catalog is `examples/catalog`; Node plugin servers get `NODE_PATH` set to Nova's `node_modules` | `GET /plugins`, `POST /plugins/preview`, `POST /plugins` (needs `confirmSideload`), `PATCH`/`DELETE /plugins/:id`, `GET /plugins/catalogs`, `GET /plugins/catalog`, `GET`/`POST /skills`, `GET`/`PATCH`/`DELETE /skills/:id`, `GET /slash-commands` |
| `hooks.ts` | Lifecycle hooks: discovery, trust by hash, the `hooks` diagnostics probe (FR-197) | `GET /hooks`, `PATCH`/`DELETE /hooks/:id`, `POST /hooks/:id/trust`, `POST /hooks/:id/untrust` |
| `mcp.ts` (M4 part) | MCP bundles and OAuth for remote servers (FR-199, FR-047); plugin-owned servers are read-only here (409 `plugin_owned`) | `POST /mcp/bundles/preview`, `POST /mcp/bundles/install`, `POST /mcp/servers/:id/oauth/start`, `DELETE /mcp/servers/:id/oauth`, `GET /mcp/oauth/callback` (no session; the state authenticates it), and `GET /.well-known/nova-client.json` at the root |
| `mcp-server.ts` | Nova's own MCP server and its per-client tokens (FR-044, FR-192) | `GET`/`POST /app-authorizations`, `DELETE /app-authorizations/:id`, and `/mcp` at the root (streamable HTTP, client token; 404 while `mcpServer.enabled` is off) |
| `mcp-apps.ts` | MCP Apps entry points, `ui://` resources under a strict CSP, and app model context kept in memory (FR-198) | `GET /ui/entry-points`, `GET /ui/resource`, `PUT /ui/context` |
| `workspace.ts` | Files, terminals, Library and project folders (FR-039, FR-006, FR-041, FR-035) | `GET /files/roots`, `/files/list`, `/files/content`, `/files/raw`, `PUT /files/content`, `POST`/`GET /terminals`, `DELETE /terminals/:id`, WebSocket `/terminals/:id/ws`, `GET /library`, `GET`/`POST /projects/:id/folders`, `POST /projects/:id/folders/:fid/reindex`, `DELETE /projects/:id/folders/:fid` |
| `profile.ts` | Profile, avatar, usage insights and import (FR-113, FR-114, FR-200) | `GET`/`PATCH /account`, `GET /account/avatar`, `GET /usage`, `POST /import/preview`, `POST /import/apply`, `GET /import/records` |

M4 also adds `PATCH /providers/:id {active: true}` (the active account per provider kind, FR-115),
`GET /threads/:id/suggestions` (FR-028) and `initiator: 'user' | 'app'` on
`POST /tools/:name/invoke` (default `app`, no user authority) in `chat-routes.ts` and `tools.ts`.
`app.ts` wires the areas together: plugin hooks and hook trust between plugins and hooks, hooks
and plugin permissions into the policy gate, server defaults from MCP and plugins, the app model
context into the chat, and the plugin, folder, memory and project services into import.

M5 adds four areas and wires the agent runtime (decisions in ADR-092). `app.ts` sets up ops →
policy → mcp → plugins → hooks → requests → schedules → code → runs → tools → consolidation →
mcpServer → mcpApps → workspace → profile, then the `ChatService` with the runs and Code
extensions. Runs and Code sessions start turns through `chat.turnStarter`; the scheduler starts
runs through `runs.starter`; Code sessions and runs are per-thread policy sources for both the
gate and the tool scope. `main.ts` calls `runs.recover()` after the chat loop recovers, so runs
continue after a restart.

| File | Area | Routes |
| --- | --- | --- |
| `runs.ts` | Work runs, plans, goals and sub-agents (FR-051..FR-054, FR-057, FR-181, FR-182, FR-186, FR-187, FR-220); the run tools join the tool sources | `GET`/`POST /runs`, `GET /runs/:id`, `POST /runs/:id/{pause,resume,start,cancel,redirect}`, `POST /runs/:id/budget` (adds to the bound; 409 `budget_exhausted` when resuming over budget), `PUT /runs/:id/plan`, `GET /runs/:id/subagents`, `GET /runs/:id/activity`, `GET`/`PUT`/`DELETE /runs/:id/goal`, `GET /goals`, `GET`/`PATCH /goals/:id`, `POST /goals/:id/{pause,resume,complete}` |
| `schedules.ts` | Schedules, their history, delivery and the `schedule.report` tool (FR-055, FR-187, ADR-079); the `schedules` diagnostics probe | `GET`/`POST /schedules` (`origin` is refused), `PATCH`/`DELETE /schedules/:id`, `GET /schedules/:id/fires?limit=`, `POST /schedules/:id/run` (201 `{runId}`) |
| `code.ts` | Code sessions, the local environment, changes, comments, reviews, commits, symbols and session terminals (FR-061..FR-066, FR-069, FR-073, FR-074, FR-211); the worktree sweep every 5 minutes | `GET /environments`, `GET`/`POST /code/sessions` (`?archived=`), `GET`/`PATCH /code/sessions/:id`, and under `/code/sessions/:id`: `GET …/changes`, `POST …/changes/:changeId/hunks` (409 `stale_hunk`), `POST …/changes/accept`, `POST …/changes/reject`, `GET`/`POST …/comments`, `POST …/comments/:commentId/resolve`, `POST …/review` (202), `GET …/reviews/:reviewId`, `POST …/commit`, `GET …/symbols?q=&limit=`, `GET …/refs?name=&limit=`, `POST …/terminal` (409 `sandbox_unavailable`) |
| `requests.ts` | Server-to-client requests, `ask_user` and the thread status service (FR-188, FR-215) | `GET /requests?status=&threadId=`, `GET /requests/:id`, `POST /requests/:id/respond` (also takes approval ids; 409 answered, 410 expired, 403 another device's request) |

`app.ts` also adds the authenticated `POST /api/v1/hello` (the server-request kinds a client
takes and its `clientSessionId`; `GET /api/v1/hello` stays public) and attaches each WebSocket to
the request broker (`?clientSessionId=`, `respond` frames). The global event stream and the
WebSocket send only the signed-in account's events. `policy.ts` adds the per-thread policy
sources and the default `ModelReviewer` on `review.model`; `tools.ts` adds `GET /exec/sessions`,
`DELETE /exec/sessions/:id`, `GET /artifacts/:id/preview` (document previews), the document,
image and plugin-draft tools; `ops.ts` adds `POST /diagnostics/test`
(`{component: provider|mcp|sandbox|storage|update, ref?}`, 30 s per test). Waiting for the
user's answer is left out of a turn's active time, and a run's exec sessions are killed when it
ends.

More options: `NOVA_SECRETS=keychain|vault`, `NOVA_TLS_CERT` / `NOVA_TLS_KEY` (HTTPS),
`NOVA_SANDBOX=auto|docker|podman|off`, `NOVA_SANDBOX_IMAGE` (terminals and command hooks run in
this image; the sample plugin's hook needs Node in it), `NOVA_DETECT_URLS`.
