# 29 — Task Breakdown

Starting task list per milestone. The build agent copies these into `LEDGER.md`, adds detail,
and tracks status there (`todo → in_progress → done`). IDs are stable; FR references are
authoritative for acceptance. This is a starter, not a ceiling — the agent may split or add
tasks as long as the milestone exit criteria are met.

## M0 — Foundation & Scaffolding

| Task | Description | FR |
| --- | --- | --- |
| T-M0-01 | Monorepo (npm workspaces + Turborepo), TS strict, ESLint/Prettier | — |
| T-M0-02 | `apps/hub` Fastify service skeleton (HTTP/WS/SSE, config, graceful shutdown, token-guarded listeners) | FR-124, FR-192 |
| T-M0-03 | `apps/web` React/Vite UI served by the Hub; PWA manifest + service worker | FR-125 |
| T-M0-04 | `packages/shared` zod schemas, event bus, error taxonomy | — |
| T-M0-05 | `packages/storage` Drizzle + SQLite (WAL) + migration runner + backup | — |
| T-M0-06 | `packages/ui` design tokens + 5 primitives; theme light/dark/system | FR-010 |
| T-M0-07 | `packages/policy` engine skeleton + tests | FR-099 |
| T-M0-08 | `packages/providers` interface + MockProvider + fixtures | — |
| T-M0-09 | `contracts/` schemas wired to shared zod; drift check in CI | — |
| T-M0-10 | Structured logging + redaction; settings precedence resolver | FR-118 |
| T-M0-11 | CI pipelines (lint, typecheck, unit, build) on Linux | — |
| T-M0-12 | `LEDGER.md` seeded from this document; ADR directory | — |
| T-M0-13 | `services/novad` supervisor skeleton (Rust) + service install | FR-141 |
| T-M0-14 | `scripts/check-spec.mjs` wired into CI (FR sync, schemas, links, names) | — |

## M1 — Chat MVP + Shell

| Task | Description | FR |
| --- | --- | --- |
| T-M1-01 | Hub-served UI shell: sidebar, mode tabs, command palette | FR-001, FR-002, FR-003 |
| T-M1-02 | Shortcut registry + defaults | FR-004 |
| T-M1-03 | Chat CRUD (create/rename/pin/archive/delete/search) | FR-017 |
| T-M1-04 | Streaming send/stop with partial retention | FR-018 |
| T-M1-05 | Composer + attachments (images/files) + markdown | FR-021 |
| T-M1-06 | Onboarding wizard (one provider + mock) | FR-014 |
| T-M1-07 | Accessibility baseline + focus management | FR-015 |
| T-M1-08 | OpenAI-compatible + Mock provider adapters; usage accounting stub | — |
| T-M1-09 | Persistence across restart; chat search | FR-017 |
| T-M1-10 | E2E J1 | FR-125 |

## M2 — Multi-Provider, Projects, Memory & Search

| Task | Description | FR |
| --- | --- | --- |
| T-M2-01 | Anthropic + OpenAI adapters with tool normalization | FR-023 |
| T-M2-02 | Virtual models, routing/fallback, circuit breaker, retries | FR-024 |
| T-M2-03 | Compute node registration + routing order | FR-126, FR-127 |
| T-M2-04 | Projects (instructions, sources, per-project chats) | FR-034, FR-040 |
| T-M2-05 | Memory extraction + Memory panel + per-chat opt-out | FR-032 |
| T-M2-06 | Cross-chat search + in-chat find | FR-025 |
| T-M2-07 | Steer/queue setting; edit/regenerate/branch | FR-019, FR-020 |
| T-M2-08 | Side chat; temporary chats; branch tree | FR-026, FR-027, FR-033 |
| T-M2-09 | Deep links | FR-007 |
| T-M2-11 | Model presets (Faster ↔ Smarter) over virtual models | FR-221 |
| T-M2-10 | E2E J2 | — |

## M3 — Tools, MCP, Policy & Approvals

