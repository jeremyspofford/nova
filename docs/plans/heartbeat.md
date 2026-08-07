# Heartbeat — she looks around on her own, and speaks only when it matters

Proposed 2026-08-07 after surveying how OpenClaw, Hermes and Vellum do it.
Decisions marked **DECIDE** are Jeremy's; everything else is buildable as
written. ROADMAP #45.

## The gap

Nova is entirely reactive between automations. Automations are the cron
half — a SPECIFIC instruction on a schedule, with its own runs history and
kill switch. Nothing periodically re-evaluates the world with her full
context and asks the one standing question: *does anything need Jeremy's
attention right now?* Reminders fire because a row said to fire; nobody
notices the thing no row was written for.

All three surveyed assistants converged on the same primitive, which is
strong evidence it is a real category and not a gimmick:

- **OpenClaw**: a periodic agent turn in the MAIN session (default 30m),
  reads `HEARTBEAT.md`, replies `HEARTBEAT_OK` to stay silent — the
  gateway strips that token and suppresses delivery; anything else is
  delivered to a channel. Config: interval, cheaper model, target channel,
  active hours + timezone, light/isolated context for token cost.
- **Hermes**: the same wake-evaluate-act-report loop, framed as "an agent
  periodically re-evaluates the world and makes conservative decisions"
  vs a blind cron job; plus liveness/zombie uses.
- **Vellum**: enabled out of the box (up to 10 runs/day), same
  `HEARTBEAT.md` checklist shape, "only surfaces things when they need
  your attention."

The convergent design: **operator-editable checklist + periodic main-agent
turn + a mechanical quiet contract + proactive delivery + dedupe + cost
controls.** Nova has none of the first four as a standing feature and all
of the ingredients to build them.

## Design — mechanical over prompts, derived not hardcoded

**One system-owned schedule, not a new loop.** A `heartbeat` entry rides
the existing automations scheduler (leader-gated, capability-evented,
kill-switched already). It is NOT an ordinary automation row: it has no
instruction of its own, cannot be deleted (only disabled), and its runs
carry `source: heartbeat` in traces — never mistakable for Jeremy's turns
(the journal-probe-noise lesson).

**The checklist is a file she and Jeremy both edit.**
`data/memory/heartbeat.md` — visible in Library → Files like everything
else, seeded with a commented starter. The turn prompt is: read the
checklist, check ONLY what it names, look at what you already flagged, and
answer. She can add items to her own checklist (an automation or a chat
request can append); Jeremy can prune it by hand.

**The quiet contract is enforced by the backend, not requested of the
model.** The reply is delivered ONLY if the backend decides it should be:

1. Reply contains `HEARTBEAT_OK` and is under 300 chars → suppressed,
   run recorded as `quiet`. (The token is stripped if it appears with
   real content — OpenClaw's rule, adopted wholesale.)
2. Anything else → delivered through the existing notify registry
   (web push / ntfy), and — when it names something actionable — raised
   as an inbox card so it survives being missed on the phone.
3. **Dedupe is mechanical**: the failures.py pattern — a fingerprint set
   of what was already flagged; a beat whose flags all match the stored
   set is suppressed as `repeat` no matter what the model wrote. The set
   clears when Jeremy opens the card or replies in chat.

**Cost and quiet hours are settings, derived where possible.**
`heartbeat.every_minutes` (0 = off), `heartbeat.active_hours`
(default 08:00–22:00 in the existing operator timezone setting),
`heartbeat.model` (empty = main's chain — local-first users pay nothing;
this finally gives the parked `automations.model` question its answer
shape), `heartbeat.light_context` (skip workspace bootstrap, keep the
checklist + flag memory only). All surfaced on a Settings card with the
last 5 beats and their outcomes (`quiet` / `repeat` / `notified`), because
an invisible background feature is an unverifiable one.

**What it is not.** Not a replacement for automations (specific recurring
work keeps its own rows and history); not the ideation proposer (weekly,
creative, card-only); not the failure census (mechanical, no model). The
heartbeat is the standing *look around* — those are things it may READ.

## Tripwires that ship with it

- A suite pinning the quiet contract: a `HEARTBEAT_OK` reply is never
  delivered; a real reply is; a repeat-fingerprint reply is suppressed
  regardless of content; the token never reaches a delivered message.
- A trace test: heartbeat turns carry `source: heartbeat`, never `chat`.
- `test_eval_grants`/servability stay green or move deliberately (the
  heartbeat agent context holds the same tools main holds — derived, so
  a granted tool is heartbeat-visible by itself).

## DECIDE (Jeremy)

1. **Default state**: on at 30m within active hours (recommended — the
   surveyed three all ship it on), or off until enabled?
2. **Delivery default**: web push + inbox card (recommended), ntfy, or
   inbox-only?
3. **Checklist seed**: propose — backup freshness, unread inbox cards
   older than a day, failed background queues, calendar/reminders once
   those exist. Edit freely.

## Phases

1. **The beat** — scheduler entry, `source: heartbeat`, quiet contract +
   suppression + delivery through notify, runs visible in the automation
   history. Smallest honest slice; verifiable end to end.
2. **The checklist + card** — `heartbeat.md` seeded and read, Settings
   card (interval, active hours, model, last beats), inbox card on
   actionable flags.
3. **The memory** — mechanical dedupe fingerprints + clear-on-read,
   light-context mode, e2e coverage of the Settings card.
