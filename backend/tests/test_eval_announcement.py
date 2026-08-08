"""A finished eval is a RESULT, and it has to reach the operator.

    docker compose exec backend python tests/test_eval_announcement.py

Jeremy, 2026-08-07: *"I ran a model eval test, haven't seen any update."* The
run had finished successfully seven minutes earlier:

    585f78c7  22:42:14 -> 22:50:01   deepseek-v4-flash, suite main
              task_index 7 of 7, tasks_passed 2, resumes 0, status 'failed'

Two defects, and this suite defends the fix to both.

1. THE WORD 'failed' MEANT TWO THINGS. That row — every task graded, the
   model scored 2 — and this one:

       aee6d5a7  status 'error', task_index 0 of 0, "no heartbeat for 90s"

   are opposite outcomes, and both surfaced as failure. `eval_runs.outcome()`
   derives the reading from how many of the suite's tasks were actually
   graded, so a 2/7 is a measurement and a run the model was never reached
   for is not a verdict on anybody. §1 pins the derivation against both real
   rows; §2 pins that the ranking and the reading share ONE predicate, since
   two copies is how a run comes to be announced as a score the standings
   silently refuse to rank.

2. NOTHING TOLD HIM IT FINISHED. §3 pins the text (model, suite, score, and
   where the per-task detail is), §4 pins that the announcement is recorded
   from notify.send's OWN result and never invents a delivery, §5 pins the
   database refusals migration 127 adds, and §6 pins that the hooks exist at
   all — a notification path nothing calls is the same defect one level up.

MIGRATION 128 ADDED §2b AND §7, because two of 127's claims held only while
nothing raced them, and this file's own checks did not notice:

* §2's four hand-written rows compared a restatement typed in this file
  against `outcome()` — a restatement agrees with itself. It passed while 10
  rows in the live table were announced as measurements the ranking refused
  to rank. §2b asks POSTGRES to evaluate `MEASURED_WHERE` and compares it to
  `outcome()` on every row that exists.
* §4 checked that the dedupe KEY was passed, which was never in doubt. It
  cannot see that the dedupe behind it is read-then-insert, so three
  concurrent announces of one run buzzed the phone three times. §7 races the
  real claim against the real database and requires exactly one winner.
"""

import asyncio
import inspect
import json
import sys
import uuid

sys.path.insert(0, "/app/backend")

from app import db, eval_runs, model_tournament, notifications  # noqa: E402

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


def row(**kw) -> dict:
    """One eval_runs row as `recent`/`progress` hand it to `outcome`."""
    base = {"id": str(uuid.uuid4()), "suite": "main", "model": "a-model",
            "status": "failed", "tasks_total": 7, "tasks_passed": 2,
            "tasks_gradeable": 7, "task_index": 7, "resumes": 0,
            "repeat_count": 1, "suite_version": 3, "duration_s": 467.0,
            "error": None, "failure": None, "stalled_for_s": None}
    base.update(kw)
    return base


# ── 1. the reading is derived from what was graded ───────────────────────