| Task | Description | FR |
| --- | --- | --- |
| T-M3-01 | Tool registry + built-in read/write/search/exec | — |
| T-M3-02 | MCP client (stdio/http) + health/restart | FR-042, FR-043 |
| T-M3-03 | Policy engine complete (allow/ask/handoff/deny) + reasons | FR-099 |
| T-M3-04 | Approval UX (allow once/always/deny/handoff) + grants | FR-100 |
| T-M3-05 | Secrets (keychain) + redaction + secret-scan CI | FR-101 |
| T-M3-06 | Per-tool defaults + effective policy preview | FR-048 |
| T-M3-07 | Agent tool loop + tool cards | — |
| T-M3-08 | Web search with citations; `@`-mentions; artifacts pane | FR-029, FR-022, FR-038 |
| T-M3-09 | Audit hash chain + Activity trace | FR-104 |
| T-M3-10 | Notifications center | FR-013 |
| T-M3-11 | Hub trusted + external E2E baseline; optional sealed mode | FR-149 |
| T-M3-13 | Confirmation tiers + intent provenance in the policy engine | FR-189 |
| T-M3-14 | Permission profiles + protected paths | FR-190 |
| T-M3-15 | Command prefix rules with load-time examples | FR-191 |
| T-M3-16 | Listener tokens, Origin checks, per-client MCP tokens | FR-192 |
| T-M3-17 | Deferred tools + `tool.search` | FR-196 |
| T-M3-18 | Memory consolidation, project-only scope, history-reference toggle | FR-204, FR-205 |
| T-M3-12 | E2E J3 | — |

## M4 — Plugins, Skills, Workspaces & Profile

| Task | Description | FR |
| --- | --- | --- |
| T-M4-01 | Plugin manifest + loader sandbox + local install | FR-045 |
| T-M4-02 | Skills + slash invocation + auto-selection | FR-046 |
| T-M4-03 | Connector framework (OAuth/PKCE, keychain) | FR-047 |
| T-M4-04 | Multi-pane layout + terminal + editor/preview | FR-005, FR-006, FR-039 |
| T-M4-05 | Theme import/export; suggested prompts | FR-011, FR-028 |
| T-M4-06 | Local projects; Library view | FR-035, FR-041 |
| T-M4-07 | Profile + usage insights + multiple accounts | FR-113, FR-114, FR-115 |
| T-M4-08 | Nova-as-MCP-server with consent | FR-044 |
| T-M4-10 | Lifecycle hooks (trust by hash, tighten-only) | FR-197 |
| T-M4-11 | MCP Apps UI host (sandboxed iframes, bridge, CSP) | FR-198 |
| T-M4-12 | MCP bundle install | FR-199 |
| T-M4-13 | Import from other assistants (preview, dedupe, secret migration) | FR-200 |
| T-M4-09 | E2E J4 | — |

## M5 — Agent Runtime: Work & Code

| Task | Description | FR |
| --- | --- | --- |
| T-M5-01 | agentd worker pool + supervisor/orchestrator/executor | FR-051 |
| T-M5-02 | Plans, autonomy levels, re-planning | FR-051, FR-131 |
| T-M5-03 | Background sub-agents + child threads | FR-053, FR-054 |
| T-M5-04 | Scheduler (cron) + recurring tasks UI | FR-055 |
| T-M5-05 | Activity view + replay | FR-057 |
| T-M5-06 | Approvals for runs | FR-058 |
| T-M5-07 | Code sessions + permission modes | FR-061, FR-063 |
| T-M5-08 | File edits + diff viewer + comments | FR-064, FR-065 |
| T-M5-09 | Terminal + repo index (tree-sitter) | FR-066, FR-074 |
| T-M5-10 | `/review` findings card | FR-069 |
| T-M5-11 | Diagnostics page; audit export | FR-119, FR-104 |
| T-M5-12 | Image generation; realtime voice | FR-030, FR-031 |
| T-M5-13 | Plugin authoring from conversation | FR-050 |
| T-M5-15 | Goals + budgeted execution + per-turn backstop | FR-181, FR-182 |
| T-M5-16 | Compaction triggers + context tools | FR-183 |
| T-M5-17 | Interactive exec sessions | FR-184 |
| T-M5-18 | Instruction-file discovery | FR-185 |
| T-M5-19 | Chat escalation to Work; thread status model | FR-186, FR-215 |
| T-M5-20 | Verified outcomes; server-to-client requests | FR-187, FR-188 |
| T-M5-21 | Model-based auto-review (fail-closed, circuit breaker) | FR-085 |
| T-M5-22 | Hook-free app Git operations | FR-211 |
| T-M5-23 | Dictation; document outputs; deep research template | FR-216, FR-219, FR-220 |
| T-M5-14 | E2E J5, J6 | — |

## M6 — Agents, Computers & Channels (+ novad core)

