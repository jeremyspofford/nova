# 17 — Roadmap & Milestones

The build proceeds strictly in order. A milestone is complete only when **all exit criteria**
and the milestone's acceptance checks in `docs/18` pass. Dependencies are noted; parallel work
within a milestone is encouraged (each task in its own commit).

Each milestone lists: **goal · deliverables · FR coverage · exit criteria · demo**.

---

## M0 — Foundation & Scaffolding

**Goal:** A monitored, tested monorepo whose Hub boots and serves an empty but real UI shell.

**Deliverables**
- npm-workspace monorepo per `docs/05` with Turborepo, strict TypeScript, ESLint, Prettier.
- `apps/hub` Fastify service (HTTP/WS/SSE, config, graceful shutdown) and `apps/web` React/Vite
  UI served by the Hub (FR-124, FR-125). The native desktop shell is a later client (ADR-081).
- `packages/shared` (zod schemas, event bus, errors), `packages/storage` (Drizzle + SQLite
  migration runner), `packages/ui` (design tokens + 5 primitives), `packages/policy`
  (skeleton), `packages/providers` (interface + MockProvider).
- `contracts/` implemented as typed schemas with a contract test harness.
- CI pipelines from `docs/16` §9 (lint, typecheck, unit, build, spec check) on Linux.
- `LEDGER.md` with the full task breakdown; ADR directory; `THIRD_PARTY_NOTICES` generator.
- Structured logging + redaction skeleton; settings table + precedence resolver.

**FR coverage:** none user-facing; enables all.
**Exit criteria**
- `npm run lint && npm run typecheck && npm test && npm run build` green.
- The Hub starts and serves the web shell with a themeable background; a Playwright smoke test
  against the running Hub passes.
- DB migrations run and roll back; contract tests pass.

**Demo:** start the Hub, open its URL; command palette opens (no commands yet); theme toggles.

---

## M1 — Chat MVP + Shell

**Goal:** A working single-provider chat with the core shell.

**Deliverables**
- Sidebar + mode tabs (Chat/Work/Code/Agents placeholders) + command palette + shortcut
  registry (FR-001/002/003/004).
- Conversation engine: create/rename/pin/archive/delete/search chats; streaming; stop
  (FR-017/018).
- Composer with attachments (images/files) and markdown rendering (FR-021 partial).
- Appearance settings + built-in themes + font size (FR-010).
- Onboarding wizard with one provider (OpenAI-compatible + MockProvider) (FR-014).
- Accessibility baseline + focus management (FR-015).
- Provider layer with OpenAI-compatible adapter + MockProvider; usage accounting stub.

**Exit criteria**
- Onboard with a mock key → stream a reply → stop mid-stream → retained partial (tested).
- Chat persists across restart; search finds a message.
- axe: no serious/critical violations on Chat and Settings.
- Cold start ≤ 3.0 s (relaxed; tightened in M9).

**Demo:** first-run onboarding, send/receive a streamed answer, switch theme.

---

## M2 — Multi-Provider, Projects, Memory & Search

**Goal:** Provider choice and durable context.

**Deliverables**
- Anthropic + OpenAI adapters with tool-call normalization; OpenRouter + generic
  OpenAI-compatible; local (Ollama/llama.cpp detection) (FR-023/024).
- Virtual models + routing/fallback + circuit breaker + retries (docs/07).
- Projects: create, instructions, sources, per-project chats (FR-034/040).
- Memory extraction + Memory panel + per-chat opt-out + import (FR-032).
- Cross-chat full-text search + in-chat find (FR-025); streaming steer/queue setting (FR-019);
  message edit/regenerate/branch (FR-020); deep links (FR-007).
- Side chat (FR-026); temporary chats (FR-027); branch tree (FR-033).
- Model presets from Faster to Smarter over virtual models (FR-221).

