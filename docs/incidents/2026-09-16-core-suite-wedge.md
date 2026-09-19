# The core suite wedges at ~12%, 2026-09-16 — ROOT-CAUSED and fixed 2026-09-18

**Status: RESOLVED 2026-09-18 (item 0).** The resolution, measured, is the
next section. The rest of the document is the 2026-09-17 read-only analysis,
kept as written: its Hypothesis A (a timed-out teardown skipping
`close_pool`) and B (TRUNCATE blocked by a leaked connection) were NOT the
cause, and its guess that the wedge was a blocked await was wrong in kind: it
was a busy spin.

## Resolution (2026-09-18, measured)

**The wedge was `drain_background()` spinning, synchronously, over one
finished task.**

```python
while _BACKGROUND:
    await asyncio.gather(*list(_BACKGROUND), return_exceptions=True)
```

- `_spawn` removes a task from `_BACKGROUND` with a done-callback
  (`task.add_done_callback(_BACKGROUND.discard)`). A done-callback runs on the
  loop's NEXT iteration, so "finished, still in the set" is a normal state for
  one iteration.
- Since CPython 3.12, `asyncio.gather` over children that are ALL already done
  completes **eagerly**: it runs its done-callbacks synchronously and returns a
  finished future. Awaiting a finished future does not yield to the loop.
- Enter `drain_background` in that one-iteration window and the `while` loop
  never yields again: the loop never runs, so the queued `discard` never runs,
  so the set never empties. The conftest's `asyncio.wait_for(..., timeout=15)`
  could not fire either: a timeout needs the loop too. That is why the suite
  hung for ever with no output, and why it moved from test to test (a timing
  window, not a test).

**How it was found** (probes in the session scratchpad, never product code):