| Task | Description | FR |
| --- | --- | --- |
| T-M6-01 | Agent model + creation/onboarding + responsibilities | FR-079 |
| T-M6-02 | `novad` supervisor + module sandbox + capability doc | FR-141, FR-142 |
| T-M6-03 | Local sandbox (bwrap) + container + cloud stub | FR-107 |
| T-M6-04 | Browser controller + computer use + takeover | FR-092, FR-093, FR-087 |
| T-M6-05 | Sign-in flow + appshots | FR-086, FR-075 |
| T-M6-06 | Proactive research + background threads | FR-082, FR-083 |
| T-M6-07 | Custom rules | FR-084 |
| T-M6-08 | Event triggers + channels (Slack/Teams/webhook) | FR-056, FR-088 |
| T-M6-09 | Agent memory + activity/stop | FR-089, FR-090 |
| T-M6-10 | Power/WoL + service management + `novad` updates | FR-144, FR-145, FR-148 |
| T-M6-11 | Egress control + injection defense | FR-102, FR-103 |
| T-M6-12 | Spaces/Pages + Sites + visualizations; pets | FR-036, FR-037, FR-076, FR-012 |
| T-M6-13 | Per-device overrides | FR-150 |
| T-M6-15 | Egress proxy modes + credential injection; external-agent rule | FR-193, FR-194 |
| T-M6-16 | Micro-VM substrate (flagged) | FR-195 |
| T-M6-17 | MCP event subscriptions; agent self-scheduling | FR-201, FR-206 |
| T-M6-18 | Computer-use control tiers; local browser fallback; page tools | FR-207, FR-209, FR-208 |
| T-M6-19 | `novad` staged writes + local MCP pass-through | FR-210 |
| T-M6-14 | E2E J7, J8 | — |

## M6.5 — Networking, Transports & Add Device

| Task | Description | FR |
| --- | --- | --- |
| T-M65-01 | Add-Device flow (QR/short code, roles/scopes, approval) | FR-132 |
| T-M65-02 | Hub-served signed `novad` builds + bootstrap command | FR-133 |
| T-M65-03 | Transport abstraction + LAN/mDNS + endpoint health | FR-135 |
| T-M65-04 | Mesh adapters (Headscale/Tailscale/NetBird/WireGuard) | FR-135 |
| T-M65-05 | Relay client + E2E sealing | FR-137 |
| T-M65-06 | Trust paths (local CA / Mesh certs / pinning) | FR-134 |
| T-M65-07 | Network Setup assistant + reachability tests + rollback | FR-136, FR-139 |
| T-M65-08 | Wake Helper role | FR-138 |
| T-M65-09 | Device management UI | FR-140 |
| T-M65-10 | E2E J9 (device add) | — |

## M7 — Cloud, Sync, Multi-Device & Mobile

| Task | Description | FR |
| --- | --- | --- |
| T-M7-01 | Cloud runner integration + environments | FR-108, FR-071 |
| T-M7-02 | E2E sync: keys, device linking, merge log | FR-109 |
| T-M7-03 | Offline replica (capability-gated) + local fallback | FR-129, FR-128 |
| T-M7-04 | Offline queue + retry | FR-112 |
| T-M7-05 | Tray/quick chat/multi-window | FR-008, FR-009 |
| T-M7-06 | Telegram/email channels; mobile relay + push + deep links | FR-110, FR-111, FR-077 |
| T-M7-07 | Specialist/team agents | FR-091 |
| T-M7-09 | Session handoff; attach window | FR-213, FR-214 |
| T-M7-10 | Best-of-N; shared threads; voice-call channel | FR-212, FR-217, FR-218 |
| T-M7-11 | Flagged: scripted tool calls; external agent adapters | FR-202, FR-203 |
| T-M7-08 | E2E J9 | — |

## M7.5 — Device Management: Boot, Power & Firmware

| Task | Description | FR |
| --- | --- | --- |
| T-M75-01 | Low-level boot (PXE/iPXE, bootloader) + watchdog | FR-143 |
| T-M75-02 | Firmware read/plan/apply/rollback + allowlist + toggle | FR-146 |
| T-M75-03 | Hardware support matrix + clear refusals | FR-146 |
| T-M75-04 | Out-of-band module (IPMI/Redfish/AMT), off by default | FR-147 |
| T-M75-05 | E2E security: firmware disabled-by-default + approval/rollback | — |

## M8 — Extensibility, Enterprise & Data Controls

| Task | Description | FR |
| --- | --- | --- |
| T-M8-01 | Extension SDK + `nova dev/validate/pack` + template | FR-117 |
| T-M8-02 | Marketplace with signatures + permission diffs | FR-049 |
| T-M8-03 | Managed policy file + precedence UI | FR-106 |
| T-M8-04 | Data export/delete + retention; spend caps; crash reporting | FR-105, FR-116, FR-121 |
| T-M8-05 | i18n + RTL + accessibility audit | FR-016, FR-015 |
| T-M8-07 | Third-party app authorization; opt-in OTLP export | FR-222, FR-223 |
| T-M8-06 | E2E J10 | — |

