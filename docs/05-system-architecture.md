# 05 — System Architecture

## 1. Architectural principles

1. **One core, many surfaces.** All business logic lives in `packages/core` and services;
   UI is a thin renderer over typed IPC.
2. **Process isolation for safety.** Untrusted work (agent tools, plugins, MCP servers,
   browser automation) runs in separate processes/containers.
3. **Contracts first.** Every boundary (IPC, HTTP, events, DB) has a schema in `contracts/`.
4. **Local-first.** SQLite is the source of truth; sync/cloud are adapters.
5. **Everything is an event.** The UI reacts to a typed event stream; actions are auditable.

## 2. Technology stack (decisions)

| Layer | Choice | Rationale |
| --- | --- | --- |
| Desktop shell | **Electron** (main + renderer) | Mature cross-platform, best webview/tooling parity with source apps, Node ecosystem for MCP |
| UI | **React 19 + TypeScript + Vite** | Ecosystem, performance, types |
| Styling | **Tailwind CSS + CSS variables** + headless primitives | Token-driven theming; accessible primitives |
| State | **Zustand** (client) + **TanStack Query** (server/session data) | Simple, testable |
| Editor | **CodeMirror 6** | Lightweight, extensible, permissive |
| Terminal | **xterm.js** + node-pty | Standard, robust |
| Browser pane | **Electron `<webview>`/`BrowserView`** for display + **Playwright/CDP** for agent control | Reliable automation + user view |
| Local DB | **SQLite** via `better-sqlite3`, **Drizzle ORM**, WAL mode | Fast, embedded, sync-friendly |
| Vector index | **SQLite + `sqlite-vec`** (or LanceDB fallback) | Local, no server |
| Agent runtime | **Node.js worker threads / child processes** (`services/agentd`) | Isolation, parallelism |
| MCP | **`@modelcontextprotocol/sdk` (TypeScript)** | Standard |
| Sandbox (Linux) | **bubblewrap** + optional rootless container (podman) | Strong, no root |
| Sandbox (macOS) | **seatbelt (sandbox-exec)** | Built-in |
| Sandbox (Windows) | **AppContainer / Job Objects** | Built-in |
| Crypto | **libsodium (via `sodium-native`)**: XChaCha20-Poly1305; Argon2id | Audited primitives |
| Secrets | **OS keychain** (`keytar`/`@napi-rs/keyring`) with encrypted-file fallback | Standard |
| Packaging | **electron-builder** + **electron-updater** | Cross-platform installers |
| Testing | **Vitest**, **Testing Library**, **Playwright**, **MSW** | Fast + E2E |
| Monorepo | **npm workspaces** (already present) + **Turborepo** | Simple, fast caching |

> **Decision FR-ARCH-1:** Electron over Tauri, because the source products' behavior maps
> cleanly to Chromium webview features (browser pane, dev-server preview, extensions) and the
> MCP/agent ecosystem is TypeScript-first. Native helpers are used for sandboxing and keychain.
> Revisit only if performance budgets fail.

## 3. Process & component diagram

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Electron Main Process (Node)                                              │
│  • Window/tray/menu management      • Auto-update                         │
│  • IPC router (typed, validated)    • Deep links / protocol handler       │
│  • Service supervisor (spawns)      • OS integration (keychain, notif.)   │
└───────┬───────────────┬─────────────────┬──────────────┬─────────────────┘
        │ typed IPC     │ child IPC       │ child IPC    │ child IPC
        ▼               ▼                 ▼              ▼
┌───────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐
│ Renderer (UI) │ │ Core service │ │ Agent daemon │ │ MCP/Plugin host   │
│ React + Vite  │ │ (Node)       │ │ (workers)    │ │ (per-server proc) │
│ no Node access│ │ DB, policy,  │ │ planner,     │ │ tools/resources   │
│ contextIsol.  │ │ providers,   │ │ tools, tasks │ │ sandboxed         │
│               │ │ sync, search │ │ scheduler    │ │                   │
└───────────────┘ └──────┬───────┘ └──────┬───────┘ └──────────────────┘
                         │                │
                         ▼                ▼
                  ┌────────────┐   ┌───────────────────────────────┐
                  │ SQLite WAL │   │ Execution substrate            │
                  │ + files    │   │  • local sandbox (bwrap/seatbelt)│
                  └────────────┘   │  • container/VM (podman/WSL)   │
                                   │  • cloud runner (remote)       │
                                   └───────────────────────────────┘
