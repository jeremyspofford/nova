# 21 — Hub & Device Model

Nova is a **hub-and-spoke, multi-device system**. A central **Hub** hosts the application and
the canonical state; **Clients** present the UI and provide local device capabilities;
**Compute Nodes** supply heavy services such as model inference. All roles can coexist on one
machine or be split across several.

## 1. Roles

| Role | Runs on | Responsibility |
| --- | --- | --- |
| **Hub** | Always-on small device (minimum: Intel N100/N150-class mini PC, 8–16 GB). | Canonical data, agent runtime, scheduler, policy/approvals, UI serving, routing, sync, audit. |
| **Compute Node** | Any machine with CPU/GPU/RAM resources. | Serves inference, embeddings, image/audio, browser/computer, code execution, storage. |
| **Client** | Phone, tablet, laptop, desktop, TV, wearable. | Presents the UI, captures input (mic/camera/files), receives notifications. |
| **Relay** | Public VPS or self-hosted server. | Content-blind forwarding for off-LAN clients; push (APNs/FCM); no data at rest. |
| **Wake Helper** | Any always-on device on the same LAN. | Sends WoL magic packets to wake sleeping devices. |

The **Hub is the only canonical writer**. Clients are the face; Compute Nodes are hands;
the Relay is a forwarder; the Wake Helper is a broadcaster.

## 2. Deployment topologies

```
All-in-one                         Split                              Off-site compute
┌──────────────┐             ┌──────────────┐   ┌────────────┐     ┌──────────────┐
│ Hub + Compute│             │     Hub      │──▶│ GPU Node   │     │     Hub      │
│  (mini PC)   │             │  (mini PC)   │   │ (desktop)  │     │  (home LAN)  │
└──────┬───────┘             └──────┬───────┘   └────────────┘     └──────┬───────┘
       │                            │                                   │ Relay
 ┌─────┴─────┐                ┌─────┴─────┐                        ┌────┴─────┐
 │  Clients  │                │  Clients  │                        │  Clients │
 └───────────┘                └───────────┘                        └──────────┘
```

- **All-in-one** — the hub also computes. Simplest; good for a single power user.
- **Split** — a small hub plus one or more compute nodes (e.g., a GPU desktop).
- **Off-site** — clients reach the hub through the Relay or a Mesh; compute may be remote.

Topology is configuration, not code. Any device may take any role if it meets the requirements.

## 3. Control plane vs data plane

- **Control plane** — Hub. Authentication, authorization, routing decisions, capability
  registry, policy, scheduling, audit, sync coordination.
- **Data plane** — Model/tool traffic. Because browser clients only speak to the Hub, the Hub
  proxies model streams from compute nodes (Q3). A desktop client that also runs `novad` may
  execute locally for offline use.

```
Client ──HTTPS──▶ Hub ──internal──▶ Compute Node
   ▲                 │                   │
   └────stream───────┴───────────────────┘   (Hub relays the stream)
```

For high-volume traffic between Hub and a Compute Node on the same LAN, the Hub may open a
direct connection to the node and fan the stream out to clients; clients never need to reach
the node directly.

## 4. Request flow (chat answered by a compute node)

```
1. Client sends message → Hub /api/chat
2. Hub resolves policy, thread context, and model
3. Hub selects a compute node and execution location (routing order, §5); both are fixed
   for this turn
4. Hub streams the request to the node over the internal protocol
5. Node streams tokens back to the Hub
6. Hub persists the assistant turn, emits events, forwards tokens to the client
7. Hub writes usage + audit records
```

- **Execution location is fixed per turn** (FR-127). The Hub resolves the node, device or
  environment when a turn starts and keeps it for every step, so no turn is half local and
  half remote. If the location is lost mid-turn, the turn ends `interrupted` (resumable); the
  next turn may route elsewhere (`docs/09` §2).
- **Hooks run where the turn executes** (FR-197). The Hub resolves the turn's hook set at turn
  start, and every hook runs at the execution location inside that location's sandbox. A hook
  that cannot run there is recorded in the trace as failed, never silently skipped.