## M9 — Hardening, Performance & Security

| Task | Description | FR |
| --- | --- | --- |
| T-M9-01 | Meet performance budgets + CI regression guard | FR-122 |
| T-M9-02 | Full security suite + fuzzing + sandbox escape tests | FR-123 |
| T-M9-03 | Test-suite completion; flakiness elimination | — |
| T-M9-04 | Error/degraded/empty-state polish | — |
| T-M9-05 | Device-lab tests (multi-device, transports, novad) | FR-135, FR-141 |
| T-M9-06 | Persistence safety evals + reviewer metrics | FR-224 |

## M10 — Packaging & Release

| Task | Description | FR |
| --- | --- | --- |
| T-M10-01 | Hub packaging (container/systemd/launchd/service) | FR-124 |
| T-M10-02 | `novad` signed per-arch builds + update channel | FR-148 |
| T-M10-03 | Client installers (Linux/macOS/Windows) + PWA | FR-125 |
| T-M10-04 | Signing/notarization + SBOM + checksums | — |
| T-M10-05 | Auto-update + staged rollout + rollback | FR-120 |
| T-M10-06 | Docs, tutorials, changelog, release notes | — |
| T-M10-08 | Install robustness (data dirs, port conflicts, download verification) | FR-225 |
| T-M10-07 | E2E J11; release checklist | — |

## N1 — Ambient Memory

| Task | Description | FR |
| --- | --- | --- |
| T-N1-01 | Reconcile ambient findings; finalize capture design (done in Phase 0, ADR-073) | — |
| T-N1-02 | Event-driven capture of the focused window + permissions (Windows first) | FR-151 |
| T-N1-03 | Accessibility-first text extraction, OCR fallback; audio STT (phase 2) | FR-152 |
| T-N1-04 | Timeline UI + FTS (time-ordered) + optional vector index | FR-153 |
| T-N1-05 | Privacy controls (rules, built-in exclusions, pauses, forget, retention) | FR-154 |
| T-N1-06 | Ambient tools (broad to narrow) + MCP exposure with coverage | FR-155 |
| T-N1-07 | Resource governor (power profiles, CPU lane, disk guard) | FR-156 |
| T-N1-08 | Redaction release gate + per-category switches | FR-227 |
| T-N1-09 | Capture split: networkless helper, `novad` transport, Hub storage, pixel upload | FR-228 |
| T-N1-10 | Activity summary | FR-229 |
| T-N1-11 | Provenance checks + scoped ambient grants | FR-232, FR-233 |
| T-N1-12 | Meeting detection + speaker identity (phase 2) | FR-230, FR-231 |

## N2 — Automations & Smart Home

| Task | Description | FR |
| --- | --- | --- |
| T-N2-01 | Automation engine + versioning + DAG execution | FR-157 |
| T-N2-02 | Trigger kinds | FR-158 |
| T-N2-03 | Action kinds | FR-159 |
| T-N2-04 | Dry-run, logs, rollback, approvals, loop prevention | FR-160 |
| T-N2-05 | Home Assistant managed-or-direct bootstrap | FR-176 |
| T-N2-06 | Entity model + areas/scenes + NL control | FR-162 |
| T-N2-07 | Agent ↔ automation interop | FR-163 |
| T-N2-08 | HomeKit bridge (optional) | FR-179 |
| T-N2-09 | Matter bridge (optional) | FR-180 |

## N3 — Extensions & Community

| Task | Description | FR |
| --- | --- | --- |
| T-N3-01 | Unified catalog format + hosting endpoints (public + tailnet) | FR-165, FR-177 |
| T-N3-02 | MCP registry import + permission wrapping | FR-166 |
| T-N3-03 | Signed publish/install + permission diff + rollback | FR-167 |
| T-N3-04 | Governance: review, scanning, report/takedown, kill switch | FR-168 |

## N4 — Learning & Self-Improvement

| Task | Description | FR |
| --- | --- | --- |
| T-N4-01 | L0 memory learning with review | FR-169 |
| T-N4-02 | L1 skill synthesis + authoring (markdown) | FR-170, FR-178 |
| T-N4-03 | Evaluation harness + regression gates | FR-175 |
| T-N4-04 | L2 workflow/prompt optimization with evidence | FR-171 |
| T-N4-05 | L3 bounded self-tuning + drift detection | FR-172 |
| T-N4-06 | L4 gated code self-modification + guardrail toggle | FR-173 |
| T-N4-07 | L5 optional local fine-tuning | FR-174 |
| T-N4-08 | Transparency view + kill switch | FR-175 |
| T-N4-09 | Skill proposals from a recorded demonstration | FR-226 |