**Exit criteria**
- Same conversation works on two providers; swapping mid-thread preserves context.
- Memory extracted, editable, and excluded from temporary chats (tested).
- Search returns ranked results with snippets and jump-to-message.

**Demo:** ask with Anthropic, switch to a local model, see memory retained.

---

## M3 — Tools, MCP, Policy & Approvals

**Goal:** The agent can safely use tools, and every action is governed.

**Deliverables**
- Tool registry + built-in read/write/search/exec tools; MCP client (stdio/http) (FR-042/043).
- Policy engine (FR-099) + approval UX (FR-100) + secrets/keychain + redaction (FR-101).
- Per-tool defaults (FR-048); agent loop with tool calls; tool cards in Chat.
- Web search with citations (FR-029); `@`-mentions (FR-022); artifacts pane (FR-038).
- Structured logging + Diagnostics basics (FR-118); notifications (FR-013).
- Audit hash chain (FR-104 partial) and Activity trace listing.
- Confirmation tiers and intent provenance (FR-189); permission profiles and protected paths
  (FR-190); command prefix rules with load-time examples (FR-191); listener tokens and
  integration hygiene (FR-192); deferred tools with tool search (FR-196).
- Memory consolidation, project-only memory and the history-reference toggle (FR-204, FR-205).

**Exit criteria**
- Install a test MCP server → call a tool → approve → audit entry with hash chain verified.
- Policy tests: allow/ask/handoff/deny + path traversal + egress denial all fail closed.
- Secret-scan CI job green; no plaintext secret in any log/trace (tested).

**Demo:** ask for a file summary; watch a read tool auto-allow and a write tool prompt.

---

## M4 — Plugins, Skills, Workspaces & Profile

**Goal:** Extensibility and a multi-pane workspace.

**Deliverables**
- Plugin format + loader sandbox + marketplace stub + local install (FR-045/049 partial).
- Skills system + slash invocation + auto-selection (FR-046); connector framework (FR-047).
- Multi-pane layout, bottom panel, terminal (FR-005/006); file editor/preview (FR-039);
  theme import/export (FR-011); suggested prompts (FR-028).
- Local projects bound to folders (FR-035); Library view (FR-041).
- Profile + usage insights (FR-113/114/115).
- Nova-as-MCP-server with consent and per-client tokens (FR-044, FR-192).
- Lifecycle hooks, trusted by hash and tighten-only (FR-197); MCP Apps UI hosting (FR-198);
  MCP bundles (FR-199); import from other assistants (FR-200).

**Exit criteria**
- Install a sample plugin; its skill runs; permissions enforced (undeclared host blocked).
- Arrange panes, save layout, restart, layout restored.
- Usage insights show tokens/cost for the session.

**Demo:** install a plugin, run its slash command, open the terminal pane.

---

## M5 — Agent Runtime: Work & Code

**Goal:** Delegated work runs and a real coding agent.

**Deliverables**
- Agent daemon + supervisor/orchestrator/executor + plans + sub-agents + activity (FR-051…058).
- Scheduler (cron) + recurring tasks UI (FR-055).
- Code sessions + permission modes + diff viewer + comments + terminal + repo index
  (FR-061/063/064/065/066/074).
- `/review` findings card (FR-069); diagnostics page (FR-119); audit export (FR-104).
- Work→Code and Code→Work delegation (FR-059 stub).
- Image generation (FR-030) and realtime voice (FR-031) if provider support is present.
- Plugin authoring from conversation (FR-050).
- Goals and budgeted execution (FR-181, FR-182); compaction triggers (FR-183); interactive exec
  sessions (FR-184); instruction-file discovery (FR-185); chat escalation to Work (FR-186);
  verified outcomes (FR-187); server-to-client requests (FR-188).
- Model-based auto-review, fail-closed (FR-085), used by the Auto permission mode.
- Hook-free app Git operations (FR-211); thread status model (FR-215); dictation (FR-216);
  document outputs (FR-219); deep research run (FR-220).

