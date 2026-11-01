# ROADMAP AND GATES

Build in this order. A milestone is complete only when its gate passes with evidence (OPERATING-RULES). **Continue through milestones autonomously** — do not stop after each one to ask what to do next. Stop only at a gate failure you cannot resolve, a genuine packet conflict, or a Tier-3 decision reserved for the user.

## M0 — Baseline and inventory (no new features)
- Fresh clone of `origin/main`; verify Era 1/Era 2 state against CAPABILITY-INVENTORY; correct the inventory where code disagrees.
- Environment baseline: toolchain pinned (Mise), lint/typecheck/tests running in CI.
- **Do not touch** the user's uncommitted worktree (SYSTEM-MAP hazards).
- Gate: written inventory delta + green CI on the untouched tree.

## M1 — Core skeleton
- Modular monolith skeleton (ADR-1): config, logging/observability, health endpoint, extension host skeleton, SQLite + migrations (ADR-4), API surface (ADR-5).
- Identity/persona layer and charter config (NOVA-SPEC §2).
- Work Ledger v1 + task envelope (CONTRACTS §1) with one local worker end-to-end.
- Gate: fresh-user acceptance test #1 — blank profile, conversational setup, one task delegated and verified with evidence, all on local-only mode.

## M2 — Triggers, memory, triage
- Trigger engine: four classes, registry UI/API, dedup + cooldowns (NOVA-SPEC §4).
- Long-term memory v1 with provenance, correction, export (CONTRACTS §7); context receipts (CONTRACTS §2).
- Decision Model Provider interface + rules fallback; decision templates with cache-miss authoring (CONTRACTS §3); Jev adapter behind the interface.
- Gate: an event trigger and a heartbeat job each produce ledger tasks; a proactive message traces to its trigger record; local-only mode never calls a remote provider (verified by egress log).

## M3 — Design system and PWA
- Token pipeline + lint (no raw values in components), component library per DESIGN-SYSTEM, two starter packages (Orb Teal, Companion Light), hot swap with preview/rollback.
- PWA layouts: desktop/laptop, tablet, phone, foldable postures; orb component with state model (the fixed semantic set of DESIGN-SYSTEM §1, owner decision 2026-10-31: red stops, amber needs you; delivered in `docs/plans/orb-states.md`).
- Agent errors surface in the UI (fix the known defect class: nothing important lives only in logs).
- Gate: swap design system live with no restart; resize/posture sweep passes; blank-profile setup completable from the PWA alone.

## M4 — Device mesh
- Enrollment ceremony (CONTRACTS §5) with hub approval; device registry; hub role + standby promotion; encrypted sync; offline spokes queue and resync.
- Boot agent + runtime agent split (ADR-3) on at least one real device class.
- Gate: pair a phone (QR) and a computer (command) to a fresh hub; revoke one; kill the hub and promote the standby; no data loss, no orphaned trust.

## M5 — Agents and integrations
- Provider registry generalizing `agent_cmd`; adapters: Claude Code, one more coding agent (Codex), one chat-class provider; automation webhook adapter (n8n); Gmail connector; smart-home bridge connector (Home Assistant).
- Human takeover for browser/computer-use tasks.
- Gate: the same brief executed by two different providers through the envelope; evidence verified for both; takeover and hand-back mid-task.

## M6 — Capture and local models
- Capture API + Screenpipe ingest adapter; per-platform capture postures (CONTEXT-AND-CAPTURE).
- Local model manager: hardware detection, recommendation, download, serve via runtime adapters (Ollama first); GPU spoke wake-and-serve.
- Fallback chains exercised: local down → policy-allowed fallback; cloud down → local; local-only task during outage → queued with honest status, never silently rerouted.
- Gate: full day-in-the-life run in local-only mode on hub-class hardware.

## M7 — Self-modification and resilience hardening
- Governed change pipeline for extensions/config/design systems (ADR-9) with canary + auto-rollback; backup/restore drill; chaos pass (kill providers, hub, network) with repair playbooks.
- Gate: Nova ships a real change to itself through the pipeline; a sabotaged change is caught by gates and rolled back automatically.
- **Amendment (2026-10-30, owner, binding): checkpoints and factory reset**, folded into M7's resilience work. Not a new milestone.
  - **Checkpoints:** user-facing restore points of the whole data home (database, memory, config, identity).
    - Nova takes one automatically before governed self-changes and upgrades.
    - The person can take a named one from Settings.
    - Restoring rolls the hub back to it.
    - The list shows each checkpoint's date and size.
    - Old ones are pruned under a stated retention rule.
  - **Factory reset:** a Settings danger-zone action that returns Nova to first-run state.
    - It wipes the data home, the hub identity and keys, the paired-device roster and memory, then runs first-run setup.
    - It offers an export first.
    - It uses the same explicit confirmation as other destructive actions.
    - It says plainly what happens to existing backups. Expected: they are wiped too, after the export offer.

