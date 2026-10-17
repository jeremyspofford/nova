# Build Ledger

> **This is the single source of truth for build progress.** The build agent keeps it current
> before and after every task (`AGENTS.md` §4). Task IDs come from `docs/29-task-breakdown.md`.

Current milestone: **M6 — Agents, Computers & Channels**
Last updated: 2026-10-17T18:00:00Z

## Phase status

| Phase | Status | Commit | Evidence |
| --- | --- | --- | --- |
| Phase 0 — reconcile external findings | done | c63b82d | `docs/external/RECONCILIATION.md` (141 capabilities); `node scripts/check-spec.mjs` |
| Phase 1 — finish the specification | done | 2868ce3 | topic docs + contracts updated; `node scripts/check-spec.mjs`; all schemas compile (Ajv 2020) |
| Phase 2 — build | in_progress | 10bbcf4 | M0-M5 done |

## Milestone status

| Milestone | Status | Started | Completed | Evidence |
| --- | --- | --- | --- | --- |
| M0 Foundation | done | 2026-10-17 | 2026-10-17 | 10bbcf4; `docs/demos/M0.md`; Playwright smoke J0 green |
| M1 Chat MVP | done | 2026-10-17 | 2026-10-17 | J1 green 3/3 (axe clean, cold start < 3 s); `docs/demos/M1.md` |
| M2 Providers/Projects/Memory | done | 2026-10-17 | 2026-10-17 | J1 + J2 green 3/3 in parallel (axe clean); `docs/demos/M2.md` |
| M3 Tools/MCP/Policy | done | 2026-10-17 | 2026-10-17 | J1, J2, J3 green 3/3 in parallel (axe clean); `docs/demos/M3.md` |
| M4 Plugins/Workspace/Profile | done | 2026-10-17 | 2026-10-17 | J1-J4 green 3/3 (axe clean); `docs/demos/M4.md` |
| M5 Agent Runtime (Work & Code) | done | 2026-10-17 | 2026-10-17 | J1-J6 green twice in a row (axe clean); `docs/demos/M5.md` |
| M6 Agents/Computers/Channels | todo | — | — | — |
| M6.5 Networking/Add Device | todo | — | — | — |
| M7 Cloud/Sync/Multi-device | todo | — | — | — |
| M7.5 Boot/Power/Firmware | todo | — | — | — |
| M8 Extensibility/Governance | todo | — | — | — |
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
| T-M65-01 | M6.5 | FR-132 | todo | — | — | Add-Device flow (QR/short code, roles/scopes, approval) |
| T-M65-02 | M6.5 | FR-133 | todo | — | — | Hub-served signed `novad` builds + bootstrap command |
| T-M65-03 | M6.5 | FR-135 | todo | — | — | Transport abstraction + LAN/mDNS + endpoint health |
| T-M65-04 | M6.5 | FR-135 | todo | — | — | Mesh adapters (Headscale/Tailscale/NetBird/WireGuard) |
| T-M65-05 | M6.5 | FR-137 | todo | — | — | Relay client + E2E sealing |
| T-M65-06 | M6.5 | FR-134 | todo | — | — | Trust paths (local CA / Mesh certs / pinning) |
| T-M65-07 | M6.5 | FR-136, FR-139 | todo | — | — | Network Setup assistant + reachability tests + rollback |
| T-M65-08 | M6.5 | FR-138 | todo | — | — | Wake Helper role |
| T-M65-09 | M6.5 | FR-140 | todo | — | — | Device management UI |
| T-M65-10 | M6.5 | — | todo | — | — | E2E J9 (device add) |
| T-M7-01 | M7 | FR-108, FR-071 | todo | — | — | Cloud runner integration + environments |
| T-M7-02 | M7 | FR-109 | todo | — | — | E2E sync: keys, device linking, merge log |
| T-M7-03 | M7 | FR-129, FR-128 | todo | — | — | Offline replica (capability-gated) + local fallback |
| T-M7-04 | M7 | FR-112 | todo | — | — | Offline queue + retry |
| T-M7-05 | M7 | FR-008, FR-009 | todo | — | — | Tray/quick chat/multi-window |
| T-M7-06 | M7 | FR-110, FR-111, FR-077 | todo | — | — | Telegram/email channels; mobile relay + push + deep links |
| T-M7-07 | M7 | FR-091 | todo | — | — | Specialist/team agents |
| T-M7-09 | M7 | FR-213, FR-214 | todo | — | — | Session handoff; attach window |
| T-M7-10 | M7 | FR-212, FR-217, FR-218 | todo | — | — | Best-of-N; shared threads; voice-call channel |
| T-M7-11 | M7 | FR-202, FR-203 | todo | — | — | Flagged: scripted tool calls; external agent adapters |
| T-M7-08 | M7 | — | todo | — | — | E2E J9 |
| T-M75-01 | M7.5 | FR-143 | todo | — | — | Low-level boot (PXE/iPXE, bootloader) + watchdog |
| T-M75-02 | M7.5 | FR-146 | todo | — | — | Firmware read/plan/apply/rollback + allowlist + toggle |
| T-M75-03 | M7.5 | FR-146 | todo | — | — | Hardware support matrix + clear refusals |
| T-M75-04 | M7.5 | FR-147 | todo | — | — | Out-of-band module (IPMI/Redfish/AMT), off by default |
| T-M75-05 | M7.5 | — | todo | — | — | E2E security: firmware disabled-by-default + approval/rollback |
| T-M8-01 | M8 | FR-117 | todo | — | — | Extension SDK + `nova dev/validate/pack` + template |
| T-M8-02 | M8 | FR-049 | todo | — | — | Marketplace with signatures + permission diffs |
| T-M8-03 | M8 | FR-106 | todo | — | — | Managed policy file + precedence UI |
| T-M8-04 | M8 | FR-105, FR-116, FR-121 | todo | — | — | Data export/delete + retention; spend caps; crash reporting |
| T-M8-05 | M8 | FR-016, FR-015 | todo | — | — | i18n + RTL + accessibility audit |
| T-M8-07 | M8 | FR-222, FR-223 | todo | — | — | Third-party app authorization; opt-in OTLP export |
| T-M8-06 | M8 | — | todo | — | — | E2E J10 |
| T-M9-01 | M9 | FR-122 | todo | — | — | Meet performance budgets + CI regression guard |
| T-M9-02 | M9 | FR-123 | todo | — | — | Full security suite + fuzzing + sandbox escape tests |
| T-M9-03 | M9 | — | todo | — | — | Test-suite completion; flakiness elimination |
| T-M9-04 | M9 | — | todo | — | — | Error/degraded/empty-state polish |
| T-M9-05 | M9 | FR-135, FR-141 | todo | — | — | Device-lab tests (multi-device, transports, novad) |
| T-M9-06 | M9 | FR-224 | todo | — | — | Persistence safety evals + reviewer metrics |
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