def test_outcome():
    print("\n[1] a completed measurement and a dead harness stop rendering "
          "identically")

    # THE REAL ROW. Seven of seven tasks graded, two passed, status 'failed'.
    jeremys = eval_runs.outcome(row())
    check("585f78c7's shape reads as a MEASUREMENT — every task was graded",
          jeremys["code"] == eval_runs.MEASURED and jeremys["measurement"],
          jeremys["label"])
    check("...and says so from the tasks, not from the status word",
          "7 tasks were graded" in jeremys["basis"], jeremys["basis"])
    check("...with the score on the face of it", jeremys["label"] == "2/7")
    check("...and a sentence that does not use the word failed",
          "failed" not in jeremys["headline"].lower(), jeremys["headline"])

    # THE OTHER REAL ROW. Nothing was graded; the process died at task 0.
    dead = eval_runs.outcome(row(
        status="error", tasks_total=0, tasks_passed=0, tasks_gradeable=0,
        task_index=0, resumes=3,
        failure={"type": "declared_dead", "message": "no heartbeat for 90s",
                 "resource_refusal": False}))
    check("aee6d5a7's shape is NOT a measurement",
          dead["code"] == eval_runs.UNMEASURED and not dead["measurement"],
          dead["label"])
    check("...and it carries why, so it is not just 'did not finish'",
          dead["why"] == "no heartbeat for 90s"
          and dead["failure_type"] == "declared_dead")

    part = eval_runs.outcome(row(tasks_gradeable=3, task_index=3,
                                 tasks_passed=1))
    check("a run killed at task 3 of 7 is INCOMPLETE, not a 1/7 model",
          part["code"] == eval_runs.PARTIAL and not part["measurement"],
          part["label"])

    refused = eval_runs.outcome(row(
        status="error", tasks_gradeable=0, task_index=0, tasks_passed=0,
        failure={"type": "no_gradeable_tasks", "message": "prompt too long",
                 "resource_refusal": True}))
    check("a machine refusal says it is about this box, not the model",
          refused["resource_refusal"]
          and "not about the model" in refused["headline"], refused["headline"])

    old = eval_runs.outcome(row(tasks_gradeable=None))
    check("a row from before per-task grading is UNKNOWN, never measured — "
          "unknowable and complete are different, and standings has excluded "
          "these since 2026-08-04",
          old["code"] == eval_runs.UNKNOWN and not old["measurement"],
          old["label"])
    check("...but a run that recorded NO tasks is an absence, not an unknown "
          "— that is aee6d5a7, and calling it 'unverifiable' would dress a "
          "dead harness up as a lost measurement",
          eval_runs.outcome(row(status="error", tasks_total=0, tasks_passed=0,
                                tasks_gradeable=None))["code"]
          == eval_runs.UNMEASURED)

    live = eval_runs.outcome(row(status="running", task_index=3,
                                 tasks_gradeable=3, stalled_for_s=4))
    check("a run in flight reads as 'task 3 of 7' — he watched an 8-minute "
          "run with no feedback at all",
          "task 3 of 7" in live["label"] and not live["stalled"], live["label"])
    stuck = eval_runs.outcome(row(status="running", task_index=3,
                                  tasks_gradeable=3, resumes=2,
                                  stalled_for_s=eval_runs.STALE_AFTER_S + 1))
    check("...and one that stopped reporting says THAT, with the same "
          "predicate the reaper uses",
          stuck["stalled"] and "stopped reporting" in stuck["label"],
          stuck["label"])
    check("...and says it has been interrupted, which is the harness",
          "interrupted 2×" in stuck["label"], stuck["label"])
    check("nothing running is ever a measurement",
          not live["measurement"] and not stuck["measurement"])


# ── 2. one definition of "measured", not two ─────────────────────────────

def test_one_predicate():
    print("\n[2] the ranking and the reading cannot drift apart")
    src = inspect.getsource(model_tournament.standings)
    check("standings filters on eval_runs.MEASURED_WHERE rather than its own "
          "copy of the clause",
          "eval_runs.MEASURED_WHERE" in src)
    check("...and no second hand-typed copy is left behind",
          "tasks_gradeable = tasks_total" not in src.replace(
              "MEASURED_WHERE", ""),
          src.count("tasks_gradeable"))

    # ONE EXPRESSION, not two that resemble each other. The filter and the
    # SELECT list must be built from the same string — this is the defect
    # that shipped: `_GRADED_SQL` fell back to counting `detail->tasks` and
    # MEASURED_WHERE read the bare column, so 10 live rows were `measured`
    # to the reading and invisible to the ranking.
    check("the WHERE clause and the SELECT list are the SAME expression",
          eval_runs._GRADED_EXPR in eval_runs.MEASURED_WHERE
          and eval_runs._GRADED_SQL.startswith(eval_runs._GRADED_EXPR))
    check("...so the filter carries the detail->tasks fallback too, and a "
          "row whose column is NULL but whose per-task record is complete "
          "cannot be announced as a score the board refuses to rank",
          "detail" in eval_runs.MEASURED_WHERE)

    # The SQL and the Python must agree on the same rows, so the number a
    # notification announces is a number the board is willing to rank.
    for r, want in ((row(), True),
                    (row(tasks_gradeable=3), False),
                    (row(tasks_gradeable=None), False),
                    (row(tasks_total=0, tasks_gradeable=0), False)):
        check(f"gradeable={r['tasks_gradeable']} of {r['tasks_total']}: "
              f"outcome() reads it as measured={want}",
              eval_runs.outcome(r)["measurement"] == want)