**Exit criteria**
- A Work run plans, executes ≥3 tool calls with one approval, and produces an artifact.
- A Code session edits 2+ files, shows a reviewable diff, runs tests, and commits.
- Scheduled task fires (simulated clock) and delivers per configuration.
- Full Activity trace for both, replayable.
- A run that reaches its budget pauses with a summary; an auto-review timeout ends as deny
  (tested).

**Demo:** evening: "fix the failing test and open a PR"; review the diff and CI.

---

## M6 — Agents, Computers & Channels

**Goal:** Always-on agents that work beyond a single session.

**Deliverables**
- Agent model + creation/onboarding + responsibilities (FR-079).
- Computer abstraction: local sandbox (bwrap), local container, cloud stub (FR-080/081/107).
- Browser controller + computer use + takeover + sign-in flow + appshots (FR-092…098,
  FR-086/087).
- Proactive research (read-only) + background threads (FR-082/083).
- Custom rules (FR-084); Activity + stop/pause (FR-090).
- Event triggers (FR-056); channels: Slack + Teams + webhook (FR-088); notification routing
  (FR-060); Agent memory (FR-089).
- Spaces/Pages + Sites (FR-036/037); visualizations (FR-076).
- Egress control (FR-102) + injection defense (FR-103).
- Pets + theming polish (FR-012).
- Egress proxy modes and credential injection (FR-193); external-agent rule (FR-194);
  micro-VM substrate behind a flag (FR-195); MCP event subscriptions (FR-201).
- Agent self-scheduling (FR-206); computer-use control tiers (FR-207); page-registered tools
  (FR-208, P2); local browser fallback (FR-209); `novad` device operations with staged writes
  (FR-210).

**Exit criteria**
- Create a Agent on the mock cloud computer; it performs read-only proactive research.
- Connect Slack (mock server); message the Agent; a rule forces an approval; answering from
  Slack proceeds; context shared.
- Browser tool navigates a local test site, screenshots, and is blocked from an unlisted host.
- Injection payload in page content does not cause an unapproved action (security test).

**Demo:** Agent books a meeting flow on a mock calendar, asking for approval to send.

---

## M6.5 — Networking, Transports & Add Device

**Goal:** reach the Hub from anywhere, and add devices safely and automatically.

**Deliverables**
- **Add a Device** flow: QR/short code, role + scope selection, required Hub approval
  (FR-132); per-device bootstrap (PWA / native / headless).
- Hub serves **signed** `novad` builds + one-line bootstrap command (FR-133).
- **Transport abstraction**: LAN/mDNS, Mesh (Headscale/Tailscale/NetBird/WireGuard),
  Relay client, ordered fallback with health checks (FR-135).
- **Trust paths**: Hub local CA, Mesh certificates, native-shell pinning (FR-134).
- **Network Setup assistant** + diagnostics + one-click rollback (FR-136, FR-139).
- **Wake Helper** role for WoL (FR-138).
- **Device management UI**: devices, capabilities, health, scopes, wake, revoke (FR-140).

**Exit criteria**
- Add a headless node via the one-line command; it registers and reports capabilities.
- Add a phone via QR; Hub approval is required; the PWA install path works.
- LAN → Mesh → Relay fallback is demonstrated and logged.
- Network setup installs/configures a mesh (Headscale or NetBird, or a mock) with a
  reachability test and rollback; a failing path is never advertised.

**Demo:** add a device; disable the LAN; watch the Relay path take over.

---

## M7 — Cloud, Sync, Multi-Device & Mobile

**Goal:** Continuity across devices and environments.

**Deliverables**
- Cloud runner integration + environment management (FR-108/071) via a local mock runner
  first, then a real one behind a flag.
- E2E-encrypted sync: keys, device linking, per-field merge, merge log (FR-109).
- Offline queue + retry (FR-112); tray/quick chat/multi-window (FR-008/009).
- Channel bridges beyond Slack/Teams: Telegram/email (FR-110); mobile relay + push + deep
  links (FR-111/077); specialist/team agents (FR-091).
