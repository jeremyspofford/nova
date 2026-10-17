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
job token. Certificates and the Mesh replace the bearer tokens in M6.5, and `novad`'s compute
module supervises the service from M6 (ADR-089, `contracts/hub-api.md` §2).

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

## 14. Non-goals

- No peer-to-peer client mesh in v1 (clients do not talk to each other).
- No automatic hub failover in v1.
- No public multi-tenant SaaS; the Hub is self-hosted.
- No client code path that bypasses the Hub's policy engine except the capability-gated local
  fallback runtime, which enforces the same policy locally.
