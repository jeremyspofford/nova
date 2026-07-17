# Implementation plans

Specs authored 2026-07-15 with Fable, written to be executed by any model
(Sonnet/Opus), one phase per session. ROADMAP.md stays the priority list;
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
| [observability-turn-tracing.md](observability-turn-tracing.md) | #3 | none; 3 flagged decisions inside, defaults chosen |
| [model-curation-proposals.md](model-curation-proposals.md) | #5 | reuses gateway-lane discovery fetcher |
| [named-inference-endpoints.md](named-inference-endpoints.md) | #6 | resolve pool-table convergence question in phase 1 |
| [video-ingestion.md](video-ingestion.md) | #8 | depends on voice phase 2 (whisper) for the transcription fallback |
| [persona-layer.md](persona-layer.md) | #15 | phase 1 (runner slot assembly) is standalone; locked decisions inside — Nova-as-proxy, specialists get house rules, not the soul |
| [remote-shared-state.md](remote-shared-state.md) | parked/designed | phase 1 (leader election) is a standalone win, safe now |

Not planned here (deliberately):
- **Mobile PWA routes (#4)** — roadmap says design WITH Jeremy after real
  on-device usage; a spec written before that usage would be fiction.
- **Chat activity in brain views (#7)** — already designed in ROADMAP.md
  (the `setActivity` contract); it's buildable from there. Note: voice.md
  phase 1 creates the audio-level hook it will consume.
- **Entity view** — paused mid-iteration at mockup v11; state and resume
  notes live in auto-memory, mockups in `frontend/public/mockups/`.