async def _predicate_agrees_live() -> None:
    """Postgres and `outcome()` on EVERY row of the real table.

    The hand-written four rows above never caught the drift, because both
    halves of the comparison were typed in this file — a restatement agrees
    with itself. This asks the database to evaluate MEASURED_WHERE and
    `outcome()` to read the same row, and requires the two answers to match
    for every run ever recorded. Read-only.
    """
    await db.init_pool()
    async with db.acquire() as conn:
        rows = await conn.fetch(
            f"SELECT id, status, {eval_runs._GRADED_SQL}, tasks_total, "
            f"       tasks_passed, task_index, resumes, "
            f"       ({eval_runs.MEASURED_WHERE}) AS sql_measured "
            f"  FROM eval_runs")
    disagree = [r for r in rows
                if eval_runs.outcome(r)["measurement"] != bool(r["sql_measured"])]
    check(f"MEASURED_WHERE and outcome() agree on all {len(rows)} rows in the "
          f"live table — a run announced as a measurement is a run the "
          f"ranking will rank",
          not disagree,
          "; ".join(f"{str(r['id'])[:8]} {r['tasks_gradeable']}/"
                    f"{r['tasks_total']} sql={r['sql_measured']}"
                    for r in disagree[:5]))


def test_one_predicate_live():
    print("\n[2b] ...proven against every row in the live table")
    asyncio.run(_predicate_agrees_live())


# ── 3. what the operator is actually told ────────────────────────────────

def test_text():
    print("\n[3] the message carries the facts he walked away from")
    title, body = eval_runs.announcement_text(row(model="deepseek-v4-flash"))
    check("the title carries the score", "2/7" in title, title)
    check("the body names the model", "deepseek-v4-flash" in body)
    check("...the suite and its version", "main" in body and "v3" in body)
    check("...how long it took", "7m47s" in body, body)
    check("...and says a low score here is a result, not a crash",
          "measurement and not a crash" in body, body)
    check("...and where the per-task detail is",
          "Library → Models → Run history" in body)
    check("the deep link is a route that exists (/library/:kind)",
          eval_runs.announce_link("abc") == "/library/models?run=abc")

    title2, body2 = eval_runs.announcement_text(row(
        status="error", tasks_total=7, tasks_passed=0, tasks_gradeable=0,
        task_index=2, resumes=2,
        failure={"type": "declared_dead", "message": "no heartbeat for 90s",
                 "resource_refusal": False}))
    check("a run that measured nothing never says 'failed' at a lock screen",
          "failed" not in title2.lower()
          and "no usable score" in title2, title2)
    check("...says why", "no heartbeat for 90s" in body2, body2)
    check("...says it had been interrupted", "resumed 2×" in body2, body2)
    check("...and refuses to let anything be read off it",
          "Nothing about the model can be read off this run" in body2)


# ── 4. the announcement is RECORDED, from notify's own words ─────────────

class Conn:
    """Answers `progress`'s SELECT and captures the claim UPDATE."""

    def __init__(self, run_row):
        self.run_row = run_row
        self.statements: list[tuple[str, tuple]] = []

    async def fetchrow(self, sql, *args):
        flat = " ".join(sql.split())
        self.statements.append((flat, args))
        if flat.startswith("UPDATE eval_runs SET announced_at"):
            return {"id": args[0]}
        return dict(self.run_row)

    async def fetch(self, sql, *args):
        self.statements.append((" ".join(sql.split()), args))
        return []

    async def execute(self, sql, *args):
        self.statements.append((" ".join(sql.split()), args))
        return "UPDATE 1"


class Acquire:
    def __init__(self, conn):
        self.conn = conn

    async def __aenter__(self):
        return self.conn

    async def __aexit__(self, *a):
        return False


def announce_with(run_row, send_result, raises=None):
    """Drive `_announce` against a fake row and a fake transport."""
    from app import notify
    conn = Conn(run_row)
    real_acquire, real_send = db.acquire, notify.send
    sent: dict = {}

    async def fake_send(message, **kw):
        sent["message"] = message
        sent.update(kw)
        if raises:
            raise raises
        return send_result

    db.acquire = lambda: Acquire(conn)
    notify.send = fake_send
    try:
        out = asyncio.run(eval_runs.announce(str(run_row["id"])))
    finally:
        db.acquire, notify.send = real_acquire, real_send
    claims = [s for s in conn.statements
              if s[0].startswith("UPDATE eval_runs SET announced_at")]
    return out, sent, claims