- Session handoff between devices (FR-213); attach window (FR-214); best-of-N attempts
  (FR-212); shared threads (FR-217); voice-call channel (FR-218).
- Behind flags: scripted tool calls (FR-202) and external agent adapters (FR-203).

**Exit criteria**
- Two profiles sync; an edit on one appears on the other; a forced conflict is logged and
  recoverable.
- Cloud Code run executes on the mock runner while the laptop profile is "offline".
- Offline edits queue and flush on reconnect with correct ordering.

**Demo:** start a task on the "phone" relay, approve it from the desktop.

---

## M7.5 — Device Management: Boot, Power & Firmware

**Goal:** manage the hardware lifecycle of devices safely, off by default.

**Deliverables**
- **Low-level boot** (PXE/iPXE, bootloader entries) opt-in, with a watchdog that reverts a
  failed boot (FR-143).
- **BIOS/firmware management**: allowlisted settings, dry-run diff, snapshot, explicit
  approval, rollback, audit; global toggle **off by default**, never proactive (FR-146).
- **Out-of-band management** (IPMI/Redfish/Intel AMT/vPro), off by default, admin-only
  (FR-147).
- Hardware support matrix + clear refusals for unsupported devices.

**Exit criteria**
- On a supported mock device: BIOS changes are impossible until the global toggle is enabled;
  once enabled, each change requires approval, produces a diff and snapshot, and can roll back;
  an audit entry is written.
- A failing boot profile is reverted automatically by the watchdog.
- The out-of-band module is disabled by default; enabling it requires explicit admin consent.

**Demo:** enable WoL and power-on-after-power-loss on a test device with approval and rollback.

---

## M8 — Extensibility, Enterprise & Data Controls

**Goal:** Customization, governance, and accessibility maturity.

**Deliverables**
- Extension SDK + `nova dev/validate/pack` + docs + template (FR-117).
- Marketplace with signatures + permission diffs (FR-049 complete).
- Managed policy file + precedence UI (FR-106); data export/delete + retention (FR-105);
  spend caps (FR-116); crash reporting opt-in (FR-121).
- i18n + RTL (FR-016); full accessibility audit + fixes (FR-015 mature).
- Third-party app authorization (FR-222); opt-in OTLP export (FR-223).

**Exit criteria**
- A sample extension adds a command, a panel, and a tool; permissions enforced.
- Managed policy locks bypass mode and network; UI shows "managed".
- Export → delete → import round-trips without data loss (verified).

**Demo:** switch to a right-to-left locale; install a third-party theme + plugin.

---

## M9 — Hardening, Performance & Security

**Goal:** Meet all budgets and prove safety.

**Deliverables**
- Performance work to meet `AGENTS.md` §9 budgets across modes (FR-122).
- Full security suite incl. fuzzing + sandbox escape attempts (FR-123) and persistence safety
  evals (FR-224).
- Test suite completion across all FRs; flakiness eliminated.
- Accessibility, i18n, and error-state polish; empty/degraded states everywhere.

**Exit criteria**
- All performance budgets met on reference hardware with CI enforcement.
- Security suite green; every denial audited.
- Coverage floors met; no open P0/P1 bugs; full E2E green on Linux.

**Demo:** performance dashboard before/after; security test run.

---

## M10 — Packaging & Release

**Goal:** Ship signed installers with updates and docs.

**Deliverables**
- electron-builder configs for Linux/macOS/Windows; signing/notarization; SBOM (docs/15).
- Auto-update with channels, staged rollout, pre-update backup, rollback (FR-120).
- In-app help, docs site bundle, `CHANGELOG.md`, `RELEASE_NOTES.md`, user guide, tutorials.
- Release checklist executed; tagged release.
- Install robustness: explicit data directories, port-conflict diagnostics, documented download
  verification (FR-225).

