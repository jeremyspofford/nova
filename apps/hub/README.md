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
fallback (M7.5 wires it, below).

M6.5 adds six areas (decisions in ADR-094). `app.ts` sets them up after devices: trust →
network → add device → agent dist → network setup → relay, and wires them together. The trust
area's identity signs the Add Device reveal, the `novad` manifest and the Relay offer, and issues
device certificates; the network area routes wakes for the devices area, takes Mesh endpoints from
network setup and the Relay endpoint from the relay area, and keeps the change log the trust and
setup areas register their undo with; the relay area opens pairing slots for Add Device, hands it
claims and receives its decisions, and its tunnel dispatches clients' requests into this Hub with
`inject` (address `relay:<client id>`, which network setup reads as the Relay transport).
`GET /api/v1/hello` adds `hubFingerprint` and `hubPublicKey`, the authenticated `POST` adds
`endpoints`, and the Host allowlist follows the network area's names. `main.ts` serves HTTPS with
the trust area's certificates when no `NOVA_TLS_CERT` is set (renewals swap in live; unreadable
certificates mean plain HTTP on 127.0.0.1 only) and reports the bound listener to the network
area, which starts the endpoint checks and mDNS.

| File | Area | Routes |
| --- | --- | --- |
| `add-device.ts` | Add Device v2 and device management (FR-132, FR-140): pairings, commit-then-reveal, signed polls, grants, approvals, the device list and scopes, revocation of browsers and apps | `POST /devices/add/start`, `GET /devices/add/requests`, `POST /devices/add/requests/:id/{approve,deny}`, `GET /devices/all`, `PUT /devices/:id/scopes`, and the public `POST /devices/add/complete`, `POST /devices/add/reveal`, `GET /devices/add/status/:requestId` (rate-limited per address) |
| `agent-dist.ts` | Signed `novad` builds from `NOVA_NOVAD_DIST` and the one-line install command (FR-133); the `agentDist` probe | the public `GET /agent/dist/:file` (60 a minute per address) |
| `network.ts` | Endpoints, health checks, mDNS, the change log with one-click rollback, diagnostics, Wake Helper routing (FR-135, FR-138, FR-139); the `network` probe | `GET`/`PATCH /network`, `POST /network/test`, `POST /network/rollback`, `GET /network/diagnostics` |
| `network-setup.ts` | The Network Setup assistant (FR-136): detection, plans, consented steps, verification, rollback; Mesh endpoints, the ACL summary and mesh certificates for the other areas; the `networkSetup` probe | `POST /network/setup`, `GET /network/setup/runs`, `GET /network/setup/runs/:id`, `POST /network/setup/runs/:id/rollback`, `GET /network/setup/consents`, `DELETE /network/setup/consents/:id` |
| `trust.ts` | The Hub identity, the local CA, the Hub's TLS and mesh certificates, device certificates (FR-134); the `trust` probe | `GET`/`PATCH /trust`, `POST /trust/renew`, and the public `GET /trust/ca.pem`, `GET /trust/ca.crt`, `GET /trust/identity?nonce=` |
| `relay.ts` | The Relay connector and its tunnel (FR-137); the `relay` probe | `GET`/`PATCH /relay`, `POST /relay/test`, `GET /relay/clients`, `POST /relay/clients/:id/revoke` |

