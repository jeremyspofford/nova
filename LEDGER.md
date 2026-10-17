# Build Ledger

> **This is the single source of truth for build progress.** The build agent keeps it current
> before and after every task (`AGENTS.md` §4). Task IDs come from `docs/29-task-breakdown.md`.

Current milestone: **M3 — Tools, MCP, Policy & Approvals**
Last updated: 2026-10-17T08:40:00Z

## Phase status

| Phase | Status | Commit | Evidence |
| --- | --- | --- | --- |
| Phase 0 — reconcile external findings | done | c63b82d | `docs/external/RECONCILIATION.md` (141 capabilities); `node scripts/check-spec.mjs` |
| Phase 1 — finish the specification | done | 2868ce3 | topic docs + contracts updated; `node scripts/check-spec.mjs`; all schemas compile (Ajv 2020) |
| Phase 2 — build | in_progress | 10bbcf4 | M0, M1, M2 done |

## Milestone status

| Milestone | Status | Started | Completed | Evidence |
| --- | --- | --- | --- | --- |
| M0 Foundation | done | 2026-10-17 | 2026-10-17 | 10bbcf4; `docs/demos/M0.md`; Playwright smoke J0 green |
| M1 Chat MVP | done | 2026-10-17 | 2026-10-17 | J1 green 3/3 (axe clean, cold start < 3 s); `docs/demos/M1.md` |
| M2 Providers/Projects/Memory | done | 2026-10-17 | 2026-10-17 | J1 + J2 green 3/3 in parallel (axe clean); `docs/demos/M2.md` |
| M3 Tools/MCP/Policy | todo | — | — | — |
| M4 Plugins/Workspace/Profile | todo | — | — | — |
| M5 Agent Runtime (Work & Code) | todo | — | — | — |
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
| T-M3-01 | M3 | — | todo | — | — | Tool registry + built-in read/write/search/exec |
| T-M3-02 | M3 | FR-042, FR-043 | todo | — | — | MCP client (stdio/http) + health/restart |
| T-M3-03 | M3 | FR-099 | todo | — | — | Policy engine complete (allow/ask/handoff/deny) + reasons |
| T-M3-04 | M3 | FR-100 | todo | — | — | Approval UX (allow once/always/deny/handoff) + grants |
| T-M3-05 | M3 | FR-101 | todo | — | — | Secrets (keychain) + redaction + secret-scan CI |
| T-M3-06 | M3 | FR-048 | todo | — | — | Per-tool defaults + effective policy preview |
| T-M3-07 | M3 | — | todo | — | — | Agent tool loop + tool cards |
| T-M3-08 | M3 | FR-029, FR-022, FR-038 | todo | — | — | Web search with citations; `@`-mentions; artifacts pane |
| T-M3-09 | M3 | FR-104 | todo | — | — | Audit hash chain + Activity trace |
| T-M3-10 | M3 | FR-013 | todo | — | — | Notifications center |
| T-M3-11 | M3 | FR-149 | todo | — | — | Hub trusted + external E2E baseline; optional sealed mode |
| T-M3-13 | M3 | FR-189 | todo | — | — | Confirmation tiers + intent provenance in the policy engine |
| T-M3-14 | M3 | FR-190 | todo | — | — | Permission profiles + protected paths |
| T-M3-15 | M3 | FR-191 | todo | — | — | Command prefix rules with load-time examples |
| T-M3-16 | M3 | FR-192 | todo | — | — | Listener tokens, Origin checks, per-client MCP tokens |
| T-M3-17 | M3 | FR-196 | todo | — | — | Deferred tools + `tool.search` |
| T-M3-18 | M3 | FR-204, FR-205 | todo | — | — | Memory consolidation, project-only scope, history-reference toggle |
| T-M3-12 | M3 | — | todo | — | — | E2E J3 |
| T-M4-01 | M4 | FR-045 | todo | — | — | Plugin manifest + loader sandbox + local install |
| T-M4-02 | M4 | FR-046 | todo | — | — | Skills + slash invocation + auto-selection |
| T-M4-03 | M4 | FR-047 | todo | — | — | Connector framework (OAuth/PKCE, keychain) |
| T-M4-04 | M4 | FR-005, FR-006, FR-039 | todo | — | — | Multi-pane layout + terminal + editor/preview |
| T-M4-05 | M4 | FR-011, FR-028 | todo | — | — | Theme import/export; suggested prompts |
| T-M4-06 | M4 | FR-035, FR-041 | todo | — | — | Local projects; Library view |
| T-M4-07 | M4 | FR-113, FR-114, FR-115 | todo | — | — | Profile + usage insights + multiple accounts |
| T-M4-08 | M4 | FR-044 | todo | — | — | Nova-as-MCP-server with consent |
| T-M4-10 | M4 | FR-197 | todo | — | — | Lifecycle hooks (trust by hash, tighten-only) |
| T-M4-11 | M4 | FR-198 | todo | — | — | MCP Apps UI host (sandboxed iframes, bridge, CSP) |
| T-M4-12 | M4 | FR-199 | todo | — | — | MCP bundle install |
| T-M4-13 | M4 | FR-200 | todo | — | — | Import from other assistants (preview, dedupe, secret migration) |
| T-M4-09 | M4 | — | todo | — | — | E2E J4 |
| T-M5-01 | M5 | FR-051 | todo | — | — | agentd worker pool + supervisor/orchestrator/executor |
| T-M5-02 | M5 | FR-051, FR-131 | todo | — | — | Plans, autonomy levels, re-planning |
| T-M5-03 | M5 | FR-053, FR-054 | todo | — | — | Background sub-agents + child threads |
| T-M5-04 | M5 | FR-055 | todo | — | — | Scheduler (cron) + recurring tasks UI |
| T-M5-05 | M5 | FR-057 | todo | — | — | Activity view + replay |
| T-M5-06 | M5 | FR-058 | todo | — | — | Approvals for runs |
| T-M5-07 | M5 | FR-061, FR-063 | todo | — | — | Code sessions + permission modes |
| T-M5-08 | M5 | FR-064, FR-065 | todo | — | — | File edits + diff viewer + comments |
| T-M5-09 | M5 | FR-066, FR-074 | todo | — | — | Terminal + repo index (tree-sitter) |
| T-M5-10 | M5 | FR-069 | todo | — | — | `/review` findings card |
| T-M5-11 | M5 | FR-119, FR-104 | todo | — | — | Diagnostics page; audit export |
| T-M5-12 | M5 | FR-030, FR-031 | todo | — | — | Image generation; realtime voice |
| T-M5-13 | M5 | FR-050 | todo | — | — | Plugin authoring from conversation |
| T-M5-15 | M5 | FR-181, FR-182 | todo | — | — | Goals + budgeted execution + per-turn backstop |
| T-M5-16 | M5 | FR-183 | todo | — | — | Compaction triggers + context tools |
| T-M5-17 | M5 | FR-184 | todo | — | — | Interactive exec sessions |
| T-M5-18 | M5 | FR-185 | todo | — | — | Instruction-file discovery |
| T-M5-19 | M5 | FR-186, FR-215 | todo | — | — | Chat escalation to Work; thread status model |
| T-M5-20 | M5 | FR-187, FR-188 | todo | — | — | Verified outcomes; server-to-client requests |
| T-M5-21 | M5 | FR-085 | todo | — | — | Model-based auto-review (fail-closed, circuit breaker) |
| T-M5-22 | M5 | FR-211 | todo | — | — | Hook-free app Git operations |
| T-M5-23 | M5 | FR-216, FR-219, FR-220 | todo | — | — | Dictation; document outputs; deep research template |
| T-M5-14 | M5 | — | todo | — | — | E2E J5, J6 |
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
- R-009: The web bundle is 202 KB gzipped after M2 (73 KB at M0). Mitigation: split routes (settings, projects, compare) with dynamic imports when M4 adds the multi-pane workspace; cold start is still under budget.
- R-010: Provider request details (Anthropic adaptive thinking and summarized reasoning, OpenRouter reasoning options) are verified only against recorded fixtures. Mitigation: opt-in live smoke tests behind a key, before M10.
- R-011: One web test (Settings → Keyboard rebinding) failed once under a fully parallel run and passed on every rerun. Mitigation: watch CI; quarantine with a ledger task if it repeats.

## Deferrals

| Requirement | Reason | Follow-up task |
| --- | --- | --- |
| FR-130 | Hub failover is post-v1 (ADR-035) | — |
| FR-040 (non-text sources) | M2 indexes text types only; PDF and office documents need extraction | T-M4-04 (file previews) |
| FR-126 (mTLS, VRAM, quiet hours, `/node/v1/services/*`) | Bearer tokens over LAN until the Mesh (ADR-089) | T-M6.5 networking tasks |
| docs/07 §9 concurrency limits | Global and per-provider semaphores are not enforced yet | T-M9 performance tasks |

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