**Exit criteria**
- Install → update → rollback works on all three OSes (tested where CI permits).
- Installers signed; checksums + SBOM published; update manifest signed.
- `docs/18` release checklist fully checked.

**Demo:** install the released build, run the first-run flow, update to the next beta.

---

## Milestone dependency graph

```
M0 ─▶ M1 ─▶ M2 ─▶ M3 ─▶ M4 ─▶ M5 ─▶ M6 ─▶ M6.5 ─▶ M7 ─▶ M7.5 ─▶ M8 ─▶ M9 ─▶ M10
                         └──────────────▶ (M5 Code depends on M3 tools/policy)
                                        (M6 Agents depends on M5 runtime + M3 policy)
                                        (M6.5 networking depends on M6 novad + M2 nodes)
                                        (M7.5 firmware depends on M6.5 device mgmt)
```

All milestones are serial at the dependency level; within a milestone, tasks may proceed in
parallel when they touch different packages.

## Requirement → milestone index

| Milestone | Requirements |
| --- | --- |
| M1 | FR-001, FR-002, FR-003, FR-004, FR-010, FR-014, FR-015, FR-017, FR-018 |
| M2 | FR-007, FR-019, FR-020, FR-021, FR-023, FR-024, FR-025, FR-026, FR-027, FR-032, FR-033, FR-034, FR-040, FR-221 |
| M3 | FR-013, FR-022, FR-029, FR-038, FR-042, FR-043, FR-048, FR-099, FR-100, FR-101, FR-118, FR-189, FR-190, FR-191, FR-192, FR-196, FR-204, FR-205 |
| M4 | FR-005, FR-006, FR-011, FR-028, FR-035, FR-039, FR-041, FR-044, FR-045, FR-046, FR-047, FR-113, FR-114, FR-115, FR-197, FR-198, FR-199, FR-200 |
| M5 | FR-030, FR-031, FR-050, FR-051, FR-052, FR-053, FR-054, FR-055, FR-057, FR-058, FR-061, FR-063, FR-064, FR-065, FR-066, FR-074, FR-085, FR-104, FR-119, FR-181, FR-182, FR-183, FR-184, FR-185, FR-186, FR-187, FR-188, FR-211, FR-215, FR-216, FR-219, FR-220 |
| M6 | FR-012, FR-036, FR-037, FR-056, FR-059, FR-060, FR-062, FR-067, FR-068, FR-069, FR-070, FR-072, FR-073, FR-075, FR-076, FR-078, FR-079, FR-080, FR-081, FR-082, FR-083, FR-084, FR-086, FR-087, FR-088, FR-089, FR-090, FR-092, FR-093, FR-094, FR-095, FR-096, FR-097, FR-098, FR-102, FR-103, FR-107, FR-193, FR-194, FR-195, FR-201, FR-206, FR-207, FR-208, FR-209, FR-210 |
| M7 | FR-008, FR-009, FR-071, FR-077, FR-091, FR-108, FR-109, FR-110, FR-111, FR-112, FR-202, FR-203, FR-212, FR-213, FR-214, FR-217, FR-218 |
| M8 | FR-016, FR-049, FR-105, FR-106, FR-116, FR-117, FR-121, FR-222, FR-223 |
| M9 | FR-122, FR-123, FR-224 |
| M10 | FR-120, FR-225 |

### Hub, devices & networking (added)

