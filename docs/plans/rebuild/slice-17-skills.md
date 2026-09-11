# Slice 17 — Skills: a procedure she wrote down, and the record of whether it helped

Branch `slice/s17` in `.worktrees/s17`, cut from `rebuild/v4` at 423ef936 (the
merge that finally carries S15 chat control and S16 workspace delete).

## The gap

"Skills" already exist in this codebase and they are barely a feature. An
agent row carries a `skills text[]`; each name resolves to a markdown file at
`<WORKSPACE_ROOT>/skills/<name>.md`; the file's text is pasted into that
agent's instructions block. That is the whole of it. There is no record of
where a procedure came from, no way to know whether one was ever read, no way
to know whether reading it changed anything, no lifecycle, no page, and Nova
herself — `persona=None` — cannot use one at all.

So the household's only mechanism for "she learned how to do this" is: the
owner writes a file into a docker volume by hand, and hopes.

The master roadmap asks for markdown procedures with provenance, an outcome
ledger, a draft/active/flagged/retired lifecycle, steps distilled from the
trace, and a with-and-without replay that proves a skill earned its place.
None of that exists.

## Decisions with Jeremy (2026-09-11)

**A skill is procedure text, and the honesty is in the measurement.** Three
shapes were on the table: prose injected into the turn, a recorded tool
sequence the runner replays, or both. He chose the first. A recorded sequence
binds only when the new request has the shape of the old one, and binding
arguments out of a sentence is itself a model decision, so the "control" would
sit exactly where the model already is. Prose cannot force her to follow it —
which is why nothing here asserts that a skill helped. A skill stays draft
until a measured run says it changed the outcome, and the ledger is what flags
one that stops helping.

**Scripting is the next slice, not this one.** He asked whether a skill with
repeatable steps should become a script: fewer round trips, fewer tokens, a
deterministic and idempotent procedure. The win is real and the objection is
the trace. Every honesty control in v4 reads `turn_spans` — the narration
check, the capability verifier, the delegation facts line — and a shell script
that moves files produces ONE span holding stdout, with the per-step record
gone. There is also no executor: core has no sandbox, and the only exec path
in the stack is `device_run` (novad `shell.exec`) on a paired machine, outside
the stack's own containment. The shape to build later is a script whose steps
dispatch through the tool registry, so the model leaves the middle of the loop
and every step is still a span. Deferred deliberately: the ledger this slice
builds is what will say WHICH skills fire often enough to be worth scripting,
and right now nobody knows, because nothing has ever recorded a skill being
used.

**Creation is the beat and the page. She does not get a save-skill tool.**
He picked both of the mechanical paths and left out the one where she decides
mid-chat that something is worth keeping. Two consequences, stated rather than
discovered later: nothing exists until the beat notices a REPEAT, so a
procedure is never captured the moment it first works; and a one-off worth
keeping can only become a skill if the owner writes it. Both are acceptable
because the alternative put the judgement in the model.

**The body is a file; the record is a row.** The markdown stays at
`<WORKSPACE_ROOT>/skills/<name>.md`, where the agents code already looks and
where the owner can edit it by hand like a memory note. The row carries what a
file cannot: status, provenance, the ledger, timestamps.

**She reads a roster, not the bodies.** Active skills reach the prompt as one
line each, name and summary. The body arrives only when she calls
`load_skill`. Context stays cheap, and — the reason that matters — "she used a
skill" becomes a SPAN rather than something inferred from the shape of a
reply.

## What gets built

### 1. The rows (migration 025)

```
skills
  id          uuid pk
  name        text unique  CHECK ~ '^[a-z][a-z0-9_-]{0,47}$'   -- the file stem
  title       text not null
  summary     text not null          -- the one line the roster shows
  status      text not null CHECK IN ('draft','active','flagged','retired')
  created_via text not null CHECK IN ('beat','page')
  source_turn_ids uuid[] not null default '{}'   -- provenance, no FK (turns are swept)
  step_names  text[] not null default '{}'       -- the tool sequence, code-composed
  flagged_reason text
  created_at / updated_at timestamptz
```

```
skill_uses
  id        uuid pk
  skill_id  uuid references skills on delete cascade
  turn_id   uuid references turns on delete set null
  loaded_at timestamptz
  -- written back when the turn ends, from that turn's spans and nothing else
  failed_calls  int
  guard_fires   int
  outcome_known boolean not null default false
```

`outcome_known` exists because a turn that was stopped, or that died on a
transport failure, leaves an incomplete span record, and a use whose outcome
was never observed must not be counted as a clean one. A ledger that treats
"we did not look" as "it went fine" is the failure shape this repo keeps
finding.

