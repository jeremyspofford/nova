# ARCHITECTURE AND DECISIONS

Each ADR is binding. If an ADR proves unworkable, stop and propose an amendment — do not silently deviate.

**ADR-1 — Modular monolith core (TypeScript).** Nova core is one deployable, internally modular (clear module boundaries, no cross-module reaching). Microservices are an evolution path the boundaries must permit, not the starting point. Rationale: one always-on hub on modest hardware; operational simplicity is a reliability feature.

**ADR-2 — Rust for device-native components.** The two device agents and any capture/sync-crypto/native low-resource components are Rust. Everything else is TypeScript unless an ADR or the packet says otherwise. Python is permitted only as optional AI/ML sidecars behind contracts.

**ADR-3 — Two device agents, never merged.** (a) A minimal, privileged **boot agent**: enrollment, keys, watchdog, safe-mode recovery. Changes rarely, highest scrutiny. (b) A frequently-updated **runtime agent**: device capabilities, capture, workers. The boot agent can always recover or replace the runtime agent; the runtime agent can never modify the boot agent.

**ADR-4 — Storage: SQLite + plain files.** Structured state (ledger, memory index, schedules, config) in SQLite with migrations. Human-meaningful content (memory exports, briefs, artifacts) as plain files. Vector indexes are derived data — rebuildable, never the source of truth.

**ADR-5 — APIs: REST/OpenAPI for commands and queries; WebSocket or SSE for live updates.** Every UI capability is an API capability (the PWA is a client, not a special path). Internal modules communicate through the same contracts the extensions use where practical.

**ADR-6 — MCP is the extension protocol, not the internal architecture.** External tools/agents integrate as MCP servers, webhook adapters, or Nova plugins behind the extension host. Nova's own internals are not required to be MCP.

**ADR-7 — Three-layer decision stack.** System 1: a **Decision Model Provider** interface (Jev is the first implementation — a hosted, non-generative typed-decision API; a local decision model/rules engine must implement the same interface for local-only mode). System 1.5: deterministic policy (hard rules, privacy modes, approval tiers). System 2: LLM/agent reasoning. System 1 never produces user-facing text and never acts alone on consequential decisions; low-confidence or out-of-schema results escalate.

**ADR-8 — Vendor agent SDKs are adapters.** Claude Agent SDK, OpenAI/Codex, Google ADK, and CLIs are integrated behind Nova's own thin task contracts (CONTRACTS §1). Nova's contracts outlive any vendor SDK. Relay integrates the same way, as an external worker service.

**ADR-9 — Governed self-modification.** Nova (and its builders) never edit the running system live. All changes — code, config, extensions, design systems — flow: isolated worktree/sandbox → automated tests → health gates → versioned release → canary/verification → automatic rollback on failure. Core, security, and permission changes require Tier 3 approval. Every change is a git commit; every deploy is a tagged, reversible version.

**ADR-10 — Local-first data plane.** All core function works with no internet: local models, local search over the user's data, on-device transcription/summarization where hardware allows. Cloud services are accelerators and fallbacks, never silent requirements. Egress is visible: the user can see what left the device, to whom, for which task (context receipts).

**ADR-11 — Hub is a role, not a box.** Exactly one active hub at a time; the role can migrate and a standby can be promoted. Device identity is cryptographic (Ed25519 keypairs generated on-device); enrollment is an approved ceremony (LOCAL-FIRST-AND-DEVICE-MESH §3), never a shared secret.

**ADR-12 — Design systems are data, not code.** UI components consume semantic design tokens only. A design system is a versioned package applied at runtime (DESIGN-SYSTEM). The app must be fully re-skinnable without a rebuild or restart.