## UI fixes — Amendment 2026-10-30-C Part 1 (one PR, straight after M7)
Small, low-risk fixes; one PR. Spec: AMENDMENT-2026-10-30-C Part 1.
- **The orb shows once per view.** No per-message avatars or orbs in chat.
- **Chat:**
  - Nova's turn is full width and has no bubble.
  - The person's turn is a tinted bubble.
  - No bubble tails.
- **Timestamps:**
  - Date or gap dividers always.
  - A group shows its time on its first message. A group is the same author, less than 5 minutes apart.
  - The exact time of each message is shown on hover, on long-press, or in details.
  - Work-trail entries show how long they took and when they finished.
  - Timestamps meet 4.5:1 contrast.
- **Settings: one structure, two layouts.**
  - On a phone: a grouped list with search.
  - On wider screens: a sidebar, a detail pane, and search.
  - Grouped by the person's task, with at most one level of nesting.
  - Search knows synonyms, shows each result's path, and jumps to the setting and highlights it.
- **Appearance:**
  - Picking a theme applies it live to the real UI. The embedded preview mock is removed.
  - A theme for this device applies instantly, with a visible Undo. A theme for all devices needs an explicit Save.
  - The current scope is always shown.
  - A live WCAG check warns below 4.5:1 for body text and below 3:1 for components, and offers a one-tap fix.
  - One design is recommended, not six listed as equals.
- **Scrolling:**
  - One scroll container per view. Any inner scroller scrolls sideways only.
  - The OS scrollbar setting is respected. No thin custom bars.
  - `scrollbar-gutter: stable`.
- **Gate:** browser tests for each item, at phone and desktop widths and in every starter package, plus the fresh-user test.

## M8 — Relay adapter
- Relay stabilized standalone first (its own bounded pass: interface freeze, tests green, contracts documented).
- Nova↔Relay adapter over the task envelope.
- Gate: a coding task briefed from Nova is executed by Relay workers in worktrees and reported back with diff evidence.

## M9 — Feel & Polish (Amendment 2026-10-30-C Part 2)
The numbers below are evidence gates, not aspirations. Spec: AMENDMENT-2026-10-30-C Part 2. Evidence base: UX-RESEARCH-2026-10-30.
- **Core Web Vitals** at the 75th percentile, measured in CI on the main views at phone and desktop widths:
  - CLS ≤ 0.1, INP ≤ 200 ms, LCP ≤ 2.5 s.
  - A skeleton's shape matches the final layout exactly.
- **Progress rules:** DESIGN-SYSTEM §1, applied to every waiting state and checked by tests.
- **Animation tokens:**
  - 150–300 ms, animating only transform and opacity.
  - `prefers-reduced-motion` is honoured.
  - No bounce or elastic motion on frequent actions.
- **Contrast:**
  - Every theme in every state meets WCAG AA: 4.5:1 for body text, 3:1 for large text and components.
  - Hit areas are 44 pt / 48 dp.
- **Foldable and responsive tests, in this order:**
  1. State survives fold, unfold and resize: scroll position, drafts, settings edits.
  2. No stretched single column on wide screens: prose is capped at 45–75ch, and the extra width goes to a second pane.
  3. Nothing sits under the hinge.
  4. 200% text survives.
- **Gate:** all of the above pass in CI, with the measurements in the PR, plus the fresh-user test.

## Ingest security gate (Amendment 2026-10-30-C Part 3)
Built with M9, or as its own PR before M10. No Nova browser opens a real page until it is merged. Spec: AMENDMENT-2026-10-30-C Part 3.
- **Every external read goes through the ingest pipeline before any acting model sees it.** That covers web pages, email, files, OCR, transcripts, QR payloads, and tool or MCP output.
- **An isolated Noul screen:**
  - No tools, memory or secrets.
  - It returns probabilities only.
  - In local-only mode it uses a local model.
