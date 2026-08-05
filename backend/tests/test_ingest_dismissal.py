"""Clearing an activity item has to actually clear it.

    docker compose exec backend python tests/test_ingest_dismissal.py

The operator has two failed rows on the Activity page that will never succeed:
both are members-only YouTube uploads on a channel he is not joining. He asked
for a way to take them off the list.

The obvious implementation — DELETE the row — is a lie, and this suite exists
to keep it one. `_enqueue_source_entries` looks every candidate up with
`find_open(media_key)`: a failed row gets REVIVED, and no row at all gets
ENQUEUED FRESH. Both branches put the video back in the queue on the next poll,
spend three more download attempts against a paywall, and land it back on the
page it was just cleared from. So dismissal is a tombstone (`dismissed_at`),
and the properties defended here are the ones that make that tombstone real:

1. HIDDEN EVERYWHERE IT WAS SHOWN. The panel, the rail badge counts, and
   `failures.census` — which feeds the FACTS line of every system prompt. A row
   cleared from one screen while Nova keeps reporting it on another is not
   cleared. The census check is the interesting one: `_Store.dismissed_col` is
   derived from information_schema, so this passes for any future queue that
   grows the column, with no edit to failures.py.

2. THE POLL DOES NOT RESURRECT IT. Called directly, with the real function,
   against a real dismissed row. This is the whole feature.

3. LIVE WORK CANNOT BE HIDDEN. Dismissing a queued or running job is refused
   in the WHERE clause. Hiding a job that is still going to change state is how
   a queue silently stops.

4. THE MODEL CANNOT DISMISS, AND CANNOT UNDO ONE. There is no tool; and
   `retry_by_agent` refuses a dismissed row in SQL. Dismissal suppresses rows
   from the failure census, so a model that could write it could silence its
   own failures. The operator's own Retry lifts it — he is looking at the row.

Every row it creates is torn down in the `finally`, live-database rules.
"""

import asyncio
import sys
import uuid

sys.path.insert(0, "/app/backend")

FAILURES: list[str] = []
MARK = "test-dismissal-" + uuid.uuid4().hex[:8]


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


async def _mk(conn, status: str, key: str) -> str:
    """One ingest_jobs row in a given terminal/live state, tagged for teardown."""
    return await conn.fetchval(
        """INSERT INTO ingest_jobs (url, media_key, title, source_key, status,
                                    attempts, error, finished_at, enqueued_by)
           VALUES ($1, $2, $3, $4, $5, 3,
                   CASE WHEN $5 = 'failed' THEN 'members-only (test)' END,
                   CASE WHEN $5 IN ('done','failed','skipped') THEN now() END,
                   'test')
           RETURNING id""",
        f"https://example.invalid/{key}", f"{MARK}:{key}",
        f"{MARK} {key}", MARK, status)


