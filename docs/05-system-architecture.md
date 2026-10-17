# 05 — System Architecture

Nova is a **hub-and-spoke, multi-device system** (see `docs/21`). A central Hub hosts the
application and canonical state; Clients present the UI; Compute Nodes supply heavy services;
`novad` runs on capable devices to provide local execution and management.

## 1. Architectural principles

1. **Hub is canonical.** One always-on Hub owns the database, agent runtime, policy, and
   scheduler. Clients and nodes are replaceable.
2. **One core, many faces.** Business logic lives in shared packages; the Hub serves it; the
   web UI and native shells consume it.
3. **Process isolation for safety.** Untrusted work (tools, plugins, MCP servers, browser,
   device management) runs in separate processes/containers with policy enforcement.
4. **Contracts first.** Every boundary (client↔hub, hub↔node, hub↔relay, hub↔`novad`) has a
   schema in `contracts/`.
5. **Local-first, cloud-optional.** LAN works with zero setup; the Relay and cloud are opt-in.
6. **Everything is an event.** The UI reacts to a typed event stream; actions are auditable.

## 2. Technology stack

| Layer | Choice | Rationale |
| --- | --- | --- |
| **Hub service** | Node.js + TypeScript, Fastify (HTTP/WS/SSE) | Matches the agent/MCP ecosystem; easy to extend |
| **Web UI** | React + TypeScript + Vite, served by the Hub | One UI for browser, PWA, and native shells |
| **Desktop shell** | Electron (primary), Tauri as an option | Tray, global hotkey, local FS/screen via `novad`, auto-update |
| **Mobile** | Native shells (later) around the same web UI | Platform APIs, push, camera/mic |
| **Device agent (`novad`)** | Rust supervisor + modules (Rust or Node workers) | Small, memory-safe, privileged daemon; per-arch static builds |
| **Relay** | Rust or Node, containerized | Content-blind forwarding + push |
| **Database** | SQLite (WAL) + Drizzle by default; PostgreSQL optional | Fits the mini-PC Hub; Postgres for teams |
| **Vector index** | `sqlite-vec` (or LanceDB) | Local, no external service |
| **Sandbox (Linux)** | bubblewrap + optional rootless container | Strong, no root |
| **Sandbox (macOS/Windows)** | seatbelt / AppContainer | Built-in |
| **Crypto** | libsodium: XChaCha20-Poly1305, Argon2id, Ed25519 | Audited primitives |
| **Secrets** | OS keychain, encrypted-vault fallback | Standard |
| **Packaging** | Hub: container/AppImage/systemd; `novad`: signed per-arch; Clients: PWA + native installers | See `docs/15` |

> **ADR-031:** The Hub is a long-running Node service, not an Electron main process. Electron
> becomes a client shell only.
> **ADR-032:** `novad` supervisor is written in Rust for a small, privileged, cross-platform
> binary; modules may be Rust or Node.

## 3. Component diagram

```
                         ┌───────────────────────────────────────────┐
                         │                 HUB                        │
                         │  Fastify API · Web UI hosting · WebSocket  │
                         │  Canonical DB · Agent runtime · Scheduler  │
                         │  Policy engine · Audit · Capability registry│
                         │  Sync coordinator · Update distributor     │
                         └───┬───────────────┬───────────────┬───────┘
             HTTPS/WS/SSE    │               │ internal      │ mTLS
        ┌────────────────────┘               │               └───────────────┐
        ▼                                    ▼                               ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐            ┌───────────────┐
│ Client: PWA   │   │ Client: native│   │ Compute Node  │            │ novad module  │
│ (browser)     │   │ shell (desk)  │   │ (compute mod) │            │ mgmt/power/BIOS│
└───────────────┘   └───────┬───────┘   └───────────────┘            └───────────────┘
                            │ local IPC (novad)
                    ┌───────┴────────┐
                    │  local runtime │  (offline fallback)
                    └────────────────┘

                     Hub ⇄ Relay (outbound, E2E)  ──▶  clients off-LAN
```

## 4. Monorepo layout

