# Hub API (Client ↔ Hub, Hub ↔ Node, Hub ↔ novad)

The Hub is the only canonical service. Everything speaks to it. This file summarizes the
boundaries; the generated OpenAPI document (from the shared Zod schemas) is authoritative.

## 1. Client ↔ Hub

Transport: HTTPS (REST) plus WebSocket/SSE for streams. Authentication: device certificate
+ scoped bearer token issued at Add Device. All requests are authorized by the policy engine.

### Auth & devices

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/devices/add/start` | Create an Add Device request; returns QR payload + short code + TTL |
| `POST` | `/api/v1/devices/add/complete` | Device submits public key + code; Hub returns a pending approval |
| `POST` | `/api/v1/devices/add/approve` | Hub-side human approves; issues device cert + scoped token |
| `GET` | `/api/v1/devices` | List devices with role, scopes, health, reachability |
| `PATCH` | `/api/v1/devices/:id` | Edit scopes/capabilities/overrides |
| `POST` | `/api/v1/devices/:id/wake` | Request WoL via a Wake Helper |
| `POST` | `/api/v1/devices/:id/revoke` | Revoke certificate and stop modules |

### Chat, projects, files

| Method | Path | Purpose |
| --- | --- | --- |
| `GET/POST` | `/api/v1/projects` | List/create projects |
| `GET/POST` | `/api/v1/threads` | List/create conversations |
| `POST` | `/api/v1/threads/:id/messages` | Send a message; response is a stream |
| `GET` | `/api/v1/threads/:id/stream` | WebSocket/SSE stream of events |
| `POST` | `/api/v1/threads/:id/cancel` | Cancel generation |
| `GET/POST` | `/api/v1/files` | List/upload files (projects, artifacts) |
| `GET` | `/api/v1/search?q=` | Hybrid search (FTS + vector) |

### Tasks, agents, approvals

| Method | Path | Purpose |
| --- | --- | --- |
| `GET/POST` | `/api/v1/runs` | List/create work runs |
| `POST` | `/api/v1/runs/:id/{pause,resume,redirect,cancel}` | Control a run |
| `GET/POST` | `/api/v1/schedules` | Recurring tasks |
| `GET/POST` | `/api/v1/agents` | Always-on agents |
| `GET/POST` | `/api/v1/approvals` | List/decide approvals |
| `GET` | `/api/v1/activity?ref=` | Activity trace for a thread/run/agent |
| `GET` | `/api/v1/audit/export` | Audit log export (JSONL) |

### Code, tools, extensions

| Method | Path | Purpose |
| --- | --- | --- |
| `GET/POST` | `/api/v1/code/sessions` | Code sessions |
| `GET` | `/api/v1/code/sessions/:id/changes` | Diffs |
| `POST` | `/api/v1/code/sessions/:id/{review,commit,pr}` | Review/commit/PR |
| `GET/POST` | `/api/v1/mcp/servers` | MCP servers |
| `GET/POST` | `/api/v1/plugins` | Plugins |
| `GET/POST` | `/api/v1/skills` | Skills |
| `POST` | `/api/v1/tools/:name/invoke` | Invoke a tool (policy-gated) |

### Settings, network, diagnostics

| Method | Path | Purpose |
| --- | --- | --- |
| `GET/PATCH` | `/api/v1/settings` | Read/update settings |
| `GET/PATCH` | `/api/v1/network` | Transports, trust, egress, wake helpers |
| `POST` | `/api/v1/network/setup` | Run the Network Setup assistant step |
| `POST` | `/api/v1/network/test` | Reachability test (LAN/Mesh/Relay) |
| `POST` | `/api/v1/network/rollback` | Revert the last network change |
| `GET` | `/api/v1/diagnostics` | Health snapshot (providers, nodes, sandboxes, devices) |

## 2. Hub ↔ Compute Node

Internal, authenticated (mTLS over Mesh or LAN). The Hub authorizes every job; nodes never
initiate to clients.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/node/v1/register` | Node announces capabilities + certificate |
| `POST` | `/node/v1/heartbeat` | Health, load, queue depth, temperature |
| `POST` | `/node/v1/models/sync` | Compare/advertise available models |
| `POST` | `/node/v1/jobs` | Submit a job (chat/tool/embedding/media) |
| `GET` | `/node/v1/jobs/:id/stream` | Stream job output |
| `POST` | `/node/v1/jobs/:id/cancel` | Cancel a job |
| `POST` | `/node/v1/services/:name/{start,stop,restart}` | Manage a service |

## 3. Hub ↔ `novad` (management channel)

mTLS using the device certificate. Every privileged action is policy-gated and audited.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/agent/v1/register` | Register device + capability document |
| `POST` | `/agent/v1/capabilities` | Update capabilities (hardware/OS/services/models) |
| `POST` | `/agent/v1/heartbeat` | Liveness + metrics |
| `POST` | `/agent/v1/modules/:name/{start,stop}` | Start/stop a module |
| `POST` | `/agent/v1/power` | Sleep, restart, shutdown, wake |
| `POST` | `/agent/v1/boot/profile` | Set/inspect the next boot profile |
| `POST` | `/agent/v1/firmware/read` | Read current BIOS/firmware settings (allowlisted) |
| `POST` | `/agent/v1/firmware/plan` | Dry-run: proposed vs current diff |
| `POST` | `/agent/v1/firmware/apply` | Apply an approved change (snapshot + rollback) |
| `POST` | `/agent/v1/firmware/rollback` | Restore a snapshot |
| `POST` | `/agent/v1/oob/:action` | Out-of-band action (IPMI/Redfish/AMT), off by default |
| `POST` | `/agent/v1/update` | Apply a signed module/binary update |

`/agent/v1/firmware/*` returns `403` unless the global "Allow BIOS/firmware changes" toggle
is enabled **and** the specific change has an approval record. `/agent/v1/oob/*` returns
`403` unless the out-of-band module is enabled (off by default).

## 4. Native shell ↔ local `novad`

Desktop shells talk to the local `novad` over a Unix domain socket (macOS/Linux) or named pipe
(Windows), authenticated by a local token:

| Method | Purpose |
| --- | --- |
| `local.capabilities` | Read this device's capabilities |
| `local.exec` | Run a local command in the sandbox (agent tools) |
| `local.fs` | Scoped file access |
| `local.screen` | Computer-use operations |
| `local.browser` | Local browser automation |

The shell never receives raw secrets; it requests scoped operations that `novad` enforces.

## 5. Streaming & backpressure

- Streams use SSE or WebSocket; events follow `contracts/events.md`.
- High-frequency deltas are coalesced (≤ 60/s); screenshots ≤ 1 per 2 s.
- Slow clients drop ephemeral deltas but never persisted events.
- Reconnect resumes from the last event id; the Hub replays missed persisted events.

## 6. Error shape

```json
{ "error": { "code": "policy_denied", "message": "Action requires approval.",
             "retryable": false, "details": { "approvalId": "…" } },
  "requestId": "req_…" }
```

Codes: `auth_missing`, `auth_expired`, `policy_denied`, `approval_required`, `rate_limited`,
`over_budget`, `capability_missing`, `node_unavailable`, `firmware_disabled`, `oob_disabled`,
`validation`, `conflict`, `not_found`, `server_error`.

## 7. Versioning

- Path prefix `/api/v1`, `/node/v1`, `/agent/v1`.
- Breaking changes bump the major version; one compatibility shim is supported for one release.
- The Hub advertises supported protocol versions in `/api/v1/hello`; clients/nodes negotiate.
