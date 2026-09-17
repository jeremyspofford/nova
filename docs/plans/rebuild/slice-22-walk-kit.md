# Slice 22 — the walk kit for the two deferred steps

The two steps deferred by Jeremy on 2026-09-14 ("Put the 'ask her about the
gpu once the game's off' for later") need his own session with the card free.
Nothing here can be run by a Claude session: curling the route proves nothing
about her, and this container has no stack at all.

So this is the kit — the question, the query, and the pass condition — written
so the walk costs one conversation and produces a verdict rather than an
impression.

**Written 2026-09-17 against `main` at `0996a31`.** The wiring below was read
in code, not assumed; every claim carries its file and line. Nothing in this
file has been executed.

---

## Before you start

The card must be free, or step 1 measures the wrong thing and step 2 cannot
run. Step 2 wants the opposite — it needs the card contended — so the two
steps want different days. Read the whole file before starting either.

All queries assume the compose project is up and use the same access path as
`tools/where-did-that-come-from.sh:26`:

```bash
PG='docker exec nova-postgres-1 psql -U postgres -d nova_core -tAc'
```

---

## Step 1 — does she reach for the tool when the question is about the GPU?

### The wiring, verified

- `inference_health` is registered: `services/core/app/tools/inference.py:161`,
  reaching the registry through `*inference.TOOLS` at
  `services/core/app/tools/__init__.py:94`.
- It is pinned in the registry snapshot at
  `services/core/tests/test_tools_registry.py:180` and `:540`, so it cannot
  fall out silently.
- Every registered tool is advertised — `advertised_tools(names=None)` defaults
  to `tool_names()`, the whole registry
  (`services/core/app/tools/__init__.py:170-192`). There is no grant, no
  allow-list, and nothing to forget to switch on (owner ruling 2026-09-03).
  The v3 failure this check was written for — a tool built and never granted —
  **cannot happen in v4 by construction.**

### The trap this walk now has, which the 2026-09-14 note did not know about

The carries file says: *"read `turn_spans` for that turn: `inference_health`
should appear as a tool span"*. That condition is **no longer sufficient.**

`inference_health` is in `live_facts.AUTO_RUN`
(`services/core/app/live_facts.py:93`), so the BACKEND may run it on its own
initiative — when a recalled note names a live source, the check runs before
she is asked anything (`live_facts.py` module docstring). A note saying "the
3090 has 24GB" is exactly such a note, and a GPU question is exactly the turn
that recalls it.

The span it files is a **real tool span** — same kind, same name, same args,
deliberately (`live_facts.py:216-223`), so it is indistinguishable from her
own call except for one key:

```python
span.meta["unasked"] = True     # live_facts.py:236
```

`unasked` is set at that line and **nowhere else** in the service (checked
across `services/core/app/*.py`). A call she chose to make has no `unasked`
key at all.

**So the pass condition is an `inference_health` span WITHOUT `meta.unasked`.**
A span carrying `unasked: true` means the backend ran it because a note named
it — which is the live-facts feature working correctly, and proves nothing
about whether she reaches for the tool.

### The walk

Ask in chat, in your own words, with the card free. Something like:

> what's the GPU doing right now?

Do not name the tool. Naming it tests whether she can follow an instruction,
which was never the question.

### The query

```bash
$PG "
SELECT to_char(started_at,'HH24:MI:SS') AS at,
       (meta ? 'unasked')               AS backend_ran_it,
       meta->>'ok'                      AS ok,
       duration_ms,
       left(meta->>'result_head', 160)  AS head
  FROM turn_spans
 WHERE kind = 'tool'
   AND name = 'inference_health'
   AND started_at >= now() - interval '10 minutes'
 ORDER BY started_at DESC"
```

`turn_spans` is `(id, turn_id, kind, name, started_at, duration_ms, meta)` —
`services/core/migrations/002_core_schema.sql:57-65`.

### Pass / fail

| Result | Verdict |
|---|---|
| A row with `backend_ran_it = f` and `ok = true` (`meta.ok` is a jsonb bool, so it prints `true`/`false`) | **PASS** — she reached for it herself. |
| Only rows with `backend_ran_it = t` | **INCONCLUSIVE** — the backend answered from a recalled note before she chose anything. Re-run the walk in a conversation whose recall does not surface a hardware note, or clear the note first. Not a failure of hers. |
| No rows at all | **FAIL** — the question was about the GPU and she did not look. That is the S22 premise not holding, and it is a finding. |

Then check the reply carried the card's **real** numbers, not a recalled note's:
`lines()` puts the live answer first and labels the note as history
(`live_facts.py:26-29`), so if both were present she had the live one in front
of her.

---

## Step 2 — does a second walled round raise the Inbox item?

### The wiring, verified

- `MIN_STALLED_ROUNDS = 2` — `services/core/app/model_speed.py:199`.
- A round counts as walled when its `llm_call` span has
  `timeout_phase = 'read'` **and** `completion_chars = 0`
  (`model_speed.py:214-226`, `_STALLS_SQL`).
- The recent window is `RECENT_HOURS = 2` (`model_speed.py:90`) — both walled
  rounds must fall inside it.
- The finding fires from `hard_stops` where `walled >= MIN_STALLED_ROUNDS`
  (`services/core/app/checks/inference.py:202`) and is keyed
  `inference_stalled:<model>` (`services/core/app/checks/inference.py:174`).
- Folding is by finding key, and `services/core/app/checks/inference.py:51` states the same-news
  rule explicitly.

### The walk

This one needs the card **contended** — play the game. Then use Nova until two
rounds wall inside the same two hours. One walled round is already on record
from 2026-09-14; it is outside the window now, so this needs two fresh ones.

### The query — confirm two walled rounds are actually counted

```bash
$PG "
SELECT meta->>'model' AS model,
       count(*) AS rounds,
       count(*) FILTER (
         WHERE meta->>'timeout_phase' = 'read'
           AND coalesce((meta->>'completion_chars')::int, 0) = 0
       ) AS walled
  FROM turn_spans
 WHERE kind = 'llm_call'
   AND started_at >= now() - interval '2 hours'
   AND meta ? 'model'
 GROUP BY 1"
```

That is `_STALLS_SQL` verbatim with the interval inlined, so it counts exactly
what the check counts.

### Then the notice

```bash
$PG "
SELECT finding_key,
       state,
       repeats,
       to_char(first_seen_at,'MM-DD HH24:MI') AS first_seen,
       to_char(last_seen_at, 'MM-DD HH24:MI') AS last_seen,
       coalesce(to_char(cleared_at,'MM-DD HH24:MI'), '-') AS cleared,
       left(title, 120) AS title
  FROM notices
 WHERE finding_key LIKE 'inference_stalled:%'
 ORDER BY first_seen_at DESC LIMIT 5"
```

The columns are `finding_key` / `first_seen_at` / `last_seen_at` / `repeats` /
`cleared_at` (`services/core/migrations/022_proactive.sql:37-84`) — there is no
`key` or `created_at` on this table. **`repeats` is the fold counter**: a
second beat that finds the same condition bumps it instead of writing a new
row, so `repeats > 1` with one row IS the fold, observed directly.

### Pass / fail

| | Expected |
|---|---|
| **Raises** | `walled >= 2` for the model → a notice keyed `inference_stalled:<model>` naming both the walled count and how much of the card is held by something that is not ollama (`services/core/app/checks/inference.py:146-174`, `_busy_clause` at `:177`). |
| **Folds** | The next beat does not write a second row for the same `finding_key`; it bumps `repeats` and `last_seen_at` on the existing one. |
| **Clears** | When the card frees and the window empties, a beat that actually RAN the check sets `cleared_at` (`022_proactive.sql:74-81` — only a check that ran may clear its own notices). |

If it raises but the card attribution is wrong — the "something that is not
ollama" clause naming nothing while a process outside every container holds
the VRAM — that is a separate finding and belongs to the contention item, not
to this check.

---

## What this walk cannot settle

The contention itself. A process outside every container has held ~7.3 GB and
99% of the shader cores on 2026-09-12, 09-14 and 09-15. After this walk she
can SAY it accurately. Nothing stops it, and by the 2026-09-03 ruling nothing
in v4 may decide to route around it on the owner's behalf — that conversation
belongs to S10's mode switch.
