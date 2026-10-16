# 17 — Roadmap & Milestones

The build proceeds strictly in order. A milestone is complete only when **all exit criteria**
and the milestone's acceptance checks in `docs/18` pass. Dependencies are noted; parallel work
within a milestone is encouraged (each task in its own commit).

Each milestone lists: **goal · deliverables · FR coverage · exit criteria · demo**.

---

## M0 — Foundation & Scaffolding

**Goal:** A monitored, tested monorepo that boots an empty but real app shell.

**Deliverables**
- npm-workspace monorepo per `docs/05` with Turborepo, strict TypeScript, ESLint, Prettier.
- `apps/desktop` Electron main + preload + renderer (React/Vite) that opens a window.
- `packages/shared` (zod schemas, event bus, errors), `packages/storage` (Drizzle + SQLite
  migration runner), `packages/ui` (design tokens + 5 primitives), `packages/policy`
  (skeleton), `packages/providers` (interface + MockProvider).
- `contracts/` implemented as typed schemas with a contract test harness.
- CI pipelines from `docs/16` §9 (lint, typecheck, unit, build) on Linux.
- `LEDGER.md` with the full task breakdown; ADR directory; `THIRD_PARTY_NOTICES` generator.
- Structured logging + redaction skeleton; settings table + precedence resolver.

**FR coverage:** none user-facing; enables all.
**Exit criteria**
- `npm run lint && npm run typecheck && npm test && npm run build` green.
- App launches to an empty shell with a themeable background; E2E smoke test passes.
- DB migrations run and roll back; contract tests pass.

**Demo:** launch the app; command palette opens (no commands yet); theme toggles.

---

## M1 — Chat MVP + Shell

**Goal:** A working single-provider chat with the core shell.

**Deliverables**
- Sidebar + mode tabs (Chat/Work/Code/Dots placeholders) + command palette + shortcut
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
- Unison-as-MCP-server with consent (FR-044).

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

**Exit criteria**
- A Work run plans, executes ≥3 tool calls with one approval, and produces an artifact.
- A Code session edits 2+ files, shows a reviewable diff, runs tests, and commits.
- Scheduled task fires (simulated clock) and delivers per configuration.
- Full Activity trace for both, replayable.

**Demo:** evening: "fix the failing test and open a PR"; review the diff and CI.

---

## M6 — Dots, Computers & Channels

**Goal:** Always-on agents that work beyond a single session.

**Deliverables**
- Dot model + creation/onboarding + responsibilities (FR-079).
- Computer abstraction: local sandbox (bwrap), local container, cloud stub (FR-080/081/107).
- Browser controller + computer use + takeover + sign-in flow + appshots (FR-092…098,
  FR-086/087).
- Proactive research (read-only) + background threads (FR-082/083).
- Custom rules + auto-review (FR-084/085); Activity + stop/pause (FR-090).
- Event triggers (FR-056); channels: Slack + Teams + webhook (FR-088); notification routing
  (FR-060); Dot memory (FR-089).
- Spaces/Pages + Sites (FR-036/037); visualizations (FR-076).
- Egress control (FR-102) + injection defense (FR-103).
- Pets + theming polish (FR-012).

**Exit criteria**
- Create a Dot on the mock cloud computer; it performs read-only proactive research.
- Connect Slack (mock server); message the Dot; a rule forces an approval; answering from
  Slack proceeds; context shared.
- Browser tool navigates a local test site, screenshots, and is blocked from an unlisted host.
- Injection payload in page content does not cause an unapproved action (security test).

**Demo:** Dot books a meeting flow on a mock calendar, asking for approval to send.

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

**Exit criteria**
- Two profiles sync; an edit on one appears on the other; a forced conflict is logged and
  recoverable.
- Cloud Code run executes on the mock runner while the laptop profile is "offline".
- Offline edits queue and flush on reconnect with correct ordering.

**Demo:** start a task on the "phone" relay, approve it from the desktop.

---

## M8 — Extensibility, Enterprise & Data Controls

**Goal:** Customization, governance, and accessibility maturity.

**Deliverables**
- Extension SDK + `unison dev/validate/pack` + docs + template (FR-117).
- Marketplace with signatures + permission diffs (FR-049 complete).
- Managed policy file + precedence UI (FR-106); data export/delete + retention (FR-105);
  spend caps (FR-116); crash reporting opt-in (FR-121).
- i18n + RTL (FR-016); full accessibility audit + fixes (FR-015 mature).

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
- Full security suite incl. fuzzing + sandbox escape attempts (FR-123).
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

**Exit criteria**
- Install → update → rollback works on all three OSes (tested where CI permits).
- Installers signed; checksums + SBOM published; update manifest signed.
- `docs/18` release checklist fully checked.

**Demo:** install the released build, run the first-run flow, update to the next beta.

---

## Milestone dependency graph

```
M0 ─▶ M1 ─▶ M2 ─▶ M3 ─▶ M4 ─▶ M5 ─▶ M6 ─▶ M7 ─▶ M8 ─▶ M9 ─▶ M10
                         └──────────────▶ (M5 Code depends on M3 tools/policy)
                                        (M6 Dots depends on M5 runtime + M3 policy)
```

All milestones are serial at the dependency level; within a milestone, tasks may proceed in
parallel when they touch different packages.

## Requirement → milestone index

| Milestone | Requirements |
| --- | --- |
| M1 | FR-001, FR-002, FR-003, FR-004, FR-010, FR-014, FR-015, FR-017, FR-018 |
| M2 | FR-007, FR-019, FR-020, FR-021, FR-023, FR-024, FR-025, FR-026, FR-027, FR-032, FR-033, FR-034, FR-040 |
| M3 | FR-013, FR-022, FR-029, FR-038, FR-042, FR-043, FR-048, FR-099, FR-100, FR-101, FR-118 |
| M4 | FR-005, FR-006, FR-011, FR-028, FR-035, FR-039, FR-041, FR-044, FR-045, FR-046, FR-047, FR-113, FR-114, FR-115 |
| M5 | FR-030, FR-031, FR-050, FR-051, FR-052, FR-053, FR-054, FR-055, FR-057, FR-058, FR-061, FR-063, FR-064, FR-065, FR-066, FR-074, FR-104, FR-119 |
| M6 | FR-012, FR-036, FR-037, FR-056, FR-059, FR-060, FR-062, FR-067, FR-068, FR-069, FR-070, FR-072, FR-073, FR-075, FR-076, FR-078, FR-079, FR-080, FR-081, FR-082, FR-083, FR-084, FR-085, FR-086, FR-087, FR-088, FR-089, FR-090, FR-092, FR-093, FR-094, FR-095, FR-096, FR-097, FR-098, FR-102, FR-103, FR-107 |
| M7 | FR-008, FR-009, FR-071, FR-077, FR-091, FR-108, FR-109, FR-110, FR-111, FR-112 |
| M8 | FR-016, FR-049, FR-105, FR-106, FR-116, FR-117, FR-121 |
| M9 | FR-122, FR-123 |
| M10 | FR-120 |