## 5. Routing order (default)

When more than one node can serve a request, choose in this order:

1. **Same device / same LAN** — privacy and lowest latency.
2. **Required model + capabilities present** — vision, tools, context length, GPU, etc.
3. **Least-loaded** node (queue depth / utilization).
4. **Lowest cost / energy** (respecting quiet hours if configured).
5. **Cloud** — only if the user allows sending work off-network.

The order is configurable per user and per project.

## 6. Hub responsibilities

- Serve the web UI to authenticated devices (HTTPS).
- Hold the canonical database; run migrations.
- Run the agent runtime (Work runs, always-on Agents, Code sessions) and the scheduler.
- Own the **Policy Engine**, approvals, and the audit log.
- Maintain the **capability registry** of devices and compute nodes.
- Route model/tool requests; account for usage and cost.
- Coordinate sync and offline replicas; issue device certificates/scopes.
- Distribute signed `novad` builds and client assets.
- Provide diagnostics, network setup, and update management.

Hub process management is handled by a supervisor (systemd unit / launchd agent / Windows
service) so the Hub stays running and restarts on failure.

From M4 (ADR-091) the Hub also installs plugins and MCP bundles into its data directory, runs
command hooks and terminals in its sandbox, hosts MCP Apps resources for clients, and serves
Nova's own MCP server to external clients. Until `novad` arrives (M6), plugin folders, project
folders, the file browser and import read only the Hub's own disk.

## 7. Compute Node responsibilities

- Register capabilities with the Hub on connect (see `docs/23`).
- Serve inference (local model backends), embeddings, image/audio, and optional
  browser/computer/code-execution services.
- Report health, load, queue depth, and temperature.
- Enforce its own limits (max concurrent jobs, VRAM reserve, quiet hours).
- Never initiate connections to clients; only accept Hub-authorized work.

From M2 the compute node is the `@nova/compute` service (`nova-compute enroll`, `nova-compute
run`): it enrolls with a one-use token from Settings → Devices, signs its capability document
with a pinned Ed25519 key, heartbeats every 10 s and serves `/node/v1/jobs` only to the Hub's
job token, and `novad`'s compute module supervises the service from M6 (ADR-089,
`contracts/hub-api.md` §2). The bearer tokens stay; since M7 a node also pins the Hub over TLS
and presents its device certificate, which the Hub checks (mutual TLS, ADR-095).

## 8. Client responsibilities

- Present the Hub-served UI (PWA or native shell).
- Capture local input: microphone, camera, files, screen (with consent).
- **Attach window** (FR-214): on desktop clients, the native shell's global shortcut asks the
  local `novad` to capture the frontmost window (screenshot plus accessibility text). Exclusions
  and redaction run on the device; the user previews the attachment before it is uploaded to
  the Hub. A plain browser tab cannot offer the global shortcut.
- **Dictation** (FR-216): speech-to-text into the composer, on the device when it has a local
  engine, otherwise on a local compute node through the Hub. Audio is streamed and discarded,
  never stored.
- Show notifications and approvals, with the thread status model (FR-215), and answer
  server-to-client requests over their stream (FR-188).
- Optionally host a **local fallback runtime** + local models via `novad` when the Hub is
  unreachable and the Hub has granted that capability to the device.
- Maintain an **encrypted local replica** only if the Hub grants that capability (Q1).

## 9. Offline & degradation (v1)

```
Hub unreachable
  ├─ Local fallback (default): client's novad runs local models/agents; actions queue
  └─ Automatic hub failover: OUT OF SCOPE for v1 (see §10)
```

- Local fallback is **capability-gated**: the Hub must have enabled "offline replica" and
  (optionally) "local runtime" for that device.
- Queued operations synchronize on reconnect with ordering and conflict handling
  (`docs/13`).
- Read-only cached views remain available when no local models are configured.