```

## 4. Monorepo layout

```
rea/
├── apps/
│   ├── desktop/                 # Electron main + preload + renderer
│   │   ├── src/main/            # window, ipc router, updater, tray
│   │   ├── src/preload/         # contextBridge, typed API surface
│   │   └── src/renderer/        # React app (routes = modes)
│   └── web-relay/               # optional channels/mobile relay (Node)
├── packages/
│   ├── core/                    # domain logic: threads, messages, projects, runs, dots
│   ├── agent/                   # planner, executor, tool registry, memory
│   ├── providers/               # provider adapters + streaming normalization
│   ├── mcp/                     # MCP client/server wrappers
│   ├── plugins/                 # manifest, loader, sandbox bridge, catalog
│   ├── policy/                  # policy engine + rule DSL
│   ├── security/                # secret redaction, sandbox abstraction, egress
│   ├── storage/                 # Drizzle schema, migrations, repositories
│   ├── sync/                    # E2E encrypted sync client
│   ├── ui/                      # design system components
│   ├── shared/                  # types, zod schemas, utils, event bus
│   └── telemetry/               # opt-in metrics + logging facade
├── services/
│   ├── agentd/                  # long-lived agent daemon (worker pool)
│   ├── sandboxd/                # sandbox broker (bwrap/seatbelt/AppContainer)
│   ├── browserv/                # browser automation controller (CDP/Playwright)
│   └── scheduler/               # cron/event scheduler
├── contracts/                   # source-of-truth interfaces & schemas
├── docs/                        # this specification
├── scripts/                     # build, release, seed, e2e fixtures
├── tests/
│   ├── unit/  integration/  e2e/
└── LEDGER.md
```

## 5. IPC & event contracts

- **Renderer ↔ Main**: `contextBridge` exposes a namespaced typed API generated from
  `contracts/ipc-channels.md`. No `nodeIntegration`; `contextIsolation: true`;
  `sandbox: true` for renderers.
- **Main ↔ Services**: child-process JSON-RPC over stdio or a local socket, validated with Zod.
- **Event bus**: in-process typed emitter; persistent events (runs, tool calls) are appended
  to an `events` table for replay and the Activity view.
- **Validation**: every inbound message is validated; invalid messages are rejected and logged,
  never executed.

See `contracts/` for the authoritative list.

## 6. Execution substrate

```
Policy Engine ──allow──▶ Sandbox Broker ──▶ Local sandbox (bwrap/seatbelt/AppContainer)
                                   ├──────▶ Container/VM (podman, WSL)
                                   └──────▶ Cloud runner (remote agent + object store)
```

- **Local sandbox** is the default for tool execution: no network by default, scoped FS
  (project dir RW, temp RW, everything else RO/deny), resource limits, no host env leakage.
- **Container/VM** for heavier or untrusted work; network policy applies.
- **Cloud runner** for always-on Dots and cloud Code sessions; state persisted as a snapshot
  (tarball of the workdir) plus event log.

All three expose the same `Computer` interface (see `contracts/`): `fs.*`, `exec`, `browser.*`,
`screen.*`, `snapshot`, `restore`.

## 7. Data flow example: send message

```
UI composer → IPC invoke("chat.send") → Core validates (zod)
  → Provider adapters stream deltas → Core emits event("chat.delta")
  → Event persisted → UI renders
  → Tool call requested → Policy Engine decides
       ├─ allow → Sandbox broker executes → result event
       ├─ ask   → Approval event → UI card → user decision → resume/deny
       └─ deny  → denial event with reason
  → Assistant turn finalized → message row + usage row + memory extraction job
```

## 8. Cross-cutting concerns

| Concern | Approach |
| --- | --- |
| Config | Layered: defaults → app settings (DB) → managed policy → env. Precedence documented. |
| Feature flags | DB + env, evaluated at startup and per-request; surfaced in Diagnostics. |
| Migrations | Drizzle migrations, forward-only, with a backup before each app update. |
| i18n | `i18next`, external strings, locale negotiation, RTL. |
| Theming | CSS variables + theme JSON; no hard-coded colors. |
| Caching | Provider prompt cache hints; local response cache keyed by hash for idempotent reads. |
| Concurrency | Agent runs are isolated; DB uses repositories with serialized writes; optimistic UI. |
| Error handling | Typed error taxonomy; retry/backoff for transient; circuit breaker per provider. |

## 9. Security boundaries

1. **Renderer** is untrusted: no Node, no raw FS, strict CSP, no remote code.
2. **Plugins/MCP servers** are untrusted: sandboxed, permissioned, resource-limited.
3. **Tool output** is data, never authority (injection defense).
4. **Secrets** never cross into the renderer or model context in plaintext.
5. **Network** is deny-by-default for agents; allowlists are explicit.
6. **Signing** of updates, plugins, and sync payloads is verified.

## 10. Scalability & performance

- Lazy-load modes and panes; code-split the renderer.
- Virtualize long lists (messages, files, logs).
- Stream and batch DB writes; index hot columns; keep DB under 1 GB with retention/compaction.
- Cap concurrent agent workers (default 4, configurable) and browser contexts (default 2).
- Background indexers are throttled and pause on battery/idle (configurable).