No FK on `source_turn_ids`: turn retention sweeps rows, and a skill must not
be deleted or silently emptied because its evidence aged out. The Skills page
resolves what still exists and says plainly when a source turn is gone.

### 2. `app/skills.py` — the module

Reads and writes the rows, resolves bodies from disk, and composes a draft.
The composition rules are the load-bearing part:

- **Steps come from `turn_spans`.** `steps_from_turns(pool, turn_ids)` reads
  the tool spans of the source turns in order and returns their names. A skill
  can therefore never describe a call that never ran — the same rule as the
  distillation notes and the delegation facts line.
- **The summary is composed from the source requests.** The user message of
  each source turn, quoted and dated. It is honest ("asked as: …"), it is the
  best available matching signal, and no model wrote it.
- **A draft is entirely code-composed.** Title from the tool sequence, summary
  from the requests, steps from the spans. No model call is involved in
  creating a skill, on any path. Prose is what the OWNER adds when they edit;
  until then the skill says exactly what the trace says and nothing more.
- **A row whose file is missing is unusable**, and `load_skill` says so by
  name. It never resolves to an empty procedure. (The existing
  `agents.skills_status` already treats a missing file this way; this makes
  the same rule true for Nova.)

### 3. The turn path

- `skills.roster_line(pool)` returns one line per ACTIVE skill: name and
  summary. It joins `volatile_system_prompt` beside the agent roster (S12's
  `roster`), and is None when there are no active skills, so a stack with none
  produces a byte-identical prompt to today's. Pinned by a test against HEAD.
- `load_skill(name)` — a new tool in `tools/skills.py`. Returns the body, or a
  refusal naming what is wrong (no such skill, not active, file missing). Its
  span is the record of use.
- Drafts, flagged and retired skills are never in the roster. `load_skill`
  refuses them by status, so a name she remembers from a previous turn cannot
  reach a retired procedure.
- An agent's `skills` array resolves through the same module, so an agent gets
  ACTIVE skills only and a retired one stops reaching its prompt. The file on
  disk is unchanged, and an agent naming a skill with no row keeps working as
  before (the file is the fallback) — S12's behaviour is not broken by this
  slice.

### 4. The ledger

When a turn ends, for every `load_skill` span in it, a `skill_uses` row is
written with the turn's own counts: failed tool calls, guard corrections that
fired. `outcome_known` is false for a stopped or failed turn.

A skill moves to `flagged` when 3 of its last 5 known-outcome uses carried a
failed call or a guard fire. The threshold is a setting, the transition is
code, and the reason is written onto the row in words. Nothing here decides a
skill HELPED — the ledger only ever raises a hand.

### 5. The trial (draft → active)

`skills.trial(app, pool, skill, model)` builds a `Case` in memory from the
skill's first source request and runs it twice through the existing eval
runner: once with the skill active, once without. `cases.Case` gains a
`skills` fixture field, the exact analogue of S12's `agents` field, so the
runner activates the named skills before the turn and restores their status
after — and so a permanent eval case can declare one too.

What the trial reports is mechanical: whether `load_skill` was called, the
number of tool calls, the number of failed calls, the wall time, and the
turn's own contract result. It is shown on the page as two columns. The owner
activates or does not. A later slice may automate promotion; this one does not
pretend a two-run sample is a measurement of quality (see
[[one-sample-is-not-a-measurement]] — the trial states N and the page says so).

### 6. The beat check — `app/checks/skills.py`

A new check family, `repeated_procedure`. It reads tool spans from the last
fourteen days grouped by turn, builds each turn's tool-name sequence, and finds
sequences of length >= 3 walked in more than one of the owner's turns,
excluding turns that already loaded a skill and sequences a skill already
covers. It returns a `Finding` whose `key` is `repeated_procedure:<hash of the
sequence>` and whose `facts` are the sequence, the turn ids and the count.

**The check writes nothing.** `app/checks/__init__.py` says a check is code
that reads rows or sockets and returns findings, and that contract is why a
finding is safe to wake someone with. The draft is created from the notice's
facts by `POST /api/v1/skills {from_notice}` — the Inbox item links to the
Skills page with the notice id, and one click composes the draft from the
facts the check recorded. Owner-initiated, still entirely code-composed.

It declares `urgent=False`. The fingerprint rules of S11 do the rest: the same
repetition folds onto its notice instead of speaking twice.

### 7. The Skills page

`/skills`, in the nav beside Agents. A list of every skill with its status,
and a detail view with the body (editable), the summary, the step list, the
source turns as links into Activity with a plain sentence when one has been
swept, the ledger counts, the trial results, and the buttons that move status:
Activate, Flag, Retire, Delete. Creating one by hand is the same form with an
empty body.

