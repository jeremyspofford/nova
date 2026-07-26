# Implementation plans

Specs authored with Fable (2026-07-15 onward), written to be executed by
any model (Sonnet/Opus), one phase per session. ROADMAP.md stays the priority list;
these are the how.

How to run one: give the implementing session the plan file + CLAUDE.md,
ask for ONE phase, and hold it to the plan's verification line (real flow
through :5173 — and :8080 where the plan says so). Leave changes
uncommitted, summarize for review. If the implementer hits a conflict
with the codebase, the plan is wrong until proven otherwise — stop and
flag, don't improvise around it.

In roadmap priority order:

| Plan | Roadmap item | Prereqs / notes |
|---|---|---|
| [voice.md](voice.md) | #1 | phase 1 + 1b SHIPPED 2026-07-15; phases 2–4 (STT) remain |
| [observability-turn-tracing.md](observability-turn-tracing.md) | #3 | none; 3 flagged decisions inside, defaults chosen — SHIPPED (turn ledger complete) |
| [observability-board.md](observability-board.md) | #30 | **COMPLETE — all 3 phases: P1 shipped (f00209c), P2 history+fleet shipped (e15bba6), P3 alerts BUILT+verified 2026-07-23 uncommitted** (real leader election underneath); loose ends: cost price map, per-host label field |
| [model-curation-proposals.md](model-curation-proposals.md) | #5 | reuses gateway-lane discovery fetcher |
| [named-inference-endpoints.md](named-inference-endpoints.md) | #6 | resolve pool-table convergence question in phase 1 |
| [content-ingestion.md](content-ingestion.md) (was video-ingestion.md, reconciled 2026-07-21) | #8 | phase 1 (media ingestion: `media` worker, dedicated `ingestion` model-recs role) BUILT 2026-07-21, uncommitted, awaiting Jeremy's review |
| [persona-layer.md](persona-layer.md) | #15 | phase 1 (runner slot assembly) is standalone; locked decisions inside — Nova-as-proxy, specialists get house rules, not the soul |
| [mcp-client.md](mcp-client.md) | #19 | HTTP transport first (pip `mcp` SDK); stdio via sidecar last; mines v0.5.0-alpha lazy-loading + consent designs; #18 research must weigh it |
| [capability-and-containment.md](capability-and-containment.md) | — | **read before either coding plan.** Nova's execution capability is already built and empty; the provenance rail is the floor both stand on |
| [acp-coding-delegation.md](acp-coding-delegation.md) | #20 | phase 0 is a validation spike — ACP landscape moves fast; build after #3 (observability). NOTE: the mounted-worktree containment at :53-58 does not hold — see capability-and-containment.md |
| [remote-shared-state.md](remote-shared-state.md) | parked/designed | **phase 1 (leader election) BUILT+verified 2026-07-23, uncommitted** (pg advisory lock, 24s failover measured, split-state startup guard); phases 2–3 (memory watcher, local-db profile + docs) remain |
| [universe-view.md](universe-view.md) | phases 1–4 BUILT 2026-07-16 + interaction round 2026-07-17 (right-drag pan, click-focus/highlight, crisp label overlay, delete→black-hole, legend, Atlas explorer), live-verified at :5173 + :8080; awaiting Jeremy's review + Galaxy-retirement call | 3D celestial brain view built alongside Galaxy; replaces Galaxy when Jeremy signs off |
| [guarded-actions-consent.md](guarded-actions-consent.md) | #29 (CRITICAL) — phase 1 BUILT 2026-07-20, uncommitted, awaiting Jeremy's review | Approve/Deny card + single-use consents validated at the tool layer; all seams verified (one caveat in the plan: organic main→guardian relay needs a re-probe in a cleaner conversation) |
| [avatar-view.md](avatar-view.md) | #2 (entity view) — SHELVED 2026-07-19 after Jeremy reviewed the animation preview | phase 0 assets + pipeline DONE and preserved; the motion layer failed review (blink occlusion, mouth flicker — critique + resume notes at the top of the plan); do not build phase 1+ without a motion prototype Jeremy approves |
| [speaker-id.md](speaker-id.md) | discussion backlog (raised 2026-07-23) | Nova knows who's talking: sherpa-onnx voiceprints in the whisper service, `user_profiles` (operator/kid/guest), persona + mechanical tool clamp per speaker, unknown→ask; LOCKED: personalization never authentication; **plan approved 2026-07-23, not built** |
| [web-push.md](web-push.md) | follow-on to #21 | **BUILT 2026-07-23, uncommitted** — native Web Push to the installed PWA (webpush provider, mig 048, push-sw.js via importScripts, per-device card in Settings); triggers: notify traffic + recommendations + long-reply-finished; awaiting Jeremy's on-phone subscribe + test |
| [ui-shell-refactor.md](ui-shell-refactor.md) | UI/UX review 2026-07-22; resolves #4 (mobile routes) | collapsible utility rail over the full-bleed canvas (routed panels + mobile bottom tabs; v1 = inspiration only, NO "Brain" destination — the canvas is the app), Settings/Library split, pop-in fix, phone-path nginx fix; **COMPLETE — all phases built, verified, phone pass accepted 2026-07-22; uncommitted**; follow-on (native app) in ROADMAP discussion backlog |
| [notifications-reachability.md](notifications-reachability.md) | #21 | SHIPPED 2026-07-22 (modular provider registry: ntfy + webhook); [web-push.md](web-push.md) extends it |
| [recommendation-surface.md](recommendation-surface.md) | discussion-backlog keystone | phases 1–2 SHIPPED (store/tool/banner + inbox/bell); phase 3 (actionable-approve via consent rails) remains |
| [device-activity-monitoring.md](device-activity-monitoring.md) | Later | designed, not built; ActivityWatch/computer-usage — NOT smart home (that's [home-assistant.md](home-assistant.md)) |
| [model-eval-pipeline.md](model-eval-pipeline.md) | gate for turn-speed phase 3 + #36 stage 2 | DECISIONS LOCKED 2026-07-24; standing answer to "can we swap agent X to model Y?"; challengers include same-model-different-prompt (2026-07-24 extension) |
| [turn-speed.md](turn-speed.md) | latency lane (measured 2026-07-24) | **ALL 6 PHASES SHIPPED 2026-07-24** — parallel read-only tools + cancellation, overflow protection, local-tier rails (quality gate FAILED: specialists stay on cloud), concurrent sibling dispatches, specialist text streaming. runner.py is unfrozen |
| [data-backups.md](data-backups.md) | **#31 (Wave 1 — build first)** | blast-radius insurance before Nova acts anywhere; restore-drill phase 5 added 2026-07-24 |
| [secrets-management.md](secrets-management.md) | **#32 (Wave 1)** | LOCKED 2026-07-24: built-in encrypted store first; phase 1 unblocks #33 T4 + #35 |
| [coding-team-pipeline.md](coding-team-pipeline.md) | **#33 (Waves 3–4)** | team layer on #20 — roles as pipeline stages; build after [acp-coding-delegation.md](acp-coding-delegation.md) phases 0–3 |
| [ideation-goals.md](ideation-goals.md) | **#34** | ideator half Wave 1 (zero hot files); goals table + Library tab Wave 3 |
| [home-assistant.md](home-assistant.md) | **#35 (Wave 2)** | after #32 phase 1; LOCKED: compose profile `home` now (IP devices), HAOS box later for radios |
| [self-improvement.md](self-improvement.md) | **#36 (Waves 3–5)** | umbrella: measure → tune → self-code → goal autonomy; containment invariants LOCKED; stage 4 activation checklist inside |

Not planned here (deliberately):
- ~~**Mobile PWA routes (#4)** — roadmap says design WITH Jeremy after real
  on-device usage; a spec written before that usage would be fiction.~~ —
  that usage happened (Jeremy's 2026-07-22 phone review);
  [ui-shell-refactor.md](ui-shell-refactor.md) now covers #4.
- **Chat activity in brain views (#7)** — already designed in ROADMAP.md
  (the `setActivity` contract); it's buildable from there. Note: voice.md
  phase 1 creates the audio-level hook it will consume.
- ~~**Entity view** — paused mid-iteration at mockup v11~~ — resumed as
  [avatar-view.md](avatar-view.md) 2026-07-19; v1–v11 mockups remain in
  `frontend/public/mockups/` as prior art.
