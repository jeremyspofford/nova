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
| **Desktop shell** | Electron (primary), Tauri as an option; a later client (ADR-081) | Tray, global shortcuts, local FS/screen via `novad`, auto-update |
| **Mobile** | Native shells (later) around the same web UI | Platform APIs, push, camera/mic |
| **Device agent (`novad`)** | Rust supervisor + modules (Rust or Node workers) | Small, memory-safe, privileged daemon; per-arch static builds |
| **Relay** | Rust or Node, containerized | Content-blind forwarding + push |
| **Database** | SQLite (WAL) + Drizzle by default; PostgreSQL optional | Fits the mini-PC Hub; Postgres for teams |
| **Vector index** | `sqlite-vec` (or LanceDB) | Local, no external service |
| **Sandbox (Linux)** | bubblewrap + seccomp + no-new-privs; optional rootless container | Strong, no root |
| **Sandbox (macOS)** | seatbelt, deny-by-default profile, sandbox binary at an absolute path | Built-in |
| **Sandbox (Windows)** | Restricted, write-restricted tokens with random per-root capability SIDs; children in kill-on-close job objects; an elevated mode with hidden sandbox users, a private desktop and firewall rules that never fail open (ADR-064) | AppContainer breaks common developer tools |
| **Micro-VM substrate (optional)** | Per-session micro-VM: Linux KVM, the macOS virtualization framework, the Windows hypervisor platform; direct kernel boot, SHA-pinned images; off by default, behind a flag (FR-195, ADR-065) | Stronger isolation at a cost in disk and memory |
| **Crypto** | libsodium: XChaCha20-Poly1305, Argon2id, Ed25519 | Audited primitives |
| **Secrets** | OS keychain, encrypted-vault fallback | Standard |
| **Packaging** | Hub (primary): container image or systemd/launchd/Windows service; `novad`: signed per-arch binaries; Clients: PWA served by the Hub, native desktop installers later | See `docs/15` |

> **ADR-031:** The Hub is a long-running Node service, not an Electron main process. Electron
> becomes a client shell only.
> **ADR-032:** `novad` supervisor is written in Rust for a small, privileged, cross-platform
> binary; modules may be Rust or Node.
> **ADR-081:** M0 builds the Hub and the web UI first; the native desktop shell arrives with the
> client work in M7 and is packaged in M10.

## 3. Component diagram

```
                         ┌────────────────────────────────────────────┐
                         │                   HUB                      │
                         │  Fastify API · Web UI hosting · WebSocket  │
                         │  Canonical DB · Agent runtime · Scheduler  │
                         │  Policy engine · Audit log · Capabilities  │
                         │  Egress proxy · Sandbox broker             │
                         │  Sync coordinator · Update distributor     │
                         └───┬───────────────┬───────────────┬────────┘
             HTTPS/WS/SSE    │               │ internal      │ mTLS
        ┌────────────────────┘               │               └───────────────┐
        ▼                                    ▼                               ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐            ┌───────────────┐
│ Client: PWA   │   │ Client: native│   │ Compute Node  │            │ novad modules │
│ (browser)     │   │ shell (desk)  │   │ (compute mod) │            │ mgmt · power  │
└───────────────┘   └───────┬───────┘   └───────────────┘            └───────────────┘
                            │ local IPC (novad, 0600 socket + token)
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
│   ├── policy/                  # Policy engine, rule evaluation, prefix rules, profiles
│   ├── hooks/                   # Lifecycle hooks: registry, hash trust, dispatch (FR-197)
│   ├── security/                # Redaction, sandbox abstraction, egress, crypto
│   ├── secrets/                 # Keychain abstraction + encrypted-vault fallback (FR-101)
│   ├── storage/                 # Drizzle schema, migrations, repositories
│   ├── sync/                    # E2E sync client + conflict resolution
│   ├── transport/               # LAN/Mesh/Relay abstraction + endpoint selection
│   ├── ui/                      # Design system components (shared by web + shells)
│   ├── shared/                  # Types, zod schemas, event bus, errors
│   └── telemetry/               # Logging facade, local traces, opt-in OTLP export (FR-223)
├── services/
│   ├── novad/                   # Device agent supervisor (Rust)
│   │   └── modules/             # management, compute, browser, screen, storage, firmware,
│   │                            # capture (networkless ambient helper, FR-228)
│   ├── sandboxd/                # Sandbox broker + egress proxy (`docs/11` §3, FR-193)
│   ├── browserv/                # Browser controller: Playwright + CDP (`docs/11` §4)
│   ├── relay/                   # Relay server (content-blind, E2E)
│   └── compute/                 # Inference/embeddings/media backends
├── contracts/                   # Source-of-truth interfaces & schemas
├── docs/                        # This specification (+ docs/adr/, docs/external/)
├── fixtures/                    # Deterministic test fixtures (`docs/16` §8)
├── scripts/                     # Repo tooling: check-spec.mjs (spec consistency check)
├── tests/                       # unit · integration · e2e; manifest.md (FR → tests)
└── LEDGER.md
```