- **Thresholds:** below a low bar, content passes as data; in the middle, it is quarantined; above a high bar, it is blocked and recorded in the ledger.
- **Deterministic checks run in parallel.** For example, hidden text, encoded blobs, mismatched links, the SSRF guard, and email authentication.
- **Taint:** an action whose origin is external content never runs on its own.
- **Separation:** the reader has no tools beyond reading, and the actor sees only the screened extract.
- **Memory guard and outbound guard.**
- **Gate:** a regression set of known injection payloads, plus canary secrets, passes in CI.

## M10 — Execution Plane (Amendment 2026-10-30-C Part 4)
Nova gets its own sandboxed computer and browser. A design doc (ADR) comes first, then the build. It requires the ingest security gate. Spec: AMENDMENT-2026-10-30-C Part 4.
- **Nova Computer:**
  - Container or VM workspaces with a shell and toolchain, one per project.
  - Checkpointed sessions, and a reset to a clean state.
  - First target: the hub's WSL environment.
- **Nova Browser:**
  - Nova's own Chromium profile, driven through accessibility and the DOM first.
  - The person can watch, pause, stop or take over.
  - Logins come from the vault at the moment of use.
  - Every page passes the ingest gate.
  - Noul makes the small step-by-step calls, and DOM ground truth always outranks a probability.
  - Validated flows are kept as templates per site.
  - Checkout stops at the itemised total: paying is Tier 3.
