# A model per chat session

**Asked for 2026-10-08** (owner): "is nova capable of running a different llm
model in multiple different chat sessions? ie: i'd like to run one on a local
llm on my dell while using a cloud model for another session" — and then, on
the shape: "removing the set model for chat … instead chat will be per session
and the only thing in settings about the chat model setting will be that it'll
use a default fallback model. We should allow each 'agent' to have a set model
as well as as many fallback models as they want, except chat will always take
the model set in the chat sessions as the main model, with fallback using the
set default fallbacks."

**State: designed, not built.** Unscheduled; the owner places it in the order.

---

## Why: what is true today

Chat sessions ([`chat-sessions.md`](chat-sessions.md), 2026-10-07) gave him
several conversations, but every one of them answers with **one** model:

- `chat.model` is a single row in `settings` — not per conversation, not per
  person (`settings_store.py`, read by `_open_turn` at `chat.py:7303`).
- Every pick writes it: the chat switcher, Models, Providers, Settings →
  Routing, and her own `set_chat_model` (`chat_pick.py`). A pick in session B
  changes session A.
- `_round_model` (`chat.py:4060`) re-reads `chat.model` on **every** round,
  by design (the 2026-10-05 Gemini walk). So a pick in B moves a turn already
  running in A on its next round.
- `runs_beside` (`chat.py:7430`) asks the gateway where `chat.model` would be
  served. Sessions run in parallel only when *the* chat model is cloud — a
  cloud session beside a Dell session cannot exist.

So "one session on the Dell, one on a cloud model" is impossible today, and
"several sessions on the Dell" works but takes turns (one GPU — S24/S15 gate,
unchanged by this slice).

## What already exists and is kept

**Agents already have what the owner asked for.** An agent's role is
`agent_<name>` and owns a chain on the gateway (`agents.register_route`,
`agents.py:710`): an ordered list of `provider:model`, link 1 its model, the
rest as many fallbacks as he likes. An agent's turn sends no model
(`chat.py:7307`), so the gateway walks that chain. **No change to agents** in
this slice beyond the UI check in step 7.

**The gateway already composes "this model, then these fallbacks".** For a
role, the request's own model is link 1 and the role's chain is the fallbacks
(`routing.py` header). A session's model in front of chat's chain is exactly
that call — the gateway does not change.

## The design

### 1. A session owns its model

`conversations.model text NULL` — new migration (`044_session_models.sql`,
check the directory for the next free number). Only a chat session's row
(`chat_session = true`, top level) carries one.

- **New session** copies `chat.default_model` at creation, **as a value**.
  Changing the default later moves no existing session. Copying (rather than
  NULL meaning "follow the default") is deliberate: a session whose model
  silently changes because a setting elsewhere moved is the defect this slice
  removes.
- **Migration backfill:** every existing chat session gets today's
  `chat.model`, so nothing changes on deploy day.
- **Threads (S24 rooms)** carry no model of their own: a room's turn uses its
  root session's model, derived through `parent_message_id`, never copied.
- **Empty** means what `chat.model = ''` means today — the gateway's default —
  and is shown as such.

### 2. The global setting becomes the default, not the model

`chat.model` → `chat.default_model`: "the model a new session starts with".
Chat's **chain** (the gateway's `chat` route) stays global and is the
fallback list for every session — as the owner asked. He edits it on Routing,
on purpose; nothing else writes it.

### 3. A pick moves one session and touches no chain

`chat_pick` today does two writes: the pick becomes `chat.model` and the model
it replaced becomes chat's first fallback. With per-session models that second
write is wrong — a pick in B would reorder A's fallbacks. So:

- A pick writes **`conversations.model` for that session only**, read back,
  answered with what was stored.
- The fallback promotion is **removed**. The 2026-10-05 reason for it (a pick
  silently dropping the Dell from every chain) no longer applies: the Dell's
  model stays wherever he put it, because a pick no longer replaces anything
  global.
- Chat rewind (`040_chat_rewind.sql`, `chat_pick.restore`) restores the
  session's model the turn changed, not a global pair.
- **Jev Router switch** (`proxies.py`): it reads `chat.model` as link 1 of
  the chat-model roles. It becomes a switch on chat's chain only; for the
  session's own link 1, a router picked by hand is a pick like any other. The
  `router_kept_slot = 'chat_model'` case is retired (migrate any stored one to
  `chain`).

### 4. Turns read their session's model, live

- `_open_turn` reads the session's model (the room's root session for a
  thread).
- `_round_model` keeps its live re-read — her `set_chat_model` mid-turn must
  still land on the next round — but reads **this turn's session row**, never
  a global. A pick in another session can no longer reach this turn.
- `runs_beside` asks the gateway's explain walk with **the session's model**.
  A cloud session now runs beside a Dell session; two Dell sessions still take
  turns. Unchanged rule, derived from the gateway's `local` flag.

### 5. Scheduled turns and beats get their own routes

