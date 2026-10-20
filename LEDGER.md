# Build Ledger

> **This is the single source of truth for build progress.** The build agent keeps it current
> before and after every task (`AGENTS.md` §4). Task IDs come from `docs/29-task-breakdown.md`.

Current milestone: **M9 — Hardening, Performance & Security**
Last updated: 2026-10-20T03:51:01Z

## Phase status

| Phase | Status | Commit | Evidence |
| --- | --- | --- | --- |
| Phase 0 — reconcile external findings | done | c63b82d | `docs/external/RECONCILIATION.md` (141 capabilities); `node scripts/check-spec.mjs` |
| Phase 1 — finish the specification | done | 2868ce3 | topic docs + contracts updated; `node scripts/check-spec.mjs`; all schemas compile (Ajv 2020) |
| Phase 2 — build | in_progress | 3478630 | M0-M8 done |

## Milestone status

| Milestone | Status | Started | Completed | Evidence |
| --- | --- | --- | --- | --- |
| M0 Foundation | done | 2026-10-17 | 2026-10-17 | 10bbcf4; `docs/demos/M0.md`; Playwright smoke J0 green |
| M1 Chat MVP | done | 2026-10-17 | 2026-10-17 | J1 green 3/3 (axe clean, cold start < 3 s); `docs/demos/M1.md` |
| M2 Providers/Projects/Memory | done | 2026-10-17 | 2026-10-17 | J1 + J2 green 3/3 in parallel (axe clean); `docs/demos/M2.md` |
| M3 Tools/MCP/Policy | done | 2026-10-17 | 2026-10-17 | J1, J2, J3 green 3/3 in parallel (axe clean); `docs/demos/M3.md` |
| M4 Plugins/Workspace/Profile | done | 2026-10-17 | 2026-10-17 | J1-J4 green 3/3 (axe clean); `docs/demos/M4.md` |
| M5 Agent Runtime (Work & Code) | done | 2026-10-17 | 2026-10-17 | J1-J6 green twice in a row (axe clean); `docs/demos/M5.md` |
| M6 Agents/Computers/Channels | done | 2026-10-17 | 2026-10-17 | J1-J8 green (17/17, axe clean), J7 and J8 three runs in a row; `docs/demos/M6.md` |
| M6.5 Networking/Add Device | done | 2026-10-17 | 2026-10-17 | J1-J8.5 green (21/21, axe clean), J8.5 three runs in a row; `docs/demos/M6.5.md` |
| M7 Cloud/Sync/Multi-device | done | 2026-10-17 | 2026-10-19 | J1-J9 green (25/25, axe clean), J9 three runs in a row; desktop shell journey (e2e-shell); CI green at 990bc0b after three CI-only fixes (a timing test made linear, a worker timeout, bubblewrap in the checks job); `docs/demos/M7.md` |
| M7.5 Boot/Power/Firmware | done | 2026-10-19 | 2026-10-19 | J1-J9.5 green (28/28, axe clean), J9.5 three runs in a row; CI green at 39502ca after three CI-only test fixes; `docs/demos/M7.5.md` |
| M8 Extensibility/Governance | done | 2026-10-19 | 2026-10-20 | J1-J10 green (52/52, axe clean), J10 three runs in a row; the WCAG 2.2 A/AA sweep (16 tests, no exclusions) and the right-to-left layout check; CI green at 6a8bceb (waves 1 and 2) and at 92f7e2d after one CI-only fix (on the runner's wider default font, wide Settings tables broke reflow at 320 px; they now scroll in their own region); `docs/demos/M8.md` |
| M9 Hardening/Security/Perf | todo | — | — | — |
| M10 Packaging/Release | todo | — | — | — |
| N1 Ambient Memory | todo | — | — | — |
| N2 Automations & Smart Home | todo | — | — | — |
| N3 Extensions & Community | todo | — | — | — |
| N4 Learning & Self-Improvement | todo | — | — | — |

## Tasks

| ID | Milestone | Requirement | Status | Commit | Evidence | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| T-P0-01 | P0 | — | done | c63b82d | `node scripts/check-spec.mjs` | Reconciliation table, FR-181..233, ADR-056..082 |
| T-P1-01 | P1 | — | done | 2868ce3 | `node scripts/check-spec.mjs`; `packages/contracts` tests | Reconciliation applied across docs/ and contracts/; ADR-083..087 |
| T-M0-01 | M0 | — | done | 10bbcf4 | `npm run lint`, `npm run typecheck` | Monorepo (npm workspaces + Turborepo), TS strict, ESLint/Prettier |
| T-M0-02 | M0 | FR-124, FR-192 | done | 10bbcf4 | `apps/hub` 15 integration tests | `apps/hub` Fastify service skeleton (HTTP/WS/SSE, config, graceful shutdown, token-guarded listeners) |
| T-M0-03 | M0 | FR-125 | done | 10bbcf4 | `apps/web` 11 tests; `vite build`; e2e/m0-smoke.spec.ts | `apps/web` React/Vite UI served by the Hub; PWA manifest + service worker |
| T-M0-04 | M0 | — | done | 10bbcf4 | `packages/shared` 51 tests | `packages/shared` zod schemas, event bus, error taxonomy |
| T-M0-05 | M0 | — | done | 10bbcf4 | `packages/storage` 14 tests (migrate, backup, restore) | `packages/storage` Drizzle + SQLite (WAL) + migration runner + backup |
| T-M0-06 | M0 | FR-010 | done | 10bbcf4 | `packages/ui` 24 tests incl. WCAG contrast | `packages/ui` design tokens + 5 primitives; theme light/dark/system |
| T-M0-07 | M0 | FR-099 | done | 10bbcf4 | `packages/policy` 27 tests, 96 % branches | `packages/policy` engine skeleton + tests |
| T-M0-08 | M0 | — | done | 10bbcf4 | `packages/providers` 9 tests | `packages/providers` interface + MockProvider + fixtures |
| T-M0-09 | M0 | — | done | 10bbcf4 | `packages/contracts` + shared contract harness (32 tests) | `contracts/` schemas wired to shared zod; drift check in CI |
| T-M0-10 | M0 | FR-118 | done | 10bbcf4 | `packages/telemetry` 5 tests; settings resolver tests | Structured logging + redaction; settings precedence resolver |
| T-M0-11 | M0 | — | done | 10bbcf4 | `.github/workflows/ci.yml` (runs on push) | CI pipelines (lint, typecheck, unit, build) on Linux |
| T-M0-12 | M0 | — | done | 10bbcf4 | this ledger; `docs/adr/` | `LEDGER.md` seeded from this document; ADR directory |
| T-M0-13 | M0 | FR-141 | done | 10bbcf4 | `node scripts/cargo.mjs test` (6 tests); capability doc validates against schema | `services/novad` supervisor skeleton (Rust) + service install |
| T-M0-14 | M0 | — | done | 10bbcf4 | `node scripts/check-spec.mjs` in CI | `scripts/check-spec.mjs` wired into CI (FR sync, schemas, links, names) |
| T-M1-01 | M1 | FR-001, FR-002, FR-003 | done | ba340d5 | `apps/web` shell tests; J1 | Hub-served UI shell: sidebar, mode tabs, command palette |
| T-M1-02 | M1 | FR-004 | done | ba340d5 | `apps/web` keys tests; Settings → Keyboard | Shortcut registry + defaults |
| T-M1-03 | M1 | FR-017 | done | ba340d5 | `packages/core` threads tests; hub chat routes | Chat CRUD (create/rename/pin/archive/delete/search) |
| T-M1-04 | M1 | FR-018 | done | ba340d5 | core chat tests; J1 stop step | Streaming send/stop with partial retention |
| T-M1-05 | M1 | FR-021 | done | ba340d5 | composer + attachment tests | Composer + attachments (images/files) + markdown |
| T-M1-06 | M1 | FR-014 | done | ba340d5 | onboarding tests; J1 step 1 | Onboarding wizard (one provider + mock) |
| T-M1-07 | M1 | FR-015 | done | ba340d5 | axe on chat + settings in J1 | Accessibility baseline + focus management |
| T-M1-08 | M1 | — | done | ba340d5 | `packages/providers` 34 tests (fake server) | OpenAI-compatible + Mock provider adapters; usage accounting stub |
| T-M1-09 | M1 | FR-017 | done | ba340d5 | J1 restart + search steps | Persistence across restart; chat search |
| T-M1-10 | M1 | FR-125 | done | ba340d5 | `e2e/j1-first-chat.spec.ts` 3/3 | E2E J1 |
| T-M2-01 | M2 | FR-023 | done | 01c0e89 | `packages/providers` 156 tests (conformance × 6 kinds); J2 on a fake Anthropic server | Anthropic + OpenAI adapters with tool normalization |
| T-M2-02 | M2 | FR-024 | done | 01c0e89 | `packages/core` router/breaker/retry tests; hub model-routes | Virtual models, routing/fallback, circuit breaker, retries |
| T-M2-03 | M2 | FR-126, FR-127 | done | 01c0e89 | core nodes tests; `services/compute` 40 tests; hub node-routes (real node end to end) | Compute node registration + routing order |
| T-M2-04 | M2 | FR-034, FR-040 | done | 01c0e89 | core projects tests; hub conversation tests; web projects tests | Projects (instructions, sources, per-project chats) |
| T-M2-05 | M2 | FR-032 | done | 01c0e89 | core memory tests; web memory tests; J2 step 4 | Memory extraction + Memory panel + per-chat opt-out |
| T-M2-06 | M2 | FR-025 | done | 01c0e89 | storage search tests; web chat-find tests; J2 step 5 | Cross-chat search + in-chat find |
| T-M2-07 | M2 | FR-019, FR-020 | done | 01c0e89 | core conversation tests; web chat-followup/chat-actions; J2 step 5 | Steer/queue setting; edit/regenerate/branch |
| T-M2-08 | M2 | FR-026, FR-027, FR-033 | done | 01c0e89 | core conversation tests; web chat-panels/chat-temporary; J2 step 4 | Side chat; temporary chats; branch tree |
| T-M2-09 | M2 | FR-007 | done | 01c0e89 | web deeplinks tests (`web+nova` handler in the manifest) | Deep links |
| T-M2-11 | M2 | FR-221 | done | 01c0e89 | core presets tests; web models-settings tests; J2 step 3 | Model presets (Faster ↔ Smarter) over virtual models |
| T-M2-10 | M2 | — | done | 01c0e89 | `e2e/j2-providers-memory.spec.ts`, 3/3 with J1 in parallel | E2E J2 |
| T-M3-01 | M3 | — | done | aef94eb | core tools tests (fs, patch, exec, web, registry); hub tools.test | Tool registry + built-in read/write/search/exec |
| T-M3-02 | M3 | FR-042, FR-043 | done | aef94eb | `packages/mcp` 47 tests (stdio + streamable HTTP fixture); hub mcp.test; J3 step 1 | MCP client (stdio/http) + health/restart |
| T-M3-03 | M3 | FR-099 | done | aef94eb | `packages/policy` 79 tests, 97.8 % branches | Policy engine complete (allow/ask/handoff/deny) + reasons |
| T-M3-04 | M3 | FR-100 | done | aef94eb | core gate.test; hub policy.test; web chat-approvals.test; J3 step 3 | Approval UX (allow once/always/deny/handoff) + grants |
| T-M3-05 | M3 | FR-101 | done | aef94eb | secrets keychain.test (fake CLIs); `scripts/secret-scan.mjs` in CI | Secrets (keychain) + redaction + secret-scan CI |
| T-M3-06 | M3 | FR-048 | done | aef94eb | hub policy.test (tool-defaults, evaluate); web tools-settings.test | Per-tool defaults + effective policy preview |
| T-M3-07 | M3 | — | done | aef94eb | core loop.test (23); web chat-tools.test; J3 | Agent tool loop + tool cards |
| T-M3-08 | M3 | FR-029, FR-022, FR-038 | done | aef94eb | core tools-web/artifacts/mentions tests; web chat-artifacts/chat-mentions tests | Web search with citations; `@`-mentions; artifacts pane |
| T-M3-09 | M3 | FR-104 | done | aef94eb | core audit.test (hash chain, tamper); J3 step 5 (verify) | Audit hash chain + Activity trace |
| T-M3-10 | M3 | FR-013 | done | aef94eb | core notifications.test; web notifications.test | Notifications center |
| T-M3-11 | M3 | FR-149 | done | aef94eb | blob sealing + TLS (hub ops.test); full-DB encryption deferred (ADR-090) | Hub trusted + external E2E baseline; optional sealed mode |
| T-M3-13 | M3 | FR-189 | done | aef94eb | policy engine tier/provenance tests; J3 step 4 | Confirmation tiers + intent provenance in the policy engine |
| T-M3-14 | M3 | FR-190 | done | aef94eb | policy paths/profiles tests; core tools-fs.test | Permission profiles + protected paths |
| T-M3-15 | M3 | FR-191 | done | aef94eb | policy command tests; J3 step 3c | Command prefix rules with load-time examples |
| T-M3-16 | M3 | FR-192 | done | aef94eb | hub listeners.test (every route, WS handshake 401); per-client MCP tokens with Nova's MCP server in M4 | Listener tokens, Origin checks, per-client MCP tokens |
| T-M3-17 | M3 | FR-196 | done | aef94eb | core registry/search tests; J3 step 1 | Deferred tools + `tool.search` |
| T-M3-18 | M3 | FR-204, FR-205 | done | aef94eb | core consolidation.test (28), history.test (7); hub consolidation.test | Memory consolidation, project-only scope, history-reference toggle |
| T-M3-12 | M3 | — | done | aef94eb | `e2e/j3-tools-approvals.spec.ts`, 3/3 with J1 and J2 in parallel | E2E J3 |
| T-M4-01 | M4 | FR-045 | done | 2c0fbf8 | core plugins-manifest/catalog/service tests; policy plugins-hooks.test; hub plugins.test; web plugins-settings.test | Plugin manifest + loader + local/URL/Git catalogs; every install a confirmed sideload; env in the vault |
| T-M4-02 | M4 | FR-046 | done | 2c0fbf8 | core skills, skills-frontmatter, loop-skills tests; web chat-suggest-slash.test | Skills + slash invocation + auto-selection |
| T-M4-03 | M4 | FR-047 | done | 2c0fbf8 | mcp oauth + oauth-service tests; hub oauth.test | Connector framework (OAuth PKCE, tokens in the vault, refresh, revoke) |
| T-M4-04 | M4 | FR-005, FR-006, FR-039 | done | 2c0fbf8 | web layout-model, workspace-layout, terminal, files tests; ui splitter.test; core workspace-terminals/files tests | Multi-pane layout + terminal (sandbox pty relay) + editor/preview |
| T-M4-05 | M4 | FR-011, FR-028 | done | 2c0fbf8 | web theme-share.test; core suggestions.test; web chat-suggest-slash.test | Theme import/export; suggested prompts with a Settings switch |
| T-M4-06 | M4 | FR-035, FR-041 | done | 2c0fbf8 | core workspace-folders, workspace-library, sources-folders tests; web project-folders, library tests | Local project folders; Library view |
| T-M4-07 | M4 | FR-113, FR-114, FR-115 | done | 2c0fbf8 | core profile, profile-accounts, usage tests; hub profile.test; web profile-settings.test | Profile + avatar + usage insights + active provider accounts |
| T-M4-08 | M4 | FR-044 | done | 2c0fbf8 | mcp server.test; hub mcp-server.test; web clients-settings.test | Nova-as-MCP-server with per-client tokens |
| T-M4-10 | M4 | FR-197 | done | 2c0fbf8 | core hooks, hooks-config, gate-hooks, loop-hooks tests; hub hooks.test | Lifecycle hooks (trust by hash, sandboxed, tighten-only, fail closed) |
| T-M4-11 | M4 | FR-198 | done | 2c0fbf8 | web apps-bridge, apps-frame, apps-views, workspace-apps tests; mcp apps.test; hub mcp-apps.test | MCP Apps UI host (sandboxed iframes, bridge, CSP) |
| T-M4-12 | M4 | FR-199 | done | 2c0fbf8 | mcp bundle.test; hub bundles.test | MCP bundle install (sideload confirmation, vault config) |
| T-M4-13 | M4 | FR-200 | done | 2c0fbf8 | core import, import-formats tests; hub import.test; web import-settings.test | Import from other assistants (preview, dedupe, secret references) |
| T-M4-09 | M4 | — | done | e12aad0 | `scripts/e2e-docker.sh --repeat-each=3`: 18/18 (smoke, J1-J4) | E2E J4 |
| T-M5-01 | M5 | FR-051 | done | 013ed1b | core runs-lifecycle, runs-loop tests; hub m5-integration.test | Run supervisor on the shared chat loop (TurnStarter/TurnExtension; ADR-076) |
| T-M5-02 | M5 | FR-051, FR-131 | done | 013ed1b | core runs-lifecycle.test; web work-run.test | Plans, autonomy levels (ask_first/standard/autonomous), plan edits |
| T-M5-03 | M5 | FR-053, FR-054 | done | 013ed1b | core runs-subagents.test; web work-run.test | Background sub-agents (task.*) + child threads, depth 1, limits |
| T-M5-04 | M5 | FR-055 | done | 013ed1b | core scheduler-recurrence/service/delivery tests; hub schedules.test; web work-scheduled.test | Scheduler (cron, RRULE, interval, at; DST; catch-up) + Scheduled UI |
| T-M5-05 | M5 | FR-057 | done | 013ed1b | hub runs.test (activity); web work-run.test (replay) | Activity view + replay |
| T-M5-06 | M5 | FR-058 | done | 013ed1b | core runs-budgets.test (approval timeout pause) | Approvals for runs |
| T-M5-07 | M5 | FR-061, FR-063 | done | 013ed1b | core code-sessions.test; core gate-m5-policy.test; web code-sessions.test | Code sessions + permission modes |
| T-M5-08 | M5 | FR-064, FR-065 | done | 013ed1b | core code-changes.test; web code-diff.test | File edits as diffs (shadow repo) + diff viewer + comments + hunks |
| T-M5-09 | M5 | FR-066, FR-074 | done | 013ed1b | core code-tools.test; web code-terminal.test | Terminal in the session folder + repo index (pattern-based; tree-sitter deferred) |
| T-M5-10 | M5 | FR-069 | done | 013ed1b | core code-tools.test; web code-review.test | `/review` findings card |
| T-M5-11 | M5 | FR-119, FR-104 | done | 013ed1b | hub diagnostics-m5.test; web diagnostics-m5.test | Diagnostics test actions; audit export verified |
| T-M5-12 | M5 | FR-030, FR-031 | done | 013ed1b | core images-tool.test | Image generation (hidden until a provider has an images call); realtime voice deferred |
| T-M5-13 | M5 | FR-050 | done | 013ed1b | core plugin-authoring.test | Plugin drafts from conversation (never auto-installed) |
| T-M5-15 | M5 | FR-181, FR-182 | done | 013ed1b | core runs-goals, runs-budgets, loop-m5-extensions tests | Goals + budgeted execution + per-turn backstop |
| T-M5-16 | M5 | FR-183 | done | 013ed1b | core context-compaction.test; web chat-followup.test | Compaction triggers + context tools |
| T-M5-17 | M5 | FR-184 | done | 013ed1b | core exec-sessions.test; hub exec-sessions.test | Interactive exec sessions |
| T-M5-18 | M5 | FR-185 | done | 013ed1b | core context-instructions.test | Instruction-file discovery |
| T-M5-19 | M5 | FR-186, FR-215 | done | 013ed1b | core runs-escalation, status-thread tests; web work-chat, work-sidebar tests | Chat escalation to Work; thread status model |
| T-M5-20 | M5 | FR-187, FR-188 | done | 013ed1b | core scheduler-delivery, requests-broker, requests-ask-tool tests; hub requests.test | Verified outcomes; server-to-client requests |
| T-M5-21 | M5 | FR-085 | done | 013ed1b | core reviewer-model, reviewer-breaker, gate-m5-review tests | Model-based auto-review (fail-closed, circuit breaker) |
| T-M5-22 | M5 | FR-211 | done | 013ed1b | core code-git.test (marker hook never runs) | Hook-free app Git operations |
| T-M5-23 | M5 | FR-216, FR-219, FR-220 | done | 013ed1b | core documents-* tests; web documents-preview.test; core runs-escalation.test (deep research) | Document outputs; deep research template; dictation deferred |
| T-M5-14 | M5 | — | done | cefed67 | `scripts/e2e-docker.sh --repeat-each=2`: 18/18 (smoke, J1-J6); J6 also with a Docker sandbox | E2E J5, J6 |
| T-M6-00 | M6 | — | done | d120865, 20de376 | core and storage tests | Seams for computers, the egress proxy, channels and the M6 areas; audit kinds |
| T-M6-01 | M6 | FR-079 | done | e370899 | core agents-service, hub agents tests; web agents-* tests | Agent model, creation page, responsibilities, avatar |
| T-M6-02 | M6 | FR-141, FR-142 | done | e370899, 827238a | `node scripts/cargo.mjs test` (120); hub devices-novad (real binary) | `novad` supervisor, modules, signed capability document; Ed25519/SHA-2 from vetted crates |
| T-M6-03 | M6 | FR-107, FR-080, FR-081 | done | e370899, 2b29a96, 6772516 | core sandbox-bwrap, sandbox-container, sandbox-protect, computers-service tests | bubblewrap + container substrates, protected paths mounted read-only, mock cloud and device computers |
| T-M6-04 | M6 | FR-092, FR-093, FR-087 | done | e370899, 6772516 | core browser-*, screen-* tests; J8 | Browser controller (Playwright), computer use with tiers and the kill key, takeover |
| T-M6-05 | M6 | FR-086, FR-075 | done | e370899 | core browser-signin, screen-service tests | Private sign-in, appshots |
| T-M6-06 | M6 | FR-082, FR-083 | done | e370899, 72e7144 | core agents-proactive, agents-loop (declared read-only MCP tool) | Read-only proactive research, background delegation |
| T-M6-07 | M6 | FR-084 | done | e370899, 72e7144 | core gate-m6-agents; hub m6-integration | Agent rules in the gate (never the managed layer; a failing source denies) |
| T-M6-08 | M6 | FR-056, FR-088, FR-110 | done | e370899, 6772516 | core channels-*, triggers-service; hub channels; J7 | Slack, Teams, webhook, in-app channels; triggers; private-to-shared check |
| T-M6-09 | M6 | FR-089, FR-090 | done | e370899, 2b29a96 | core agents-service; hub m6-integration | Agent memory and notes; activity, pause, stop, delete with its computer |
| T-M6-10 | M6 | FR-144, FR-145, FR-148 | done | e370899 | core devices-service; Rust power, update tests | Power and Wake-on-LAN, services, signed updates with rollback |
| T-M6-11 | M6 | FR-102, FR-103 | done | e370899, 72e7144 | core egress-proxy, egress-policy, browser-injection tests; J8 | Egress control and injection defense |
| T-M6-12 | M6 | FR-036, FR-037, FR-076, FR-012 | done | e370899 | core spaces-*, web spaces-*, pets-* tests | Spaces and pages, sites, visualizations, pets |
| T-M6-13 | M6 | FR-150 | done | e370899 | core devices-service | Per-device overrides and policy |
| T-M6-14 | M6 | — | done | 6772516 | `scripts/e2e-docker.sh`: 17/17; J7 and J8 three runs in a row | E2E J7, J8 |
| T-M6-15 | M6 | FR-193, FR-194 | done | e370899, 72e7144 | core computers-egress (credential injection on real substrates), egress-proxy | Egress proxy modes and credential injection; external-agent rule |
| T-M6-16 | M6 | FR-195 | done | e370899 | core sandbox-container (micro-VM flag) | Micro-VM substrate behind a flag (no runner shipped) |
| T-M6-17 | M6 | FR-201, FR-206 | done | e370899, 72e7144 | core triggers-service, scheduler-service; J7 | MCP event subscriptions; agent self-scheduling |
| T-M6-18 | M6 | FR-207, FR-208, FR-209 | done | e370899, 6772516 | core screen-*, browser-* tests; J8 | Control tiers; page tools; local browser fallback refuses with the reason (device browser module is M6.5) |
| T-M6-19 | M6 | FR-210 | done | e370899, 8583520 | core devices-files; hub devices; J7 step 7 | `novad` staged writes, access requests, local MCP pass-through; agent device-file tools |
| T-M6-20 | M6 | FR-062, FR-067, FR-068, FR-070, FR-072, FR-073, FR-078, FR-097 | done | e370899, 72e7144 | core code-m6-*, sandbox-publish, browser-devserver; web code-m6-* | Code environments, PRs and CI, worktree leases, dev servers through a port bridge, auto-verify, cross-session tools, budgets |
| T-M6-21 | M6 | FR-060 | done | e370899, 72e7144 | core channels-notify, notifications; web channels-routing | Notification routing and quiet hours |
| T-M6-22 | M6 | — | done | 3224b69, b658201 | `node scripts/check-spec.mjs` | Contracts, data model, ADR-093, topic docs, demo, ledger |
| T-M6-01 | M6 | FR-079 | todo | — | — | Agent model + creation/onboarding + responsibilities |
| T-M6-02 | M6 | FR-141, FR-142 | todo | — | — | `novad` supervisor + module sandbox + capability doc |
| T-M6-03 | M6 | FR-107 | todo | — | — | Local sandbox (bwrap) + container + cloud stub |
| T-M6-04 | M6 | FR-092, FR-093, FR-087 | todo | — | — | Browser controller + computer use + takeover |
| T-M6-05 | M6 | FR-086, FR-075 | todo | — | — | Sign-in flow + appshots |
| T-M6-06 | M6 | FR-082, FR-083 | todo | — | — | Proactive research + background threads |
| T-M6-07 | M6 | FR-084 | todo | — | — | Custom rules |
| T-M6-08 | M6 | FR-056, FR-088 | todo | — | — | Event triggers + channels (Slack/Teams/webhook) |
| T-M6-09 | M6 | FR-089, FR-090 | todo | — | — | Agent memory + activity/stop |
| T-M6-10 | M6 | FR-144, FR-145, FR-148 | todo | — | — | Power/WoL + service management + `novad` updates |
| T-M6-11 | M6 | FR-102, FR-103 | todo | — | — | Egress control + injection defense |
| T-M6-12 | M6 | FR-036, FR-037, FR-076, FR-012 | todo | — | — | Spaces/Pages + Sites + visualizations; pets |
| T-M6-13 | M6 | FR-150 | todo | — | — | Per-device overrides |
| T-M6-15 | M6 | FR-193, FR-194 | todo | — | — | Egress proxy modes + credential injection; external-agent rule |
| T-M6-16 | M6 | FR-195 | todo | — | — | Micro-VM substrate (flagged) |
| T-M6-17 | M6 | FR-201, FR-206 | todo | — | — | MCP event subscriptions; agent self-scheduling |
| T-M6-18 | M6 | FR-207, FR-209, FR-208 | todo | — | — | Computer-use control tiers; local browser fallback; page tools |
| T-M6-19 | M6 | FR-210 | todo | — | — | `novad` staged writes + local MCP pass-through |
| T-M6-14 | M6 | — | todo | — | — | E2E J7, J8 |
| T-M65-01 | M6.5 | FR-132 | done | e8441eb | core pairing, pairing-binding; hub add-device, m65-integration (real novad); web devices-add, join-*; J8.5 | Add Device v2: QR and short code (one use, 5 min, rate-limited), commit-then-reveal confirmation signed by the Hub, owner types the code the device shows; grants bound to the device key |
| T-M65-02 | M6.5 | FR-133 | done | e8441eb | hub agent-dist, agent-dist-novad (real binary); Rust install tests (143) | Signed manifest (Hub identity, domain-tagged), dist route, one-line command (code on stdin), `novad install` checks pin, signature and its own SHA-256 before writing anything |
| T-M65-03 | M6.5 | FR-135 | done | e8441eb | core network-endpoints, network-mdns; shared network (selectEndpoint); hub network; J8.5 | Endpoints per transport with real reachability checks (only healthy ones advertised), LAN and mDNS, fallback order, transport event log |
| T-M65-04 | M6.5 | FR-135, FR-136 | done | e8441eb | core network-mesh (fake CLIs); hub network-setup; J8.5 | Mesh adapters (Headscale, Tailscale, NetBird, WireGuard), ufw, package installs; argv only, fixed system PATH |
| T-M65-05 | M6.5 | FR-137 | done | e8441eb | relay (98% lines), relay-service, core relayhub; hub relay, relay-integration; J8.5 | Sealed envelopes (XChaCha20-Poly1305, X25519 bound to Ed25519), segmenting, acks, keepalive; self-hostable Relay with global caps; Hub connector, pairing, API tunnel; push and channel relay are M7 |
| T-M65-06 | M6.5 | FR-134 | done | e8441eb | core trust, trust-x509; hub trust, trust-main (real HTTPS) | Hub identity (never silently replaced), local CA with name constraints, TLS leaf with renewal, device certificates, mesh certificates by SNI, pinning statement with a nonce |
| T-M65-07 | M6.5 | FR-136, FR-139 | done | e8441eb | core network-setup, network-changes; hub network, network-setup; web netsurface-*; J8.5 | Network Setup assistant: detect, plan, consent per exact step, apply, verify, automatic rollback, lock-out guard; diagnostics; one-click rollback |
| T-M65-08 | M6.5 | FR-138 | done | e8441eb | core network-wake; hub network-wake; Rust wake-other; J8.5 | Wake Helper role: helper chosen by reported subnet, Hub fallback on its own LAN, rate-limited and audited with `via` |
| T-M65-09 | M6.5 | FR-140 | done | e8441eb | web devices-add, devices-manage, netsurface-*; J8.5 | Devices for every kind, scopes, wake, revoke; the Network surface (overview, setup, trust, Relay, wake helpers) |
| T-M65-10 | M6.5 | — | done | eb95271 | `scripts/e2e-docker.sh`: 21/21; J8.5 three runs in a row | E2E J8.5 (Add Device & transports) |
| T-M65-11 | M6.5 | — | done | e8441eb | regression tests per finding (review probes ported) | Two security reviews (18 and 6 findings, two high: confirmation brute force on the path, silent identity replacement), all fixed |
| T-M65-12 | M6.5 | — | done | e8441eb | `node scripts/check-spec.mjs` | Contracts, topic docs, ADR-094, demo, test manifest |
| T-M7-01 | M7 | FR-108, FR-071 | done | 783a955 | runner-service unit, server tests (bubblewrap); core cloudrun.test (bubblewrap, else the host test double); hub cloudrun.test (a Code session's command on a real runner on loopback); web cloud-settings, cloud-environment, cloud-run tests; J9 step 6 | `services/runner` (Apache-2.0): environments with several repositories, a setup script run once, caches, rebuild and snapshots; commands in bubblewrap or a container with process, memory and disk limits, live output, cancel, artifacts into the thread; CPU, wall-time and disk caps with a warning at 80 % (FR-116); the Hub's `cloud` environment kind, with Code sessions and Work runs that keep running while the client is offline; Settings → Cloud runner. Not built: runner network through the Hub's egress proxy (network stays off unless the owner turns on `cloud.runner.unrestrictedNetwork`, R-030), snapshots encrypted by Nova, agent computers on the real runner (they stay on the mock) |
| T-M7-02 | M7 | FR-109 | done | 783a955 | core sync-hlc, sync-service, sync-idempotency tests; hub sync, sync-idempotency tests (device A pushes, B pulls; merge log and restore); web replica-engine, sync-settings, sync-units tests; J9 steps 1-3 | Hub-canonical sync over `/api/v1/sync/*` (the Hub plays the sync service of `contracts/rest-api.md` §2; the Relay path stays content-blind): a change feed, per-field last writer wins by hybrid logical clock, device and clock-skew checks, a merge log with restore, `Idempotency-Key` with replay opted in per route; Settings → Sync. Not built: replicas in clients other than the web app, `sync.status.changed`, a `sync` audit kind (entries use `device`) |
| T-M7-03 | M7 | FR-129, FR-128 | done | 783a955 | hub sync.test (replica routes need `offline-replica`; revocation ends the copy); web replica-engine, offline-reads, offline-local, offline-labels tests; desktop local-runtime.test, shell.spec (offline start); `node scripts/cargo.mjs test` (local runtime, per-user sockets); hub m7-novad-tls.test (the scope reaches `scopes.json`) | FR-129: a device keeps a copy only while it has the `offline-replica` scope, sealed in IndexedDB under a non-extractable AES-GCM key; revocation, a 401 or a withdrawn grant wipes it. FR-128, partly built: in the desktop app a local model answers a waiting chat message through `novad`'s local runtime (a 0600 per-user socket, or loopback with a token; `local-runtime` scope), and the answer is queued and stored labelled as answered offline; the shell starts offline from its service-worker copy. Not built: local agents and tools, a Windows named pipe |
| T-M7-04 | M7 | FR-112 | done | 783a955 | web offline-queue, offline-reads tests; core and hub sync-idempotency tests; J9 step 4 | Offline writes (messages, new chats, renames, pins, archives, page and project edits, space names) become sync changes with a visible status and their own `Idempotency-Key`, sent in order once the copy catches up, with backoff and jitter; retry, copy, or discard (asks first); the Hub answers the last message written offline (`POST /api/v1/threads/:id/messages/:mid/answer`). Refused offline: files, deletes, model or reasoning changes, temporary chats |
| T-M7-05 | M7 | FR-008, FR-009 | done | 783a955 | `npm test -w apps/desktop` (pinning, routes, shell-parts, hub-client, connect, hardening); `npm run test:shell -w apps/desktop` (Electron journey, 3 tests; CI job e2e-shell); web shellbridge-units, shellbridge-views tests | `apps/desktop` (Electron): joins through Add Device as a browser device, checking the pinned identity on the same TLS connection before sending anything; tray and quick overlay (current or new chat, New task, the status list, Quit), global shortcuts (two modifiers, system keys refused, conflicts reported), windows of their own for app routes, OS notifications, `nova://` links, an offline start. Not built: voice in quick chat, detaching panes without a route, Electron fuses (M10) |
| T-M7-06 | M7 | FR-110, FR-111, FR-077, FR-137 | done | 783a955 | core channels-telegram, channels-email, channels-mail-drops, channels-push, channels-webpush tests; hub channels-m7, push tests; relay-service push.test (APNs and FCM against local fakes); web channels-m7-setup, channels-m7-log, push-subscribe, push-sw, push-approvals, push-newtask, relay-join, relay-transport, deeplinks-m7 tests; J9 step 7 | Telegram (webhook with a Hub-made secret, or polling; inline-keyboard approvals), email (IMAP and SMTP, the RFC 8601 sender check against the binding's authserv-id, approvals by signed one-use link only), Slack buttons, a message log; Web Push from the Hub (RFC 8291, 8292) and native push through the Relay's APNs and FCM senders; the Approvals page and the New task sheet; deep links `nova://run`, `nova://code`, `nova://approval`; the web join page and transport through the Relay (the Hub's CSP names the Relay it uses; the Relay answers CORS on its client routes). Not built: Telegram files, email OAuth, the channel relay, native apps; attachments, raw files, avatars and the terminal do not go through the tunnel |
| T-M7-07 | M7 | FR-091 | done | 783a955 | core team-agents, team-members, team-shared, team-oidc, team-review tests; hub team, team-oidc, team-review tests; web team-agents, team-members, team-member-mode, team-join, team-oidc, team-card tests | Several people on one Hub (ADR-095 decision 5): one-use invitations, members with their own accounts, folders and settings, owner-only routes, non-owners limited to public addresses; OIDC sign-in, link and join and the public profile card (FR-113). Team agents: an identity account that never signs in, credentials as `secret://` references, each task in its own thread with the requester's authority, approvals answered by the owner. Not built: purging a removed member's data, sharing the owner's providers, a member mode for Tools & MCP, Notifications and Channels |
| T-M7-09 | M7 | FR-213, FR-214 | done | 783a955 | core code-m7-handoff, code-m7-transport, code-m7-ssh tests (stand-in ssh client); hub code-m7.test; web code-m7-session, code-m7-environments tests; J9 step 5; desktop capture.test (AT-SPI through a fake `gdbus`) | Code handoff to another environment or worktree with the branch, HEAD, local commits as a Git bundle and uncommitted changes as one binary-safe patch, the target confirming the same state; the Moves tab. Also the M6 gaps of FR-062: SSH environments (off by default, host key pinned, helper checked by SHA-256) and Hub-side capture, review and commits for remote sessions. A chat handoff is recorded and announced, but its turns still run on the Hub and no UI moves a chat. Attach window: Linux text through AT-SPI, redacted, sent after the preview; window text on macOS and Windows and screenshot redaction are not built |
| T-M7-10 | M7 | FR-212, FR-217, FR-218 | done | 783a955 | core code-m7-attempts, code-m7-merge, team-shared, gate-m7-limits tests; hub code-m7, team, team-review tests; web code-m7-session (Best of N, Merges), team-shared tests | Best-of-N: 2 to 4 attempts in their own worktrees with budgets and an optional model; compare and apply one. Three-way merges (the M6 gap of FR-073): conflicts refused with their three sides, or written as markers that block commits. Shared threads: each turn runs under its writer, an allow-list of content tools, nobody's memory, instructions or connectors join. FR-218 (voice-call channel) is not built: it needs the voice pipeline (FR-031, FR-216), follow-up T-M9-07 |
| T-M7-11 | M7 | FR-202, FR-203 | done | 783a955 | core scripts-vm, scripts-tool, acp-protocol (fake ACP agent), acp-delegation, acp-security, egress-agent-policy tests; hub flagged.test; web flagged-settings, flagged-panes tests | Both behind security settings, off by default. `script.run`: QuickJS in a worker with time, memory and call limits; each nested call goes through the tool runtime and the gate without the user's instruction; never served to MCP clients. External agents (an ACP v1 subset): started only from the user's route, in the session's sandbox with the folder read-only and network only to the adapter's declared hosts, every file and command request through the gate, only the adapter's own secrets. Not built: a `script` origin in `tool_call`, ACP terminal environment variables |
| T-M7-08 | M7 | — | done | 1fac175 | `scripts/e2e-docker.sh`: 25/25; J9 4/4 three runs in a row; e2e-shell | E2E J9 (two devices with offline copies, a conflict restored, the offline queue in order, a Code handoff, a cloud Code session finishing while the laptop is offline, a phone's task through the Relay approved on the desktop). In the Playwright container the runner uses its host test double (the real sandbox path is hub cloudrun.test). J9 found seven product bugs, all fixed (M7 known gaps) |
| T-M7-12 | M7 | FR-092, FR-094, FR-098, FR-103 | done | 783a955 | core browser-capture, browser-crash, browser-observe, browser-scope, browser-review, browser-chromium tests (Playwright container); hub browser.test; web browser-m7.test | The M6 browser gaps: `browser.hover`, element screenshots, console and network capture (masked, never stored, scanned for injection), restart after a crash (only a navigation replayed), site levels per project and agent (the policy engine's `ruleTool`), a newest-first trace with a cursor; scoped levels go with their project or agent |
| T-M7-13 | M7 | FR-126, FR-192 | done | 783a955 | `node scripts/cargo.mjs test` (165 passed); compute hub-tls.test; hub device-trust, m7-novad-tls (real `novad`, also in CI's novad job), relay-token tests; web devices-tls, netsurface-relay-token tests | `novad`'s TLS client (rustls): install, enrollment and heartbeats over HTTPS, the pinned identity checked on the same connection first, the device certificate shown only to a verified Hub; mutual TLS on the device and node routes (a device that holds a certificate cannot call without it); heartbeat scopes kept in `scopes.json`; compute nodes check the CA's name constraints; the Relay registration token, tied to its Relay. The Hub → `novad` management channel is still plain HTTP (R-022); certificates are not renewed |
| T-M7-14 | M7 | FR-030, FR-042, FR-044, FR-053, FR-055, FR-060, FR-188 | done | 783a955 | hub mcp-m7, mcp-server-m7, channels-m7 tests; mcp stdio-launcher, device-transport tests; providers images.test; core images-openai, gate-m7-limits, runs-m7-limits, loop-m7-answer, approval-detail, agents-m7 tests; web flagged-images, channels-m7-log tests | Earlier deferrals and M6 gaps closed: device-hosted MCP servers, `auth` and `oauth`; resources, prompts and the stdio launcher on Nova's MCP server; image generation through OpenAI-compatible providers; sub-agent tool lists at the gate; the user's `ask_user` answer carries their authority; the schedule webhook secret shown once; test notifications, MCP subscription refresh, the channel message log; goal retry after a usage limit, `thread.status.changed` and plugins per agent; a device-file commit's diff on its approval card |
| T-M7-15 | M7 | — | done | 783a955 | regression tests per finding (review probes ported) | Security reviews (identity, execution, transports, browser, desktop): 46 findings, one critical, six high and one high/medium, all fixed; the docs pass found ten places where code and spec disagreed, all resolved (eight code fixes, ADR-095 decision 90 for the FR-126 tag, CI's `novad` job for the skipped TLS tests) |
| T-M7-16 | M7 | — | done | 783a955 | `node scripts/check-spec.mjs` | Contracts (`hub-api.md`, `rest-api.md` §2, §3, §5, `events.md`, `ipc-channels.md`, the capability schema), topic docs, ADR-095, demo, test manifest |
| T-M75-01 | M7.5 | FR-143 | done | 0521821 | core boot-service, boot-pxe, boot-fake tests; core firmware-authz.test (the `boot.set` vector); hub boot.test, boot-pxe.test (public routes, tokens, rate limits), listeners.test, settings-m75.test (consent), devices-policy-push.test; `node scripts/cargo.mjs test` (boot: one-shot, watchdog, GRUB verification); web boot-tab, firmware-settings tests; J9.5 step 7 | Low-level boot behind `devices.boot.allowLowLevel` (off; turned on with a confirmation): `novad` reads systemd-boot, GRUB, UEFI (`efibootmgr`) or a fake and sets a one-shot next boot only with a Hub-signed authorization over the exact body (ADR-096 D2), so a machine that never comes up returns to its default by itself; boot profiles; try and commit through a Hub-only approval card, sent once when the owner allows it; revert works with the switch off; the watchdog on the device (marker written first, `devices.boot.watchdogSeconds` or the try's own) clears the one-shot and restarts once into the default, and the Hub's own clock fails a trial 120 s after its deadline and links a linked BMC's power cycle; only a confirmed trial becomes the default, an unverified GRUB trial only with `confirmUnverified`; PXE/iPXE behind `devices.pxe.enabled` (off): a menu and images from `<dataDir>/boot-images/` by per-device boot token (`nvb_`, hashed, shown once), rate-limited, audited, masked in the log; the Boot tab. Not built: kernel arguments (refused), DHCP and TFTP, iPXE over HTTPS; nothing ran on a real bootloader (R-036, R-038) |
| T-M75-02 | M7.5 | FR-146 | done | 0521821 | core firmware-authz.test (four vectors shared with `novad`), firmware-service.test; hub firmware.test, settings-m75.test (consent and one audit entry per switch change), devices-policy-push.test (a switch reaches the device at once); `node scripts/cargo.mjs test` (firmware and authz: plan, apply, rollback, the watchdog, every refusal); web firmware-tab, firmware-settings, firmware-units tests; J9.5 steps 1-6 | BIOS/firmware settings, off by default (`devices.firmware.allowChanges`, and `devices.firmware.allowSecurityDegrading` for turning Secure Boot or the TPM off, each turned on with a confirmation and audited with before and after; the device also holds the switch, from every heartbeat answer and at once when it changes, and refuses apply and rollback while it is off): read and plan (a diff and a snapshot; one change per plan) through `novad`; a Hub-only approval card bound by a hash to the change, its diff and snapshot; apply only with a Hub-signed authorization, only while the device still holds the snapshot's values, restoring them if a write fails; an optional guarded restart whose watchdog restores the snapshot key by key (the Hub counts only a complete revert, else `revert_failed` with an attention notice, and a restart not reported in time is `missed`); rollback with its own approval from the device's snapshot or the Hub's sealed copy; the BIOS admin password write-only in the vault and sent only over mutual TLS; `device.firmware.*` audit with before and after; no model-facing tool; the Firmware tab and Settings → Devices → Firmware and boot. Not built: firmware updates (`fwupd` is listed read-only); no guarded restart on a BIOS with an admin password (R-037); nothing ran on a real BIOS (R-036) |
| T-M75-03 | M7.5 | FR-146 | done | 0521821 | `node scripts/cargo.mjs test` (firmware: unsupported hardware, the matrix against `tests/fixtures/firmware-support-matrix.json`); shared firmware-matrix.test (the same fixture); core firmware-service.test (unsupported hardware and the channel); hub firmware.test; web firmware-tab.test (the support matrix) | The hardware support matrix (`novad`'s table is authoritative, mirrored in `packages/shared/src/m75/firmware.ts` and `GET /api/v1/devices/firmware/support`): Dell, Lenovo and HP through the Linux kernel's firmware-attributes class, boot order on any UEFI machine through `efibootmgr`; ASUS and Supermicro refused with the reason, Windows and macOS `os_not_supported`, an unknown vendor without UEFI `legacy_bios`. The device and the Hub must both call a machine supported; every write route otherwise answers 409 `conflict` `{reason: unsupported_hardware, detail}`, and the tab says why in plain words with the matrix. Vendor attribute names are checked only against mock sysfs trees (R-036) |
| T-M75-04 | M7.5 | FR-147 | done | 0521821 | core oob-protocols.test (Redfish over a pinned certificate, `ipmitool`), oob-service.test (consent, addresses, pins confirmed before credentials, approvals bound to the BMC); hub oob.test; web oob.test; J9.5 step 8 | Out-of-band management on the Hub (no `novad` route), off by default and owner-only: turned on only through `POST /api/v1/oob/enable {confirm: true}` (the settings route refuses it); Redfish over HTTPS with the BMC's certificate pinned and confirmed by the owner before any credential is sent, IPMI through `ipmitool` lanplus with the password only in `IPMI_PASSWORD`; credentials only in the vault; addresses the owner enters, never loopback, link-local, the Hub's own or bare numeric forms, checked again at connect; power status, on, off, cycle and reset, sensors, BIOS read, plan and apply (Redfish pending settings, under the firmware switches), a one-time boot override; every change on a Hub-only card bound to the BMC's address and pin, run once within 10 minutes of the owner's allow; `device.oob.*` audit; the Out-of-band management page and a device's Out-of-band tab. Not built: Intel AMT (`capability_missing` `{reason: not_built}`), console access, BIOS settings over IPMI; tested only against a fake BMC (R-039) |
| T-M75-05 | M7.5 | — | done | d2446d4 | `scripts/e2e-docker.sh`: 28/28; J9.5 3/3 three runs in a row | E2E J9.5 (`e2e/j9-5-devices.spec.ts`, three tests): a device added through Add Device runs the real `novad` with its fake BIOS and bootloader and a fake `systemctl`, so the protocol, the Hub-signed authorizations and `novad`'s watchdogs run for real. Firmware is off by default (the tab and the Hub refuse), turned on with consent and audited; the demo change (Wake-on-LAN on, power-on after a power cut "On") is planned, approved on its Hub-only card, applied and rolled back with its own approval; Secure Boot off is refused without the override; a change whose restart never comes back is reverted by the watchdog; a boot trial is reverted by the watchdog with the default untouched; out-of-band management is off by default, turned on with consent, and a fake Redfish BMC (reached through a connection redirect, since the Hub refuses loopback BMC addresses) is pinned and confirmed before credentials, read and power cycled after its Hub-only card; axe on every page. J9.5 found product bugs, all fixed: the Hub refused the boot status of `novad`'s fake bootloader (`bootloader: "fake"`), and a switch reached a device only with its next heartbeat, so an apply right after turning it on was refused (now pushed at once through `POST /agent/v1/config`, with one retry); the firmware watchdog's length could not be set; the audit page showed no before/after values; the notices described a revert without a restart as a machine that did not come back |
| T-M75-06 | M7.5 | FR-126, FR-192 | done | 0521821 | `node scripts/cargo.mjs test` (mgmt_tls: TLS 1.3, refused client certificates, renewal checks and the swap); core devices-ops.test (mutual TLS, no downgrade, legacy certificates, renewal states); hub devices-m75.test (an https device managed over mutual TLS, a certificate naming another device), device-trust.test; web devices-m75-ops.test (the channel and renewal lines) | The Hub → `novad` management channel is mutual TLS 1.3 for a device that holds a certificate: `novad` presents its device certificate (both purposes since M7.5) and requires the Hub's client certificate (its local CA, `urn:nova:hub:<fingerprint>`, 90 days, kept in the vault); the Hub checks the device by chain, `urn:nova:device:<id>`, its pinned key and serial, never by host name, and refuses any `urn:nova:` certificate as the Hub's; an https endpoint is never called or moved back over plain HTTP (`endpoint_downgrade`), and privileged requests over plain HTTP to a device with a certificate are refused (`tls_required`); M7's clientAuth-only certificates are checked byte for byte for a 10-minute grace; renewal in the heartbeat answer until the device presents it, then the old one is revoked; the device page and diagnostics show the channel and the renewal. Not built: compute node certificate renewal; a device without a certificate stays on plain HTTP (R-022); the two sides were never run against each other (R-042) |
| T-M75-07 | M7.5 | FR-209 | done | 0521821 | core browser-fallback.test (offer, consent, sessions, end reasons, orphans), browser-fallback-device.test (fake `novad`; a real Chromium in the Playwright container), browser-session.test; hub browser-m75.test (fallback routes, trace marks); `node scripts/cargo.mjs test` (browser, egress and ws: launch, dedicated users, the egress filter, the DevTools WebSocket; a fake Chromium); web browserdevice-offer, browserdevice-settings tests | When a block page, or a challenge seen twice in 10 minutes, stops an agent's own browser and its agent has a connected computer offering the `browser` module, the user is asked (a `user_input` request with a `context`): a clean profile on that computer, their own browser through the extension, or not now; the consent is revocable, per agent, device and site. `novad`'s browser module runs Chromium with a fresh profile deleted on close, DevTools over a pipe relayed as a WebSocket (no TCP port), at most 2 sessions (closed after 10 minutes without a client, 4 hours at most), never as root (dedicated users `nova-browser1` and `nova-browser2` under a root `novad`), behind a per-session egress filter (the site and `*.site`, ports 80 and 443, public addresses only after DNS); the Hub drives it with Playwright `connectOverCDP` through a loopback relay; leaving the site ends the session; downloads off; trace rows marked and audited; orphaned sessions closed. Not built: nothing asks for the fallback on purpose (`BrowserService.localFallback` has no caller); thread-scoped consents; the real `novad` and a real Chromium never ran together (R-040) |
| T-M75-08 | M7.5 | FR-096 | done | 0521821 | core browser-bridge.test (grants, tab consent, `expectHost`, Shift-only keys, the Hub's own hosts, a replaced host, history search); extension bridge.test, icons.test (fake `chrome.*`); hub browser-m75.test (bridge routes, `POST /agent/v1/bridge/events`); `node scripts/cargo.mjs test` (bridge: framing, the per-user socket, token, uid and origin refusals, `bridge_offline`, `bridge_busy`, `bridge enable`); web browserdevice-bridge.test | The extension bridge to the user's own browser: `apps/extension` (Manifest V3, our own code and icon, no new dependency) with no host permissions by default, agent tabs in a "Nova" group, the debugger banner and a badge, and 13 page scripts of its own (no free `Runtime.evaluate`); `novad bridge-host` (native messaging, at most 1 MiB) talks only to the local `novad` over a per-user 0600 socket with that user's token, registered only by `novad bridge enable` run by the user, one host at a time (another OS user's is refused, `bridge_busy`); on the Hub owner-confirmed host grants ("all sites" a separate elevated grant), never the Hub's own hosts, per-tab consent, six DevTools methods with `expectHost`, Shift as the only modifier, no cookies, storage, downloads or uploads, history search asked in the extension each time; the Browser bridge section on the device page. Not built: a Windows bridge; a pinned extension id (R-041); connection state and tab consents do not survive a Hub restart |
| T-M75-09 | M7.5 | FR-140 | done | 0521821 | core devices-ops, devices-decommission-hub-only tests; hub devices-m75.test (online, offline, denied); `node scripts/cargo.mjs test` (uninstall order and the purge guard; decommission refusals and replay); web devices-m75-ops.test | Decommission: `POST /api/v1/devices/:id/decommission {purge}` files a Hub-only card (1 hour); on the owner's allow a reachable device gets a signed `device.decommission` authorization, wipes its key, credentials, certificate and Hub trust, then removes its service, binary and browser users in a fixed order (purge deletes the data folder, only one that is `novad`'s); the device is revoked whatever it answered, an offline one at once (it wipes itself at its next contact); its BIOS password leaves the vault. `novad uninstall [--purge]` does the local side, with the bridge manifests and tokens. Decommission… on the device page, the device's name typed to confirm |
| T-M75-10 | M7.5 | FR-142, FR-145, FR-148, FR-150, FR-126 | done | 0521821 | core devices-ops, nodes-ops tests; hub devices-m75.test (overrides, available builds, a real compute node's policy, VRAM and services); compute m75.test, node.test; web devices-m75-ops.test | The owner-only routes the M6 UI lacked: managed services (`novad` 0.7.0 lists them through `POST /agent/v1/services`; an older one answers `update_required`), the build available from the agent-dist manifest (information only), the owner's overrides with push-now, and the management channel view; on the device page (Modules, Updates, Policy). Compute nodes (the M6 deferral of FR-126): VRAM from `nvidia-smi` or `rocm-smi` in the signed document and every heartbeat; the owner's node policy (quiet hours in the policy's time zone, routing eligibility) in the heartbeat answer, new jobs refused in quiet hours or with the jobs service stopped, and routing skips the node; `/node/v1/services` for `jobs` and, with `--backend-unit`, the model server; the node's Policy and services page |
| T-M75-11 | M7.5 | FR-100, FR-146, FR-147 | done | 0521821 | core approvals.test (`answerIn`, `scope`), channels-hub-only.test, devices-decommission-hub-only.test, firmware-service.test (decisions by `channel:`, `hook:` and `system` refused); web approval-device-card.test; J9.5 (`answerIn: 'hub'`) | Hub-only approval cards: firmware, boot, out-of-band and decommission cards set `approval.answer_in = 'hub'` (`ApprovalView.answerIn`, with `scope` such as `device:<id>`); the approvals gate refuses any decision not made by the signed-in user (`hub_only`): channel buttons and replies are refused, a signed email link shows nothing and the attempt is audited, prompts carry no buttons or link and say to answer in the web or desktop app, push only opens `nova://approval/<id>`; each area re-checks `decided_by = 'user'` and uses an approval once. The card says it is Hub-only, links its device and offers a plain Deny |
| T-M75-12 | M7.5 | — | done | 0521821 | regression tests per finding (review probes ported) | Security reviews (privileged device actions; the browser fallback and bridge; out-of-band and PXE): 19 findings, one medium-high and seven medium, none critical or high, all fixed, with their hardening notes except those in the M7.5 known gaps. Found while building and fixed: modules, Code processes and services started by a management request died with the request's thread (since M6). The docs pass wrote the docs to the code where the agents' reports disagreed with it, and the code-side mismatches it found were fixed while closing (M7.5 known gaps) |
| T-M75-13 | M7.5 | — | done | 0521821 | `node scripts/check-spec.mjs` | Contracts (`hub-api.md` §1-§6, `events.md`, `schemas/server-request.json`, the capability schema's description), topic docs (03, 04, 06, 11, 12, 14, 16, 17, 18, 19, 20, 22, 23), ADR-096, READMEs (core, hub, web, extension, `novad`), demo, test manifest |
| T-M8-01 | M8 | FR-117, FR-198, FR-200 | done | 6a8bceb, 3478630 | core sdk-bundle, sdk-engine, sdk-host, sdk-manifest, sdk-service, sdk-supply tests; hub sdk.test; sdk and cli package tests; web extensions-page, extensions-shell, extensions-units, extensions-update-m8 tests; J10 step 1 | The extension SDK: `.novax` bundles (the M4 plugin format plus `.nova-plugin/extension.json`) signed with Ed25519 over a canonical file digest (control characters refused in paths, `.git`, `.env` and PEM keys refused), verified for every install source; handlers run in a QuickJS worker per extension with no ambient authority: commands, panels (the MCP Apps bridge), `ext:<id>/<name>` tools through the gate, theme tokens, keybindings, menus, status items and hooks, and fs, network (8 requests in flight, 16 MB being received) and secrets only as declared, anything else denied, audited and the extension turned off; a CPU budget that faults endless promise chains; installed files checked against the digest before a worker starts; a change of publisher needs `acceptPublisherChange` on every install path and clears the extension's secrets and data; secret refs scoped by account; `@nova/sdk` (types and a test host, Apache-2.0) with the sample and template; the `nova` CLI (`init`, `dev`, `validate`, `pack`, `keys`, `mcp stdio`, `data export/import`). FR-198's App frame domains line and the composer's + menu, and FR-200's hooks from other plugin layouts (converted on import, untrusted) |
| T-M8-02 | M8 | FR-049 | done | 6a8bceb, 3478630 | core market-signing, market-service, market-sample, market-edges, market-extensions, market-review tests; hub market.test, market-mcp.test; web market-page, market-catalogs, market-pets, market-publishers tests; J10 demo | The marketplace: local, Git (commit-pinned, read inside the checkout only) and remote catalogs whose index is signed by a key the entry pins (a pinned catalog without a signature is refused); search, install, update with a permission diff that must be accepted (MCP servers' command, args and default approval; plugin tools, hooks, roles and UI), rollback, local ratings, plugins, skills, themes, pets, MCP servers and extensions; publishers named only when the owner trusts the key, otherwise by fingerprint; the bounded zip reader (overlapping entries, mismatched stored sizes, data past the end and ZIP64 refused, the larger size counted) for every archive including imports; the signed sample catalog (Release notes, Aurora, a skill, Word count); the Marketplace page in the sidebar with its Catalogs tab |
| T-M8-03 | M8 | FR-106 | done | 6a8bceb, 3478630 | core managed-policy, managed-rules, managed-restrictions, managed-gate, managed-areas, managed-source tests; hub managed.test; web managed-page, managed-note tests; J10 step 2 | Managed policy: the OS-protected file (root- or Administrators-owned, not writable by others) and a signed remote policy pinned in it, with `minSerial`; settings become the locked `managed` layer and `restrict` feeds one `ManagedPolicy` service read by the gate, tools, plugins, extensions, MCP, sessions, folders, browser, egress (the policy's allow list is a ceiling over the owner's own), routing, telemetry, apps and installs; tighten-only: a loosening value is ignored and reported, every security setting has a rule or is listed as having no order (then policy cannot set it), and anything unreadable fails closed; a test layer only with `--allow-test-policy` or `NODE_ENV=test`; "Managed by your organization (source)" on every locked control and the Managed policy page |
| T-M8-04 | M8 | FR-105, FR-115, FR-116, FR-121 | done | 6a8bceb, 3478630 | core datactl-archive, datactl-service, datactl-account, datactl-crash, datactl-cli tests; hub datactl.test, team-m8.test; web datactl-page, datactl-retention-crash, spend-caps tests; J10 step 3 | Data controls: export as `.novaexport` (per-table JSONL with checksums; sealed with a passphrase in chunked AES-256-GCM, confirmed with the Hub's name and refused from a paired device; without one, secrets and cookie jars are left out and listed), delete-all with the Hub's name, import into an empty Hub that checks the format, schema, every checksum, every secret reference and path, verifies table by table before committing, and brings risky items back off (stdio MCP servers, plugins, hooks, external agents, other sessions); an account-scoped export of a removed member; per-item retention with a daily sweep and an anchored audit; spend caps per provider with reservations and a hard stop (at most one call over), provider limits and entitlements, clear usage; opt-in crash reports with local dumps and a preview, sent only to the owner's endpoint |
| T-M8-05 | M8 | FR-016, FR-015 | done | 6a8bceb, 3478630 | i18n package tests; `npm run i18n:check`; the `nova-i18n/no-literal-ui-text` rule on every web folder and packages/ui; web i18n-*.test (en-XA on every area, ar on the shell, chat, settings, marketplace and extensions); web rtl-css.test; `e2e/rtl-layout.spec.ts`; `e2e/a11y-sweep.spec.ts` (16 tests); J10 demo | Localization: `@nova/i18n` (typed `defineMessages` with an ICU subset, `fmt` on Intl, catalogs per locale and namespace, pseudo-locales en-XA and ar-XB) used by the web app, packages/ui and the desktop app; every web area converted (about 12,900 messages); `appearance.locale` with English, Arabic (partial, machine-drafted) and the two test locales; right-to-left layout with logical CSS properties, mirrored direction icons, left-to-right islands for code, paths and URLs, and `dir="auto"` on user content. Accessibility: the WCAG 2.2 A/AA sweep (axe with every A/AA tag and no exclusions, plus keyboard, focus, target size, drag alternatives, reduced motion, reflow, text spacing, live regions) as owner, member, phone and in dark and high-contrast themes, and its fixes (toasts with an action never time out, hoverable tooltips, drag alternatives, field and placeholder contrast, lock notes linked to their controls, page titles); conformance table in docs/04 |
| T-M8-07 | M8 | FR-222, FR-223 | done | 6a8bceb, 3478630 | core appauth, appauth-rules tests; hub appauth.test, appauth-forward.test, otlp.test, routes.test, listeners.test; telemetry tests; web appauth-consent, appauth-settings tests | Third-party apps: OAuth 2.0 authorization code with PKCE (S256), dynamic registration (pending registrations listed and removable, lapsing after an hour unless open registration is on), the consent page at `/authorize`, `nva_` access tokens (1 h) and rotated refresh tokens (30 d) per app, scoped to the app routes their scopes name and never owner administration, revocable, audited per app per hour; managed policy can turn it off. OTLP/HTTP JSON export of traces, metrics and logs to the owner's collector (headers as secrets), off by default, redacted, content only with its own switch, bounded queue with backoff. Every Hub route classified exactly once (closes R-032) |
| T-M8-06 | M8 | — | done | 3478630 | `scripts/e2e-docker.sh`: 52/52; J10 three runs in a row | E2E J10 (`e2e/j10-extension-governance.spec.ts`): a sample extension's command, panel and tool with its permissions enforced (an undeclared host refused before any request, audited, the extension turned off); a managed policy that locks Bypass and the network, shown as managed with its source, refused by the Hub, and a stricter file applied on reload; export without and with a passphrase, delete everything, import, every table and file compared; the demo (Arabic right to left, the Aurora theme and the Release notes plugin from the Marketplace). It found product bugs, all fixed (see the M8 known gaps) |
| T-M8-08 | M8 | FR-011, FR-110, FR-217, FR-091 | done | 6a8bceb, 3478630 | web custom-theme, theme-share tests; core channels-telegram-files, channels-email-oauth tests; hub channels-m8, team-m8, team-m8-mailbox, flagged-m8 tests; web channels-m8, team-m8, member-mode-m8 tests | Carry-ins: a saved theme applied token for token (`appearance.customTheme`, cached for the first paint); Telegram files in and out and email XOAUTH2 with the file field in the message log; a removed member's data kept for a grace period then purged (or exported and purged at once), their pollers stopped at once, member mode for Tools & MCP, Notifications and Channels, agent skill catalogs scoped to their plugins, authors shown in shared chats; `script` as a `tool_call` origin, device MCP resources and prompts, ACP terminal environment through an allowlist |
| T-M8-09 | M8 | FR-036, FR-037 | done | 6a8bceb, 3478630 | core spaces-m8, sites-hosting tests; hub spaces-m8.test; web spaces-m8 test | Spaces and sites: reorder pages (drag, or Move up/down and Move to), delete with what goes listed, undo and Recently deleted with Restore; change a site's source after a preview of what changes; remote hosting targets over WebDAV (https, or http only to this machine; a temporary collection swapped in with one MOVE; only folders carrying Nova's marker replaced; write-only credentials; every request through the egress check), a publish plan before every publish, `sites.remoteTargets` (managed can turn it off) |
| T-M8-10 | M8 | — | done | 6a8bceb, 3478630 | regression tests per finding (review probes ported) | Security reviews (access and app authorization; data controls and managed policy; the extension supply chain) and the docs pass: every finding fixed with a regression test (M8 known gaps) |
| T-M8-11 | M8 | — | done | 3478630 | `node scripts/check-spec.mjs`; core contracts-m8.test | Contracts (`hub-api.md` M8 routes and route classes, app scopes, `events.md`, schemas for the extension manifest and signature, catalog index and signature, managed settings and the export manifest), topic docs (04, 05, 06, 08, 10, 12, 13, 14, 15, 16, 19, 20, 23, 26 §9 the extension author's guide, 28), ADR-097, READMEs (core, hub, ui, i18n, sdk, cli), demo |
| T-M9-01 | M9 | FR-122 | todo | — | — | Meet performance budgets + CI regression guard |
| T-M9-02 | M9 | FR-123 | todo | — | — | Full security suite + fuzzing + sandbox escape tests |
| T-M9-03 | M9 | — | todo | — | — | Test-suite completion; flakiness elimination |
| T-M9-04 | M9 | — | todo | — | — | Error/degraded/empty-state polish |
| T-M9-05 | M9 | FR-135, FR-141 | todo | — | — | Device-lab tests (multi-device, transports, novad) |
| T-M9-06 | M9 | FR-224 | todo | — | — | Persistence safety evals + reviewer metrics |
| T-M9-07 | M9 | FR-218 | todo | — | — | Voice-call channel (in-app and telephony, streaming speech both ways); needs the voice pipeline (FR-031, FR-216 are deferred) |
| T-M9-08 | M9 | FR-093, FR-207 | todo | — | — | `novad` `screen` module: computer use on a real desktop through `novad` (the device side of FR-093 and FR-207), moved from M7.5 to be built with N1's capture work (ADR-096) |
| T-M10-01 | M10 | FR-124 | todo | — | — | Hub packaging (container/systemd/launchd/service) |
| T-M10-02 | M10 | FR-148 | todo | — | — | `novad` signed per-arch builds + update channel |
| T-M10-03 | M10 | FR-125 | todo | — | — | Client installers (Linux/macOS/Windows) + PWA |
| T-M10-04 | M10 | — | todo | — | — | Signing/notarization + SBOM + checksums |
| T-M10-05 | M10 | FR-120 | todo | — | — | Auto-update + staged rollout + rollback |
| T-M10-06 | M10 | — | todo | — | — | Docs, tutorials, changelog, release notes |
| T-M10-08 | M10 | FR-225 | todo | — | — | Install robustness (data dirs, port conflicts, download verification) |
| T-M10-07 | M10 | — | todo | — | — | E2E J11; release checklist |
| T-N1-01 | N1 | — | todo | — | — | Reconcile ambient findings; finalize capture design (done in Phase 0, ADR-073) |
| T-N1-02 | N1 | FR-151 | todo | — | — | Event-driven capture of the focused window + permissions (Windows first) |
| T-N1-03 | N1 | FR-152 | todo | — | — | Accessibility-first text extraction, OCR fallback; audio STT (phase 2) |
| T-N1-04 | N1 | FR-153 | todo | — | — | Timeline UI + FTS (time-ordered) + optional vector index |
| T-N1-05 | N1 | FR-154 | todo | — | — | Privacy controls (rules, built-in exclusions, pauses, forget, retention) |
| T-N1-06 | N1 | FR-155 | todo | — | — | Ambient tools (broad to narrow) + MCP exposure with coverage |
| T-N1-07 | N1 | FR-156 | todo | — | — | Resource governor (power profiles, CPU lane, disk guard) |
| T-N1-08 | N1 | FR-227 | todo | — | — | Redaction release gate + per-category switches |
| T-N1-09 | N1 | FR-228 | todo | — | — | Capture split: networkless helper, `novad` transport, Hub storage, pixel upload |
| T-N1-10 | N1 | FR-229 | todo | — | — | Activity summary |
| T-N1-11 | N1 | FR-232, FR-233 | todo | — | — | Provenance checks + scoped ambient grants |
| T-N1-12 | N1 | FR-230, FR-231 | todo | — | — | Meeting detection + speaker identity (phase 2) |
| T-N2-01 | N2 | FR-157 | todo | — | — | Automation engine + versioning + DAG execution |
| T-N2-02 | N2 | FR-158 | todo | — | — | Trigger kinds |
| T-N2-03 | N2 | FR-159 | todo | — | — | Action kinds |
| T-N2-04 | N2 | FR-160 | todo | — | — | Dry-run, logs, rollback, approvals, loop prevention |
| T-N2-05 | N2 | FR-176 | todo | — | — | Home Assistant managed-or-direct bootstrap |
| T-N2-06 | N2 | FR-162 | todo | — | — | Entity model + areas/scenes + NL control |
| T-N2-07 | N2 | FR-163 | todo | — | — | Agent ↔ automation interop |
| T-N2-08 | N2 | FR-179 | todo | — | — | HomeKit bridge (optional) |
| T-N2-09 | N2 | FR-180 | todo | — | — | Matter bridge (optional) |
| T-N3-01 | N3 | FR-165, FR-177 | todo | — | — | Unified catalog format + hosting endpoints (public + tailnet) |
| T-N3-02 | N3 | FR-166 | todo | — | — | MCP registry import + permission wrapping |
| T-N3-03 | N3 | FR-167 | todo | — | — | Signed publish/install + permission diff + rollback |
| T-N3-04 | N3 | FR-168 | todo | — | — | Governance: review, scanning, report/takedown, kill switch |
| T-N4-01 | N4 | FR-169 | todo | — | — | L0 memory learning with review |
| T-N4-02 | N4 | FR-170, FR-178 | todo | — | — | L1 skill synthesis + authoring (markdown) |
| T-N4-03 | N4 | FR-175 | todo | — | — | Evaluation harness + regression gates |
| T-N4-04 | N4 | FR-171 | todo | — | — | L2 workflow/prompt optimization with evidence |
| T-N4-05 | N4 | FR-172 | todo | — | — | L3 bounded self-tuning + drift detection |
| T-N4-06 | N4 | FR-173 | todo | — | — | L4 gated code self-modification + guardrail toggle |
| T-N4-07 | N4 | FR-174 | todo | — | — | L5 optional local fine-tuning |
| T-N4-08 | N4 | FR-175 | todo | — | — | Transparency view + kill switch |
| T-N4-09 | N4 | FR-226 | todo | — | — | Skill proposals from a recorded demonstration |

## Blockers

- (none)

## Risks

- R-001: Scope is very large (233 FRs). Mitigation: strict milestone gating, vertical slices, feature flags (`docs/00` §8).
- R-002: Provider API churn. Mitigation: adapter interface + recorded fixtures + conformance suite (`docs/07` §15).
- R-003: Sandboxing differs per OS. Mitigation: Linux bubblewrap first; macOS and Windows behind flags (ADR-064, ADR-065).
- R-004: Prompt injection through tools, channels and capture. Mitigation: intent provenance, untrusted labelling, fail-closed auto-review (FR-189, FR-085, FR-194).
- R-005: Legal/IP. Mitigation: clean-room rules, name check in `scripts/check-spec.mjs` (ADR-056).
- R-006: No Rust toolchain on the dev host. Mitigation: build and test `services/novad` in a `rust` container; CI runners have cargo.
- R-007: Node built-in SQLite is still marked "active development". Mitigation: storage access goes through `packages/storage`, so the driver can be swapped (ADR-084).
- R-008: The dev host lacks Chromium's system libraries and sudo. Mitigation: E2E runs in the official Playwright container (`scripts/e2e-docker.sh`); CI installs the libraries itself.
- R-009: The web bundle's main chunk is 328 KB gzipped after M5 (288 KB after M4, 202 KB after M2, 73 KB at M0); the terminal (xterm) is a separate 83 KB chunk. Mitigation: split Work, Code, settings, projects, compare and the apps host into dynamic routes in M6; cold start is still under budget.
- R-010: Provider request details (Anthropic adaptive thinking and summarized reasoning, OpenRouter reasoning options) are verified only against recorded fixtures. Mitigation: opt-in live smoke tests behind a key, before M10.
- R-011: Tests are timing-sensitive when every package runs at once (each Vitest spawns a worker per core). Mitigation: `npm test` runs at most 4 packages at a time, async queries wait up to 5 s (`apps/web/test/setup.ts`), timing guards leave room for loaded runs, and racy fixtures were fixed at the cause; quarantine with a ledger task if one still flakes.
- R-012: MCP stdio servers run as the Hub's user without a sandbox or egress proxy until M6 (FR-107, FR-193). Mitigation: only a signed-in owner can add one; secrets are passed by reference; every add and change is audited.
- R-013: Effect inference for MCP and plugin tools can be over-strict (`list_orders` reads as a purchase and is never pre-approvable). Mitigation: it only ever tightens; a manifest-declared effect list arrives with plugins (M4).
- R-014: The SQLite database is not encrypted at rest (`node:sqlite` has no encrypting storage layer). Mitigation: blobs are sealed, Diagnostics warns when the data directory is not on an encrypted volume; revisit in M9 (ADR-090).
- R-015: Command hooks and terminals need the container sandbox; without docker or podman they fail closed (hooks block, terminals show unavailable). The Playwright container has no docker, so J4 checks hook trust states in the UI and leaves hook execution to unit tests; CI runners have docker. Mitigation: the bubblewrap sandbox in M6 (ADR-064).
- R-016: Documents are built and read synchronously on the Hub's main thread (a 100k-row workbook takes about 1 s). Mitigation: caps on size; move to a worker thread if it matters (ADR-092).
- R-017: Office files are validated structurally (zip parts, content types, relationships, XML), not opened in an office suite in tests. Mitigation: minimal parts; add a conversion check in CI before M10.
- R-018: Auto-review's circuit breaker and `startTurn`'s queue live in memory: a Hub restart resets the breaker count and drops queued runtime starts (the areas recover their own state). Mitigation: documented in ADR-092; persist if it becomes a problem.
- R-019: The agent browser depends on Playwright's Chromium on the Hub (`npx playwright install chromium`); without it the browser tools refuse with the reason. Mitigation: diagnostics report it; CI and the E2E container have it.
- R-020: Protected locations in sandboxes are mounted only where they exist when a command starts and on the path from a root to the working folder; a credential folder elsewhere in a granted folder stays visible to that command (Hub and `novad`). Mitigation: file tools refuse them at any depth; revisit with a full walk or landlock in M9.
- R-021: The dev-server bridge port listens on 127.0.0.1 without a token, so any local process on the Hub machine can reach a running dev server (as with a native dev server). Mitigation: loopback only; closed with the server; documented in docs/12 §8.
- R-022 (closed in M7.5 for devices with a certificate): A device without a device certificate, which is every device in the default trust mode (`none`) and every device added before certificates, is still managed with bearer tokens over plain HTTP (port 7420), and so is a device or node whose Hub serves plain HTTP; `devices.tls.allowWithoutCertificate` (on for one release) accepts a device that never had a certificate. For a device that holds one, M7.5 made the management channel mutual TLS 1.3 (the Hub's client certificate from its local CA; the device checked by chain, `urn:nova:device:<id>`, its pinned key and serial, never by host name), an https endpoint is never called or moved back over plain HTTP, and certificates renew through the heartbeat (ADR-096 D1; `novad`'s mgmt_tls tests, `apps/hub/test/devices-m75.test.ts`; the two sides were not run against each other, R-042). Over plain HTTP, firmware, boot and decommission still need a Hub-signed authorization over the exact body (D2), which a captured management token cannot make, and the BIOS admin password is never sent. Mitigation: per-device credentials, hashed; signed capability documents and updates; the Mesh; the Hub local CA in onboarding (R-025).
- R-023 (closed in M7): `novad` has a TLS client (rustls with the ring provider): install, enrollment and heartbeats go over HTTPS, the pinned identity statement is checked on the same connection before anything is sent, and the device certificate is shown only to a verified Hub (ADR-095 decisions 73-75; `apps/hub/test/m7-novad-tls.test.ts` against the real binary, also in CI's `novad` job). The install command fetches with `curl -fsSLk`; the SHA-256 in the command carries the integrity.
- R-024: Relay sessions have no forward secrecy (static per-pairing keys from X25519): a later leak of either side's Relay key exposes recorded traffic of that pairing. Since M7 a browser paired through the Relay also holds such keys, as raw bytes sealed in IndexedDB that page script can use (R-031). Mitigation: re-pairing rotates the keys; the Relay sees only ciphertext; a ratchet in M9.
- R-025: Phones cannot join a Hub that serves plain HTTP at a network address (no secure context, so no Web Crypto, for a direct join and for pairing through the Relay alike); the trust mode defaults to `none`. M7 did not change this: pairing through the Relay from the web needs Web Crypto too, no native app exists, and the desktop shell needs HTTPS for any Hub not on its own computer. Mitigation: the join page says so, Add a device warns the owner; onboarding (H1) should offer the Hub local CA; native apps in M10.
- R-026: Add Device sessions of browsers and apps are owner sessions: only the `offline-replica` and `local-runtime` scopes are enforced (since M7, read on every request, so a revoked device fails closed); `files`, `browser`, `computer_use` and `exec` are recorded and shown but do not narrow the session. Mitigation: every join needs the owner's approval with the device's code; one-click revoke ends the session, blocks the key and wipes the offline copy; scoped sessions in M9.
- R-027: Mesh adapters were exercised only against fake CLIs, and network setup runs as the Hub's user (no elevation). Mitigation: off-by-default host-changes setting, consent per exact step, automatic rollback, lock-out guard; manual runs against real meshes in M9/M10.
- R-028: Email sender authentication rests on the receiving server: a sender counts as their mapped person only by the topmost Authentication-Results header with the binding's authserv-id (RFC 8601), so a mail server that adds no header of its own lets a forged one with that id count; for large providers the default id (the IMAP host's domain) does not match, so their mail stays unverified until the owner sets `authservId`. Mitigation: DMARC pass for the From domain or an aligned DKIM pass in the same result; email approvals only by a signed one-use link mailed to the real address; `senderCheck: none` needs a confirmation and is audited; docs/13 §4 says the server must add its own header.
- R-029: The desktop shell's app identity off Linux (System Events on macOS, PowerShell and user32 on Windows), on which excluded apps depend, is tested only against recorded command output; the shell's journey runs only on Linux; its Electron fuses are not set before packaging; and with Electron 44 a certificate check that races one from the main process fails a page load (worked around by sending one request alone first, so a renewal under concurrent requests can still fail one). Mitigation: capture refuses a window whose app it cannot name; the e2e-shell CI job; manual runs on macOS and Windows and the fuses in M10.
- R-030: With `cloud.runner.unrestrictedNetwork` on, cloud commands get the runner host's network outside the Hub's egress proxy: no allow or deny lists, no private-address block, no credential scanning, no egress audit; under bubblewrap that is the runner machine's own network, which for the local runner is the Hub's machine and its loopback services. Mitigation: off by default (an owner security setting that asks first); only when the turn's network mode is not `off`; environments with network are refused without it (`cloud_network_off`); external agents refuse network there (`no_egress_proxy`); the container substrate on a shared runner; proxying runner network through the Hub in M9.
- R-031: A browser paired through the Relay authenticates with a device token sent as a bearer header (the Hub's cookies do not come back through the tunnel); the token and the Relay session keys are sealed in IndexedDB under a non-extractable key, but page script can use them, so a script injection on the Hub's origin could take a long-lived device credential (weaker than an HttpOnly cookie). Mitigation: the Hub's strict CSP (scripts from the Hub only); revoking the device ends the token and the Relay route at once; a binding page script cannot read, in M9.
- R-032 (closed in M8): What kept members off the Hub's administration and machine was `OWNER_ONLY_ROUTES` (`packages/core/src/team/access.ts`), which every new Hub-administration route must join by hand; nothing fails when one is left off (no test classifies every route, as `listeners.test.ts` does for public routes), and member-reachable areas rely on filtering by account. Since M8 every registered route is classified exactly once as public, owner, member, device, node or app (`packages/core/src/team/routes.ts`), an unlisted route is refused to members, and `apps/hub/test/routes.test.ts` fails on a route without a class (T-M8-07).
- R-033: M7's outside services are verified only against local fakes: the Telegram Bot API, IMAP and SMTP, APNs and FCM, Web Push services (the RFC 8291 test vector, no real push service), OIDC providers, SSH (a stand-in client, no real sshd) and external coding agents (a fake ACP agent; the protocol subset was written from its public description). Mitigation: each adapter follows its RFC or public API and fails closed; SSH and external agents are off by default; opt-in live smoke tests before M10 (as R-010).
- R-034: `novad` running as root makes each listed user's local-runtime socket and, since M7.5, their extension-bridge socket (`bridge.sock`) by forking, switching to the user's ids and binding in the user's folder; it reads each user's bridge token and removes their bridge manifests at uninstall the same way. All of this is tested only with the build user's own ids, never across users as root, and the macOS path never on a Mac. A mistake here is a local privilege escalation (the M7 transports review found one). Mitigation: root never creates or changes anything in the user's folder itself, refuses links, and re-checks the socket's owner, mode, link count and inode; a bridge connection must come from the socket owner's uid with that user's token; cross-user runs in the M9 device lab (T-M9-05).
- R-035 (closed in M7): In SSH, WSL and device Code sessions the Hub's `fs.*` tools acted on the Hub's own disk at the session folder's path. They now reach the folder on that machine through the session's helper or device provider with the Hub's path rules (no escape, no credential files, protected paths read-only, links never followed), `fs.search` and the document tools are hidden there, the tool runtime gets no root on the Hub's disk, terminals are refused, and an unreachable machine fails closed (`packages/core/test/code-m7-remote-files.test.ts`). Still open: a cloud thread's tool scope names `/workspace/<folder>` as a Hub path for mentions and instruction files (its `fs.*` stay denied), T-M9.
- R-036: BIOS and boot management ran only against stand-ins: the firmware-attributes backend against mock sysfs trees with vendor attribute names from the kernel drivers (Dell `dell-wmi-sysman`, Lenovo `think-lmi`, HP `hp-bioscfg`), `efibootmgr`, `bootctl` and the GRUB tools against fakes, and J9.5's device against `novad`'s fake BIOS and bootloader files with a fake `systemctl`; nothing ran on a real BIOS, bootloader or restart. A wrong attribute name or value fails a write, and a bootloader that behaves differently can leave a trial unverified or not taken. Mitigation: off by default (`devices.firmware.allowChanges`, `devices.boot.allowLowLevel`); an allowlist of seven settings with the device's own allowed values; a snapshot checked before any write and restored when one fails; rollback; watchdogs on the device and on the Hub's clock; boot trials are one-shots that fall back to the default at the next power cycle; the device lab (T-M9-05).
- R-037: `novad`'s watchdog cannot restore a BIOS that has an admin password, because it never holds the password: the Hub refuses a guarded restart there (`watchdog_unavailable`), so such a change is applied without one and the owner restarts the machine with no watchdog behind it; a setting that stops the machine from starting is then undone by hand (or through the BMC, where there is one). On a device without a certificate the password is never sent, so such a BIOS cannot be changed at all. Mitigation: the apply dialog says so first; the snapshot is kept on the device and, sealed, on the Hub for a rollback once the machine is back; the password is read per call from the vault, sent only over mutual TLS and deleted when the device is revoked or decommissioned.
- R-038: GRUB cannot report which entry booted: `novad` checks that the one-shot was consumed and compares the kernel in `/proc/cmdline` with the entry's `linux` line, so entries that boot the same kernel with other arguments cannot be told apart, and a trial it cannot verify still reports `ok` with `verified: false`. Mitigation: the Hub makes an unverified trial the default only with `confirmUnverified: true`, and the card says the device could not verify it; commit is refused unless grub.cfg boots `saved_entry`; a trial is a one-shot, so the next power cycle returns to the default.
- R-039: Out-of-band management was tested only against a fake Redfish BMC (`node:https` on loopback, reached in J9.5 through a connection redirect because the Hub refuses loopback BMC addresses) and a fake `ipmitool`; no real BMC's certificate, reset types, BIOS attribute names (Dell and HPE mapped) or IPMI boot override (many BMCs drop it after about 60 s without a restart) was tried. Mitigation: off by default, turned on only with consent; owner-only; credentials only after the owner confirms the pinned certificate; every change on a Hub-only card bound to the BMC's address and pin; a reset type the BMC does not list is refused, never substituted; the device lab (T-M9-05).
- R-040: The local browser fallback never ran with all its real parts: `novad`'s browser tests use a fake Chromium speaking the DevTools pipe, and the Hub drove a real Chromium only behind a fake `novad` in the Playwright container, so a real Chromium started by `novad` as `nova-browser1` or `nova-browser2` was never run, on a desktop with a display or elsewhere. The egress filter is an HTTP proxy: Chromium's WebRTC traffic policy and LAN discovery were not checked against a real browser, so a page might reach the device's network outside the filter; a visible browser run as a dedicated user probably cannot open the desktop user's display; without unprivileged user namespaces Chromium's sandbox does not start. Mitigation: each site needs the user's consent when the offer comes; the session covers one site and its subdomains and ends when the agent leaves it; a clean profile deleted on close, downloads off; a dedicated unprivileged user; `browser.localFallback` can be turned off; the device lab (T-M9-05).
- R-041: The extension bridge trusts the extension id the owner configures: the extension is not pinned with a manifest `key`, so `bridge.extensionId` is set by hand from the unpacked or store id (an unpacked extension's id changes when its folder moves, which breaks the bridge), and the host manifest lets exactly that id reach `novad`; a wrong id would let the extension that has it act as the bridge (report tabs, receive the agent's input). Mitigation: the host is registered only by `novad bridge enable` run by the user, into browser folders that already exist; host grants need the owner's confirmation, "all sites" its own acknowledgement and `browser.extensionBridgeAllSites`, and none covers the Hub's own hosts; each tab needs the user's consent; every action goes through `browser.act` with the site's level and the classifier; the id pinned with a manifest key at packaging (T-M10).
- R-042: The Hub's management client and `novad`'s mutual-TLS server were never run against each other: `novad`'s server is tested with rustls clients (`mgmt_tls.rs`), the Hub's client against the core fake device (`apps/hub/test/devices-m75.test.ts`), J9.5 runs in the default trust mode (plain HTTP), and the one test of the real `novad` with a certificate (`apps/hub/test/m7-novad-tls.test.ts`) checks only its calls to the Hub. The Ed25519 certificates over TLS 1.3, the legacy (clientAuth-only) certificate path and the renewal swap are therefore unverified between Node's TLS and rustls. A mismatch fails closed (`device_tls_failed`, never plain HTTP), which would leave a device with a certificate unmanageable. Mitigation: both sides follow one written contract (`contracts/hub-api.md` §3, ADR-096 D1) and fail closed; a Hub test against the real binary in the local CA mode (T-M9-05, or sooner).
- R-043: PXE boot tokens travel in clear: iPXE fetches `/boot/ipxe/:token` and the images over plain HTTP (iPXE over HTTPS needs the Hub CA built into iPXE), so anyone who can watch the LAN can take a device's token and download its boot images until it is rotated, and a LAN client can tell PXE is on from 429 versus 404. Mitigation: `devices.pxe.enabled` is off by default; one token per device (256 bits, hashed, shown once, rotatable and revocable); only regular files directly in `<dataDir>/boot-images/`; 30 menus and 120 images a minute per address; every fetch audited; the token masked in the request log and by the redactor; the docs say images must hold no secrets.
- R-044: Extension handlers run in QuickJS in a worker thread inside the Hub's process: an engine bug or a worker escape would give an extension the Hub's authority. The boundary was probed by the supply-chain review (the bridge, the CPU and memory limits, declared permissions), not fuzzed. Mitigation: no ambient authority (every call is a message through the policy engine), declared permissions only, CPU and memory budgets, files checked against the signed digest before start, signatures with trusted publishers, unverified installs only with an explicit sideload (managed policy can forbid them or turn the SDK off); fuzzing the bridge in M9 (T-M9-02).
- R-045: The marketplace's remote and Git catalogs, the signed remote managed policy, OTLP collectors, crash-report endpoints, OAuth providers for email and WebDAV hosting targets were exercised only against local fakes. Mitigation: each follows its specification and fails closed (signatures with pinned keys, commit pins, https, bounded readers, no redirects for WebDAV); opt-in live smoke tests before M10 (as R-010, R-033).
- R-046: Managed policy file checks (owner root or Administrators, not writable by others) ran only on Linux; macOS ownership and Windows ACLs are untested, and registry or configuration-profile sources are not read. Mitigation: a file whose checks cannot be made is ignored and reported, never partly applied; unreadable policy fails closed; the per-OS checks and sources with packaging (T-M10).
- R-047: App tokens (`nva_`) are bearer tokens with no sender binding: a leaked access token works from anywhere for up to an hour, and a refresh token until it is used or revoked. Mitigation: scopes reach only the app routes they name and never owner administration; refresh tokens rotate (reuse revokes the chain); every app's calls are audited; revoking an app or turning apps off ends its tokens at once; managed policy can turn app authorization off.
- R-048: The Arabic translation is machine-drafted and partial (about 10 % of messages), and right-to-left layout was verified only in Chromium for Arabic and the ar-XB pseudo-locale. Mitigation: English fallback for every missing message; pseudo-locale tests on every area; the picker says "partly translated"; reviewed translations before a locale is called supported (T-M10).

## Deferrals

| Requirement | Reason | Follow-up task |
| --- | --- | --- |
| FR-130 | Hub failover is post-v1 (ADR-035) | — |
| FR-040 (non-text sources) | Text types only; PDF and office documents need extraction (M4 previews PDFs in the file viewer but indexes neither) | T-M9 (document extraction) |
| FR-126 (VRAM, quiet hours, `/node/v1/services/*`) | Closed in M7.5: VRAM from `nvidia-smi` or `rocm-smi` in the signed document and every heartbeat, the owner's node policy (quiet hours, routing eligibility) in the heartbeat answer, `/node/v1/services` for `jobs` and the model server (`services/compute/test/m75.test.ts`, `apps/hub/test/devices-m75.test.ts`); compute node certificates are not renewed (M7.5 known gaps) | done (T-M75-10) |
| docs/07 §9 concurrency limits | Global and per-provider semaphores are not enforced yet | T-M9 performance tasks |
| FR-149 (database and backups at rest, sealed mode) | No encrypting SQLite layer; backups and sealed mode not yet | T-M9 hardening tasks |
| FR-042 (`deviceId` server field; `oauth`/`auth` in the shared server schema) | Closed in M7: device-hosted servers through the device bridge, never spawned on the Hub; `auth` from the vault (`apps/hub/test/mcp-m7.test.ts`) | done (T-M7-14) |
| FR-185 (imported user instructions) | Import writes `<dataDir>/instructions.md`; the chat reads it with instruction-file discovery | T-M5 (FR-185) |
| FR-011 (apply a custom palette) | Closed in M8: `appearance.customTheme` applies a saved theme token for token (`apps/web/test/custom-theme.test.tsx`) | done (T-M8-08) |
| FR-113 (public profile card, OIDC sign-in) | Closed in M7: OIDC sign-in, link and join; the card needs `team.publicProfiles` and the person's opt-in (`apps/hub/test/team-oidc.test.ts`, `apps/hub/test/team.test.ts`) | done (T-M7-07) |
| FR-115 (entitlements and limits), docs/14 §6 (spend caps, clear usage) | Closed in M8: provider limits and entitlements, spend caps with a hard stop, clear usage (`packages/core/test/datactl-service.test.ts`, `apps/web/test/spend-caps.test.tsx`) | done (T-M8-04) |
| FR-044 (a `nova` command on the PATH) | Resources, prompts and the stdio launcher shipped in M7 (`apps/hub/test/mcp-server-m7.test.ts`, `packages/mcp/test/stdio-launcher.test.ts`); since M8 `packages/cli` provides the `nova` command (`nova mcp stdio` among its subcommands); putting it on the PATH comes with packaging | T-M10 packaging |
| FR-199 (bundle servers in the sandbox) | Bundle servers run like other MCP stdio servers (R-012); confirmed permissions are recorded | T-M9 (MCP stdio servers in the sandbox and egress proxy) |
| FR-216 (dictation), FR-031 (realtime voice) | Need a local speech engine or a realtime audio provider; Nova ships neither (assessment in ADR-092) | T-M9 or a voice milestone |
| FR-030 (image generation visible) | Closed in M7: `OpenAICompatibleProvider.generateImage`; `image.generate` and the composer's button appear when an image model is configured (`packages/core/test/images-openai.test.ts`) | done (T-M7-14) |
| FR-055 (webhook signing-secret reveal) | Closed in M7: `POST /api/v1/schedules/:id/webhook-secret` rotates it and shows it once (`no-store`) (`apps/hub/test/channels-m7.test.ts`) | done (T-M7-14) |
| FR-188 (`ask_user` answer authority) | Closed in M7: a signed-in user's answer gives the rest of the turn their authority and reaches the model as their words (`packages/core/test/loop-m7-answer.test.ts`) | done (T-M7-14) |
| FR-053 (sub-agent tool allow-list) | Closed in M7: enforced at the gate, plus `run.complete`, `tool.search`, `context.remaining` and `context.fresh` (`packages/core/test/gate-m7-limits.test.ts`) | done (T-M7-14) |
| FR-218 (voice-call channel) | Needs the voice pipeline (streaming speech both ways); Nova ships none (FR-031, FR-216) | T-M9-07 |
| FR-128 (local agents and tools on a device while the Hub is away) | M7 built a local model answering a waiting chat message in the desktop app (ADR-095) | T-M9 |
| FR-074 (tree-sitter index; renames in diffs) | Pattern-based symbol index; renames show as delete + add | T-M9 |
| FR-198 (allowed domains in the App frame header; Apps in the composer's + menu; `UiEntryPointView.domains`) | Closed in M8 (`apps/web/test/extensions-shell.test.tsx`, `apps/hub/test/sdk.test.ts`) | done (T-M8-01) |
| FR-200 (hooks from other plugin layouts) | Closed in M8: converted on import and installed untrusted | done (T-M8-01) |
| FR-146 (firmware updates through `fwupd`; BIOS settings on Windows and macOS) | Updates are listed read-only; BIOS tools off Linux are vendor tools for Windows, so other systems answer `os_not_supported` (ADR-096 D10) | — |
| FR-147 (Intel AMT; console access; BIOS settings over IPMI) | WS-Man is out of scope; Redfish and IPMI power, sensors and the boot override ship, BIOS settings only over Redfish (ADR-096 D10) | — |
| FR-143 (kernel arguments in boot profiles; DHCP and TFTP) | A profile names an entry only (`kernel_args_not_supported`); the owner points their own DHCP server at the Hub's iPXE route (ADR-096 D10) | — |
| FR-093, FR-207 (computer use on a real desktop through `novad`) | The `novad` `screen` module moved from M7.5 to M9, to be built with N1's capture work (ADR-096) | T-M9-08 |
| FR-016 (text the Hub writes) | The web app, packages/ui and the desktop app are localized; error messages, statuses and details the Hub or a device writes stay English (M8 known gaps) | T-M9 (localization polish) |
| FR-016 (translations) | Arabic is partial and machine-drafted; no other locale ships | T-M10 (reviewed translations) |
| FR-106 (machine policy registry, device-management profiles) | M8 reads the OS-protected file and a signed remote policy (ADR-097 D4); Windows registry policy and macOS configuration profiles are not read | T-M10 (per-OS packaging) |

## Known gaps (code vs spec, M5)

Found by the M5 docs review; each has a follow-up. Fixed during integration: tool listings per
thread (`ask_user` only in Work/Code, `schedule.report` only in the fired run's thread), the
tool's name (`ask_user`, as the contract), autonomous runs refused without a reviewer model,
cross-account event replay, run ids on typed run turns, request audit and restart expiry,
reviewer audit kind, review errors, the commit hook note, `nova://code/<id>`, the per-project
`code.permissionMode`, the Bypass availability rule, and a queue-order race between a user's
queued message and a runtime start.

| Gap | Follow-up |
| --- | --- |
| Auto-review input lacks resource, taint, provenance and rules (docs/12 §6.1); a breaker trip shows Blocked, not Needs input | T-M6 review hardening |
| Instruction files have no project trust check ("untrusted projects are skipped"); user-added folders count as trusted (ADR-092) | T-M6 project trust |
| A session whose Auto/Bypass condition lapsed shows its stored mode while it runs as Manual | T-M6 code UI |
| Code sessions carry no run budgets (docs/09 §2) | T-M6 |
| Runs: goal continuations ignore quiet hours; the step limit does not set a goal `budget_limited`; persistent model errors fail instead of pausing; usage-limit retries use a fixed 15 min; a child's approval is not mirrored in the parent thread; `task.spawn` takes no budget cap; children's active time adds to the parent's time meter (parallel children use it up faster); researchers get the read-only profile only with an all-read-only tool list | T-M6 runtime hardening |
| Schedule API body differs from `contracts/schemas/schedule.json` (`target`, `origin`, `wakeReason` arrive with agents; extra M5 fields) | T-M6 agents |
| Requests: `request.created` reaches every stream (not only clients that declared the kind); resolution shape, `targetDeviceId: null`, id prefix and the full hello (protocol version, limits, `suppressEvents`) differ from contracts/hub-api.md §5 | T-M6 clients |
| Images cannot be edited (FR-030; generation is visible since M7; `git.branch` and `git.commit` arrived in M6) | T-M9 |

## Known gaps (code vs spec, M6)

Found by the M6 docs review, the web agents and the journeys; fixed during integration: protected
paths in sandboxes (writable `.git` let a command reach the Hub's own Git), hand-written crypto in
`novad`, agent rules reaching the managed layer, unsealed browser screenshots and cookies, the
agent browser losing its proxy credentials, a shared-channel reply counted as already public, the
data-directory deny blocking agents' own computer folders, Bypass offered for remote sessions, a
Git host token sent to `http://` remotes, `code.autoVerify` settable by a project, the egress
deny list ignored by the gate and the browser ignoring the egress mode, notification copies to
shared channels, an unsigned webhook event id, and container environments outside the proxy.

| Gap | Follow-up |
| --- | --- |
| `novad` modules: `screen` (computer use on a real desktop) and `capture` are placeholders; the `screen` module moved from M7.5 to M9, to be built with N1's capture work (ADR-096); the `browser` module, uninstall and decommission shipped in M7.5 (T-M75-07, T-M75-09) and the `compute` module is dropped (`services/compute` is the compute node); modules run as `novad`'s user (a root `novad` runs Chromium as dedicated users); no macOS or Windows sandbox | T-M9-08 (screen), N1 (capture, T-N1-09), T-M9 (module sandboxes) |
| Local browser fallback (FR-209): the consent flow refuses until a device offers a browser module; the extension bridge (FR-096) | Closed in M7.5 (T-M75-07, T-M75-08; `packages/core/test/browser-fallback-device.test.ts`, `browser-bridge.test.ts`); open items are in the M7.5 known gaps |
| WSL environments answer `not_windows` everywhere (`novad` has no WSL operations); SSH environments and remote capture, review and commits shipped in M7 | T-M10 (with `novad` on Windows) |
| Code: handoff, three-way merge, best-of-N, cloud environments; delegating from an agent to a Code session | Closed in M7 (T-M7-01, T-M7-09, T-M7-10; `apps/hub/test/code-m7.test.ts`) |
| Browser: console and network capture, hover, element screenshots, restart after a crash, per-scope site levels; `GET /browser/actions` lists oldest first | Closed in M7 (T-M7-12; `packages/core/test/browser-scope.test.ts`, `browser-crash.test.ts`) |
| Channels: email adapter, Telegram adapter, Slack interactive buttons; refresh route for MCP subscriptions; a test-notification route; a channel message log route | Closed in M7 (T-M7-06; `apps/hub/test/channels-m7.test.ts`) |
| Egress: SOCKS5; the browser ignores scope policies; `web.fetch` and MCP stdio servers bypass the proxy (R-012); compressed bodies are not scanned for credentials | T-M9 hardening |
| Agents: goal retry after a usage limit; `thread.status.changed` for agents; plugins per agent | Closed in M7 (T-M7-14; `packages/core/test/agents-m7.test.ts`) |
| Screen: the real desktop through `novad` (the `screen` module, moved from M7.5 to M9 with N1's capture work, ADR-096); purchase classification of screen actions; browser takeover input not in `screen_action` | T-M9-08 (screen module), T-M9 |
| Spaces and sites: reorder and delete pages in the UI; change a site's source in the UI; remote hosting targets | Closed in M8 (T-M8-09; `packages/core/test/sites-hosting.test.ts`, `apps/web/test/spaces-m8.test.tsx`): WebDAV is the one remote kind |
| Devices UI: no routes for managed services, available updates, owner overrides (the QR code shipped in M6.5) | Closed in M7.5 (T-M75-10; `apps/hub/test/devices-m75.test.ts`, `apps/web/test/devices-m75-ops.test.tsx`): available updates are information only |
| A device-file commit's approval card shows the staged id, not the diff (the diff is on the device page) | Closed in M7 (T-M7-14; `packages/core/test/approval-detail.test.ts`) |

## Known gaps (code vs spec, M6.5)

Found by the security reviews and J8.5; fixed during the milestone: a man in the middle could
brute-force the 6-digit confirmation (now commit-then-reveal, Hub-signed); a missing vault key
silently created a new Hub identity and CA; devices could claim roles the owner did not approve;
anyone could burn every open pairing; a failed Headscale policy read became allow-all; one-word
machine names widened the CA's name constraints; failed undos and hung commands in network setup;
loopback trusted by the lock-out guard; the probe dropped the system roots and trusted a Hub that
sent no fingerprint; wake rate limits and broadcast addresses; the Relay trusting client ids it
assigns, the tunnel path allowlist bypassed with encoded dot segments, unbounded Relay queues,
spoofable forwarded addresses, and the stream floor saved after delivery; the phone join page
blaming the Hub on plain HTTP, settings not following the Relay switch, the Relay advertised only
at the next check, a turned-off transport logged as a failure, and `novad install` giving up after
two minutes.

| Gap | Follow-up |
| --- | --- |
| No native app registers with the Relay for push (the APNs and FCM senders are in the Relay, and the web pairs and works through it, since M7); the channel relay answers 501 (`channel_relay_not_built`) | T-M10 |
| Two tabs on one paired record get Hub replies only on the newest connection (the registration token and push token checks shipped in M7) | T-M9 |
| Only the `offline-replica` and `local-runtime` scopes are enforced; the others are recorded and shown, and a browser's or app's device session is an owner session scopes do not narrow (R-026); `deviceId`, `scopes` and mutual TLS shipped in M7 | T-M9 |
| Identity and CA rotation, `ca.mobileconfig`; compute node certificate renewal (`novad` devices renew through the heartbeat since M7.5); mDNS name-conflict probing; IPv6 Wake-on-LAN from the Hub | T-M9 |
| `novad` on Windows (key generation reads `/dev/urandom`) and macOS services are untested; no elevation for network setup commands | T-M10 packaging |
| Diagnostics problems are free text; the diagnostics `mesh`, `relay` and `deviceTls` fields are untyped | T-M9 (T-M9-04) |

## Known gaps (code vs spec, M7)

Found by the security reviews (identity, execution, transports, browser, desktop: 46 findings, one
critical) and the docs pass; fixed during the milestone: members' tool calls with no thread ran in
the Hub's own folders (critical), and a removed member's schedules, channels, triggers and sockets
kept running there; members could make the Hub call its loopback and LAN and widen its egress allow
list; an OIDC callback bound to no browser; one person's messages steering another's tools in a
shared thread, and team tasks sharing one thread; the idempotency store replaying tokens; cloud
commands outside the egress policy; external agents reading any vault secret, running unsandboxed
in SSH, WSL and device sessions, reaching hosts they did not declare and outliving their flag; a
runner-chosen folder becoming a Hub write root, credentials in repository URLs, `/nova` writable by
commands, no process or memory limits per sandbox and a bypassable disk cap; a handoff into a folder
no check approved, delegated sessions losing the agent's rules and budgets, and SSH hosts read as
options; a page freezing the Hub through quadratic redaction, tokens in network capture and scoped
site levels bypassing hooks; excluded apps never matched off Linux and the shell bridge trusting a
frame's URL; root in `novad` changing modes and owners through links in a user's folder, forged
email sender authentication, Web Push after device revocation and the device certificate offered
to unverified servers; cloud environments reported as isolated and handoff refusals never produced.
J9 found seven more: a page the Hub serves could not reach the Relay (the CSP allowed only the Hub,
whatever scheme the Relay URL used, and the Relay answered no CORS preflight); a Hub without a
sandbox of its own refused commands of cloud sessions, which run on the runner, and `test.run`
looked for the test command on the Hub's disk; the chat list did not show chats made on another
device until a reload; a chat open while offline kept its sent messages "Queued" after
reconnecting; the runner ran the setup script outside the repository; and the composer silently
dropped a message sent before the model list loaded (J3 and J4 under load). Closing the ledger
found one more, also fixed: the file tools of SSH, WSL and device Code sessions acted on the Hub's
own disk at the remote folder's path (R-035).

| Gap | Follow-up |
| --- | --- |
| Sync: only the web app keeps a replica; `sync.status.changed` is not emitted; sync audit entries use kind `device`; offline, a chat shows the path back from its newest message | T-M9 (event, audit kind), T-M10 (native clients) |
| Cloud runner: runner network does not pass the Hub's egress proxy (off unless the owner allows it, R-030); snapshots are not encrypted by Nova; agent computers stay on the mock runner; in a container, CPU is what the container reports | T-M9 |
| Code: a cloud thread's tool scope names `/workspace/<folder>` as a Hub path, so mentions and instruction files could read a `/workspace` folder on the Hub machine (its `fs.*` stay denied); remote file operations run one helper process each; delegating to an external agent in an SSH, WSL or device session fails with "the Code session has no folder" (closed, but unclear); no test against a real sshd (`ControlMaster` reuse untested); symbols, refs, dev servers and worktrees work only on the Hub's own files | T-M9 |
| Chat handoff: recorded and announced, but turns still run on the Hub; no UI moves a chat to another device | T-M9 |
| Channels: Telegram files are not read or sent; email OAuth (XOAUTH2) is not built; no native app registers with the Relay; the channel relay (`/v1/relay/messages`, `/outbox`) is not built; the voice-call channel (FR-218) is not built | Telegram files and email OAuth closed in M8 (T-M8-08); T-M10 (native apps, channel relay), T-M9-07 (voice) |
| Web over the Relay: attachments, raw files, avatars and the terminal socket do not go through the tunnel; a paired browser's device token is usable by page script (R-031); with a Relay older than the `decided` notice the page cannot tell denied from expired | T-M9 |
| Team: a removed member's data is kept; members configure their own providers; skills of plugins not connected to an agent still show in its catalog; a removed member's channel pollers keep polling (their turns are refused) until a restart; Tools & MCP, Notifications and Channels have no member mode in the web UI; the ordinary chat view does not show who wrote each message of a shared chat | Closed in M8 (T-M8-08) except members configuring their own providers (T-M9) |
| Flagged: no `script` origin in `tool_call`; device MCP servers expose tools only; ACP terminal environment variables are ignored | Closed in M8 (T-M8-08; `apps/hub/test/flagged-m8.test.ts`, `packages/core/test/acp-env.test.ts`) |
| Desktop shell: window text on macOS and Windows and screenshot redaction are not built; app identity off Linux is tested only against recorded command output (R-029); on Wayland the screenshot may be missing; the journey runs only on Linux; Electron fuses; voice in quick chat | T-M10 (macOS, Windows, fuses), T-M9 (redaction), T-M9-07 (voice) |
| Device TLS: the management channel is mutual TLS for a device that holds a certificate, with renewal through the heartbeat, since M7.5 (T-M75-06); a device without one (the default `none` trust mode) stays on bearer tokens over plain HTTP (R-022); compute node certificates are not renewed; Windows has no per-user named pipe (the shell reports `no_access`); a non-root `novad` makes a socket only for itself; the per-user sockets are tested only with the build user's own ids (R-034); the `local.*` methods of `contracts/hub-api.md` §4 are not built | T-M9 (compute node renewal, cross-user runs), T-M10 (Windows) |
| Browser: opaque tokens in URL paths are not masked; the restart limit resets with a new session; hover exists only as an agent tool (the computers-area controller has none) | T-M9 |
| Review hardening notes left open: an OIDC identity linked from a device session survives revoking that device; the desktop shell accepts a listed leaf until it expires after the Hub stops listing it | T-M9 |

## Known gaps (code vs spec, M7.5)

Found by the security reviews (privileged device actions; the browser fallback and bridge;
out-of-band and PXE: 19 findings, one medium-high and seven medium, none critical or high) and the
docs pass; fixed during the milestone: a firmware watchdog revert that failed (a BIOS with an admin
password) recorded as a success, after which the rollback was refused, and a restore failing midway
undone back to the new values; the BIOS admin password sent over plain HTTP; GRUB unable to write
`grubenv` under the service unit, and GRUB confirming trials it could not verify; a rollback that
weakens security that could never run; the boot watchdog restarting a healthy machine; the file and
exec modules reaching BIOS settings and EFI variables without a Hub-signed authorization, an
unreadable replay store failing open, watchdog markers written after the change, the BIOS password
left in the vault after revocation and decommission leaving its unit file; the bridge checking the
owner's host grant against the tab's old host, an agent able to paste the user's clipboard with
Ctrl+V, another OS user's browser taking over an agent's session, a cookie blocklist that string
concatenation got around, and Chromium run as the shared `nobody` account; allowed-site entries
that made every clean-profile launch fail, a fallback that followed links to other sites, device
sessions never cleaned up, downloads landing on the device's disk and full URLs in history results;
PXE boot tokens in the Hub's log; the firmware and boot switches turned on through the plain
settings route without consent; out-of-band approvals not bound to the BMC they named, run without
checking who answered, credentials sent before the owner confirmed the BMC's certificate, and BMC
addresses that could be loopback or the Hub's own. Found while building: since M6, a module, Code
process or service started by a management request died when the request's thread ended (Linux's
parent-death signal) and counted as a crash (`spawn_kept`); Chromium's DevTools port on loopback had
no authentication of its own (now a pipe). J9.5 found two more, also fixed: the Hub refused the boot
status of `novad`'s fake bootloader (`bootloader: "fake"`), and the firmware and boot switches
reached a device only with its next heartbeat (now pushed at once and synced before every
privileged send, without spending the approval); the firmware watchdog's length could not be set
(now `devices.firmware.watchdogSeconds`); the audit page showed no before/after values; and the
notices described a revert without a restart as a machine that did not come back.
Fixed while closing, from the docs pass: the Hub's support matrix drifting from `novad`'s (both are
now checked against one fixture), the Hub's own hosts missing the host of `channels.publicUrl`, the
redactor missing the `nvbr_` bridge token, `novad install` printing the plain-HTTP endpoint after
registering an https one, and decommissions never marked `cancelled`.

| Gap | Follow-up |
| --- | --- |
| Hardware: nothing ran against a real BIOS, bootloader or BMC: vendor attribute names are checked against mock sysfs trees, the BMCs are a fake Redfish server and a fake `ipmitool`, and `novad`'s browser tests use a fake Chromium (the Hub side ran a real Chromium behind a fake `novad`) (R-036, R-039, R-040) | T-M9-05 (device lab) |
| Management channel: the Hub's client and `novad`'s mutual-TLS server were never run against each other, nor the legacy-certificate path (each side is tested against its own stand-in, and J9.5 runs in the default trust mode, plain HTTP; R-042); a device without a certificate stays on plain HTTP (R-022); only `novad` devices renew their certificates (compute nodes do not) | T-M9 (a real-binary test, compute node renewal) |
| Firmware: the watchdog cannot restore a BIOS with an admin password, so the Hub refuses a guarded restart there (R-037); on a device without a certificate the BIOS password is never sent, so such a BIOS cannot be changed until the device uses the Hub local CA; no firmware updates (`fwupd` is listed read-only) | T-M9-05; `fwupd` updates not planned (ADR-096 D10) |
| Boot: GRUB trials are verified only by the kernel path, and `grub-set-default` needs `GRUB_DEFAULT=saved` (R-038); the Hub cannot revert a machine that never comes up (the one-shot does that at the next power cycle; with a linked BMC the alert offers a power cycle); many BMCs drop an IPMI boot override after about 60 s without a restart; kernel arguments in profiles are refused | T-M9-05; kernel arguments not planned (ADR-096 D10) |
| PXE: tokens travel in clear over plain-HTTP iPXE, so boot images must hold no secrets (R-043); iPXE over HTTPS needs the Hub CA built into iPXE; a LAN client can tell PXE is on from 429 versus 404; Nova runs no DHCP or TFTP | T-M9 (iPXE over HTTPS, the same answer either way); DHCP and TFTP not planned |
| Browser on a device: sessions an earlier Hub connection opened inside Chromium stay attached after a reconnect (the pipe outlives the WebSocket); a visible (non-headless) browser run as a dedicated user probably cannot use the desktop user's display; without unprivileged user namespaces Chromium's sandbox does not start (`browser_start_failed`); WebRTC traffic policy and LAN discovery were not checked against a real Chromium (R-040); on macOS the owner creates the browser users | T-M9-05, T-M10 (macOS) |
| Fallback: nothing asks for it on purpose (`BrowserService.localFallback` has no caller, so the `requested` cause never occurs, and no UI offers "continue on my computer"); it is offered only after a block; consents are per agent (the thread scope exists only in the table) | T-M9 |
| Bridge: no Windows bridge (no named pipe, no registry manifest); the extension id is not pinned with a manifest `key`, so `bridge.extensionId` is set by hand from the unpacked or store id (R-041); connection state and tab consents do not survive a Hub restart | T-M10 (Windows, the pinned id with packaging), T-M9 (kept state) |
| Not built (ADR-096 D10): `fwupd` updates, BIOS settings on Windows and macOS, Intel AMT, out-of-band console and BIOS settings over IPMI, DHCP and TFTP, kernel arguments, the `novad` `screen` and `capture` modules (the `compute` module is dropped) | T-M9-08 (screen), N1 (capture, T-N1-09); the rest not planned |

## Known gaps (code vs spec, M8)

Found by the security reviews (access and app authorization: one medium; data controls and managed
policy: 13, eight medium; the extension supply chain: nine, one high and one medium-high; none
critical) and fixed during the milestone: a member able to take an owner-approved app code through
the Hub's own loopback callback, and message content reaching OTLP; a crafted unsealed archive
making the Hub send its own keys to an outside server, imported rows deleting folders outside the
data folder, cookie jars in unsealed exports, delete-all and export missing data folders, image
generation outside spend caps and managed provider rules, and managed rules (folders, unverified
installs, user-added MCP servers, denied extensions, egress on every network path, local sessions)
that the user they constrain could get around; zip size caps bypassed by stored entries and shared
payloads (before any signature check), update diffs that missed MCP server commands and default
approvals, another publisher taking over an installed extension and its secrets, unbounded
`nova.net.fetch` buffering, files dropped from a signed bundle through newlines in paths, hook
trust that ignored helper files, a pinned catalog downgraded by deleting its signature, and a "/"
filesystem scope accepted at install. The docs pass found and the closing fixed: the removed
member's export never wired, `nova init` leaving the template id behind, the plugins install path
skipping the publisher check, extension hooks still applying with the SDK off, three settings with
no managed rule, and a zip check missing from the import scanner. J10 found and fixed: a blocked
extension announced as a plugin with a link to the wrong page, a sealed export refused because the
page did not send the Hub's name, the policy's egress allow list intersected with the owner's empty
list (now a ceiling), lock notes without their source or link, delete-all landing on onboarding, the
Network page not showing the hosts in force, a policy-stopped extension without its reason, a
command's result not shown, and a catalog-verified item named only by a key fingerprint. The
localization pass found and fixed: a literal `}}` serialized with a stray apostrophe, and plural and
select placeholders inside rich messages always taking `other`.

| Gap | Follow-up |
| --- | --- |
| Text the Hub or a device writes stays English: error `message`s where the client has no words for the code, validation issues, statuses and details (provider tests, diagnostics, policy previews, MCP and channel `lastError`s, device certificate problems and plan steps, network problem lines and setup steps, Relay and push errors, cloud runner and browser details, work and agent activity, notification titles and bodies, marketplace permission lines and catalog data, extension errors and manifest text, chart and diagram labels); ADR-097's limitations list it per area | T-M9 (localization polish) |
| Translations: Arabic is partial (about 10 % of 12,900 messages: the shell, setup, palette, chat, settings navigation and Appearance, marketplace, extensions and packages/ui) and machine-drafted; no other locale; English fallback strings in a partial locale carry no `lang="en"` (WCAG 3.1.2); MCP apps are told `navigator.language`, not Nova's locale; the desktop app reads catalogs from the web source tree (packaging must copy them) | T-M10 (reviewed translations, packaging), T-M9 (`lang` on fallbacks) |
| Accessibility: reflow at 320 px is verified for chat and every Settings section, not for Work, Code, Devices, Network and the Marketplace (axe ran there at 390 px); approving a device means typing a 6-digit code from the other device (WCAG 3.3.8; a compare-and-confirm alternative needs a security decision); screen-reader smoke tests are on the release checklist, not automated | T-M9 (reflow sweep, the pairing decision), T-M10 (screen readers) |
| Extensions: the QuickJS boundary is not fuzzed (R-044); no paid or hosted-store extensions (ADR-097 D8); the extension bridge for MCP apps answers JSON-RPC errors in English | T-M9-02 (fuzzing); N3 (catalog hosting) |
| Managed policy: only the OS-protected file and a signed remote policy are read (no Windows registry policy or macOS configuration profile); the file checks ran only on Linux (R-046) | T-M10 |
| Data controls: an account-scoped archive (a removed member's export) is kept, not imported; import needs an empty Hub; spend caps stop on an estimate (a reservation per call from the provider's recent average), so concurrent calls can overshoot by at most one call each; crash reports cover uncaught errors in the Hub process, not native crashes | T-M9 |
| Third-party apps: tokens are bearer tokens without sender binding (R-047); OTLP is HTTP/JSON only (no protobuf or gRPC) | T-M9 (sender-constrained tokens), — |
| Spaces and sites: WebDAV is the only remote hosting kind; a zip publish cannot be undone; deleted pages are kept until their space is deleted | T-M9 |
| Team: members do not configure their own providers (they use the owner's) | T-M9 |
| Live services: remote catalogs, the signed remote policy, OTLP collectors, crash endpoints, email OAuth providers and WebDAV servers ran only against local fakes (R-045) | T-M10 (live smoke tests) |

## Milestone summaries

- **M0** (10bbcf4): monorepo, Hub service skeleton with token-guarded listeners, web shell, storage
  with migrations and backups, policy engine skeleton, contracts harness, `novad` skeleton, CI.
- **M1** (ba340d5): chat MVP: onboarding, streaming with stop, attachments, search, settings,
  themes and keyboard map; J1 green with axe checks and a cold start under 3 s.
- **M2** (01c0e89): Anthropic, OpenRouter and llama.cpp adapters behind one conformance suite;
  one router for every turn with presets (Faster / Balanced / Smarter), fallback and retries
  before output, a circuit breaker and `routing.allowCloud`; compute nodes (`@nova/compute`) that
  enroll with a one-use token and signed capability documents; steer and queue follow-ups,
  message versions, branches with a tree and compare view, side chats, temporary chats with
  TTL purge; projects with instructions and indexed sources cited in replies; reviewable memory
  extracted from chats and kept out of temporary chats; ranked search and find in chat; deep
  links. Evidence: about 950 unit and integration tests across 13 packages, J1 and J2 green three times in parallel.
  Risks added: R-009..R-011. Next: M3 (tools, MCP, policy and approvals).
- **M3** (aef94eb): the policy engine (built-in safety, confirmation tiers, intent provenance,
  permission profiles and protected paths, command prefix rules with examples, per-tool and
  per-server defaults) and approvals with every decision, grants and previews; the tool runtime
  and agent loop (file, exec in a container sandbox or failing closed, web search and fetch,
  artifacts, deferred tools with `tool.search`, mentions) with results returned as untrusted
  data; an MCP client on the official SDK with health, restart backoff and logs; a hash-chained
  audit log, notifications with a bell and OS notifications, a log viewer and diagnostics;
  keychain secret backends, sealed blobs, optional TLS and a secret scanner in CI; memory
  consolidation with summaries, topics and aging, and past-chat reference. Found and fixed in
  integration: a new chat's first approval card never appeared (the stream connected after the
  request), and "Always allow" on a command preselected the whole tool. Evidence: about 1,600
  unit and integration tests across 14 packages; J1, J2 and J3 green three times in parallel.
  Risks added: R-012..R-014. Next: M4 (plugins, skills, workspaces and profile).
- **M4** (2c0fbf8 and the M4 docs commit): plugins from local, URL and Git catalogs with skills,
  commands, roles, hooks and MCP servers, every install an explicit sideload with env values in
  the vault; skills by slash command and auto-selection; lifecycle hooks trusted by content hash,
  sandboxed and fail-closed; plugin permissions in the gate (an undeclared host denies, disables
  the plugin and notifies; the plugin's defaults rank below the user's); MCP Apps in sandboxed
  iframes with a bridge and declared-domain CSP, inline, full screen and picture in picture;
  Nova's own MCP server with hashed per-client tokens; MCP bundles; OAuth PKCE for remote
  servers; panes, a terminal through the sandbox, a file editor, project folders and the Library;
  profile, avatars, usage insights, active provider accounts; import from other assistants with
  secret references. Found and fixed in integration: a plugin manifest's literal secrets reached
  the database; plugin installs skipped the sideload check; hook continuation turns emitted an
  actor the event store rejects (the test sink now validates envelopes); a plugin's server could
  be edited or deleted around the plugin; four error statuses differed from the contract (a test
  now compares them); switching Inspector tabs stopped an open app (state-preserving move, clean
  restart elsewhere); an app's own tool calls showed as the model's. Evidence: 2,217 unit and
  integration tests across 14 packages; smoke and J1-J4 green three times in a row. Risks added:
  R-015. Next: M5 (agent runtime: Work and Code).
- **M5** (013ed1b and the M5 fix, e2e and docs commits): one runtime for every mode (ADR-076):
  Work runs, Code sessions, schedules and goals start and shape turns of the chat loop through
  TurnStarter and TurnExtension. Runs plan (three autonomy levels), act with approvals, pause on
  budgets, the backstop, approval timeouts and errors, verify declared outputs, resume after a
  restart, hold goals with the runtime-enforced blocked rule, spawn depth-1 sub-agents, start
  from a chat and run deep research. Schedules evaluate cron, RRULE, intervals and one-shots in
  their time zone across DST, catch up once, never double fire and count a job done only on a
  delivery receipt. Code sessions capture every change through a shadow Git repository outside the
  user's repo, with hunk review, comments, a structured review, hook-free Git, commits on
  `nova/...` branches and a symbol index; permission modes and run autonomy set the gate's policy
  and the tools' roots per thread; an auto-reviewer can only tighten and fails closed;
  server-to-client requests, `ask_user` and a derived thread status reach the clients; the loop
  compacts context, discovers instruction files and runs interactive exec sessions; documents are
  written and read without new dependencies. Found and fixed in integration: event replay sent
  other accounts' events; memory consolidation read text the user never typed; a Code session's
  tools worked in the Nova workspace instead of its folder; a runtime start could jump a message
  the user queued in the same millisecond; autonomous runs without a reviewer model would deny
  every action silently; plus run ids on typed turns, request audit and expiry, scoped tool
  listings and several UI corrections. Evidence: about 2,800 unit and integration tests across 14
  packages; smoke and J1-J6 green twice in a row, J6 also with a Docker sandbox. Risks added:
  R-016..R-018; known gaps listed above. Next: M6 (agents, computers and channels).
- **M6** (e370899 and the M6 fix, web, docs, novad and e2e commits): always-on agents with
  responsibilities, rules the gate enforces, notes and memory, read-only proactive research,
  goals, self-set wakes, delegation and an external-agent rule; channels (Slack, Teams, webhook,
  in-app) with a private-to-shared check, approvals answered from a channel, triggers, signed MCP
  event subscriptions, notification routing and quiet hours; computers (bubblewrap and container
  substrates, a mock cloud, devices) with an egress proxy as the only network route, HTTPS
  inspection, injected credentials and a decision log; an agent browser on Playwright with site
  permissions, a page-action classifier, private sign-in and injection defense; computer use with
  tiers, grants, the kill key and takeover; `novad` with a supervisor, signed capabilities,
  power and Wake-on-LAN, signed updates, two-phase device writes and access requests; Code
  environments, pull requests and CI, worktree leases, dev servers through a port bridge and
  auto-verify; spaces, pages, sites, visualizations and pets; and the web UI for all of it on one
  shared event stream. Found and fixed in integration: see the M6 known gaps above (fourteen
  security and correctness fixes before the milestone closed). Evidence: about 3,900 unit and
  integration tests across 15 packages and 120 Rust tests; smoke and J1-J8 green (17/17), J7 and
  J8 three runs in a row. Risks added: R-019..R-022. Next: M6.5 (networking, transports and Add
  Device).
- **M6.5** (e8441eb, eb95271): Add Device for headless computers, phones and browsers with a QR
  code or short code and a commit-then-reveal confirmation the Hub signs, approved by the owner
  typing the code the device shows; signed `novad` builds and a one-line install that checks the
  Hub's pinned identity, the manifest signature and its own hash before writing anything; Hub
  identity, a local CA with name constraints, HTTPS, mesh certificates and native-shell pinning;
  transports with real reachability checks (only healthy endpoints advertised), mDNS, a fallback
  log and diagnostics; mesh adapters and a Network Setup assistant with consent per step,
  automatic rollback and a lock-out guard; a content-blind, self-hostable Relay with sealed
  envelopes, pairing and an API tunnel; the Wake Helper role; the Devices and Network surfaces.
  Two security reviews (24 findings, two high) and J8.5 (five bugs) were fixed before the
  milestone closed. Evidence: unit and integration tests in all 16 workspaces, 143 Rust tests, the
  real `novad` joining the wired Hub, smoke and J1-J8.5 green (21/21), J8.5 three runs in a row.
  Risks added: R-023..R-027. Next: M7 (cloud, sync, multi-device and mobile).
- **M7** (783a955, 1fac175): sync through a Hub-canonical change feed, per-field last writer wins by hybrid
  logical clock and a merge log with restore, with sealed offline copies only on devices granted
  one; offline changes queued with a visible status and landing once, in order
  (`Idempotency-Key`); a self-hostable cloud runner (`services/runner`) whose environments run Code
  sessions and Work runs while the user's computer is away, with caps and snapshots; Telegram and
  email channels and Slack buttons; Web Push from the Hub and native push through the Relay; an
  Approvals page and a New task sheet for phones, and deep links; Code handoff with its Git state,
  best-of-N attempts, three-way merges, SSH environments and delegation from agents; several
  people on one Hub with shared threads, team agents and OIDC; the flagged `script.run` and
  external agent adapters; the desktop shell (tray, quick chat, windows, attach window, an offline
  start with a local model through `novad`); `novad`'s TLS client and mutual TLS for devices; the
  M6 browser gaps. The security reviews (46 findings: one critical, six high and one high/medium)
  and the ten places the docs pass found code and spec disagreeing were fixed before the milestone
  closed, and so were J9's seven product bugs (among them the Relay out of reach of the Hub's
  pages, cloud commands refused on a Hub without a sandbox, two stale chat views and a dropped
  first message); the voice-call channel
  (FR-218) is not built. Evidence: unit and integration tests in all 18 workspaces (5,773),
  165 Rust tests, the real `novad` over mutual TLS, smoke and J1-J9 green (25/25), J9
  three runs in a row, the desktop shell's Electron journey. Risks added: R-028..R-035; R-023 and
  R-035 closed, R-022 and R-026 narrowed. Next: M7.5 (boot, power and firmware).
- **M7.5** (0521821, d2446d4): BIOS and firmware management on devices, off by default (a global switch and
  a separate one for changes that weaken security, each turned on with a confirmation): read, plan
  with a diff and a snapshot, a Hub-only approval card, a short-lived Hub-signed authorization over
  the exact body, apply with an optional guarded restart whose watchdog restores the snapshot,
  rollback with its own approval, and audit entries with before and after; a hardware support
  matrix (Dell, Lenovo and HP through the Linux firmware-attributes class, boot order on any UEFI
  machine) with plain refusals elsewhere; low-level boot as one-shot trials with a watchdog on the
  device and on the Hub's clock, boot profiles and PXE/iPXE by per-device token; out-of-band
  management of Redfish and IPMI BMCs from the Hub, off by default, turned on with consent, with
  each BMC's certificate pinned and confirmed before credentials go out; mutual TLS on the Hub →
  `novad` management channel with certificate renewal; the local browser fallback on the owner's
  computer (a clean profile limited to the site, run as a dedicated user behind an egress filter)
  and the extension bridge to the owner's own browser; decommission and `novad uninstall`; the
  device routes the M6 UI lacked; compute nodes' VRAM, quiet hours and services; approval cards
  only the signed-in owner can answer. Three security reviews (19 findings: one medium-high and
  seven medium, none critical or high) were fixed before the milestone closed, and so were J9.5's
  product bugs (the Hub refusing the fake bootloader's status, the switches reaching a device only
  with its next heartbeat, the firmware watchdog's length, the audit page's missing values and
  the notices' wording). The `novad` `screen` module moved to M9 with
  N1's capture work; not built: `fwupd` updates, BIOS settings on Windows and macOS, Intel AMT,
  DHCP and TFTP, kernel arguments. Evidence: unit and integration tests in all 19 workspaces
  (6,410), 252 Rust tests, the real `novad` over mutual TLS (`m75-novad-mtls`), smoke and
  J1-J9.5 green (28/28), J9.5 three runs in a row; nothing
  ran on real firmware, bootloaders or BMCs. Risks added: R-036..R-043; R-022 closed for devices
  with a certificate, R-034 widened to the bridge socket. Next: M8 (extensibility, enterprise and
  data controls).
- **M8** (6a8bceb, 3478630): the extension SDK (signed `.novax` bundles, handlers in a QuickJS worker
  per extension with only the permissions they declare, commands, panels, tools, theme tokens,
  keybindings, menus, status items and hooks; `@nova/sdk` and the `nova` CLI); the marketplace
  (local, Git and remote catalogs with pinned keys, permission diffs that must be accepted, rollback,
  ratings, plugins, skills, themes, pets, MCP servers and extensions; publishers named only when
  trusted; a change of publisher always confirmed); managed policy (the OS-protected file and a
  signed remote policy, tighten-only for every security setting, an egress ceiling, fail closed,
  "Managed by your organization" with its source on every locked control); data controls (sealed or
  plain export, delete-all, a vetted atomic import that brings risky items back off, an
  account-scoped export of a removed member, retention with an anchored audit, spend caps with a
  hard stop, provider limits, opt-in crash reports); third-party app authorization (OAuth with
  PKCE, a consent page, scoped revocable `nva_` tokens) and opt-in OTLP export; every Hub route
  classified (R-032 closed); localization (`@nova/i18n`, every web area, packages/ui and the desktop
  app converted, Arabic partly translated, two pseudo-locales, guards in lint and tests) and
  right-to-left layout; a WCAG 2.2 A/AA sweep with its fixes; the carry-ins (saved themes applied in
  full, Telegram files and email OAuth, removed members' data, member modes, spaces page order and
  restore, site sources and WebDAV hosting targets). Three security reviews (23 findings: one high,
  one medium-high, ten medium, none critical) and J10's product bugs were fixed before the
  milestone closed. Not built: paid or hosted-store extensions, Windows and macOS policy sources,
  translations of text the Hub writes. Evidence: unit and integration tests in all 22
  workspaces (7,728), smoke and J1-J10 green (52/52), J10 three runs in a row, the
  accessibility sweep (16 tests, no exclusions) and the right-to-left layout check; outside
  services ran only against local fakes. Risks added: R-044..R-048; R-032 closed. Next: M9
  (hardening, performance and security).
