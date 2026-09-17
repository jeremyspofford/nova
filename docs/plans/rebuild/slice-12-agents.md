# Slice 12 — Agents: specialists Nova orchestrates

Plan: `~/.claude/plans/ethereal-cooking-dusk.md` (approved 2026-09-08).
Branch `slice/s12` in `.worktrees/s10a`, cut from `slice/s10`.

Jeremy asked for agents during S10 planning ("should we have agents
configured, each with a role, skills, model?") and again after S10 shipped:
"move onto agents … I want to make sure we have this well spec'd out."
S10 made the ROLE the unit of routing and metering precisely so an agent
could be a row that names a role and rides the same chains — this slice is
that row.

## Decisions with Jeremy (2026-09-08)

- An agent is used four ways, all the same object: a specialist Nova
  delegates to mid-turn; addressable directly in chat as `@coder` (NOT a
  separate persona thread — one chat, one Nova, she hands the turn over and
  the conversation stays whole); bound to a scheduled timer; and created by
  Nova herself, **no limits** beyond the spend caps that already exist.
- Memory: Nova orchestrates. An agent works ISOLATED by default (its own
  notes); only Nova writes the shared household memory; a per-agent switch
  grants READ access to it.
- An agent carries its own instructions, skill packs, workspace folder,
  monthly spend cap and max-tool-rounds ceiling.
- Delegation shows in chat as ONE collapsed line that expands to the live
  steps. Revised the same evening: each agent also gets **its own page** —
  traces, artifacts, activity, idle-or-working right now.
- Deferred by Jeremy as an optional late feature: an animated "office" view
  (lounge when idle, desk or garage when working). Nothing here forecloses
  it — see `slice-12-carries.md`.

## What shipped

- **The agent row (core, migration 021).** `agents`: name (CHECK
  `^[a-z][a-z_]{0,25}$`), purpose, instructions, tools subset, skills,
  `monthly_cap_usd` (NULL = uncapped, never 0), `max_tool_rounds` (1..50),
  `read_shared_memory`, its own INACTIVE `log_conversation_id`,
  `created_via`, `created_turn_id`. Plus `turns.agent_id` + `turns.role`
  (who did the work and which chain its rounds walked; `person_id` stays
  the OWNER whose money it is) and `timers.agent_id` (ON DELETE RESTRICT,
  CHECK only a `scheduled` row can be bound).
  **NO people row.** The only two things one would buy — a memory partition
  key and a spend key — the memory service already gives to any slash-free
  string and the gateway to any `ROLE_RE` role, while a people row leaks a
  non-person into every person-scoped query. One binding per fact: name →
  routing role by derivation (`agent_<name>`), id → memory partition by
  derivation. The `agent_` prefix plus the 26-char name cap is what keeps
  every derived role inside the ledger's `^[a-z_]{1,32}$`.
- **One funnel.** `chat._run_turn` gained ONE keyword-only `persona=None`.
  The Persona swaps the advertised tools, the prompt block, the workspace
  root (`agents/<name>/`), the guard feeds, the listing subset and the
  recall scopes; `persona=None` is byte-identical to before (pinned against
  HEAD, not just self-referentially). All four uses go through it: the
  delegate tool's child turn, an `@name` chat turn, a bound firing, and
  Nova's own turns.
- **Dynamic roles (gateway).** `ROLES` → `BUILTIN_ROLES`; `validate_role`
  accepts a built-in or any name the ledger's own `ROLE_RE` accepts, so
  whatever can be METERED under a role can be ROUTED by it. `GET
  /admin/routes` carries `builtin: bool`; new `DELETE /admin/routes/{role}`
  refuses a built-in and 404s a role with no row. No gateway migration —
  `routes.role` and `usage_events.role` were already free text. Core
  refuses a `PUT /api/v1/routes/agent_<name>` for an agent that does not
  exist, by name, where the owner types it.
- **Delegation.** `delegate_to_agent(agent, task, context?, deliverable?)`
  runs the agent to completion as its OWN turn (kind `agent`, in its log
  conversation, every span under `turns.agent_id`) and answers with a facts
  line the BACKEND composed from spans — status, rounds, calls ok/failed,
  seconds, cost, trace id, the files it actually wrote — followed by the
  agent's report labelled as its words. Files come from the successful
  `workspace_write_file` spans, never from the report: an agent that claims
  a file it never wrote lists none. Depth is 1: an agent cannot delegate.
- **`@name` in chat.** Parsed in CORE (the backend decides who runs the
  turn; a client-side parse would be an offered list, not enforcement). The
  user row is stored VERBATIM; the whole turn runs as the agent in the same
  conversation with its chain, its rounds and its subset; the badge is
  derived from `turns.agent_id`, never a stored label. Assistant rows from
  agent turns reach the next turn's history prefixed `[coder] ` — relative
  to whoever runs that turn, so an agent does not read itself in the third
  person.
- **Scheduled binding.** `person_id` stays the owner who set the timer;
  `agent_id` says who RUNS it. `PUT /api/v1/timers/{id}/agent`, a `runs as`
  column, and `create_timer(agent=…)` in chat. Deleting an agent pauses its
  bound timers WITH THE REASON in the same transaction (and leaves an
  already-paused timer's own reason intact); the RESTRICT FK is the
  backstop against any path that forgets.
- **Caps and rounds.** Both enforced inside the funnel, so no caller can
  forget. The cap reads the gateway's own monthly `by_role` figure before
  the first round; over it the turn ends with a stated sentence persisted
  verbatim (`_end_without_a_reply(verbatim=True)`), which delegation, a
  firing and an `@` bubble already display. A ledger that cannot be read
  does NOT refuse — it runs, and says `unreadable` on the span, in the
  delegate result and on the page. Rounds come from the row, which is also
  the number the prompt states.
- **Memory scopes.** Recall asks the agent's own partition and, only when
  `read_shared_memory` is on, the owner's too — concurrently, under ONE
  span, with the 2 s timeout never doubled and shared hits prefixed
  `(shared) `. The scope is DERIVED from the row inside `persona_for`, so
  the prompt's sentence and the wire can never disagree. Ingest only ever
  reaches the agent's own scope.
- **Her own tools.** `create_agent`, `update_agent`, `delete_agent`,
  `list_agents`, `delegate_to_agent` — the same one writer and validator
  the page uses, so nothing is operator-only (v3 dropped `fallback_model`
  silently; a test pins that the tool's parameter names equal the API's
  field names). Registry 26 → 31.
- **Pages.** `/agents` roster (state pill, spend, last active) and
  `/agents/<name>` (facts header, Edit/Delete, Traces / Artifacts / Log
  tabs). Sidebar entry between Schedules and Files. Activity badges agent
  turns and shows the routed role; Schedules gained "runs as"; Routing
  labels `agent_<name>` and offers Remove only for a stray row.

## Which line of code refuses when the model is wrong

- An AST pin: `_run_turn`, `_deferral_redirect` and `_regen_rejected_by`
  contain ZERO bare registry reads. A missed persona site would feed a
  guard the whole registry and "correct" an agent's honest "I do not have
  that tool" into a lie.
- A call outside the subset still RUNS and the span says `outside_subset`
  (the subset is scope, not permission), but a call to a tool that does not
  exist is answered from the agent's own subset, not from the 31-name
  registry that contradicts its prompt.
- `guards.delegation_claim_check`: `narration_check` only ever sees first
  person, so "coder wrote hello.py" was invisible to every guard. Now an
  agent name followed by a completed-action verb (or "written by coder") is
  a claim, backed only by a successful `delegate_to_agent` span this turn —
  or, for work the conversation itself records (an earlier `@` turn or an
  earlier successful delegation), by that record. A delegate call REFUSED
  before any run is not a run that failed. On an agent's own turn its own
  name is checked under narration's rule and corrected in the first person.
- `create` / `update` / `delete` read the row and the folder back before
  saying so, state the gateway route outcome instead of swallowing it, and
  roll the row back when the folder cannot be made.
- `refuse_person_write`: an agent has no people row, so `create_timer` and
  `cancel_timer` refuse in words rather than hitting a foreign key. A
  missed site still fails STATED through dispatch's `Error:`.
- `traces.DOING` is process-local by design: a stored "working" flag would
  lie the moment the process died (the INFLIGHT lesson).

## Pins that moved, and why

- `test_tools_registry` 26 → 31 (the five agent tools).
- Gateway `test_routing`: the two `vibes → 400` cases moved to `Vibes-1` —
  a `ROLE_RE`-valid name is now an accepted derived role.
- `test_proxies` ROUTES +1 (`DELETE /api/v1/routes/{role}`), plus a test
  that an unknown agent role is refused by core before the gateway.
- Message key set (+`agent`, +`delegations`) in `test_timers_api` and a new
  `MESSAGE_KEYS` pin; activity `TURN_KEYS` (+`agent`, +`role`); timers
  `ROW_KEYS` (+`agent_id`, +`agent`); `test_chat`'s meta key set (+`agent`).
- `test_scheduler`'s exact-kwargs pin for a PLAIN timer is unchanged; the
  agent case is pinned beside it.
- NOT moved, by design: `test_no_approvals` (all pins), `test_settings`
  KNOWN_KEYS, `test_eval_corpus` (16 ids, suite_version 7 — a delegation
  case needs a `setup.agents` fixture hook first; carried).

## The live walk (2026-09-08), and the two things it caught

Deployed from the branch's commits; migration 021 applied at core startup.
Everything below was asked in chat, in her words, and read back from the
trace and the tables — never from her reply.

- She created `coder` herself from one sentence (one `create_agent` span,
  ok), wrote its instructions, and the row, the folder, the `agent_coder`
  route and the `agent.created` governance event were all there.
- Delegation ran end to end: ONE `delegate_to_agent` span on her turn with
  `meta.facts` naming the child turn and `files: ["haiku.md"]`; the child
  turn (`kind agent`, `agent_coder`, `model ''`, the owner's `person_id`)
  wrote the file and read it back; she relayed the haiku. Her page showed
  the turn under Traces, the file under Artifacts, the brief and report
  under Log.
- `@coder read haiku.md back to me`: the user row stored verbatim, the
  reply badged `coder` on reload, the ledger metering 7 rounds under
  `agent_coder`, and the exchange in the AGENT's memory partition — not
  the owner's.
- A scheduled timer bound to `coder` fired as the agent and wrote the file;
  the timer stayed the owner's.
- Cap: at $0.00 the turn ended before any model round (the `agent_cap` span
  is the ONLY span) with the statement persisted verbatim; raised to $5.00
  it ran again.
- Deleting the agent paused its bound timer with "paused: agent coder was
  deleted", removed the route, left the folder and the log, and left the
  seven earlier turns carrying `role agent_coder` with no name.
- `@nobody` fell through to an ordinary Nova turn that said there is no
  such agent, with no fabricated call.
- Asked "what did coder do earlier?" after all of that, she recounted five
  true things across a delegation, an `@` turn and a firing — and NO
  delegation-claim correction fired. That exemption was a confirmed review
  finding before the walk; the walk is where it was proven.

**Two guard defects the walk caught, both fixed here:**

1. **She disowned delegation.** Asked to hand the task to the agent she had
   just created, she answered "that capability isn't in my toolset right
   now" — with `delegate_to_agent` in her advertised list and the roster
   line naming `coder` in the same prompt. The capability guard already
   contradicts a false denial; its phrase table simply had no entry for the
   five new tools. Added. The verdict still reads the live list the caller
   was given, so the same sentence stays honest from an agent (whose subset
   can never contain `delegate_to_agent`).
2. **A scope limit read as a disowned capability.** "I can't write files
   outside my folder" is TRUE — the tool exists and `_resolve_within`
   refuses the path — and the guard was correcting it with "I can do that",
   telling the owner the opposite of the fact and replacing the agent's
   honest answer. Agents say that sentence constantly. A scope qualifier
   right after the capability phrase now makes the denial honest; a bare
   "I can't list files" is still corrected.

Both are the founding rule in its mirror form: the prompt carried the
truth and she contradicted it anyway, so the fix is a line of code.