def test_record():
    print("\n[4] what was recorded is what notify.send said, never a tick")
    accepted = {"ok": True, "deduped": False, "provider": "webpush",
                "notification_id": "n-1", "in_chat": True, "state": "accepted",
                "delivery_label": "accepted by webpush — not confirmed received",
                "confirmed": False}
    r = row()
    out, sent, claims = announce_with(r, accepted)
    check("the row records HOW it went, in the notification's own words",
          out and out["how"] == accepted["delivery_label"], str(out))
    check("...and does NOT claim receipt from a transport that only queued it",
          out["confirmed"] is False and out["state"] == "accepted")
    check("...naming the notification it is a pointer to",
          out["notification_id"] == "n-1")
    check("the claim is conditional, so two processes cannot both close it",
          claims and "announced_at IS NULL" in claims[0][0],
          claims[0][0][:90] if claims else "no claim")
    check("the doc carries `how`, which migration 127's CHECK requires",
          claims and "how" in json.loads(claims[0][1][1]))
    check("the dedupe key is the RUN, so a race folds onto one notification "
          "and two different runs never suppress each other",
          sent.get("dedupe_key") == f"eval-run:{r['id']}",
          sent.get("dedupe_key"))
    check("the tap lands on the run it is about",
          sent.get("click") == f"/library/models?run={r['id']}",
          sent.get("click"))

    deduped = {"ok": True, "deduped": True, "notification_id": "n-0",
               "state": "accepted", "in_chat": True,
               "delivery_label": "accepted by webpush — not confirmed received",
               "confirmed": False}
    out2, _, _ = announce_with(row(), deduped)
    check("a send that published nothing is recorded as deduped, not as a "
          "send this run made", out2["deduped"] is True)

    failed = {"ok": False, "deduped": False, "notification_id": "n-2",
              "in_chat": True, "state": "failed", "confirmed": False,
              "provider": "ntfy",
              "delivery_label": "not delivered — could not reach ntfy",
              "error": "could not reach ntfy"}
    out3, _, claims3 = announce_with(row(), failed)
    check("a transport failure is written down rather than retried forever — "
          "and it still says it is not delivered",
          out3["how"].startswith("not delivered") and claims3,
          out3["how"])

    out4, _, claims4 = announce_with(row(status="running", task_index=3), {})
    check("a run still going is NOT announced — it has no result yet",
          out4 is None and not claims4)

    out5, _, claims5 = announce_with(
        row(announced_at="2026-08-07T22:50:00Z",
            announcement={"how": "already told"}), {"ok": True})
    check("an already-announced run is not announced twice",
          out5 is None and not claims5)

    out6, _, claims6 = announce_with(row(), {}, raises=RuntimeError("boom"))
    check("an announcement that blows up never takes the verdict with it, "
          "and leaves the row unannounced for the sweep to retry",
          out6 is None and not claims6)


# ── 5. the database refuses a claim with no account of itself ────────────

async def refuses(conn, sql, *args) -> bool:
    """Did the database reject that statement? Each attempt gets its own
    SAVEPOINT — a failed statement poisons the whole transaction otherwise,
    and every check after it would report a refusal it never made."""
    sp = conn.transaction()
    await sp.start()
    try:
        await conn.execute(sql, *args)
    except Exception:                                        # noqa: BLE001
        await sp.rollback()
        return True
    await sp.rollback()
    return False