async def run() -> None:
    from app import db, failures, ingest_jobs
    from app.tools.builtin import _enqueue_source_entries
    await db.init_pool()

    collateral: list = []   # live rows step 5 dismisses; the teardown restores them
    try:
        async with db.acquire() as conn:
            failed = await _mk(conn, "failed", "failed")
            done = await _mk(conn, "done", "done")
            queued = await _mk(conn, "queued", "queued")
            running = await _mk(conn, "running", "running")

        print("1. a dismissed row leaves the panel, the counts and the census")
        before = await ingest_jobs.summary(recent=500)
        base_failed = before["counts"].get("failed", 0)
        check("the failed row is on the page to begin with",
              any(str(j["id"]) == str(failed) for j in before["jobs"]))

        row = await ingest_jobs.dismiss(failed)
        check("dismiss returned the row", row is not None)

        after = await ingest_jobs.summary(recent=500)
        check("gone from the job list",
              not any(str(j["id"]) == str(failed) for j in after["jobs"]))
        check("gone from the counts the rail badge reads",
              after["counts"].get("failed", 0) == base_failed - 1,
              f"{base_failed} -> {after['counts'].get('failed', 0)}")
        check("counted as dismissed instead", (after.get("dismissed") or 0) >= 1)

        # The row still EXISTS — that is the point. A delete would have made
        # the poll re-enqueue it (property 2 below).
        async with db.acquire() as conn:
            still = await conn.fetchval(
                "SELECT count(*) FROM ingest_jobs WHERE id = $1", failed)
        check("the row survives as a tombstone, not deleted", still == 1)

        c = await failures.census(samples=1)
        ids = {s.get("id") for s in c["sources"].get("ingest_jobs", {}).get("recent", [])}
        check("out of the failure census — so out of the FACTS prompt line",
              str(failed) not in ids)
        store_cols = None
        async with db.acquire() as conn:
            store_cols = {r["column_name"] for r in await conn.fetch(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_schema='public' AND table_name='ingest_jobs'")}
        check("the census suppression is DERIVED from the column, not a table name",
              failures._Store("ingest_jobs", store_cols).dismissed_col == "dismissed_at")

        print("2. the followed-source poll does NOT resurrect it")
        entry = {"media_key": f"{MARK}:failed",
                 "url": "https://example.invalid/failed", "title": "x"}
        stats = await _enqueue_source_entries([entry], MARK, 10, enqueued_by="poll")
        check("nothing re-queued", stats["queued"] == 0, str(stats))
        check("reported as the operator's decision, not as 'already had'",
              stats["dismissed"] == 1, str(stats))
        async with db.acquire() as conn:
            st, dis = await conn.fetchrow(
                "SELECT status, dismissed_at FROM ingest_jobs WHERE id = $1", failed)
        check("still failed and still dismissed after a poll pass",
              st == "failed" and dis is not None, f"{st} / {dis}")
        async with db.acquire() as conn:
            twins = await conn.fetchval(
                "SELECT count(*) FROM ingest_jobs WHERE media_key = $1",
                f"{MARK}:failed")
        check("and no fresh duplicate row was created for the same video",
              twins == 1, f"{twins} rows")

        print("2b. the housekeeping sweep does not reap the tombstone")
        # The gap this suite missed on its first pass, found by an adversarial
        # review: purge_old took every done/skipped row older than a week with
        # no dismissed_at guard. A live/upcoming-stream skip writes NO
        # media_ingests ledger row, so its dismissed row is the only thing
        # standing between the item and the next poll — reaping it resurrects
        # exactly what was cleared, a week later, on a timer. Backdated here
        # because dismiss() deliberately does not touch finished_at, which
        # means an ALREADY-old row is eligible at the very next sweep.
        async with db.acquire() as conn:
            skipped = await _mk(conn, "skipped", "skipped")
            await conn.execute(
                "UPDATE ingest_jobs SET finished_at = now() - interval '30 days' "
                "WHERE id = ANY($1)", [skipped, done])
        await ingest_jobs.dismiss(skipped)
        await ingest_jobs.dismiss(done)
        # Global, like the button it defends — but harmless on a live install:
        # ingest_worker.loop already calls purge_old() with this same default
        # roughly hourly, so this deletes only rows the worker was about to
        # delete anyway. Nothing else in this suite runs an unscoped write.
        await ingest_jobs.purge_old(days=7)
        async with db.acquire() as conn:
            alive = await conn.fetchval(
                "SELECT count(*) FROM ingest_jobs WHERE id = $1", skipped)
            done_alive = await conn.fetchval(
                "SELECT count(*) FROM ingest_jobs WHERE id = $1", done)
        check("a dismissed 'skipped' tombstone survives the purge", alive == 1)
        # ...and the asymmetry is deliberate: 'done' is protected by the
        # media_ingests ledger instead, so keeping its rows forever would just
        # make every cleared trail immortal.
        check("a dismissed 'done' row is still swept — the ledger protects that one",
              done_alive == 0)
        stats = await _enqueue_source_entries(
            [{"media_key": f"{MARK}:skipped",
              "url": "https://example.invalid/skipped", "title": "x"}],
            MARK, 10, enqueued_by="poll")
        check("so a poll after the sweep still refuses to re-queue it",
              stats["queued"] == 0 and stats["dismissed"] == 1, str(stats))
        async with db.acquire() as conn:
            done = await _mk(conn, "done", "done2")   # step 5 needs one back

        print("3. live work cannot be hidden")
        check("a queued job refuses dismissal", await ingest_jobs.dismiss(queued) is None)
        check("a running job refuses dismissal", await ingest_jobs.dismiss(running) is None)
        check("dismissing twice is a no-op, not a second write",
              await ingest_jobs.dismiss(failed) is None)

        print("4. the model cannot undo the operator's decision")
        res = await ingest_jobs.retry_by_agent(failed, agent_name="test")
        check("retry_by_agent refuses a dismissed row", res["status"] == "dismissed",
              res["status"])
        check("and names THAT wall, not the retry budget",
              res["status"] != "budget_spent")
        async with db.acquire() as conn:
            st = await conn.fetchval(
                "SELECT status FROM ingest_jobs WHERE id = $1", failed)
        check("the refusal left the row alone", st == "failed", st)
        # the poll's own revival path must not clear it either
        check("the poll's retry() cannot lift a dismissal",
              await ingest_jobs.retry(failed) is None)

        print("5. the operator can clear the trail, and can change his mind")
        # dismiss_finished() is deliberately global — it is the "Clear
        # finished" button — and this suite runs against the LIVE database, so
        # calling it sweeps the operator's real trail as collateral. Snapshot
        # what was undismissed first; the teardown puts every one of those rows
        # back. (Found the hard way: the first run of this file cleared 39 real
        # rows off his Activity page.)
        async with db.acquire() as conn:
            collateral[:] = [r["id"] for r in await conn.fetch(
                "SELECT id FROM ingest_jobs WHERE dismissed_at IS NULL "
                "AND status = ANY($1) AND source_key IS DISTINCT FROM $2",
                list(ingest_jobs.DISMISSABLE), MARK)]
        n = await ingest_jobs.dismiss_finished()
        check("clear-finished took the finished rows", n >= 1, f"{n} rows")
        async with db.acquire() as conn:
            live = await conn.fetch(
                "SELECT status, dismissed_at FROM ingest_jobs WHERE id = ANY($1)",
                [queued, running])
        check("and left queued/running work alone",
              all(r["dismissed_at"] is None for r in live))
        async with db.acquire() as conn:
            d = await conn.fetchval(
                "SELECT dismissed_at FROM ingest_jobs WHERE id = $1", done)
        check("the done row went with it", d is not None)

        check("restore puts a row back", await ingest_jobs.restore(done) is not None)
        back = await ingest_jobs.summary(recent=500)
        check("and it is on the page again",
              any(str(j["id"]) == str(done) for j in back["jobs"]))

        r = await ingest_jobs.retry(failed, refill_agent_budget=True,
                                    clear_dismissal=True)
        check("an operator Retry lifts the dismissal", r is not None)
        check("and re-queues the job", r and r["status"] == "queued")
        check("and clears the tombstone", r and r["dismissed_at"] is None)
    finally:
        async with db.acquire() as conn:
            await conn.execute("DELETE FROM ingest_jobs WHERE source_key = $1", MARK)
            if collateral:
                await conn.execute(
                    "UPDATE ingest_jobs SET dismissed_at = NULL WHERE id = ANY($1)",
                    collateral)
        await db.close_pool()

    print()
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES))
        sys.exit(1)
    print("All ingest-dismissal properties hold.")


if __name__ == "__main__":
    asyncio.run(run())
