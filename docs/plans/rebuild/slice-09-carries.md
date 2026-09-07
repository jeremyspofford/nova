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
