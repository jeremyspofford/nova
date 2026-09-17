# The core suite wedges at ~12%, 2026-09-16 — hypotheses, not yet a root cause

**Status: UNCONFIRMED.** Written 2026-09-17 against `main` at `0996a31` by
reading the code only. The suite was **not run** — it is known to wedge, and
this container has no postgres to run it against. Everything below is a
mechanism argued from source with file and line. None of it is measured.

That distinction is the point: a plausible story told confidently is how the
journal poisoning cost an afternoon on 2026-09-16 (slice-28-attachments.md,
"the first diagnosis was wrong"). This document proposes probes; it does not
claim an answer.

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