## 5. Protocol boundaries

| Boundary | Protocol | Contract |
| --- | --- | --- |
| Client ↔ Hub (UI) | HTTPS + WebSocket/SSE | `contracts/hub-api.md` |
| Client ↔ Hub (off-LAN) | Same, via Mesh or Relay (E2E) | `contracts/hub-api.md`, `docs/22` |
| Hub ↔ Compute Node | Internal HTTP/gRPC over LAN/Mesh | `contracts/hub-api.md` |
| Hub ↔ `novad` | mTLS, capability + management RPC | `contracts/hub-api.md`, `contracts/schemas/device-capability.json` |
| Hub ↔ Relay | Outbound WebSocket; sealed envelopes with client, stream and sequence ids, segmenting and cumulative acks (ADR-071) | `contracts/rest-api.md`, `docs/22` §3 |
| Hub ↔ Hub (later failover) | Replicated store + leases | `docs/21` §10 |
| Native shell ↔ local `novad` | Local IPC: Unix socket (mode 0600) or named pipe (user-only ACL), plus a token (FR-192) | `contracts/hub-api.md` (local subsection) |
| Sandbox ↔ egress proxy | HTTP CONNECT / SOCKS5 to the proxy only; credentials added by the proxy (ADR-063) | `docs/11` §3, §7; `docs/12` §8 |
| External MCP client ↔ Nova MCP server | MCP over a token-authenticated transport; one scoped, revocable token per client (FR-044, FR-192) | `docs/08` §2.2 |

All messages are validated against schemas in `contracts/`; invalid messages are rejected and
logged, never executed.

## 6. Execution substrate

```
Policy Engine ──allow──▶ Sandbox Broker (sandboxd)
                           ├──▶ OS sandbox (bwrap+seccomp / seatbelt / restricted token)
                           ├──▶ Container (podman, WSL)
                           ├──▶ Micro-VM (flagged, FR-195)
                           └──▶ Compute Node (local or remote) · Cloud runner (optional)

every substrate ──network──▶ Egress proxy ──▶ allowed hosts only
                             (allowlist | limited; injects credentials; audits each decision)
```

All substrates expose the same `Computer` interface (`docs/11`): `fs.*`, `exec`, `browser.*`,
`screen.*`, `snapshot`, `restore`.

- **Permission profile** (FR-190, ADR-059): every execution runs under a profile (filesystem
  entries plus a network block). Protected paths (`.git`, `.nova`, `.agents`, the Nova data
  directory, credential locations) stay read-only or denied inside writable roots. An allow
  rule never removes the sandbox; failure to create one fails closed.
- **Egress proxy** (FR-193): `sandboxd` starts it beside the sandbox on whichever node
  executes, with policy from the Hub. The sandbox can reach only the proxy. If the proxy cannot
  start, the sandbox has no network.