- **Chat as the control plane** for coding (Relay workers in worktrees), infrastructure (a plan is shown before any apply, and apply is Tier 3), networking (Tier 3, with a snapshot, a diff and a dead-man's switch), and accounts (Tier 3; passwords never enter model context).
- **Approval tiers apply throughout,** and everything goes in the Work Ledger.
- **Gate:** set in the M10 design doc before the build starts; at least, the Part 4 tier rules are each proven by tests, plus the fresh-user test.
- **Service orchestration (owner input 2026-10-31, binding):** `INPUT-2026-10-31-SERVICE-ORCHESTRATION.md`. Designed in the addendum ADR `docs/plans/M10-orchestration.md`, whose open questions the owner decided the same day (`INPUT-2026-10-31-ORCHESTRATION-DECISIONS.md`); built after M10d as phases M10e–M10k. Nova stays fully functional with no Kubernetes anywhere. The promotion drill with two test devices is part of M10's gate evidence.

## QA harness — Amendment 2026-10-31-A
Spec: AMENDMENT-2026-10-31-A. A local harness with two modes: change-aware PR testing, and a sweep of the full application on disposable seeded instances, with nothing leaving this machine.
- **Stage 1:** a standalone prototype, outside this repo.
- **Stage 2:** the repo build. The owner approved the Stage 1 report on 2026-10-31. Stage 2 is the milestone after M10k on the critical path, which keeps Amendment B's rule that nothing displaces the M10e–M10k order. It is built with Amendment B Part 8's design from the start, and Part 7 follows it.
- **The change pipeline** consumes its results before any canary deploy.
- **Assertions come from the spec,** never from observed behaviour, and UX findings are always advisory.
- **Amendment 2026-10-31-B:** Parts 7 and 8 extend it.

## M11 — Home: Smart Home and cameras (owner input 2026-10-31)
Spec: `nova-smart-home-design-2026-10-31.md`, with the owner's same-day change on camera stream paths; designed in `docs/plans/smart-home.md`, with the owner's eight decisions recorded there.
- **Placement:** after QA Stage 2 and Amendment B Part 7. It displaces nothing in M10e–M10k or Stage 2.
- **S1:**
  - S1a: the device model and the Smart Home page over Home Assistant (areas and entities, cameras through its stream proxy), the Smart Home card, discovery and the connect card;
  - S1b: the Scrypted connector, camera-first, on the Credential Broker.
  - **Gate:** the ADR's stand-in list, plus the owner-assisted real Home Assistant and real Scrypted checks, flagged as the owner's step.
- **S2:** camera event classification through the Decision Service (after DS1), by class only; kept clips into the capture archive (after M10h's archive); scenes and automations; two-way talk.
- **S3:** direct local and vendor-cloud connectors, by demand. Vendor clouds are opt-in and never in local-only. Matter gets its own ADR.
- **Rules from the owner's decisions:**
  - a direct tap needs no approval at tiers 0–2, and one on-tile confirm at tier 3, while Nova-initiated commands follow the tier table;
  - no face recognition;
  - no cloud in local-only, Box included.

## Launch readiness — Amendment 2026-10-31-B (eight parts)
Spec: AMENDMENT-2026-10-31-B. Evidence base: LAUNCH-READINESS-RESEARCH-2026-10-31. No new milestone: nothing displaces in-flight work or the M10e–M10k order. Where each part lands:
1. **Tev1, the local decision provider, plus the injection eval:** a side PR, as soon as a slot is free. The eval is a real gate: if Tev1 misses the bounds, it stays advisory and the deterministic layer decides.
2. **First-session value:** folds into M10f onboarding (discovery, an import offer, a populated first view, a timed first win of under 15 minutes in the fresh-user test).
3. **A self-update channel for Nova itself:** design doc (ADR) first, when scheduled.
4. **The eval harness (golden tasks, capability and regression suites, a model-swap scorecard):** a side PR, when a slot is free. **Delivered 2026-10-31 (#249):** 28 tasks from failures on record. The regression suite runs at 100% with stand-ins in `npm test`, so a drop fails CI. The scorecard is written to `workers/evals/`, and Settings › Models shows it once its route and UI land. Part 5 (cost caps) follows.
5. **Hard caps on autonomy cost:** a small design and build. **Delivered 2026-10-31 (#256):** ceilings per task and per day, a loop detector, and resume as a new approval. Inert until wired (a Track 1 follow-up). Gate: `tests/acceptance/caps.test.ts`, plus the regression task `safety.runaway-loop-stopped`.
6. **A diagnostics bundle and an integrity scrub:** fold into Health work. **The bundle was built 2026-10-31 (#259).** It is redacted by construction and proven with canaries. Wiring it into Health, the integrity scrub and the disk-health signals are still open on Track 1.
7. **A fault matrix and a soak run:** extend the QA harness under Amendment 2026-10-31-A.
8. **QA Stage 2 integration with the Service Manager:** the recorded design, applied when Stage 2 is built, so the harness isn't built for the supervisor alone.
- **Closing rule:** no capability is claimed in onboarding, docs or the UI that the Part 4 eval suite can't demonstrate. **On for user-facing text, 2026-10-31** (owner decision; `docs/plans/honest-claims.md`): unproven claims softened, their eval cases named for Track 3, CI fails on an unbacked one.
- **Decision Service (owner input 2026-10-31, extends Part 1):** `nova-jev-decision-layer-2026-10-31.md`, designed in `docs/plans/decision-service.md`.
  - Built as side PRs:
    - DS1: the service (registry, seats, decision log, boundary test);
    - DS2: ingest and chat guardrails, model routing, the memory gate, retrieval scoring, trigger triage;
    - DS3: browser verification, with M10b.
  - Smart home, camera and knowledge-graph alignment come later. Nothing here displaces M10e–M10k.
  - Gate per template: a pre-registered eval passing on the exact model version, or the template ships advisory.
  - **DS1 built (PR #255):** the service, the seats, the decision log and the boundary test. Moving the gate onto it is Track 1's job.

## Nova Vault and the Credential Broker (owner input 2026-10-31)
Spec: `nova-vault-broker-design-2026-10-31.md`, with the owner's instruction and decisions. The design (ADR) is `docs/plans/vault-broker.md`. Each phase is ADR-gated, and nothing displaces in-flight work or the M10e–M10k order.
- **Phase 1:** the broker and Nova Vault. A side track after M10e, in three PRs, ahead of M10h's spoke credentials and M10j's cluster credentials.
  - **P1a under review (#275, 2026-11-01):** broker, Nova Vault, fixed verbs and IPC, plus owner findings A regression fixes. Core/supervisor consumer integration remains P1b; complete gate P1c. No merge is claimed: independent live review and the other model's findings are still required.
  - **Gate:** canary values found nowhere Nova writes; the broker refusing a non-bound origin even when core asks; an adversarial review.
- **Phase 2:** the 1Password connector behind the broker, after Phase 1's gate. A real account needs the owner's OK.
- **Phase 3:** optional Vaultwarden and further connectors, by demand. Never a default.

## Direction only (no work scheduled): second-model reviews through Relay
Relay, the owner's existing multi-agent dispatcher, already integrated with Nova at the adapter level (M8), is the intended vehicle for dispatching second-model reviews automatically, once that integration is deepened. The owner will schedule that work separately. Until then, review packets are handed over by the owner (OPERATING-RULES, "Second-model review").

## Sequencing rules
- Relay stabilization may run parallel to M1–M2 (it is independent), integration only at M8.
- Nothing in CAPABILITY-INVENTORY marked "Later" enters an earlier milestone without a packet amendment.
- Every milestone updates CAPABILITY-INVENTORY and the decision log in the repo.