async def _live_constraints() -> None:
    await db.init_pool()
    async with db.acquire() as conn:
        cols = await conn.fetch(
            "SELECT column_name FROM information_schema.columns "
            " WHERE table_name = 'eval_runs' "
            "   AND column_name IN ('announced_at','announcement')")
        check("migration 127 has been applied to this database",
              len(cols) == 2, str([c["column_name"] for c in cols]))
        if len(cols) != 2:
            return

        # Everything below runs inside a transaction that is ALWAYS rolled
        # back: this is the operator's live eval history, and the lesson from
        # `staged-tree-suite-mutates-live` is that a suite which can reach
        # live rows will.
        tr = conn.transaction()
        await tr.start()
        try:
            rid = await conn.fetchval(
                "INSERT INTO eval_runs (suite, agent_name, model, status, "
                "  tasks_total, tasks_passed, tasks_gradeable, task_index) "
                "VALUES ('fake-127','model-manager','fake','failed',7,2,7,7) "
                "RETURNING id")
            check("a row cannot say it was announced without saying HOW",
                  await refuses(
                      conn, "UPDATE eval_runs SET announced_at = now(), "
                            "announcement = '{\"state\":\"accepted\"}'::jsonb "
                            "WHERE id = $1", rid))
            check("...nor with no account at all",
                  await refuses(
                      conn, "UPDATE eval_runs SET announced_at = now(), "
                            "announcement = NULL WHERE id = $1", rid))

            await conn.execute(
                "UPDATE eval_runs SET announced_at = now(), "
                "announcement = '{\"how\":\"in your chat\"}'::jsonb "
                "WHERE id = $1", rid)
            check("...and an honest one is accepted",
                  await conn.fetchval("SELECT announced_at IS NOT NULL FROM "
                                      "eval_runs WHERE id = $1", rid))

            rid2 = await conn.fetchval(
                "INSERT INTO eval_runs (suite, agent_name, model, status) "
                "VALUES ('fake-127','model-manager','fake','running') "
                "RETURNING id")
            check("a run still executing cannot announce a result",
                  await refuses(
                      conn, "UPDATE eval_runs SET announced_at = now(), "
                            "announcement = '{\"how\":\"x\"}'::jsonb "
                            "WHERE id = $1", rid2))
        finally:
            await tr.rollback()

        left = await conn.fetchval(
            "SELECT count(*) FROM eval_runs WHERE suite = 'fake-127'")
        check("nothing was left behind in the live table", left == 0, str(left))

        # THE INCIDENT ROW, if this is the box it happened on. The backfill
        # must have closed it (nobody was told at the time, and it says so)
        # and it must now read as the measurement it always was.
        r = await conn.fetchrow(
            "SELECT id FROM eval_runs WHERE id::text LIKE '585f78c7%'")
        if r is None:
            print("  note  585f78c7 is not in this database — the incident "
                  "row check is not applicable here")
        else:
            got = await eval_runs.progress(str(r["id"]))
            check("the run Jeremy never heard about now reads as a "
                  "measurement", got["outcome"]["measurement"],
                  got["outcome"]["label"])
            check("...and its announce step is closed with the truth: nobody "
                  "was told at the time",
                  bool(got["announced_at"])
                  and got["announcement"].get("backfilled") is True,
                  str(got["announcement"]))

        unannounced = await conn.fetchval(
            "SELECT count(*) FROM eval_runs "
            " WHERE announced_at IS NULL AND status <> 'running' "
            "   AND started_at < now() - interval '1 day'")
        check("the backfill closed history, so the sweep cannot buzz the "
              "phone about last week", unannounced == 0, str(unannounced))


def test_live():
    print("\n[5] migration 127's refusals, against the live database")
    asyncio.run(_live_constraints())


# ── 6. the hooks exist — a path nothing calls is not a path ──────────────

def test_wiring():
    print("\n[6] every terminal state actually announces")
    check("a run that recorded its verdict announces it",
          "await announce(run_id)" in inspect.getsource(eval_runs._execute))
    check("...strictly after the verdict landed, never before",
          inspect.getsource(eval_runs._execute).index("await announce(run_id)")
          > inspect.getsource(eval_runs._execute).index(
              "could not record its verdict"))
    check("a parked run announces — he pressed a button and this is the "
          "answer", "await announce(run_id)" in inspect.getsource(eval_runs._park))
    check("a run certified dead announces",
          "announce(str(r[\"id\"]))" in inspect.getsource(
              eval_runs._certify_dead))
    check("and results whose own process never got to it are retried",
          "_announce_backlog" in inspect.getsource(eval_runs._sweep))
    check("...but never under a test's `only_run` scope, which reaches live "
          "rows", "if only_run else" in inspect.getsource(eval_runs._sweep))


# ── 7. two callers racing announce ONCE (migration 128) ──────────────────
#
# The claim migration 127 shipped with — "the same run announced twice folds
# onto one notification" — was false, and was measured false: `notify.send`
# reads `notifications.find_repeat` and then inserts, over a plain btree, so
# two callers that read before either writes both publish. Three concurrent
# `_announce` calls on one terminal run produced 3 pushes, 3 notification
# rows and 3 chat pointers, every one of them reporting `deduped: False`.
#
# `_claim_announce` is the line that refuses it, and it has to be the
# database rather than an `asyncio.Lock` because the two callers are not
# always in one process: `_execute` announces its own verdict while the
# leader's sweep announces the backlog, and a second backend is routine here.
#
# THE FIXTURE ROW IS `running` ON PURPOSE. It is the live eval table, and a
# terminal unannounced row left lying about for even a second is one the real
# backend's sweep may announce — a fake push to Jeremy's phone. `running` is
# invisible to `_announce_backlog` (status <> 'running'), too young to be
# claimed as stale, and nowhere near MAX_RESUMES, so nothing else in the
# system will touch it. `_claim_announce` itself does not read status — the
# gate under test is the lease — so the fixture proves exactly what it must.

