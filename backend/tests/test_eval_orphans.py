"""A live eval run must not be declared dead by somebody else's boot.

    docker compose exec backend python tests/test_eval_orphans.py

`reconcile_orphans` used to reap EVERY row with status='running', at every
startup, unconditionally. That is correct only while exactly one process
exists, and one never does: a test run, `python -m app.evals`, a second
container, another session — any of them booting the app was enough.

Measured 2026-08-04. A tournament run was executing `ingestion` against
`ollama:gemma4:12b` when another process started the app. Its row was marked
`error: interrupted by a backend restart`. No restart had happened, and the
run had not died — three minutes later it finished normally and recorded
`failed (2/6)`. The damage was not cosmetic: the tournament watches the row
to know when a model is done, so it moved on while the in-process slot was
still held, refused the remaining five models in one burst, and the night
measured one model of six.

So death is proven now, never assumed. A live run touches `detail->heartbeat`
every 20s and only a row that has missed several beats is closed out. These
are the properties that keep that true.

MIGRATION 124 CHANGED WHAT REAPING MEANS, and this suite was updated for it
deliberately rather than routed around. A run now persists a per-task cursor,
so the first answer to "this one stopped reporting" is to RESUME it; only a
run picked up MAX_RESUMES times and still dying is certified dead. Two
assertions moved as a result, both named at their site:

  * `reconcile_orphans` returns {"resumed", "parked", "leader"} rather than a
    bare count — it now does two things and the caller deserves to know which
    happened. §1's "nothing to close out reports nothing" reads `parked`.
  * the reap statement carries `resumes >= MAX_RESUMES`. §6 pins that clause,
    because without it the recovery is unreachable: every stale row would be
    closed out before anything could pick it up.

Nothing was weakened. The heartbeat evidence, the staleness window and the
ban on claiming an unobserved restart are all still asserted verbatim.
"""

import asyncio
import sys

sys.path.insert(0, "/app/backend")

from app import eval_runs                                     # noqa: E402

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


class Conn:
    """Captures the reap statement and the rows it claims to have closed."""

    def __init__(self, returns):
        self.returns = returns
        self.sql = ""

    async def fetch(self, sql, *args):
        self.sql = " ".join(sql.split())
        return self.returns

    async def execute(self, sql, *args):
        self.sql = " ".join(sql.split())
        return "UPDATE 1"


class Acquire:
    def __init__(self, conn):
        self.conn = conn

    async def __aenter__(self):
        return self.conn

    async def __aexit__(self, *a):
        return False


def reap(returns=()):
    """Drive the boot hook against a fake connection.

    `reconcile_orphans` returns {"resumed", "parked", "leader"} since
    migration 124 — it certifies AND recovers, and a bare count could not say
    which. Only the certify half runs here: this process holds no leadership,
    which is itself pinned in §5.
    """
    from app import db
    conn = Conn(list(returns))
    real = db.acquire
    db.acquire = lambda: Acquire(conn)
    try:
        out = asyncio.run(eval_runs.reconcile_orphans())
        return out, conn.sql
    finally:
        db.acquire = real


