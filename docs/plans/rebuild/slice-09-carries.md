# Slice 9 — Scheduling: close-out and carries

Plan: slice-09-scheduling.md (committed 1853f969). Design approved by the
owner 2026-09-06 with two amendments (timezone during onboarding; "heartbeat"
means a code job). Commits on `rebuild/v4`, by task, listed below as they
land.

## What shipped (filled in per task)

- **T5 — timezone at setup** (cd48efe2): onboarding Timezone step after
  Account (fresh runs only), Settings → General first section, browser zone
  preselected, `Intl.supportedValuesOf` guarded, write-then-advance, refusal
  shown in core's words; App gate test and e2e 01-wizard click through the
  step. Web suite 558.

- **T1 — core scheduler** (33c39ea6): timers/timer_firings, pure
  schedule.py, SKIP LOCKED claim, three firing paths, nova.timezone + the
  first SettingDef.validate hook, `_run_turn(ingest=)`. Core 1477.
- **T4 — web** (1a947336): Schedules page, derived Reminder/Scheduled label,
  chat idle poll with the spine merge, MobileNav parity pin. Web 563.
- **T2 — her side** (this commit): create_timer / list_timers /
  cancel_timer, capability + offer guard classes, corpus v7 (+2 cases,
  16 total), get_time in the household zone. Reviewed twice; the guard
  pattern's `for\b(?!\s+you\b)` residual and `about` as a tail landed with
  the commit.
- **T3 — API** (this commit): /api/v1/timers routes, `last_firing` derived in
  the API layer, `turn_kind` on GET messages, nginx long-timeout location for
  `/api/v1/timers/{id}/fire`, and the store fix the review reproduced:
  `fire_now` re-dues a row only if `next_fire_at` is still the instant it
  read, else returns the loop's firing — "Run now" during the loop's claim can
  no longer fire the row twice (pinned with a held row lock).

## Owner-owed (the DoD walk)

Filled in by T6.

## Carries

- **Default equals unset.** `nova.timezone` defaults to `UTC`, and the timers
  tool treats the default as "no timezone configured" (an absolute-time
  request is refused until it changes). A household that genuinely lives in
  UTC picks the preselected `UTC` at setup and Continues, and the server
  still treats it as unset — only Settings → General says why. The step
  cannot warn without hardcoding the server default. Fix shape: a distinct
  unset sentinel (empty string) with the wizard writing the browser zone
  explicitly, or the SettingDef exposing `is_default`. Small; touches T1's
  setting and T2's refusal.
- **`pages/onboarding/timezone.ts` belongs in `src/lib/timezone.ts`.** It is
  shared by GeneralSection; it lives under onboarding only because T5's file
  set excluded `src/lib`. Move with the next web touch.
- **Eight steps in the StepIndicator.** The fresh-run indicator now has eight
  items inside `max-w-xl`; unverified at sm+ widths — check on the e2e stack
  during T6 (or the next wizard walk).
- **No notification server on this WSL host.** `notify-send` on
  DELL-XPS-8950 fails with `org.freedesktop.Notifications was not provided by
  any .service files` (WSLg ships no notification daemon), so a reminder's
  device leg to this box is a STATED failure in `timer_firings.delivery`,
  never a toast. Two fixes, neither S9's: install a daemon in WSL (`dunst` or
  `mako`, a host step), or teach novad to use a Windows toast when it detects
  WSL interop (S6 — Windows daemon).
- **T3 must serialise what T4's web reads.** The Schedules page reads
  `last_firing {status, ended_at, reason} | null` off every timer row and the
  chat label / idle-poll merge read `turn_kind` off every row of
  `GET /conversations/{id}/messages`. Neither exists yet: `timers.timer_spec`
  emits no `last_firing`, and `conversations.py` emits no `turn_kind`. T4
  hardened the page so a row without `last_firing` reads as never-fired
  (`lastOutcome(undefined) → null`) instead of crashing, but until T3 lands
  the chat label can never appear live, and `couldBeOurReply`'s null-kind
  leniency means a reminder row could be claimed as a streamed turn's missing
  reply. T3 owns both fields (plan "API" section).
- **`turn_id` on GET messages (later).** The idle-poll merge matches a live
  turn's user row to its persisted copy by exact text (core persists
  `message.strip()`; ChatInput trims). Exposing `turn_id` per row would let it
  match by the SSE `meta.turnId` — an id, not an inference.
- **The eval case is `remind-me-in-twenty-minutes`, not two.** The plan named
  `remind-me-in-two-minutes`; the corpus case says "in 20 minutes" because an
  eval turn creates a REAL timer row under the scratch person and the
  in-process scheduler would fire a two-minute one before cleanup on a slow
  run. Same contract (`tool_succeeded create_timer`); the plan's name is the
  stale one.
- **Timer row JSON carries `conversation_id`** (from T1's `timer_spec`); the
  plan's field list omits it and the web type ignores it. Harmless; either
  list it in the plan or drop it from the spec.
- **`DEFAULT_PAUSE_REASON` is spelled twice** — `timers_api.py` (the server
  default for body-less callers) and `SchedulesPage.tsx` `PAUSED_FROM_PAGE`
  (the page always sends it). Identical strings today; one source would be
  better — the page could send no body and let the server default speak.
- **Serial firings, no per-firing bound.** `run_forever` runs claimed firings
  one after another with no wall-clock cap; a scheduled turn that hangs on
  the gateway delays every other timer until the gateway's own timeout.
  Bound it (asyncio.wait_for around `_run_firing`, recorded as `error` with
  the reason) when S11 adds more firing kinds.
- **A scheduled firing cancelled mid-`_run_turn`** records the FIRING as
  `interrupted` but `_run_turn`'s own shielded finally closes the TURN as
  `error` (its `decided` is None on CancelledError). Chat's domain; align the
  turn's close verdict when chat next touches that finally.