*As built in M7 (ADR-095; `apps/web/src/replica`, `apps/web/src/offline`, `apps/hub/src/sync.ts`,
`apps/desktop/src/local-runtime.ts`, `services/novad/src/local_runtime.rs`).* The web app (in a
browser, the PWA or the desktop app) is the only client that works offline; the Hub stays the only
canonical writer and everything a device writes offline reaches it as sync changes (`docs/13` §2).

- **Offline copy (FR-129).** The web app keeps one only while its device session has the
  `offline-replica` scope (`GET /api/v1/session` answers `deviceId` and `scopes`; the owner's own
  browser session has none). It loads through `GET /api/v1/sync/snapshot` pages, then
  `GET /api/v1/sync/changes` from the first page's cursor, and pulls again on `sync.changed` and
  whenever the Hub comes back; a 409 `replica_reset` or `cursor_ahead`, or `sync.replica.reset` for
  this device, loads it again. The copy, the queue and a few start-up answers (hello, session,
  settings without the security-relevant ones, account, models, presets, spaces) live in IndexedDB,
  each record sealed with AES-GCM under a key WebCrypto made non-extractable; wiping the key wipes
  what it sealed. The copy is wiped, key and all, on `sync.replica.revoked` (the device revoked or
  the scope removed), on a 403 `replica_not_granted`, on any 401, and at once when
  `device.scopes.changed` takes the scope away. A browser without IndexedDB or WebCrypto keeps no
  copy and says so.
- **Offline reads.** With a copy, the chat list, a chat's messages, projects, spaces and pages are
  answered from it inside the app's API layer, so the usual views work and the app can start with
  no Hub at all; the banner says "Offline: showing what this device has." A chat shows the path back
  from its newest message, since the copy does not record which version is active. Without a copy
  only what the page already loaded comes back, read-only, and nothing is written to the device.