def main() -> int:
    print("1. the reap is bounded by evidence of death, not by status alone")
    out, sql = reap()
    check("it no longer closes every 'running' row it can see",
          "WHERE status='running' RETURNING" not in sql, sql[:90])
    check("it tests a heartbeat", "heartbeat" in sql, sql[-120:])
    check("...falling back to started_at, so a run that never beat once is "
          "still reachable", "COALESCE" in sql and "started_at" in sql)
    check("...and only past the staleness window",
          f"{eval_runs.STALE_AFTER_S} seconds" in sql, sql[-90:])
    check("nothing to close out reports nothing", out["parked"] == 0, str(out))
    check("a follower resumes nothing — leadership is the soft gate, the row "
          "lock in _claim_stale is the hard one",
          out["leader"] is False and out["resumed"] == 0, str(out))

    print("2. the window is several beats, so one slow query is not a death")
    check("staleness is a multiple of the heartbeat interval",
          eval_runs.STALE_AFTER_S >= 3 * eval_runs.HEARTBEAT_EVERY_S,
          f"{eval_runs.STALE_AFTER_S}s vs {eval_runs.HEARTBEAT_EVERY_S}s")

    print("3. it no longer claims a restart it cannot know happened")
    # The old text was "interrupted by a backend restart", written on rows
    # that no restart had touched. A message that states a cause it did not
    # observe is the same class of error as a capability claim.
    check("the recorded reason describes what was OBSERVED — silence",
          "restart" not in sql.lower(), sql[-140:])

    print("4. a run reports while it is alive")
    beat_sql = []

    class BeatConn(Conn):
        async def execute(self, sql, *args):
            beat_sql.append(" ".join(sql.split()))
            raise SystemExit  # one beat is enough for the test

    from app import db
    real, real_sleep = db.acquire, asyncio.sleep
    db.acquire = lambda: Acquire(BeatConn([]))

    async def _nap(_s):
        return None                      # do not actually wait 20s

    asyncio.sleep = _nap
    try:
        try:
            asyncio.run(eval_runs._heartbeat("11111111-1111-1111-1111-111111111111"))
        except SystemExit:
            pass
    finally:
        db.acquire, asyncio.sleep = real, real_sleep

    check("the beat writes detail->heartbeat",
          beat_sql and "heartbeat" in beat_sql[0], str(beat_sql[:1])[:120])
    check("...and only for a row still marked running, so it can never "
          "resurrect a finished one",
          beat_sql and "status = 'running'" in beat_sql[0], str(beat_sql[:1])[:150])

    print("5. startup does not reap before the window can prove anything")
    src = open("/app/backend/app/main.py").read()
    check("boot schedules the reap with a delay past the staleness window",
          "reconcile_orphans(delay_s=" in src
          and "STALE_AFTER_S" in src, "main.py")
    check("...and does not block the boot on it", "bg.spawn(eval_runs" in src)
    # MEASURED 2026-08-07 from the backend's own log while this lane was
    # being verified: ready→reload gaps of 68s, 63s and 101s, three in a row,
    # none of them the 105s the scheduled sweep waits for. A boot-only
    # recovery is unreachable on a box that reloads that often, which is the
    # box this feature exists for. So the sweep re-arms itself.
    ev = open("/app/backend/app/eval_runs.py").read()
    check("the recovery re-arms rather than running once per boot",
          'bg.spawn(reconcile_orphans(delay_s=SWEEP_EVERY_S)' in ev)
    check("...in a finally, so a sweep that raised does not end the chain",
          "finally:" in ev.split("async def reconcile_orphans")[1]
          .split("async def")[0])
    check("...and it sweeps more often than a run can go stale, so nothing "
          "waits a whole window twice",
          eval_runs.SWEEP_EVERY_S <= eval_runs.STALE_AFTER_S,
          f"{eval_runs.SWEEP_EVERY_S}s vs {eval_runs.STALE_AFTER_S}s")

    print("6. death is the SECOND answer now, never the first (migration 124)")
    # Without this clause the recovery is unreachable: every stale row would
    # be certified dead before anything could pick it up, which is exactly the
    # state the 175 lost runs were in.
    check("the reap only fires at the resume ceiling",
          f"resumes >= {eval_runs.MAX_RESUMES}" in sql, sql[:160])
    check("...and the ceiling is a small number, so a run that keeps killing "
          "the process cannot be rescued forever",
          1 <= eval_runs.MAX_RESUMES <= 5, str(eval_runs.MAX_RESUMES))
    check("the reason it records says how many attempts it took, so 'the "
          "harness kept dying' cannot be read as 'the model failed'",
          "'resumes', resumes" in " ".join(
              open("/app/backend/app/eval_runs.py").read().split()))
    evsrc = open("/app/backend/app/eval_runs.py").read()
    # The worst defect this lane found: status is initialised to "passed" and
    # CancelledError is a BaseException, so a shutdown mid-suite used to write
    # a PASS. The row must be LEFT for recovery instead.
    check("a cancelled run writes no verdict at all",
          "except asyncio.CancelledError" in evsrc and "terminal = False" in evsrc)
    check("...and the terminal write is gated on having reached one",
          "if not terminal:" in evsrc)

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: " + "; ".join(FAILURES))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