Today `scheduled` and `beat` turns send `chat.model` as link 1
(`CHAT_MODEL_ROLES`, `scheduler.py:280`), so they follow his last chat pick.
After this slice they have no session to read. They become like agents:
**their own route on the gateway** (link 1 their model, then fallbacks),
edited on Routing. Migration: seed each role's chain with today's
`chat.model` followed by chat's current chain, so the first run after deploy
asks for what it asked for the day before. A role whose chain is then emptied
walks chat's chain, as the gateway already does for any role with none.

`CHAT_MODEL_ROLES` shrinks to `("chat",)`, and then to nothing worth naming —
chat's link 1 is the session's.

### 6. Every other reader of `chat.model`

Each one moves to the reading that is true for it. Grep `chat.model` /
`chat_model` before closing the slice; the list as of 2026-10-08:

| Reader | Becomes |
|---|---|
| `tools/inference.py` (`machine_status` throughput), `resources_api.py` | the model of **the session the turn is in** (the page: of the session open in the main pane, else every session's model) |
| `tools/models.py:633` (refuses removing the chat model) | refuses removing a model **any live session**, the default, or a scheduled/beat/agent link 1 names — derived from the rows, never a list |
| `model_read.chat_model` | the turn's session model; callers without a turn say which session they mean |
| `checks/stack.py` | checks the default and each live session's model can be served |
| `skills_api.py:276` | the session the skill run belongs to, else the default |
| `scheduler.py` (refusal "no chat model is set") | the role's own route: "the scheduled route has no model" |
| `guards.py:9077` (literal string) | update the pinned wording |
| web: `ModelSelector`, `ContextGauge`, `ModelFitNotice`, `RoutingSection`, `ProvidersSection`, `MachinesSection`, `SettingsPage` | the selector sits on each **pane** and picks that session; Settings shows "default model for new sessions" plus the chat fallback chain |

### 7. Her tools

- `set_chat_model` sets the model of **the session her turn is in**
  (`ToolContext.conversation_id`, added 2026-10-07). A room's turn sets its
  root session's. Answer is the stored row, read back.
- `set_default_chat_model` (new) sets `chat.default_model`, stating that
  existing sessions are not changed. **Register it** in `tools.REGISTRY`;
  `test_tools_registry`'s pinned set goes red and is updated deliberately.
- `route_explain` for `chat` explains with the turn's session model as link 1.
- Agents: confirm her agent tools and the agent page can set link 1 and add
  any number of fallbacks. If either can only set one model, that is the gap
  to fill here.

### 8. Saying which model answered

A per-session fallback is easy to miss. The served model is already recorded
per message (`X-Nova-Served-By`, `provider:model`). Each pane's header shows
the session's model and, when the last reply was served by a fallback, says so
in words (the gateway's `X-Nova-Route` reason, quoted). A cloud session that
fell to the Dell must look different from one that did not.

## The edge case to close: a fallback onto the GPU

`runs_beside` decides **once, before the turn opens**, from where link 1 would
be served. A cloud session whose provider walls mid-turn falls to the next
link — and if that link is the Dell while another Dell turn runs, two turns
share one GPU, which is what the S24 gate exists to prevent.

The fix must be mechanical, not a prompt:

- **Preferred:** when a turn admitted as `parallel` reaches a round the
  gateway would serve locally (explain walk before the round, or the
  `local` flag on the response's route), it **waits** for the person's
  running local turn to end before that round, and the pane says it is
  waiting for the GPU. It never runs beside it.
- Rejected: dropping local links from the walk for parallel turns — that turns
  "cloud is down" into "no reply" when the Dell was free a moment later.

A test pins it: two sessions, one cloud with the Dell as its fallback, the
cloud provider walled mid-turn, the second turn must not open its local round
until the first closes.

## Tests that go red, on purpose

- `test_tools_registry` — `set_default_chat_model` added.
- `chat_pick` tests — the fallback promotion is removed; rewrite them to pin
  the new rule (a pick changes one session and no chain).
- Jev Router switch tests — `router_kept_slot = 'chat_model'` retired.
- New pins: a pick in session B leaves session A's model and a running A turn
  untouched; a new session copies the default; changing the default moves no
  session; a room uses its root's model; `runs_beside` reads the session's
  model; scheduled/beat first run after migration asks for the same model as
  before; the GPU fallback case above.
- `test_no_approvals` should stay green: nothing here decides whether a call
  may run.

## Done means

Walked in his real chat, through her:

1. Two sessions open side by side. In one, he asks her to use the Dell's
   model; in the other, a cloud model. `turn_spans` shows each session's
   rounds served where its session says.
2. Both answer **at the same time** (the cloud one does not queue behind the
   Dell one).
3. A third session on the Dell queues behind the first and runs after it.
4. A pick in one session mid-turn in another: the other turn's spans show
   its model unchanged.
5. A scheduled reminder and a beat fire after the migration and are served by
   the model they were served by the day before.

## Order of work (proposed)

1. Migration + `conversations.model` + backfill; `chat.default_model`.
2. Core turn path: `_open_turn`, `_round_model`, `runs_beside`, rooms.
3. `chat_pick` rewrite + rewind + Jev Router switch.
4. Scheduled/beat routes + seed migration.
5. The other readers (section 6).
6. Her tools (section 7).
7. Web: per-pane selector, Settings default + chain, served-by in the header.
8. The GPU fallback wait.
9. The walk.