- **Offline queue (FR-112).** With a copy, sending a message, starting a chat (chat mode, not
  temporary), renaming, pinning, archiving or moving a chat, changing a project's name or
  instructions, renaming a space and editing a page's title or content become sync changes. The
  request answers as the Hub would have, built from the copy with the change laid over (a message
  answers `disposition: 'queued'` and can be cancelled from the chat's queue strip). Each item shows
  its status (Waiting to send, Sending, Not sent with the reason, Sent) and carries its own
  `Idempotency-Key`, reused on every resend, so the Hub applies it once. The queue is sealed under
  its own key, so removing the copy never destroys unsent work: such items show as not sent and can
  be copied or discarded. While the Hub is away it is checked again after 2 s, growing to 60 s with
  jitter, and on the browser's `online` event. On reconnect the copy pulls first, then the items go
  out in order; a busy or failing Hub (429, 5xx) makes the item and those after it wait, with
  exponential backoff from 1 s to 60 s and jitter, while a change the Hub refuses stays not sent,
  with the reason, and the next one goes on. Nothing is dropped silently: Settings → Sync lists what
  waits, with Retry, Copy (its words) and Discard (after a confirmation).
- **Not queued.** Messages with files are refused with a sentence; deletes, model or reasoning
  changes, temporary chats and every other write fail as they would without the offline layer.
  Without a copy nothing is queued (offline is read-only).
- **Answering messages written offline.** A queued message reaches the Hub as history: it starts
  no turn and the chat labels it "Written offline" (`provenance: sync`). Once it is in, the web app
  asks `POST /api/v1/threads/:id/messages/:mid/answer` (202; its own `Idempotency-Key`), only for the
  last waiting message of a chat that this device's model has not already answered. The route runs
  the stored message through the normal turn, once. A refusal stays as a plain note on the sent item:
  `answered`, `not_last` and `turn_in_progress` (409), `shared_thread` (another member's words never
  run under the caller's authority) and `not_user_message` (400). A 429 or 5xx is asked again later.
- **Local answers (FR-128).** Only in the desktop app, only for a chat in the copy, and only when the
  session has `local-runtime`; elsewhere the chat says why it is not offered. The shell's main
  process reaches `novad`'s local runtime (`docs/23` §4.3) through `window.novaShell.localRuntime`
  (`models`, `chat`): the page never sees the socket, the token or the address. The model gets the
  chat (the newest 40 turns within 60,000 characters) and its project's instructions; the answer
  streams without the model's reasoning, at most 4 at once, and stops when the page closes or
  navigates. Refusals are `no_novad`, `no_access` (`novad` runs as another user without a socket
  for this one), `scope_missing`, `no_model_server` and `failed`. The answer is kept on the device
  and queued as an assistant message `{parentId, model, provenance: offline}`; the Hub takes it only
  from a session with `local-runtime` (else `local_runtime_not_granted`, and the item stays not sent
  with a note), and the chat labels it "Answered offline by a local model". `novad` keeps serving
  with the last grant it saw while the Hub is down.
- **Desktop app start without the Hub.** When the remembered Hub is unreachable at start (only
  then), the shell opens its window anyway: the web UI runs from the service worker's copy of the
  app shell, and every request to the Hub is cancelled until a fresh identity check passes (`docs/22`
  §5). It checks again every 15 s and reloads its windows once the Hub passes; any refusal other than
  unreachable shows the connect page.
- **Not built.** No local agents or tools: the local fallback answers in chat only. A plain browser
  has no local models. No client replica other than the web app's, and no native mobile app. On
  Windows `novad` offers no per-user pipe, so the desktop app reaches the local runtime only through
  a loopback address and a token file set by hand that the user can read (else `no_access`).
  Automatic Hub failover is not built (§10).

## 10. Hub failover (later)

Automatic failover (another node becomes the Hub) is deferred. When implemented it will use:

- A **Hub candidate** list with priority and health checks.
- **Lease-based leadership** backed by the replicated store; followers keep a warm replica.
- **Split-brain prevention** via quorum (for >2 candidates) or a tie-breaker.
- **Client redirection**: clients discover the active Hub via the Mesh/MagicDNS or a Relay
  pointer, and re-point automatically.

Until then, the Hub's supervisor restarts it on crash, and clients fall back locally.

## 11. Reactive and proactive behavior

Nova is explicitly both:

- **Reactive** — answers requests; responds to events (webhook, Slack/Teams message, file
  change, email, connector event, MCP event subscription per FR-201) via triggers
  (`docs/09` §7). Only sources that declare events can trigger; joining a channel never creates
  a trigger by itself (FR-056).
- **Proactive** — schedules recurring work; watches for conditions and surfaces findings; can
  initiate action subject to policy and approvals. In particular:
  - **Idle-driven research** (FR-082): when an agent has no turn in progress and nothing
    pending, at most hourly by default and never in quiet hours, it reads connected sources
    with read-only tools, records findings in its notes and brings suggestions to the user.
    Findings are untrusted and never count as user intent (FR-189).
  - **Self-scheduled wakes** (FR-206): an agent may set its own next wake-up with
    `schedule.wake` (minimum interval 5 min, horizon at most 30 days, at most 24 per day by
    default). Wakes appear in the Scheduled list, are editable and cancellable by the user,
    respect quiet hours, and are audited.
  - **Goal continuation** (FR-181): while a goal is active and its thread is idle, the runtime
    starts a continuation turn within budgets and quiet hours.

Proactive work always runs on the Hub (the always-on piece), using compute nodes for heavy
steps. Safety defaults: proactive actions that affect the outside world require approval.

## 12. Minimum hardware

| Tier | Spec | Supported |
| --- | --- | --- |
| **Supported minimum** | Intel N100/N150-class mini PC, 8–16 GB RAM, SSD | Hub role fully supported |
| Recommended | 16 GB RAM, NVMe, optional iGPU | Hub + light compute |
| Compute node | Any machine with CPU/GPU and sufficient RAM | Compute only |
| Client | Any modern browser device | Thin client |

Performance budgets are set against the supported minimum (see `docs/16`).

## 13. Ports & protocols (summary)

| Path | Protocol | Notes |
| --- | --- | --- |
| Client ↔ Hub | HTTPS (web UI + REST/WebSocket/SSE) | Served by the Hub |
| Client ↔ Hub (off-LAN) | HTTPS via Mesh or Relay | End-to-end encrypted |
| Hub ↔ Compute Node | Internal gRPC/HTTP over LAN or Mesh | Hub-authorized |
| Hub ↔ Relay | WebSocket/HTTPS, outbound | Content-blind |
| `novad` ↔ Hub | mTLS (device certificate) | Capability + management channel |
| Native shell ↔ local `novad` | Unix socket (mode 0600) or named pipe (user-only ACL) | Token required; loopback is never authorization (FR-192) |
| External MCP client ↔ Hub | Streamable HTTP at `/mcp` on the Hub's port | Per-client token; 404 while Nova's MCP server is off (FR-044, M4) |
| Client ↔ Hub terminal | WebSocket `/api/v1/terminals/<id>/ws` | Session required; the shell runs in the Hub's sandbox (FR-006, M4) |

Every listener requires a token or certificate (FR-192). Detailed contracts live in
`contracts/`.

*As built in M6.5 (ADR-094).*

| Path | Protocol | Notes |
| --- | --- | --- |
| Client ↔ Hub | HTTP on port 7419 (the next free port when taken); HTTPS with the Hub local CA's or the mesh certificate once `trust.mode` is `local-ca` or `mesh` (after a restart), or with `NOVA_TLS_CERT` | Session cookie or bearer token; device sessions come from Add Device (`docs/22` §4) |
| Client ↔ Hub (off-LAN) | The same over a mesh address, or the API tunnelled through the Relay (sealed streams, `/api/v1` only, no WebSocket) | Clients pick an endpoint from those the Hub advertises; since M7 a browser paired through the Relay does (`docs/22` §2) |
| LAN discovery | mDNS on UDP 5353: `_nova._tcp` with the Hub's port and a TXT record of `v=1` and the fingerprint | Only while LAN is advertised and the Hub listens beyond loopback |
| Hub ↔ Relay, client ↔ Relay | One outbound WebSocket each to `/v1/relay/connect` (subprotocol `nova-relay.v1`), plus HTTPS calls; the self-hosted Relay listens on 7430 behind TLS | Route token in a bearer header or the `bearer.<token>` subprotocol; content-blind (`contracts/rest-api.md` §3) |
| Hub ↔ Compute Node | HTTP over LAN or Mesh; the node listens on 7420 | Bearer tokens (ADR-089); Add Device binds the enrollment token to the node's key |
| `novad` ↔ Hub | HTTP over LAN or Mesh; the management channel on 7420 | Bearer tokens; `novad install` checks the pinned identity key and the signed manifest; device certificates are issued in `local-ca` mode (M7 below) |
| Wake Helper ↔ target | UDP magic packet to port 9 (or 7) on the helper's own subnet | Sent by a `novad` Wake Helper, or by the Hub on its own LAN (FR-138) |

*As built in M7 (ADR-095).* `novad` and compute nodes reach an HTTPS Hub through the fingerprint
pinned at Add Device and present their device certificate there (mutual TLS); the Hub asks for it
without requiring it and checks it on the device and node routes (`docs/22` §5). `novad` enrolled
over HTTP moves to HTTPS once the Hub serves it. The Hub → `novad` management channel on 7420 is
still bearer tokens over plain HTTP (R-022). On a client device, the desktop shell reaches `novad`'s
local runtime over a 0600 Unix socket (per user at `/run/user/<uid>/nova/runtime.sock`) or a loopback
address with a token; it serves only four `/v1` model routes, and only after the Hub granted
`local-runtime` (`docs/23` §4.3). The `local.*` methods of `contracts/hub-api.md` §4 are not built.

## 14. Non-goals

- No peer-to-peer client mesh in v1 (clients do not talk to each other).
- No automatic hub failover in v1.
- No public multi-tenant SaaS; the Hub is self-hosted.
- No client code path that bypasses the Hub's policy engine except the capability-gated local
  fallback runtime, which enforces the same policy locally.
