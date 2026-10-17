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

M6 adds seven areas and their wiring (decisions in ADR-093). `app.ts` sets up ops → policy →
mcp → plugins → hooks → requests → schedules → code → runs → computers → channels → agents →
browser → screen → devices → spaces → tools → consolidation → mcpServer → mcpApps → workspace →
profile, then the `ChatService` with the runs, Code and agents extensions. The tools' sandbox is
`threadSandboxRouter(computers.router(computers.sandbox))`: a Code session's commands go to its
environment, an agent's to its computer, and every sandbox reaches the network only through the
egress proxy. Agents, channels and schedules start turns through `chat.turnStarter`.

| File | Area | Routes |
| --- | --- | --- |
| `agents.ts` | Always-on agents, external agents (FR-079..FR-090, FR-181, FR-194, FR-206); the agent tools join the tool sources; the agents' thread policy (autonomy plus the computer's folder as the only root) and `agentPolicy` (their rules, through `policy.useAgentPolicy`); the `agents` diagnostics probe | `GET`/`POST /agents`, `GET`/`PATCH`/`DELETE /agents/:id` (`{confirm: true}`), `GET /agents/:id/avatar`, `POST /agents/:id/{pause,resume,stop}`, `POST /agents/:id/research` (202), `GET /agents/:id/{activity,threads,background}`, responsibilities, rules (with `…/preview`), memory, suggestions, `GET`/`PUT`/`DELETE /agents/:id/goal`, `GET`/`POST /agents/:id/schedules`, `GET`/`POST /external-agents`, `DELETE /external-agents/:id` |
| `channels.ts` | Channel bindings and identities, triggers, MCP event subscriptions, notification routing and quiet hours (FR-088, FR-056, FR-201, FR-060); `channel.list` and `channel.send`; Slack and Teams schedule delivery; the `channels` probe | `GET`/`POST /channels`, `GET`/`PATCH`/`DELETE /channels/:id`, `POST /channels/:id/{connect,disconnect,test}`, `GET`/`POST /channel-identities`, `DELETE /channel-identities/:id`, `GET`/`POST /triggers`, `GET`/`PATCH`/`DELETE /triggers/:id`, `GET /triggers/:id/events`, `GET`/`POST /mcp/subscriptions`, `GET`/`DELETE /mcp/subscriptions/:id`, `GET /mcp/event-sources`, `GET /notification-rules`, `PUT`/`DELETE /notification-rules/:category`, `GET`/`PUT /quiet-hours`, and the public `POST /channels/:id/inbound`, `POST /triggers/:id/webhook`, `POST /mcp/events/:subscriptionId` |
| `computers.ts` | Computers, the egress proxy and its inspection CA (`<dataDir>/egress/`), the sandbox (`NOVA_SANDBOX`, `NOVA_SANDBOX_IMAGE`), the computers' thread policy; the `egress` probe (FR-080, FR-102, FR-107, FR-193) | `GET /computers`, `GET /computers/:id`, `GET`/`POST /computers/:id/snapshots`, `DELETE /computers/:id/snapshots/:snapshotId`, `POST /computers/:id/{restore,stop}`, `GET /egress`, `GET /egress/ca.pem`, `PUT`/`DELETE /egress/scopes/:kind/:id`, `GET`/`POST /egress/credentials`, `PATCH`/`DELETE /egress/credentials/:id`, `GET /egress/decisions` |
| `browser.ts` | The agent browser on `playwright-core`, site permissions, sign-ins and saved logins, the screenshot sweep every 6 hours; the `browser` probe (FR-086, FR-092..FR-098, FR-208) | `GET /browser/status`, `GET`/`PUT /browser/sites`, `PATCH`/`DELETE /browser/sites/:pattern`, `GET`/`PUT /browser/domains`, `GET /browser/sessions`, `DELETE /browser/sessions/:computerId`, `GET /browser/actions`, `GET /browser/actions/:id/screenshots/:which`, `GET /browser/signins`, `POST /browser/signins/:id/{submit,cancel}` (410 when no longer waiting), `GET /browser/logins`, `DELETE /browser/logins/:id` |
| `screen.ts` | Computer use, grants, the kill key, takeover, appshots and the live view; closes takeovers a restart left open; prunes screenshots daily (FR-093, FR-207, FR-087, FR-075, FR-098) | under `/computers/:id`: `GET …/screen`, `PUT …/screen/control`, `POST …/screen/{kill,resume}`, `GET …/screen/observation`, `GET …/screen/frame`, grants, `GET …/screen/actions` and their images, `GET`/`POST …/takeover`, `POST …/takeover/{input,end}`, WebSocket `…/screen/live`, `POST …/appshots`; `GET /appshots`, `GET /appshots/:id` |
| `devices.ts` | `novad` devices (FR-141..FR-150, FR-210, FR-081): the session routes and, through `node-routes.ts`, Add Device for `client` and `wake-helper` and the `/agent/v1` routes; devices as `local_host` computers and Code environments; folder-access cards; the `devices` probe | `GET /devices/novad`, `POST /devices/novad/enroll`, `GET /devices/:id`, `GET /devices/:id/capabilities`, modules, services, power, updates, files, grants, access requests, staged writes, local MCP, `GET`/`POST /devices/connections`, `DELETE /devices/connections/:id`; and the public `POST /agent/v1/{register,heartbeat,capabilities}` |
| `spaces.ts` | Spaces and pages, sites, the page and visualization tools, the sandboxed preview CSPs; the `spaces` probe (FR-036, FR-037, FR-076) | `GET`/`POST /spaces`, `GET`/`PATCH`/`DELETE /spaces/:id`, pages, versions, restore, comments, proposals, `GET /sites/data-sources`, `GET`/`POST /sites`, `GET`/`PATCH`/`DELETE /sites/:id`, `POST /sites/:id/build`, versions, `…/preview`, `…/zip`, `GET /sites/:id/publishes`, `POST /sites/:id/{publish,unpublish}` (`confirm: true`) |