- **Credential injection** (ADR-063): network credentials never enter the sandbox. The proxy
  matches the destination host, takes the credential from the keychain and adds it to the
  request, so a compromised sandbox cannot read it. Environment-variable injection remains
  only for tools that cannot use a proxy, and each use is audited.
- **Execution location** (FR-127): the Hub fixes the substrate and node for a turn when the
  turn starts; it may change only between turns.

## 7. Data flow: send a message

```
Client (browser) → Hub POST /api/chat (HTTPS)
  → Hub validates, assembles context, resolves policy
  → Hub selects compute node (routing order); the choice is fixed for the turn (FR-127)
  → Hub streams request to node; node streams tokens back
  → Hub persists the turn, emits events, forwards deltas to client over WS/SSE
  → Hub writes usage + audit
  → (offline) local novad runtime produces the answer; Hub reconciles on reconnect
```

## 8. Cross-cutting concerns

| Concern | Approach |
| --- | --- |
| Config | Layered: defaults → Hub settings (DB) → managed policy → env. |
| Feature flags | DB + env; each flag carries a stage: `experimental` (off, hidden), `beta` (off, visible in Advanced), `stable` (on), `deprecated`, `removed` (rejected at load). Diagnostics shows each flag's stage (ADR-082). No remote flags (ADR-080). |
| Migrations | Drizzle, forward-only, backup before each Hub update. |
| i18n | `i18next`; external strings; RTL-ready. |
| Theming | CSS variables + theme JSON; no hard-coded colors. |
| Caching | Provider prompt cache hints; node-level model pre-warm. |
| Concurrency | Hub serializes writes; agent workers isolated; per-node job limits. |
| Errors | Typed taxonomy; retry/backoff; circuit breaker per provider and per node. |

## 9. Security boundaries

1. **Clients** are untrusted: authenticated, scoped, no canonical writes bypassing the Hub.
2. **Modules/plugins/MCP servers/hooks** are untrusted: sandboxed, permissioned,
   resource-limited; hooks run only after trust by content hash and can only tighten a
   decision (ADR-068).
3. **Content is data, never authority.** Tool output, pages, files, channel messages, captures
   (ambient and attach window) and anything produced by external agents are untrusted. Only
   instructions typed by the authenticated user count as authorization (FR-103, FR-189,
   FR-194).
4. **Secrets** never cross into the UI, the model context or a sandbox in plaintext; network
   credentials are injected by the egress proxy (ADR-063).
5. **Network** is deny-by-default for agents and modules; allowlists are explicit.
6. **`novad`** is elevated but minimal; every privileged action is signed, policy-gated, and
   audited.
7. **Relay** is content-blind; updates, plugins, and sync payloads are signature-verified.
8. **Listener hygiene** (FR-192, ADR-075): every Hub and `novad` listener (HTTP, WebSocket,
   Unix socket, named pipe) requires a token or certificate; loopback is never authorization;
   WebSocket upgrades with a non-allowlisted `Origin` or `Host` are refused; Unix sockets are
   mode 0600. Nova never writes itself, its keys or its skills into another application's
   configuration.
9. **Child process containment:** on Windows every spawned child (tools, MCP servers,
   sandboxed commands, modules) is placed in a job object with kill-on-close, so no child
   outlives its parent; on Linux and macOS children run in their own process group, which the
   broker kills when a run is cancelled or the parent exits (Linux also sets a parent-death
   signal).

## 10. Scalability & performance

- The Hub is designed for a single small device; heavy work is offloaded to compute nodes.
- Lazy-load UI surfaces; virtualize lists; stream responses.
- Cap concurrent agent workers (default 4) and node jobs (per capability declaration).
- Index build and model warm-up are throttled and respect quiet hours.
- Backups and compaction run on a schedule during low activity.