1. `pytest-timeout --timeout-method=thread` named the test: `test_chat_mention.py::test_a_leading_mention_runs_the_whole_turn_as_the_agent`, inside its own `await chat.drain_background()`. The same file alone: 7 passed in 4.6 s. So the state came from earlier in the run.
2. A plugin recording `chat._BACKGROUND` at every test's start found **nothing leaked between tests**. The hang was in-test. It moved to `test_chat.py`, then `test_chat_bare_intent.py`, then `test_chat_honesty.py`, then `test_chat_deferral.py`: never the same test twice, every time a `drain_background()` call.
3. The main thread's stack at the timeout ended on `while _BACKGROUND:` itself, so this was a spin, not a blocked await.
4. Wrapping `drain_background` to log each round showed one `drain_queue` task (spawned from `_run_turn`'s `finally`, chat.py:5103), `done=True`, no exception, not cancelled, on the running loop, for 3,000 rounds.
5. Keyed by weak reference to the task object (not `id()`, which CPython reuses): neither of its done-callbacks had run. Both handles, `set.discard` and the probe's own, were sitting **uncancelled in the running loop's `_ready` queue**. The loop was never iterating.

**The fix** (`app/chat.py`, `drain_background`): gather only tasks that are
still running, and when only finished ones remain, `await asyncio.sleep(0)` so
the loop runs once and the queued discards land. Pinned by
`tests/test_chat_background.py`, which builds the exact state (a finished task
still in the set) and counts gather rounds instead of relying on a timeout that
cannot fire. Red before the fix: 101 rounds, 0.07 s. Green after.

**Not only a test bug.** `main.py`'s lifespan calls `drain_background()` at
shutdown, so a stop that landed in the same window would have spun until
Docker's SIGKILL after `stop_grace` (330 s), losing whatever the drain was
meant to let finish.

**A guard so it cannot be silent again:** `pytest-timeout` is a dev dependency
with `timeout = 120`, `timeout_method = "signal"` in `pyproject.toml`. SIGALRM
interrupts a blocked await AND a Python-level spin, fails that test by name,
and the rest of the suite still runs.

**Two stale pins the wedge had hidden**, both from slices that merged on
targeted suites while the full run could not finish:
- `test_chat_agents.py::test_recall_asks_one_partition_or_two_under_one_span`
  predates `recalled` on the recall span (f0693c35, 2026-09-16), which moved
  `test_chat.py`'s pin and missed these two.
- `test_timers_api.py::test_messages_carry_turn_kind_…` predates S28's
  `attachments` key on every message row (conversations.py:401).

**Full-suite runs after the fix** (the suite has 2,957 tests):

| Run | Result | Time |
|---|---|---|
| 1 | 2,956 passed, 1 failed (the `attachments` pin) | 13:22 |
| 2 | 2,956 passed, 1 failed (same pin; collected before its fix) | 15:27 |
| 3 | **2,957 passed** | 13:11 |
| 4 | **2,957 passed** | 13:19 |

Runs 3 and 4 are the final code, back to back, against a scratch database on
`nova-scratch-pg`. The suite has not been able to finish since S25.

**Found in passing, not fixed here:** `queued.next_waiting_conversation`
(queued.py:101-107) filters `claimed_at IS NULL` but not
`cancelled_at IS NULL`, while `any_waiting` and `claim_next` filter both. A
cancelled row in another conversation sends every drain on a wasted claim
attempt. It is harmless (`claim_next` re-checks) but inconsistent. Carried.

---

## What was observed (from slice-28-attachments.md)

- The full core suite wedged at about 12%, in the chat tests, three times on
  2026-09-16.
- One run **ignored the SIGTERM from its own `timeout`**.
- It first appeared while S25 was being gated, *before* S28 began — so it is
  not S28's defect.
- Consequence: no slice can show a full-suite green. S28 merged on targeted
  suites (187 tests) and six live walks instead.

"About 12%" is consistent with position: `services/core/tests/` holds 98 test
files, collected alphabetically, and `test_chat*.py` begins at the ninth
(`test_activity`, `test_agents`, `test_agents_api`, `test_attachments`,
`test_attachments_api`, `test_auth`, `test_beats`, `test_capability_guard`,
then `test_chat.py`).

## Fact 1 — nothing bounds a hung test

`services/core/pyproject.toml` declares the dev group as
`ruff`, `pytest`, `pytest-asyncio`, `pyyaml`. **There is no `pytest-timeout`.**
`[tool.pytest.ini_options]` sets `asyncio_mode = "auto"`, `pythonpath`, and
`testpaths` — no global timeout of any kind.

So a single await that never returns hangs the process forever, with no output
naming the test it died in. That is not the cause, but it is why the cause is
invisible, and it is the cheapest thing to fix first.

It also explains the ignored SIGTERM: `timeout` signals the process group, and
pytest's handler defers teardown to the end of the current test — which is the
test that never ends.

## Hypothesis A (strongest) — the pool outlives its event loop

`services/core/tests/conftest.py:96-120`:

```python
p = await db.init_pool()
...
try:
    yield p
finally:
    await asyncio.wait_for(chat.drain_background(), timeout=15)
    await db.close_pool()
```

The fixture's own comment (`conftest.py:105-106`) states the invariant:

> The pool belongs to this test's event loop, so it is built and torn down per
> test rather than shared.

**The `finally` can violate that invariant.** The two awaits are sequential. If
`asyncio.wait_for(...)` raises `TimeoutError` at 15 s, **`db.close_pool()`
never runs.**

And `db._pool` is a module global (`services/core/app/db.py:14`) with
`init_pool()` guarded by `if _pool is None` (`db.py:26-31`). So the next test
calls `init_pool()`, finds `_pool` **not** None, and is handed a pool whose
connections are bound to the **previous test's event loop** — which
`pytest-asyncio` in auto mode has already closed.

An asyncpg pool used from a different, dead loop does not fail fast. Its
futures are attached to a loop that will never run again, so the first query
that needs a fresh connection awaits something nothing will ever complete. The
suite stops with no error, in whichever test first touches the DB.

Once tripped, every later test inherits it — which fits a wedge that reproduces
at roughly the same place three times running.

### What makes this reachable: `drain_background` need not terminate

`services/core/app/chat.py:472-475`:

```python
async def drain_background() -> None:
    """Wait for everything fired and forgotten so far."""
    while _BACKGROUND:
        await asyncio.gather(*list(_BACKGROUND), return_exceptions=True)
```

The loop re-checks `_BACKGROUND` after each gather. If the tasks it just waited
on themselves fired new background work — which is the normal shape here: a
turn's trace close queues a memory ingest, an ingest queues a distillation —
the set is non-empty again and it goes round. There is no bound on the number
of rounds and no deadline inside the function.

The codebase already knows this function is dangerous. `settle_detached`'s
docstring, thirteen lines below it (`chat.py:484-487`), says so outright:

> **Never `drain_background()`**: the caller is often itself one of
> `_BACKGROUND`'s tasks … and a task that gathers the whole set gathers
> ITSELF — a deadlock, hit the first time an eval job ran detached.

That warning is about production callers. The test fixture calls
`drain_background()` on **every single test** (`conftest.py:119`). It is
protected by the 15 s `wait_for` — and that protection is exactly what skips
`close_pool()`.

So the 15 s timeout does not rescue the suite; it converts a slow teardown into
a corrupted global.

### Why the chat tests specifically

They are the tests that generate background work. `test_chat.py:608-910` drives
full turns through the ASGI app with a `FakeGateway` held open by an
`asyncio.Event` — including
`test_a_hard_refresh_mid_turn_finishes_server_side_with_the_full_reply`
(`test_chat.py:608`), whose entire subject is work that **deliberately outlives
the request**. That is the densest concentration of detached tasks in the
suite, and it sits exactly where the wedge is reported.

## Hypothesis B — `TRUNCATE` blocks on a lock a leaked connection holds

`conftest.py:113` runs, per test:

```python
await p.execute(f"TRUNCATE {', '.join(_TABLES)} RESTART IDENTITY CASCADE")
```

`TRUNCATE` takes `ACCESS EXCLUSIVE` on every named table and **waits
indefinitely** for it. Postgres applies no `statement_timeout` unless one is
set, and `_configure` (`db.py:17-21`) sets only a jsonb codec — no timeout.

A connection leaked by Hypothesis A, left idle-in-transaction or simply holding
a read lock, is enough to block that TRUNCATE forever. A and B are the same
failure seen from two ends, which is why fixing A may be sufficient.

## Hypothesis C (weaker) — an unset `asyncio.Event`

`test_chat.py` uses bare `await <Event>.wait()` inside ASGI `receive()`
callbacks at `:637`, `:691`, `:738` and `:779`. If the producing `send()`
never observes the delta that sets the event, those await forever.

Ranked last because the four call sites checked are each reached through
`await asyncio.wait_for(app(...), timeout=10)` (e.g. `test_chat.py:643`), so
the outer bound should fire. Worth confirming for the remaining ones rather
than assuming the pattern holds throughout.

## Probes, cheapest first

Each is a measurement, not a fix. None has been run.

1. **Make the wedge name itself.** Add `pytest-timeout` to the dev group and
   run with `--timeout=60 --timeout-method=thread`. The thread method kills a
   blocked C-level socket read, which `signal` will not. This alone converts
   "the suite wedges" into "this test wedges", and every hypothesis below gets
   cheaper.

2. **Test whether the pool survives a test.** Assert the invariant the fixture
   comment already states — that `db._pool` is `None` on entry:

   ```python
   assert db._pool is None, "a previous test leaked its pool"
   ```

   placed at the top of the `pool` fixture. If Hypothesis A is right, this
   reddens on the test *after* the first slow teardown, naming both.

3. **Ask whether the teardown is timing out at all.** Wrap the drain and log on
   timeout rather than swallowing it:

   ```python
   finally:
       try:
           await asyncio.wait_for(chat.drain_background(), timeout=15)
       except TimeoutError:
           logger.error("drain_background did not finish for %s", request.node.nodeid)
       finally:
           await db.close_pool()
   ```

   The nested `finally` is the actual fix for A regardless of what the probe
   says — `close_pool()` must not be skippable. Worth doing on its own merits.

4. **Ask postgres what is blocking.** While the suite is wedged, from another
   shell:

   ```bash
   docker exec nova-postgres-1 psql -U postgres -d nova_core -c "
   SELECT pid, state, wait_event_type, wait_event,
          left(query, 80) AS query,
          now() - state_change AS stuck_for
     FROM pg_stat_activity
    WHERE datname = current_database()
    ORDER BY state_change"
   ```

   A row in `state = 'idle in transaction'` next to one waiting on a `Lock`
   with a `TRUNCATE` query confirms Hypothesis B directly.

5. **Bisect the position.** `pytest -x -p no:randomly services/core/tests` and
   note the last test that prints. Then run `test_chat.py` alone — if it passes
   in isolation but wedges in the full run, the cause is cross-test state
   (A or B), not the test itself (C).

## Why this matters beyond one red suite

`CLAUDE.md` calls the pinned-expectation suites tripwires. A suite that wedges
is a tripwire that cannot fire — and by `decisions-2026-09-15.md:207`, CI is
disabled and git hooks are off (owner, 2026-09-07), so hand-running them is the
only place any of it runs at all.

S27's proposed flag tripwire assumes a suite that finishes. So does S26's
corpus, which leans hardest of all on the chat tests. This is upstream of both.
