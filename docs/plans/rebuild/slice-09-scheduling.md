# Slice 9 — Scheduling: reminders, scheduled turns, jobs

Parent: the Master Roadmap, §S9 (M, additive) and §"Scheduling & proactive".
Inputs: the S9 understand pass (2026-09-06, seven read-only readers over core,
the v3 scheduler prior art, novad, the web app, the rails); memory
[[scheduling-names-a-day]] (v3's "remind me tomorrow became a daily job"),
[[automation-runs-capped-at-50]], [[heartbeat-lane]], [[journal-probe-noise]];
v3 `backend/app/schedules.py` / `scheduler.py` / `heartbeat.py` (prior art,
mine-not-port). Slice type: ADDITIVE. Size: M. Owner approval: design approved
2026-09-06 ("you're a go") with two amendments — the timezone is set during
onboarding, and "heartbeat" here means a code job, never the model checking in
(that is S11).

Goal: "remind me in two minutes" arrives in chat and as a daemon notification;
a scheduled instruction runs a real turn while nobody is watching; housekeeping
runs on the same scheduler with the same run history; a Schedules page shows,
pauses and proves it all. Every firing is a traced turn through the SAME
runner the chat uses. Nothing asks anyone for approval (owner ruling 09-03).

Vocabulary, fixed: a **timer** is a row. Its **kind** is `reminder` (delivery
is code, no model), `scheduled` (an instruction run as a model turn) or `job`
(a code handler bound by name — the roadmap's "heartbeat rows on mechanical
handlers"; S11's checklist heartbeat is NOT this). A **firing** is one
execution of a timer. Nothing in this slice is called a heartbeat.

## Definition of done (operator-visible, walked live)
1. In chat: "remind me in two minutes to stretch" → she confirms with the
   resolved time in words → within the next tick after that time the reminder
   appears in the SAME conversation (the page open, no reload) labelled
   "Reminder", and as a desktop notification on every connected paired device.
   Activity shows the `reminder` turn with a `device_notify` span per device.
2. In chat: "every day at 7 tell me what's on my calendar file" (any
   instruction) → a `scheduled` timer; run it now from the Schedules page → an
   assistant reply labelled "Scheduled" lands in that conversation; Activity
   shows the `scheduled` turn with its llm_call and tool spans.
3. Schedules page: the timers above are listed with kind, next fire (local
   time), last outcome; each firing expands with per-channel delivery
   (chat ok; device X ok / device Y offline, stated). Pause the daily one →
   its next fire passes → NO firing row appears and the row says "paused";
   Resume → a next fire is shown again. Delete removes it. The `retention`
   job is listed as a job with its own history.
4. Onboarding on a fresh instance has a Timezone step (browser zone
   preselected); Settings → General shows and changes it; `get_time` answers
   in that zone. With the zone still unset, an absolute-time request is refused
   in her own words naming where to set it — never a wrong time.
5. Restart core mid-flight → the firing that was running is closed
   `interrupted` with the reason visible; nothing fires twice; due timers
   fire on the first tick after restart.

## Architecture

### Data (core migration `019_timers.sql`, next free number — re-check)
```
timers
  id            uuid PK DEFAULT gen_random_uuid()
  person_id     uuid REFERENCES people(id) ON DELETE CASCADE   -- NULL iff kind='job'
  kind          text NOT NULL CHECK (kind IN ('reminder','scheduled','job'))
  title         text NOT NULL            -- what the page and the list tool show
  payload       jsonb NOT NULL DEFAULT '{}'
                -- reminder:  {"message": str, "device": str|null}
                -- scheduled: {"instruction": str}
                -- job:       {"handler": str}
  schedule      jsonb NOT NULL           -- a validated spec (below)
  timezone      text NOT NULL            -- IANA zone the spec is computed in
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL
                -- where a reminder/scheduled reply lands; NULL for jobs
  next_fire_at  timestamptz              -- NULL = finished (a once that fired)
  paused_at     timestamptz
  paused_reason text
  consecutive_failures int NOT NULL DEFAULT 0
  created_via   text NOT NULL CHECK (created_via IN ('chat','page','system'))
  created_turn_id uuid REFERENCES turns(id) ON DELETE SET NULL  -- provenance
  created_at / updated_at timestamptz NOT NULL DEFAULT now()
  CHECK ((kind = 'job') = (person_id IS NULL))
  CHECK (paused_at IS NULL OR paused_reason IS NOT NULL)
  INDEX timers_due ON (next_fire_at) WHERE paused_at IS NULL AND next_fire_at IS NOT NULL
  UNIQUE INDEX timers_one_row_per_job ON ((payload->>'handler')) WHERE kind = 'job'

timer_firings
  id            uuid PK
  timer_id      uuid NOT NULL REFERENCES timers(id) ON DELETE CASCADE
  scheduled_for timestamptz NOT NULL     -- the next_fire_at it was claimed at
  started_at    timestamptz NOT NULL DEFAULT now()
  ended_at      timestamptz
  status        text NOT NULL CHECK (status IN ('running','ok','error','refused','interrupted'))
  reason        text
  turn_id       uuid REFERENCES turns(id) ON DELETE SET NULL
  delivery      jsonb NOT NULL DEFAULT '{}'
                -- {"chat": {"ok": bool, "reason"?: str},
                --  "devices": [{"name": str, "ok": bool, "reason"?: str}]}
  CHECK ((status = 'running') = (ended_at IS NULL))
  CHECK (status IN ('running','ok') OR reason IS NOT NULL)
  INDEX timer_firings_timer ON (timer_id, started_at DESC)
```
Both tables join `tests/conftest._TABLES`. The `retention` job row is NOT
seeded by migration (TRUNCATE would remove it); `timers.ensure_jobs(pool)`
inserts any missing `JOBS` row at startup (the gateway's ensure-builtin
pattern), idempotent on the unique index.

### The schedule function (`app/schedule.py`, pure — no clock, no DB)
Restated from v3, one closed set of shapes, unknown keys refused BY NAME:
```
{"kind":"once",    "at": "<ISO 8601 local wall time, no offset>"}
{"kind":"minutes", "every": N}                    # N >= 5
{"kind":"hour",    "minute": M}                   # 0..59
{"kind":"day",     "at": "HH:MM"}
{"kind":"week",    "days": ["mon",...], "at": "HH:MM"}
{"kind":"month",   "day": D, "at": "HH:MM"}       # D 1..31, clamped to month end
```
- `validate(spec) -> dict` raises `SpecError(reason)`; the reason names the
  bad field and the accepted shape. `spec.get(k) or default` is banned
  (v3's `day: 0` → 1 bug); every field is read with explicit presence checks.
- `next_after(spec, after: datetime[UTC], tz: str) -> datetime[UTC] | None`:
  all arithmetic in `zoneinfo.ZoneInfo(tz)` wall time, ONLY the answer
  converted to UTC. `None` when a `once` is at or before `after`. Month day
  clamped, never skipped. A wall time that does not exist on a DST-forward
  day resolves to the first instant after the gap; an ambiguous fall-back
  time takes the first occurrence (`fold=0`). Pinned with America/New_York
  2026-03-08 / 2026-11-01 cases and a month-31 clamp across Feb.
- `describe(spec, tz, next: datetime) -> str`: the words the tool and the
  page use ("once, Sat 6 Sep 2026 14:32 EDT (in 2 minutes)"; "every day at
  07:00 America/New_York, next Sun 7 Sep"). One function, so her reply and
  the page cannot disagree about the same row.
- Relative creation ("in N minutes") is resolved by the CALLER into a `once`
  at an absolute local wall time before validation; the store never holds a
  duration. A `once` in the past is refused at creation.

### Timers store (`app/timers.py`)
`create(pool, *, person, kind, title, payload, spec, tz, conversation_id,
created_via, created_turn_id=None) -> row` (validates spec, computes
`next_fire_at`, refuses a past once, refuses `job` from anywhere but
`ensure_jobs`, refuses an unknown handler); `list_for(pool, person)`
(the person's timers + every job); `get`, `pause(pool, id, *, reason)`,
`resume` (a paused once still in the future keeps its instant; a repeat is
recomputed from now), `delete`, `fire_now(pool, id)` (sets
`next_fire_at = now()` then awaits one `scheduler.tick_once` so "Run now" is
immediate and still goes through the claim + run history), `firings_for(pool,
id, *, limit, before)`. `JOBS: dict[str, Callable[[Pool], Awaitable[str]]] =
{"retention": retention}`; `retention` deletes `timer_firings` older than 30
days and returns the count in words. `ensure_jobs(pool)` seeds `retention` as
`day at 03:30 UTC`.

### Tick and claim (`app/scheduler.py`)
- `tick_once(app, pool, *, now: datetime | None = None) -> list[uuid]`.
  In ONE transaction: `SELECT … FROM timers WHERE paused_at IS NULL AND
  next_fire_at IS NOT NULL AND next_fire_at <= $now ORDER BY next_fire_at
  LIMIT 20 FOR UPDATE SKIP LOCKED`; per row compute `next =
  next_after(spec, row.next_fire_at, tz)`, INSERT the `running` firing with
  `scheduled_for = row.next_fire_at`, UPDATE the timer's `next_fire_at`
  (NULL for an exhausted once). COMMIT. THEN run each firing outside the
  transaction (a long model turn must not hold a row lock), close it, and
  update `consecutive_failures` (reset on ok; +1 on error/refused; at 5 the
  timer is paused with `paused_reason = "paused after 5 consecutive
  failures: <last reason>"`). `now` defaults to the DB clock; tests pass it.
- The claim IS the exactly-once guarantee: two concurrent `tick_once` on one
  due row produce ONE firing (pinned by a test with two pools). This replaces
  the roadmap's "leader-elected" wording — core is pinned to one process
  (traces.py) and a row claim holds with N processes anyway.
- `run_forever(app, pool, interval_s=60)`: loop `tick_once` (every
  exception logged, never fatal) then sleep. Owned by `main.lifespan`:
  created after the sweeps, CANCELLED and awaited BEFORE
  `chat.drain_background()` (a forever task inside `_BACKGROUND` would hang
  the drain — it never joins that set).
- `sweep_orphaned_firings(pool)` at startup: every `running` firing →
  `interrupted`, reason "core restarted while this firing was running".
- Every firing opens a turn: `traces.open_turn(kind=<timer kind>,
  conversation_id=…, model=…)`; the firing row links `turn_id`. Activity
  shows `reminder`/`scheduled`/`job` turns (it hides only `eval`). Scheduled
  turns are NOT added to `traces.INFLIGHT` (that set means "the owner's
  browser is waiting"); the chat page learns of the row by the idle poll.

### Firing semantics
- **reminder** — no model. Text = `"Reminder: " + payload.message` (his
  words, verbatim). `chat._persist_assistant(pool, conversation_id, text,
  turn.id)`; then for each target device — `payload.device` if named, else
  EVERY currently connected paired device (`devices_ws.hub.connected_ids()`
  ∩ live rows) — dispatch through `chat._run_tool(turn, ctx,
  ToolCall(id, "device_notify", json({device, message})))` so the span,
  redaction and facts are exactly the chat's. No connected device is a STATED
  fact in `delivery.devices` (empty, with `delivery.note`), not a failure.
  Firing `ok` iff the chat row persisted.
- **scheduled** — `model = chat.model`, `history = []`, no user row is
  written, the model's message is the instruction framed by code:
  `"[Scheduled turn — you set this up earlier as '<title>'; the owner may
  not be watching. Local time now: <describe>.]\n\n<instruction>"`. Run
  `chat._run_turn(app, pool, turn, owner, conversation_id, message, [],
  model, max_tool_rounds, emit=collector, ingest=False)` — `ingest` is the
  ONE new keyword on the runner (default True, so chat and evals are
  unchanged): a scheduled instruction must not be written into memory as
  something he said today, every day. Then settle the way the eval runner
  does and read the turn's status for the firing outcome. The assistant row
  is written by `_run_turn` with `turn_id`, so the bubble label is DERIVED
  (below), never stored.
- **job** — `open_turn(kind='job')`, one `job` span named after the handler
  with `meta.result`; unknown handler → firing `refused` ("no job handler
  named X") and the timer paused with that reason, never routed to a model.

### Her side (`app/tools/timers.py`, guards, corpus)
Three tools, flat schemas, structured fields (the model never parses dates):
- `create_timer(text, kind='reminder'|'scheduled', in_minutes?, at?
  ('YYYY-MM-DD HH:MM' local), repeat? ({every: minutes|hour|day|week|month,
  n?, at?, days?, day?}), device?)` — exactly one of `in_minutes`/`at`/
  `repeat`, else `Error:` naming the rule. Absolute `at`/`repeat` with
  `nova.timezone` still at its default → `Error: no timezone is set for this
  instance yet — it is set in Settings → General (or during setup); relative
  reminders ("in 20 minutes") work without one.` Returns `describe()`'s words
  plus where it will land. Result is durable, not ephemeral.
- `list_timers()` — `result_kind = RESULT_KIND_LISTING`; each line id (short),
  kind, title, next fire in words, paused state.
- `cancel_timer(id_or_title)` — the person's own only; ambiguous title → the
  candidates, no guess.
Guards (derived from the registry, pinned): a `_CAPABILITY_TOOLS` pattern
(`set (a )?(reminder|timer|alarm)|remind you|schedule (a |an )?…` →
`create_timer`) and a `_SET_REMINDER` `_ActionClass` in `_OFFER_CLASSES`, so
"I can't set reminders" and "want me to set a reminder?" after "remind me…"
are caught like the existing classes. Corpus: two cases at `suite_version 7`
for ALL cases — `remind-me-in-two-minutes` (contract `tool_succeeded
create_timer`) and `list-my-reminders` (`tool_succeeded list_timers`);
`test_eval_corpus` count 14 → 16 and version pin move with a comment. Eval
turns run under a scratch person; `timers.person_id … ON DELETE CASCADE`
removes their rows at cleanup. `test_tools_registry`'s set moves 17 → 20.

### Timezone
`SettingDef(key="nova.timezone", type="str", default="UTC", description=…)`
plus an optional `validate: Callable[[Any], str | None]` on `SettingDef`
(additive; `validated()` calls it after the type check) — for this key,
`zoneinfo.ZoneInfo(value)` must load. `test_settings.KNOWN_KEYS` moves.
`get_time` reads it and answers `"<local ISO> (<zone>, UTC<offset>); UTC
<iso>; unix <epoch>"`; when unset it says so as today. Onboarding gains a
`timezone` step after `account` (browser zone preselected via
`Intl.DateTimeFormat().resolvedOptions().timeZone`, list from
`Intl.supportedValuesOf('timeZone')`, Continue writes the setting; a failed
write is shown, never skipped). Settings → General (`GeneralSection.tsx`,
new, first section) shows and changes it with the InlineSave pattern.
AppearanceSection and `lib/color-palettes.ts` are another session's files:
NOT touched.

### API (`app/timers_api.py`, `require_person`)
```
GET    /api/v1/timers?limit&before          {"timers": [row…]}   cursor = last id
GET    /api/v1/timers/{id}/firings?limit&before   {"firings": [row…]}
POST   /api/v1/timers/{id}/pause            {"reason"?: str}   → row
POST   /api/v1/timers/{id}/resume           → row
POST   /api/v1/timers/{id}/fire             → {"firing": row}  (runs the tick inline)
DELETE /api/v1/timers/{id}                  → 204
```
Timer row JSON: id, kind, title, payload, schedule, schedule_words, timezone,
next_fire_at, paused_at, paused_reason, consecutive_failures, created_via,
created_at, last_firing {status, ended_at, reason} | null. A person sees
their own timers and every job; someone else's id is 404, never 403
(conversations.owned_conversation's rule). Creation stays conversational in
S9 (page-side creation is a carry). `GET /conversations/{id}/messages` adds
`turn_kind` per row, read from `turns.kind` via `messages.turn_id` — the
same derivation `served_by` already uses.

### Web (`apps/web`)
- `lib/api.ts`: `Timer`, `TimerFiring`, `listTimers`, `listTimerFirings`,
  `pauseTimer`, `resumeTimer`, `fireTimer`, `deleteTimer`,
  `TIMERS_PAGE_SIZE = 50`; `StoredMessage.turn_kind`.
- `pages/schedules/SchedulesPage.tsx` (+ test) and `schedulesFormat.ts`
  (+ test): injectable `api`/`pageSize`/`pollMs` (15 s list refresh),
  PageHeader/Badge/Button/EmptyState/Skeleton, `role="alert"` load banner,
  testids `schedules-row-<id>`, `schedules-detail-<id>`,
  `schedules-skeleton`; expand-in-place firings (Activity's drill-in), with
  per-channel delivery lines; Pause/Resume/Run now/Delete (Delete confirms).
- Route `/schedules`; nav item "Schedules" (lucide `CalendarClock`) in the
  System section of BOTH `Sidebar.navSections` and `MobileNav.moreItems`;
  while there, add the missing Governance entry to MobileNav (the two lists
  had drifted — a one-line fix in the file S9 edits anyway).
- Chat: `MessageBubble` shows a small "Reminder" / "Scheduled" label on an
  assistant row whose `turn_kind` is `reminder`/`scheduled`; `ChatPage`
  gains an idle poll — every 15 s while not streaming and not responding,
  fetch messages and reconcile new rows through the reducer (a firing that
  lands while he is looking appears without a reload). Pinned with a fake
  api that returns one more row on the second poll.

## Tasks (order: T1 ‖ T4 → T2 ‖ T3 → T5 → T6)
Every task: implementer (uncommitted, file-disjoint from the other sessions
— `apps/web/src/lib/color-palettes.ts`, `apps/web/src/pages/settings/
AppearanceSection*.tsx`, `services/gateway/**` are off-limits), adversarial
review, one fix-up round, then a commit by path on `rebuild/v4` with the
hand-run gates (`[[v4-push-gate]]`). Each implementer uses its OWN scratch
database on `nova-scratch-pg` (`nova_core_s9_<task>`).

- **T1 core scheduler (M).** `migrations/019_timers.sql`, `app/schedule.py`,
  `app/timers.py` (incl. `JOBS`, `ensure_jobs`, `retention`),
  `app/scheduler.py`, `main.py` lifespan wiring (ensure_jobs, sweep, task
  start/cancel), `traces.Turn` unchanged, `chat._run_turn(..., ingest=True)`
  keyword, `settings_store` `nova.timezone` + `validate` hook,
  `conftest._TABLES`. Tests: `test_schedule.py` (every shape, refusals by
  name, DST forward/back, month clamp, once-in-past, `describe`),
  `test_timers.py` (create/pause/resume/delete/fire_now/ensure_jobs
  idempotent/unknown handler refused), `test_scheduler.py` (a due reminder →
  chat row + `reminder` turn + firing ok with delivery; a due scheduled →
  `_run_turn` called with `ingest=False`, no user row, reply labelled by
  turn kind; job runs handler; concurrent ticks → one firing; paused →
  nothing; 5 failures → paused with reason; once → `next_fire_at` NULL;
  restart sweep → `interrupted`; lifespan starts and cancels the task before
  drain). `test_settings` KNOWN_KEYS moved deliberately.
- **T4 web Schedules + chat label + idle poll (M).** Everything under
  "Web" except onboarding/General. Unit tests with a fake `api`.
- **T2 core tools + guards + corpus (S–M).** `app/tools/timers.py`,
  `tools/__init__.py` registry, `guards.py` classes, `get_time` timezone,
  two corpus cases + `suite_version 7` for all, `test_tools_registry` set
  17 → 20, `test_eval_corpus` pins, `test_guards`/`test_capability_guard`
  pins for the new class, `test_tools_timers.py` (each refusal shape; the
  no-timezone refusal; describe words match the row).
- **T3 API (S).** `app/timers_api.py`, router in `main.py`, `turn_kind` on
  GET messages, `test_timers_api.py` (404-not-403, cursor pagination,
  fire runs the tick inline and returns the firing row).
- **T5 onboarding + Settings → General (S).** `steps.ts` order/labels +
  tests, `steps/Timezone.tsx`, `GeneralSection.tsx` in `SettingsPage`,
  `steps.test.ts`, section test.
- **T6 deploy + walk (S).** `docker compose --project-directory deploy up -d
  --build --no-deps core web` (compose pre-checks per
  [[compose-gpu-overlay-trap]]); set the timezone in Settings → General;
  walk DoD 1–3 and 5 through the real chat and read `turn_spans` and
  `timer_firings`; DoD 4's onboarding step is walked on the isolated e2e
  stack or by a unit test of the wizard (a fresh owner cannot be minted on
  the live instance). One e2e spec `17-schedules.spec.ts` (list renders, pause
  changes the row) is added but the tick-dependent DoD is walked live.

## Rails in force
- No approvals (test_no_approvals): the claim → run path awaits nothing but
  the work; no table is consulted for permission; no text says "awaiting".
- Every firing is a turn; every device delivery is a `tool` span written by
  `_run_tool`; a delivery is `ok` only from the device's own result frame.
- Derived, never stored: the bubble label comes from `turns.kind`; jobs come
  from `JOBS`; the page's words come from `describe()`.
- Never report success unchecked: a firing that cannot verify its own
  outcome is `error` with a reason; a `once` that fired is `next_fire_at
  NULL`, never "disabled" by a flag that could drift.
- Prose never causes an action: the create tool takes fields, not a date
  sentence; the scheduled turn's instruction rides as the model's message,
  never persisted as his words.
- Journal-probe-noise: scheduled/reminder turns carry their kind and a
  conversation; eval scratch timers cascade away with the scratch person.
- Age-based retention (30 d) via the `retention` job — never a row cap
  ([[automation-runs-capped-at-50]]).

## Out of scope (named)
S11's proactive engine (checklist heartbeat, quiet contract, noise ceilings,
Inbox, channel ladder); page-side timer creation and editing (carry);
per-person timezone (one install setting; S8); daemon-side notification
title/urgency (novad unchanged); the roadmap's consent-driven "follow-ups"
kind (voided by no-approvals); leader election (replaced by the row claim).

## Process
Plan approved in chat 2026-09-06. Each task ends with counts verbatim and a
commit by path; the close-out lands in `slice-09-carries.md`. Deploy rule per
[[nova-v4-tailnet-url]] (HEAD compose, `--project-directory deploy`).