`code.ts` adds the M6 Code routes (environments, Git hosts, the worktree registry and, under
`/code/sessions/:id`, `extras`, `budget/extend`, `branch`, `push`, `pr`, `pr/refresh`, `devservers`,
`verify` and `ask`), polls pull requests every `code.ciPollSeconds` and checks in-use environments
every 5 minutes. `mcp.ts` adds `onServerRemoving`, so deleting a server unsubscribes its MCP events
first; `ops.ts` adds notification routing (`useNotificationRouting`, the `os` flag on
`notification.created`); `tools.ts` lets the Inspector frame artifact content (`X-Frame-Options:
SAMEORIGIN`, `frame-ancestors 'self'`). The wiring connects agents to the scheduler, runs,
computers, quiet hours and channels; deleting an agent removes its bindings, computer, browser
session, screen records and desktop first; the kill key and a takeover pause the agent using the
computer and its browser, and returning control resumes what they paused; cloud computers get mock
desktops; devices serve as local-host computers and Code device environments; Code dev servers get
the browser's grant and opener (`browserDevServerGrant`, `browserDevServerOpener`), and container
environments the egress proxy (late-bound). The Hub answers to the host of `channels.publicUrl` and
follows the setting. Not wired in M6: an SSH transport, the Hub's update key and the local browser
fallback.

More options: `NOVA_SECRETS=keychain|vault`, `NOVA_TLS_CERT` / `NOVA_TLS_KEY` (HTTPS),
`NOVA_SANDBOX=auto|docker|podman|bwrap|microvm|off` (M6 adds bubblewrap and the micro-VM stub; `auto`
tries a container engine, then bubblewrap), `NOVA_SANDBOX_IMAGE` (terminals and command hooks run in
this image; the sample plugin's hook needs Node in it), `NOVA_DETECT_URLS`.