| Milestone | Requirements |
| --- | --- |
| M0 | FR-124 |
| M1 | FR-125 |
| M2 | FR-126, FR-127 |
| M3 | FR-149 |
| M5 | FR-131 |
| M6 | FR-141, FR-142, FR-144, FR-145, FR-148, FR-150 |
| M6.5 | FR-132, FR-133, FR-134, FR-135, FR-136, FR-138, FR-139, FR-140 |
| M7 | FR-128, FR-129, FR-137 |
| M7.5 | FR-143, FR-146, FR-147 |
| post-v1 | FR-130 |
| N1 (Ambient Memory) | FR-151, FR-152, FR-153, FR-154, FR-155, FR-156, FR-227, FR-228, FR-229, FR-230, FR-231, FR-232, FR-233 |
| N2 (Automations & Smart Home) | FR-157, FR-158, FR-159, FR-160, FR-161, FR-162, FR-163, FR-164, FR-176, FR-179, FR-180 |
| N3 (Extensions & Community) | FR-165, FR-166, FR-167, FR-168, FR-177 |
| N4 (Learning & Self-Improvement) | FR-169, FR-170, FR-171, FR-172, FR-173, FR-174, FR-175, FR-178, FR-226 |

---

## Post-core capability tracks (N1–N4)

These tracks are in scope but scheduled after the core Hub/agent/coding platform is stable.
They may run in parallel once their dependencies are met. Each track gets its own milestone
gate and acceptance demo.

### N1 — Ambient Memory (`docs/24`)

**Depends on:** M6 (`novad`, computer use), M3 (policy). Reconciled against the external
ambient-capture findings (`docs/external/RECONCILIATION.md`, ADR-073, ADR-074).

**Deliverables (in phase order, `docs/24` §11):** phase 1 recall: event-driven, text-first
capture of the focused window (FR-151, FR-152), the capture split between device helper,
`novad` and Hub (FR-228), the redaction release gate (FR-227), privacy controls (FR-154),
timeline and search (FR-153), the activity summary (FR-229), scoped tools with coverage
(FR-155), provenance checks (FR-232), scoped grants for automations (FR-233) and the resource
governor (FR-156). Phase 2 meetings: audio capture, meeting detection (FR-230) and speaker
identity (FR-231).

**Exit criteria:** capture off by default; enabling shows a persistent indicator; nothing is
readable until certified by redaction; a query returns screen matches with the time covered
and any gaps; exclusions and "forget last N minutes" work; a capture containing an injection
payload never triggers an action; a reply claiming screen activity without an ambient tool call
is flagged.

### N2 — Automations & Smart Home (`docs/25`)

**Depends on:** M5 (agent runtime), M6.5 (networking), M3 (policy).

**Deliverables:** versioned trigger→condition→action engine; time/event/device/ambient/
location/manual triggers; smart-home/agent/tool/messaging/script/webhook actions; dry-run,
logs, rollback; Home Assistant + MQTT + one vendor connector; normalized entity model;
agent↔automation interop; managed-policy controls.

**Exit criteria:** a scheduled automation runs an agent and controls a (mock) smart-home
entity; a physical-world action requires approval; a dry-run produces no side effects; a
failed action rolls back where compensation exists.

### N3 — Extensions & Community (`docs/26`)

**Depends on:** M8 (extension SDK, marketplace). Expands M8 rather than replacing it.

**Deliverables:** unified catalog for all extension types; MCP registry import; signed publish
with permission diffs; governance (review, scanning, report/takedown, managed allow/deny, kill
switch).

**Exit criteria:** install a signed community MCP server and plugin; an added permission on
update forces re-confirmation; an unsigned/sideloaded entry warns; the fleet kill switch
disables an extension.

### N4 — Learning & Self-Improvement (`docs/27`)

**Depends on:** M9 (hardening, eval harness), M5/M6 (agent runtime), M3 (policy). Runs last.

**Deliverables:** L0 memory learning; L1 skill synthesis; L2 evaluated optimization; L3
bounded self-tuning; L4 gated/tested/staged/approved code self-modification; L5 optional local
fine-tuning; evaluation harness with regression gates; transparency view and kill switch;
skill proposals from a recorded demonstration (FR-226).

**Exit criteria:** memory learning is reviewable/reversible; a proposed skill requires
approval; an optimization is backed by eval evidence and can be rolled back; an attempt to
modify the policy engine is denied and logged high-severity; the kill switch halts all
self-improvement activity.