`node-routes.ts` loses `add/start` (Add Device's now) and gains `POST /devices/compute/enroll`
(the scripted compute-node token); `POST /devices/:id/revoke` also revokes devices only the
add-device area knows. `devices.ts` keeps `POST /devices/novad/enroll` for scripted `novad`
enrollment, and its wake route goes through the network area's Wake Helper router.

M7 adds six areas and extends others (decisions in ADR-095; routes in `contracts/hub-api.md`).
`app.ts` sets up, after the relay: push → device trust → cloud runner → flagged → spaces → tools →
team, then consolidation, the MCP server, MCP apps, workspace and profile, the `ChatService`, and
sync last (it needs the services the others built). The idempotency hooks (`preHandler`,
`onSend`, `onResponse`) run right after authentication on every request. `GET /api/v1/session`
adds `deviceId`, `scopes` and `role`; account-less system events go to the owner only; a removed
member's sockets and event streams close at once. The tools' sandbox router also asks the cloud
area for a cloud thread's sandbox; the gate takes each thread's own substrate.

| File | Area | Routes |
| --- | --- | --- |
| `sync.ts` | Sync (FR-109, FR-112, FR-129): the change feed from the event bus, replicas, the merge log, and the `Idempotency-Key` store and hooks every mutating route shares (`REPLAYABLE_ROUTES`); the `sync` probe | `GET /sync/snapshot`, `GET /sync/changes`, `POST /sync/push` (replica routes: a device session with `offline-replica`), `GET /sync/merge-log`, `POST /sync/merge-log/:id/restore`, `GET /sync/devices`, `POST /sync/devices/:id/reset`, `POST /threads/:id/messages/:mid/answer` |
| `cloudrun.ts` | The cloud runner (FR-108, FR-071, FR-116): registration, environments, leases with caps, snapshots, artifacts, Work runs on a cloud environment; the cloud sandbox, environment transport, Work policy and tool rules for the other areas; the `cloudRunner` probe | under `/cloud`: `GET`/`PUT`/`PATCH`/`DELETE /cloud/runner`, `POST /cloud/runner/test`, `GET /cloud/environments[/:id]`, `POST …/:id/rebuild`, `GET …/:id/files`, `GET`/`POST …/:id/snapshots`, `POST /cloud/snapshots/:id/restore`, `DELETE /cloud/snapshots/:id`, `GET /cloud/runs[/:id]`, `PATCH /cloud/runs/:id`, `POST /cloud/runs/:id/{cancel,artifacts}`, `POST /cloud/work` |
| `push.ts` | Web Push subscriptions and the OS/push leg of notification routing; native pushes through the Relay connector (FR-111, FR-060); the `push` probe | `GET /push/vapid-key`, `GET`/`POST /push/subscriptions`, `DELETE /push/subscriptions/:id`, `POST /push/test` |
| `team.ts` | Members, invitations, the owner-only guard (`preHandler`), members' folders, OIDC, profile cards, shared threads, team agents, plugins per agent (decision 5, FR-217, FR-091, FR-113, FR-045); the `team` probe | under `/team`: `me`, `members`, `invitations`, `me/settings`, `me/card`, `oidc` (with `…/test`), `me/identities/:id`, `threads` (share, messages, cancel, stream), `agents` (credentials, tasks, audit, approvals), `tasks`; `GET`/`PUT /agents/:id/plugins`; and the public `POST /team/join/preview`, `POST /team/join`, `GET /auth/oidc/providers`, `POST /auth/oidc/start`, `GET /auth/oidc/callback`, `GET /profiles/:handle[/avatar]` |
| `flagged.ts` | `script.run` and external agent adapters (FR-202, FR-203), off by default; the `flagged` probe | `GET /scripts/runs`, `GET /scripts/runs/:id`, `GET`/`POST /agent-adapters`, `GET`/`PATCH`/`DELETE /agent-adapters/:id`, `POST /agent-adapters/:id/check`, `GET`/`POST /code/sessions/:id/delegations`, `GET /delegations/:id`, `POST /delegations/:id/cancel` |
| `device-trust.ts` | Mutual TLS for `novad` devices and compute nodes (FR-126): checks the client certificate on the `/agent/v1` and `/node/v1` routes over HTTPS; the `deviceTls` probe | `GET /devices/tls` |

Extended areas: `channels.ts` (Telegram and email bindings run by pollers, Slack buttons, the
public approval-link routes `GET`/`POST /channels/approval-links/:token`, `GET /channels/:id/messages`,
`POST /mcp/subscriptions/:id/refresh`, `POST /notification-rules/:category/test`,
`POST /schedules/:id/webhook-secret`); `code.ts` (handoff, merges, attempts, SSH with
`POST /environments/:id/hostkey/reset`, delegation from agents, handoff files swept after 7 days);
`browser.ts` (site levels per project or agent, console and network capture, the trace newest
first with a cursor); `relay.ts` (`PUT /relay/registration-token`; `idempotency-key` passes the
tunnel); `mcp.ts` and `mcp-server.ts` (device MCP servers through `novad`, `auth` and `oauth`;
resources and prompts on `/mcp`); `agent-dist.ts` (the install command for an https Hub fetches
with `curl -fsSLk` and checks the SHA-256 it carries). `main.ts` asks HTTPS clients for a
certificate of the Hub local CA without requiring one.

M7.5 adds three areas and extends others (decisions in ADR-096; routes in `contracts/hub-api.md`).
`app.ts` sets them up after device trust: the devices area gets the management channel's mutual TLS
(the trust area's Hub client certificate and device certificate checks), certificate renewal, the
authorization signer and the available builds; then firmware → out-of-band → boot, each wired to the
devices service (device calls, heartbeat events, the heartbeat's `policy`), and boot gets the
out-of-band power-cycle link. All of it is owner-only (`/api/v1/devices` and `/api/v1/oob` are on the
owner-only list) and off by default. `PATCH /settings` refuses to turn on the firmware, low-level
boot and PXE switches without `confirm: true` and refuses `devices.oob.enabled`. The settings
route, the firmware policy route and `POST /oob/enable|disable` all write through `writeSetting`,
so a security setting's change has one audit entry (the ops subscriber's `setting.changed`) with
before, after and `confirmed`. The request log
records the route pattern, never the token, for `/boot/` paths.

| File | Area | Routes |
| --- | --- | --- |
| `firmware.ts` | BIOS and firmware (FR-146): the switches with consent, the support matrix, read, plan, Hub-only approval, apply and rollback with a signed authorization, the BIOS password, watchdog sweeps every 30 s; the `firmware` probe | `GET`/`PUT /devices/firmware/policy`, `GET /devices/firmware/support`, under `/devices/:id/firmware`: `GET`, `POST plan`, `GET changes/:changeId`, `POST changes/:changeId/{request-approval,apply}`, `POST snapshots/:snapshotId/rollback`, `GET history`, `PUT`/`DELETE admin-password` |
| `boot.ts` | Boot profiles and PXE (FR-143): trials and "make default" after approval, revert, the Hub-side watchdog, boot tokens, images; the `boot` probe | under `/devices/:id/boot`: `GET`, `GET`/`POST profiles`, `PATCH`/`DELETE profiles/:pid`, `POST profiles/:pid/try`, `GET attempts/:aid`, `POST attempts/:aid/commit`, `POST revert`, `GET requests/:rid`, `POST`/`DELETE pxe/token`; `GET /devices/boot-images`; and the public `GET /boot/ipxe/:token` and `GET /boot/images/:token/:name` (per-device boot token; 30 menus and 120 images a minute per address) |
| `oob.ts` | Out-of-band management (FR-147): BMC endpoints, pins confirmed by the owner, Hub-only approvals, the 60 s sweep, the settings guard for `devices.oob.enabled`; the `oob` probe | `GET /oob`, `POST /oob/{enable,disable}`, `GET`/`POST /oob/endpoints`, `GET`/`PATCH`/`DELETE /oob/endpoints/:id`, `POST /oob/endpoints/:id/pin/confirm`, `POST /oob/endpoints/:id/actions/:action`, `GET /oob/actions`, `GET /oob/actions/:id` |

Extended areas: `devices.ts` (`GET /devices/management-tls`, `GET /devices/:id/services`,
`GET /devices/:id/updates/available`, `GET /devices/:id/overrides`, `POST /devices/:id/overrides/push`,
`GET`/`POST /devices/:id/decommission`, decommission cards answered through `approval.decided`; the
`deviceManagement` probe); `node-routes.ts` (`GET /devices/:id/node`, `GET`/`PUT /devices/:id/node/policy`,
`GET /devices/:id/node/services`, `POST /devices/:id/node/services/:name/:action`); `browser.ts`
(the local browser fallback and the extension bridge, FR-209, FR-096: `GET /browser/fallback/consents`,
`DELETE /browser/fallback/consents/:id`, `GET /browser/fallback/sessions`, `GET /devices/:id/bridge`,
`GET`/`POST /devices/:id/bridge/grants`, `POST /devices/:id/bridge/grants/:grantId/confirm`,
`DELETE /devices/:id/bridge/grants/:grantId`, the public `POST /agent/v1/bridge/events` with the device
credential; it ends its own open fallback sessions at start and closes unknown device sessions every
15 minutes; `browser.useDevices(devices.service, …)` connects it to devices); `device-trust.ts`
(`/agent/v1/bridge/events` is a `novad` route; a renewed certificate the device presents retires the
old one).

M8 (decisions in ADR-097) adds seven areas and changes the start. `app.ts` now sets up `managed`
first (every other area reads its settings layer), then ops → policy → mcp → plugins → hooks →
sdk → … as before, and `market`, `datactl`, `appAuth` and `otlp` after sync; `quiesceHub` stops new
turns, schedulers and node checks and closes the other areas before delete-all or an import, and
`main.ts` restarts the Hub in-process afterwards and installs crash reporting. The model router is
wrapped in `withSpendCaps`. Every route is classified once in `packages/core/src/team/routes.ts`
(`test/routes.test.ts` fails on an unclassified route), and the request log writes the route
pattern, never the path. Routes are in `contracts/hub-api.md` §1.

| File | Area | Routes |
| --- | --- | --- |
| `managed.ts` | Managed policy (FR-106): the protected file, the signed remote policy and its refresh, the test layer (`NOVA_MANAGED_SETTINGS_FILE` only with `NODE_ENV=test` or `--allow-test-policy`), the managed settings layer, the settings guard for `managed.*` and policy-refused values, one `managed.denied` audit per refusal; the `managed` probe | `GET /managed` (member), `POST /managed/reload` (owner) |
| `sdk.ts` | Extensions (FR-117): install, `nova dev`, contributions, commands and status items, secrets; the `ext:` tool source, plugin permissions with extensions, the hook client and gate for SDK hooks, panels for MCP Apps; reacts to `sdk.enabled`, `managed.policy.changed` and trusted publishers; the `extensions` probe | `GET`/`POST /extensions`, `POST /extensions/preview`, `POST /extensions/dev`, `GET /extensions/contributions`, `GET`/`PATCH`/`DELETE /extensions/:id`, `POST /extensions/:id/commands/:command/run`, `POST /extensions/:id/status/:item/click`, `PUT`/`DELETE /extensions/:id/secrets/:name` |
| `market.ts`, `mcp-market.ts` | The marketplace (FR-049): the built-in sample catalog `examples/catalog` with its pinned key, the owner's catalogs, installers for every kind (the MCP one from `mcp-market.ts`: registry entries and `.mcpb` bundles), ratings, pets | under `/market`: `GET catalogs`, `GET items`, `GET items/:catalogId/:kind/:id[/screenshots/:n]`, `POST preview`, `POST install`, `GET installed`, `DELETE installed/:kind/:id`, `GET`/`PUT ratings`, `DELETE ratings/:kind/:id`, `GET pets`, `GET pets/:id/files/*` |
| `datactl.ts` | Data controls (FR-105, FR-116, FR-115, FR-121): export (streamed, ticket downloads), delete-all, import, retention sweeps (hourly check, daily sweep), crash reports, spend caps and provider limits; the `dataControls` probe | under `/data`: `GET`, `POST export`, `POST export/ticket`, `GET export/download`, `POST delete-all`, `POST import/upload`, `DELETE import/uploads/:id`, `POST import/check`, `POST import`, `GET retention`, `POST retention/sweep`, `GET`/`DELETE crash-reports`, `GET crash-reports/:id/preview`, `POST crash-reports/:id/send`, `DELETE crash-reports/:id`; under `/usage`: `GET caps`, `PUT`/`DELETE caps/:provider`, `GET limits`, `POST clear` |
| `appauth.ts` | Third-party apps (FR-222): registration, consent, the token and revocation endpoints, the app-token gate (`APP_ROUTE_SCOPES` only, Bearer only), the hourly call audit; `nva_` tokens authenticate through `auth.ts` once the gate is installed | the public `POST /apps/register`, `POST /oauth/token`, `POST /oauth/revoke`, `GET /.well-known/oauth-authorization-server`; owner `GET`/`POST /apps/authorize`, `GET /apps`, `DELETE /apps/:id`, `GET /apps/pending`, `DELETE /apps/pending/:clientId` |
| `otlp.ts` | OTLP export (FR-223): request spans and metrics, the log sink, header values in the vault, reconfiguration on settings and policy changes; the `otlp` probe | `GET`/`PUT /telemetry/otlp`, `POST /telemetry/otlp/test` |

Extended areas: `channels.ts` (email OAuth: `POST /channels/:id/oauth/start`,
`DELETE /channels/:id/oauth`, the public `GET /channels/oauth/callback`; Telegram files; files in the
message log; on `team.member.removed` it stops the member's pollers and revokes their mailboxes'
tokens); `team.ts` (`GET /team/removed`, `POST /team/removed/:id/purge`,
`GET /team/removed/:id/export` (the data controls' `memberExporter`, wired in `app.ts`), `GET /team/me/access`, the hourly purge
sweep; the member guard reads the route classification); `mcp.ts` (managed checks on add, change,
enable and policy change, `bundle_launch`, the marketplace's MCP installer, the OAuth callback's
`iss` guard); `mcp-apps.ts` (`UiEntryPointView.domains`, extension panels); `spaces.ts` (`PUT /spaces/:id/order`,
`GET /spaces/:id/pages/:pageId/deletion`, `GET /spaces/:id/deleted-pages`,
`POST /spaces/:id/pages/:pageId/undelete`, `POST /sites/:id/source-preview`,
`POST /sites/:id/publish-plan`, and the owner's hosting targets: `GET`/`POST /sites/targets`,
`GET`/`PATCH`/`DELETE /sites/targets/:targetId`, `POST /sites/targets/:targetId/check`); `plugins.ts` and
`hooks.ts` (managed hooks re-read on `managed.policy.changed`); `tools.ts` (managed folder rules in
the tool scope, spend caps for image generation).

More options: `--allow-test-policy` (M8: honour `NOVA_MANAGED_SETTINGS_FILE` as a test layer),
`NOVA_SECRETS=keychain|vault`, `NOVA_TLS_CERT` / `NOVA_TLS_KEY` (HTTPS),
`NOVA_SANDBOX=auto|docker|podman|bwrap|microvm|off` (M6 adds bubblewrap and the micro-VM stub;
`auto` tries a container engine, then bubblewrap), `NOVA_SANDBOX_IMAGE` (terminals and command hooks
run in this image; the sample plugin's hook needs Node in it), `NOVA_DETECT_URLS`,
`NOVA_SLACK_API_BASE` (a Slack-compatible API address instead of Slack's own: a test double or a
proxy), `NOVA_NOVAD_DIST` (M6.5: the folder of `novad-<os>-<arch>` builds and an optional `VERSION`
file the Hub signs and serves; without it the install command is unavailable) and
`NOVA_NETWORK_TOOLS_FILE` (M6.5: a JSON file `{bins: {<cli>: [absolute argv prefix]}, baseEnv: {…}}`
naming the programs Network Setup runs for each mesh, firewall or package CLI instead of looking in
the system folders; the E2E journeys point it at fakes. Only whoever starts the Hub can set it, the
Hub logs a warning when it is set, and a file that cannot be read or parsed stops the start), and
`NOVA_TELEGRAM_API_BASE` (M7: a Telegram-compatible Bot API address instead of Telegram's own, for
a test double).