async def _claim_race() -> None:
    await db.init_pool()
    async with db.acquire() as conn:
        rid = await conn.fetchval(
            "INSERT INTO eval_runs (suite, agent_name, model, status, "
            "  tasks_total, tasks_passed, task_index) "
            "VALUES ('fake-128','model-manager','fake','running',7,0,0) "
            "RETURNING id")
    rid = str(rid)
    try:
        won = await asyncio.gather(*(eval_runs._claim_announce(rid)
                                     for _ in range(3)))
        check("three callers race the announce step and exactly ONE wins — "
              "the case that produced 3 pushes for one eval",
              won.count(True) == 1, str(won))

        async with db.acquire() as conn:
            held = await conn.fetchrow(
                "SELECT announce_claimed_at, announce_claimed_by "
                "  FROM eval_runs WHERE id = $1::uuid", rid)
        check("...and the winner is written down, not merely assumed",
              held["announce_claimed_at"] is not None
              and bool(held["announce_claimed_by"]),
              str(dict(held)))

        again = await eval_runs._claim_announce(rid)
        check("a fourth caller inside the lease is refused too", not again)

        # A process that died between claiming and sending must not silence
        # the result forever — that is why this is a lease and not a flag.
        async with db.acquire() as conn:
            await conn.execute(
                "UPDATE eval_runs SET announce_claimed_at = now() - "
                f"  interval '{eval_runs.ANNOUNCE_LEASE_S + 60} seconds' "
                " WHERE id = $1::uuid", rid)
        check("...but a claim whose holder died is re-takeable once the "
              "lease lapses, which is what the backlog sweep is for",
              await eval_runs._claim_announce(rid))

        # ...and the sweep does not burn its five-per-pass slots on runs
        # somebody else is mid-send on.
        check("the backlog query skips runs under a live lease",
              "announce_claimed_at" in inspect.getsource(
                  eval_runs._announce_backlog))
    finally:
        async with db.acquire() as conn:
            await conn.execute("DELETE FROM eval_runs WHERE suite = 'fake-128'")
    async with db.acquire() as conn:
        left = await conn.fetchval(
            "SELECT count(*) FROM eval_runs WHERE suite = 'fake-128'")
    check("nothing was left behind in the live table", left == 0, str(left))


def test_claim():
    print("\n[7] one run, one announcement — under a race, across processes")
    src = inspect.getsource(eval_runs._announce)
    check("the claim is taken BEFORE the send, or it gates nothing",
          "_claim_announce" in src
          and src.index("await _claim_announce")
          < src.index("await notify.send("))
    check("...and after the row is known to be terminal, so nothing claims "
          "an announcement for a run still earning its score",
          src.index("still running") < src.index("_claim_announce"))
    check("the run-id dedupe key is still sent — it is what folds a "
          "SERIALIZED retry after a send that was not recorded",
          "dedupe_key=f\"eval-run:{run_id}\"" in src)
    # A process that published and then died leaves the claim to expire. The
    # sweep's retry must land INSIDE the fingerprint window, or that retry is
    # the second push this whole section exists to prevent.
    check("the announce lease expires inside notifications' dedupe window, so "
          "a retry after a dead claim folds instead of buzzing twice",
          eval_runs.ANNOUNCE_LEASE_S < notifications.DEDUPE_WINDOW_S,
          f"lease {eval_runs.ANNOUNCE_LEASE_S}s vs window "
          f"{notifications.DEDUPE_WINDOW_S}s")
    asyncio.run(_claim_race())


def main() -> int:
    test_outcome()
    test_one_predicate()
    test_one_predicate_live()
    test_text()
    test_record()
    test_live()
    test_wiring()
    test_claim()
    print()
    if FAILURES:
        print(f"{len(FAILURES)} check(s) failed:")
        for f in FAILURES:
            print(f"  - {f}")
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