API: `GET/POST /api/v1/skills`, `GET/PATCH/DELETE /api/v1/skills/{name}`,
`POST /api/v1/skills/{name}/trial`. Owner-authenticated like every other
admin surface.

## What refuses when the model is wrong

Stated as CLAUDE.md asks, one line per control:

- A skill's steps are read from `turn_spans`, so a procedure cannot name a
  call that never ran.
- A skill's summary is quoted from the owner's own message rows.
- `load_skill` refuses a draft, flagged or retired skill by status, so prose
  she remembers cannot reach a procedure that was withdrawn.
- A row whose file is missing refuses instead of resolving to nothing.
- The ledger's outcome is computed from the turn's spans, never from the
  reply, and a turn whose outcome was not observed is not counted as clean.
- The roster is derived from the table at prompt build, so a retired skill
  leaves the prompt by that fact alone.

## Out of scope, on purpose

- **Scripted skills.** The next slice, with the executor question answered.
- **A save-skill tool for her.** The owner's call; revisit if the beat proves
  too slow at noticing.
- **Automatic promotion on a trial.** Two runs is not a measurement.
- **Per-person skills.** Skills are the household's, like agents. Partitioning
  waits for S8's people work.

## Definition of done (walked, not tested)

1. The beat proposes a draft from a procedure she actually repeated, and the
   Inbox item links to it.
2. The owner opens the draft, sees steps that match Activity for the source
   turns, edits the prose and activates it.
3. In a real chat turn, asked to do that thing again, she calls `load_skill`
   and the trace shows it, and the reply reflects the procedure.
4. Retire it, ask again, and the roster no longer names it and `load_skill`
   refuses.
5. A trial on a draft reports both columns with a real difference in the call
   count.

Every claim above checked against `turn_spans` by `turn_id`, and the files
checked on the volume.

---

## Verification (walked 2026-09-11 on the deployed stack)

Core and web rebuilt from `.worktrees/s17` into the live `nova` stack;
migration 025 applied at startup. Every turn below is the real chat route as
the owner, and every claim is checked against `turn_spans` by `turn_id`.

| Turn | Asked | Ran |
|---|---|---|
| `5cb76ffb` | list the workspace, write walk-notes-1.md, read it back | list → write → read |
| `783f8bcc` | "do that again please" for walk-notes-2.md | list → write → read |
| beat fire | — | `skills_repeated_procedure` raised: the shape, walked in 2 turns |
| `70d42164` | "same thing again for walk-notes-3.md please" | list, **load_skill**, write, read |
| `8defbdea` | "one more time please, walk-notes-4.md" | **load_skill**, list, write, read |
| `ddd2a191` | same again, with the skill RETIRED | `load_skill` **refused**, then the work by hand |

The last row is the one worth keeping. With the skill retired the roster no
longer named it, and she called for it anyway — from the conversation, where
she had used it twice. The tool refused by status in as many words ("the skill
… is retired, not active, so it is not a procedure to follow") and the ledger
recorded no use, which is exactly the difference between a lifecycle held by a
prompt and one held by a row.

### Two defects the walk found, both real, neither caught by a test

**The summary was empty, and the summary is the whole matching signal.** The
first draft composed on the live stack said `asked as: (no request recorded)`.
`requests_from_turns` read `messages.turn_id`, and a USER row never carries one
— migration 018 added that column for the assistant row's served-by badge and
says so in its first line. The unit test passed because its fixture stamped a
column the product does not stamp: a test measuring a world that cannot exist,
the same shape as the eval-fixture lesson in S12. The request is now found by
CONVERSATION AND TIME (the newest user row at or before the turn opened, which
is the row `chat_stream` inserts immediately before `traces.open_turn`), and
the fixtures build the rows the product builds.

**Every turn counted as rough.** Her first real use of a skill was recorded as
having gone badly on a turn where nothing went wrong, because the ledger
counted every `guard` span as a correction. Most guard spans exist only
because a guard fired — the span is filed inside the `if correction is not
None` — but the responsiveness judge files one whenever it RUNS, and says so
on the span (`checked`). Five such uses would have flagged a healthy
procedure. `skills.guard_fired` now reads what the span says about itself, so
a future guard that wants the same treatment self-registers by writing the
same marker.

Both were found by asking her to do the thing, not by reading the code.

### Not exercised live

The trial (`POST /skills/{name}/trial`) is covered by its own test with a
scripted gateway and not by this walk: it runs two real turns against the
household's model and the walk's skill had one source request worth replaying,
which would have written two more walk-notes files into the owner's workspace.
