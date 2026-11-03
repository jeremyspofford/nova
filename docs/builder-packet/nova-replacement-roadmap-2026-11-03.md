# Nova — the goal, stated (owner direction, 2026-11-03)

## The goal
Nova becomes the one personal AI its owner actually lives in —
replacing, job by job and on a published roadmap, the assistant
and agent products the owner would otherwise rent: OpenClaw,
Hermes, ChatGPT / Codex / Dots, Claude / Cowork / Claude Code /
Duet, Grok / Grokbot, Gemini, Siri, and Muse. Replacement is
earned per job (see matrix), never claimed wholesale. Nova is
not "another AI harness": two capabilities no incumbent ships
are its reason to exist, and every roadmap phase must move at
least one of them.

## Flagship 1 — REPLAY ("a personal time machine, with receipts")
Because Nova holds capture, provenance-grade memory, decision
traces, and checkpoints, questions like "what did I know on
Tuesday?" and "why did we decide X?" are queries, not
archaeology. A replay answer cites its evidence: the capture
frames, memory items, decision trace (candidates, Jev
probability, approval tier), and the checkpoint state.
Depends on: graph addendum G2 (prospective decision traces),
capture completeness, checkpoints. The proof/receipts property
falls out of the same machinery: every Nova action already
leaves an owner-held, citable trace.

## Flagship 2 — COMPOUNDS ("a year in, measurably yours")
Nova distills its owner's repeated routines into its own
skills — gated: multi-trace evidence → reviewable diff → paired
with/without eval → owner approval → never auto-promoted
(graph addendum G5). The improvement is personal and local: it
never trains anyone else's model, and it is measurable (eval
deltas ship with every promoted skill). Depends on: traces
(G2), the Skills page + drafts inbox (Insertion #2 R4/R5),
eval harness.

## The supporting differentiators (already in the design)
- Survives its models: identity, memory, and tasks persist
  across interchangeable providers (Architecture A1); a vendor
  outage or quota is a routing event, not Nova's outage.
- A body that degrades gracefully: mesh devices as limbs;
  offline tiers below.

## Replacement matrix (job-by-job; order is the roadmap)
| Incumbent | The job it holds for the owner today | Nova's path | Phase |
|---|---|---|---|
| Siri | Hands-busy voice, home control | Voice chat + M11 Home; phone as spoke | 1 |
| ChatGPT / Dots, Gemini (chat), Muse | Default daily chat + questions | Chat on core providers + A1 plurality; morning board habit | 1 |
| Claude Cowork routines | Standup/timecard automation | Triggers + capture-derived drafts (morning loop) | 1–2 |
| Claude Code / Codex | Deep coding sessions | Core providers already drive both; Relay adapter (M8) dispatches workers | 2 |
| ChatGPT/Codex as builder-of-Nova | Building Nova itself | Nova Computer + coding track; self-build within policy | 2–3 |
| OpenClaw / Hermes | Agent-harness experiments | Nova itself; import path for their skills/configs is a scout item (R5) | 2 |
| Grok / Grokbot | Live X/social data | Social connectors first (R6); data licensing is the constraint, not engineering | 3 |
A job counts as replaced when the owner has used Nova for it
for 30 consecutive days without reaching for the incumbent.

## Mobile track (owner request, 2026-11-03)
PWA first (settled): the installed PWA is the mobile app for
monitoring devices, chat, and approvals. Native later, for the
things PWAs structurally cannot do (background work, on-device
models, OS intents).
- Notifications: the design explained 2026-10-31 is now an
  approved input: ONE Notification Service, Web Push (VAPID on
  hub, per-device subscriptions at pairing, encrypted payloads),
  iOS rule (Home-Screen-installed PWA, permission from a tap),
  quiet hours + Decision Service "worth interrupting?" gate,
  delivery receipts in the ledger, local-only mode = remote
  push OFF and the UI says so. Write-up joins the packet as
  its own input; build slots with the wiring workstream.
- Device monitoring: Health + Topology exist; the mobile
  deliverable is a glanceable monitor view (orb state, device
  list, problems) sized for the Duo's outer screen.

## Offline / emergency mode (owner request, 2026-11-03)
Nova must keep working when the network doesn't. Three tiers,
honestly labelled in the UI by which tier is active:
- L1 — Cloud down, home fine: hub routes to local models
  (Ollama/Tev1 seats). Mostly a routing + labelling job on A1.
- L2 — Internet down, LAN up: full Nova on the home network;
  capture, memory, smart home, chat-with-local-models; cloud
  actions queue and reconcile on reconnect.
- L3 — Phone alone, no network: the emergency subset. A small
  on-device LLM (native-app era; a PWA cannot carry this on
  iOS), the last synced memory snapshot (with a visible
  freshness stamp), local notifications, voice-note capture
  queued for ingest, and critical device facts cached. L3
  never pretends to be full Nova: the orb shows the offline
  state and the UI names what's unavailable.
Pre-positioning is the feature: models downloaded and snapshot
sync verified while things are calm, tested by a drill (pull
the WAN, run the checklist) — same standard as the restore
drill in the launch criteria.

## Sequencing against the live queue
Nothing here jumps the current queue (M10j/k, Insertion #3,
wiring, Design Stage 2). This roadmap governs what comes
after: Architecture track (A1/A2 + graph G1–G6) builds the
flagships' foundations → Replay v1 (time/decision queries over
traces + capture) → Compounds v1 (gated distillation pipeline)
→ Mobile/offline track (notifications build, monitor view,
L1/L2, then L3 with native) → replacement phases declared per
the matrix as each job's 30-day test passes.