## Deferrals

| Requirement | Reason | Follow-up task |
| --- | --- | --- |
| FR-130 | Hub failover is post-v1 (ADR-035) | — |
| FR-040 (non-text sources) | Text types only; PDF and office documents need extraction (M4 previews PDFs in the file viewer but indexes neither) | T-M9 (document extraction) |
| FR-126 (mTLS, VRAM, quiet hours, `/node/v1/services/*`) | Bearer tokens over LAN until the Mesh (ADR-089) | T-M6.5 networking tasks |
| docs/07 §9 concurrency limits | Global and per-provider semaphores are not enforced yet | T-M9 performance tasks |
| FR-149 (database and backups at rest, sealed mode) | No encrypting SQLite layer; backups and sealed mode not yet | T-M9 hardening tasks |
| FR-042 (`deviceId` server field; `oauth`/`auth` in the shared server schema) | OAuth works for remote servers (M4); device-hosted servers come with devices | T-M6 device tasks |
| FR-185 (imported user instructions) | Import writes `<dataDir>/instructions.md`; the chat reads it with instruction-file discovery | T-M5 (FR-185) |
| FR-011 (apply a custom palette) | Themes share and import in M4; applying a saved custom palette fully is not wired | T-M8 theming tasks |
| FR-113 (public profile card, OIDC sign-in) | Not in M4 scope | T-M7 cloud tasks |
| FR-115 (entitlements and limits), docs/14 §6 (spend caps, clear usage) | Usage insights only in M4 | T-M8 governance tasks |
| FR-044 (`nova mcp stdio` launcher; resources and prompts on Nova's server) | Streamable HTTP with tools only in M4 | T-M6 device tasks |
| FR-199 (bundle servers in the sandbox) | Bundle servers run like other MCP stdio servers (R-012); confirmed permissions are recorded | T-M6 (FR-107, FR-193) |
| FR-216 (dictation), FR-031 (realtime voice) | Need a local speech engine or a realtime audio provider; Nova ships neither (assessment in ADR-092) | T-M9 or a voice milestone |
| FR-030 (image generation visible) | Built and tested; hidden until a provider adapter has an images call (`Provider.generateImage`) | T-M7 provider tasks |
| FR-070 (PR flow, CI status), FR-073 (worktree registry routes, leases, handoff, `.worktreeinclude`) | Commits stay local in M5; worktrees are created per session only | T-M7 code tasks |
| FR-055 (webhook signing-secret reveal) | Secrets never appear in responses; a rotate-and-show-once route is needed | T-M6 channels |
| FR-188 (`ask_user` answer authority) | The answer returns as an untrusted tool result; a loop hook to carry the user's authority is needed | T-M6 |
| FR-053 (sub-agent tool allow-list) | Enforced only through the read-only profile | T-M6 |
| FR-060 (quiet hours for goal continuations), FR-206 (self-set wakes), agent-made schedules | Agents arrive in M6 | T-M6 agents |
| FR-074 (tree-sitter index; renames in diffs) | Pattern-based symbol index; renames show as delete + add | T-M9 |
| FR-198 (allowed domains in the App frame header; Apps in the composer's + menu; `UiEntryPointView.domains`) | The frame, bridge, CSP and entry points ship; these surfaces do not | T-M8 extensibility tasks |
| FR-200 (hooks from other plugin layouts) | Noted on the import item; not converted | T-M8 extensibility tasks |

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
| Images cannot be edited (FR-030); only `git.status`, `git.diff` and `git.log` exist among `git.*` tools | T-M7 |

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