```
nova/
├── apps/
│   ├── hub/                     # Hub service: API, UI hosting, runtime, scheduler
│   ├── web/                     # Shared web UI (React) — served by Hub, installable PWA
│   ├── desktop/                 # Native desktop shell wrapping the web UI
│   └── mobile/                  # iOS/Android shells (later)
├── packages/
│   ├── core/                    # Domain: threads, projects, runs, agents, files
│   ├── agent/                   # Planner, executor, tool registry, memory
│   ├── providers/               # Provider adapters + streaming normalization
│   ├── mcp/                     # MCP client/server wrappers
│   ├── plugins/                 # Manifest, loader, sandbox bridge, catalog
│   ├── policy/                  # Policy engine + rule evaluation
│   ├── security/                # Redaction, sandbox abstraction, egress, crypto
│   ├── storage/                 # Drizzle schema, migrations, repositories
│   ├── sync/                    # E2E sync client + conflict resolution
│   ├── transport/               # LAN/Mesh/Relay abstraction + endpoint selection
│   ├── ui/                      # Design system components (shared by web + shells)
│   ├── shared/                  # Types, zod schemas, event bus, errors
│   └── telemetry/               # Opt-in metrics + logging facade
├── services/
│   ├── novad/                   # Device agent supervisor (Rust)
│   │   └── modules/             # management, compute, browser, screen, storage, firmware
│   ├── relay/                   # Relay server (content-blind, E2E)
│   └── compute/                 # Inference/embeddings/media backends
├── contracts/                   # Source-of-truth interfaces & schemas
├── docs/                        # This specification
├── tests/                       # unit · integration · e2e
└── LEDGER.md
```

## 5. Protocol boundaries

| Boundary | Protocol | Contract |
| --- | --- | --- |
| Client ↔ Hub (UI) | HTTPS + WebSocket/SSE | `contracts/hub-api.md` |
| Client ↔ Hub (off-LAN) | Same, via Mesh or Relay (E2E) | `contracts/hub-api.md`, `docs/22` |
| Hub ↔ Compute Node | Internal HTTP/gRPC over LAN/Mesh | `contracts/hub-api.md` |
| Hub ↔ `novad` | mTLS, capability + management RPC | `contracts/hub-api.md`, `contracts/schemas/device-capability.json` |
| Hub ↔ Relay | Outbound WebSocket, sealed payloads | `contracts/rest-api.md`, `docs/22` |
| Hub ↔ Hub (later failover) | Replicated store + leases | `docs/21` §10 |
| Native shell ↔ local `novad` | Local IPC (Unix socket / named pipe) | `contracts/hub-api.md` (local subsection) |

All messages are validated against schemas in `contracts/`; invalid messages are rejected and
logged, never executed.

## 6. Execution substrate

```
Policy Engine ──allow──▶ Sandbox Broker ──▶ Local sandbox (bwrap/seatbelt/AppContainer)
                                    ├──────▶ Container/VM (podman, WSL)
                                    └──────▶ Compute Node (local or remote)
                                             Cloud runner (optional)
```

All substrates expose the same `Computer` interface (`docs/11`): `fs.*`, `exec`, `browser.*`,
`screen.*`, `snapshot`, `restore`.

## 7. Data flow: send a message

```
Client (browser) → Hub POST /api/chat (HTTPS)
  → Hub validates, assembles context, resolves policy
  → Hub selects compute node (routing order)
  → Hub streams request to node; node streams tokens back
  → Hub persists the turn, emits events, forwards deltas to client over WS/SSE
  → Hub writes usage + audit
  → (offline) local novad runtime produces the answer; Hub reconciles on reconnect
```

## 8. Cross-cutting concerns

| Concern | Approach |
| --- | --- |
| Config | Layered: defaults → Hub settings (DB) → managed policy → env. |
| Feature flags | DB + env; surfaced in Diagnostics. |
| Migrations | Drizzle, forward-only, backup before each Hub update. |
| i18n | `i18next`; external strings; RTL-ready. |
| Theming | CSS variables + theme JSON; no hard-coded colors. |
| Caching | Provider prompt cache hints; node-level model pre-warm. |
| Concurrency | Hub serializes writes; agent workers isolated; per-node job limits. |
| Errors | Typed taxonomy; retry/backoff; circuit breaker per provider and per node. |

## 9. Security boundaries

1. **Clients** are untrusted: authenticated, scoped, no canonical writes bypassing the Hub.
2. **Modules/plugins/MCP servers** are untrusted: sandboxed, permissioned, resource-limited.
3. **Tool output** is data, never authority (injection defense).
4. **Secrets** never cross into the UI or model context in plaintext.
5. **Network** is deny-by-default for agents and modules; allowlists are explicit.
6. **`novad`** is elevated but minimal; every privileged action is signed, policy-gated, and
   audited.
7. **Relay** is content-blind; updates, plugins, and sync payloads are signature-verified.

## 10. Scalability & performance

- The Hub is designed for a single small device; heavy work is offloaded to compute nodes.
- Lazy-load UI surfaces; virtualize lists; stream responses.
- Cap concurrent agent workers (default 4) and node jobs (per capability declaration).
- Index build and model warm-up are throttled and respect quiet hours.
- Backups and compaction run on a schedule during low activity.
