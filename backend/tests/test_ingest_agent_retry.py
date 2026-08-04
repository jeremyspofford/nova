"""A model gets one retry, and the refusal is in the WHERE clause.

    docker compose exec backend python tests/test_ingest_agent_retry.py

The operator asked on 2026-08-02 that Nova be able to fix failed ingests, not
only describe them. The risk that comes with that is a loop: she reads
"ingest_jobs 2" in her facts, retries, the job fails again for the same
permanent reason (both of his were members-only YouTube videos at attempts
3/3), and she retries again. The operator's own retry resets `attempts` AND
`orphans` to zero, so an unbounded agent loop defeats both the worker's
max_attempts and MAX_ORPHANS and can re-run an expensive transcription
forever.

So the budget is a column and the refusal is a WHERE clause. The property
defended here is that she cannot spend it twice and cannot refill it — not
that the tool politely declines, which is a sentence, but that Postgres
returns zero rows, which is not.

This suite writes: it creates its own throwaway job row and deletes it.
"""

import asyncio
import sys
import uuid

sys.path.insert(0, "/app/backend")

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


async def run() -> None:
    from app import db, ingest_jobs
    await db.init_pool()

    marker = f"https://example.invalid/test-agent-retry/{uuid.uuid4()}"
    async with db.acquire() as conn:
        job_id = await conn.fetchval(
            "INSERT INTO ingest_jobs (url, status, error, attempts, max_attempts) "
            "VALUES ($1, 'failed', 'planted by the test', 3, 3) RETURNING id",
            marker)
    try:
        print("1. the first agent retry is allowed")
        r = await ingest_jobs.retry_by_agent(job_id, agent_name="main")
        check("it re-queues", r["status"] == "queued", str(r["status"]))
        async with db.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT status, attempts, orphans, agent_retries FROM ingest_jobs "
                "WHERE id = $1", job_id)
        check("the job is back in the queue", row["status"] == "queued")
        check("with a fresh worker budget", row["attempts"] == 0)
        check("and the AGENT budget is spent", row["agent_retries"] == 1)

        # Found live, 2026-08-02: the executor read job["error"] AFTER the
        # update had set it to NULL and sliced it, so the audit write raised
        # and the whole tool call errored even though the retry had already
        # happened. The reason a job failed is exactly what the audit event
        # is for, so it has to come out of the same statement that clears it.
        check("the OLD error survives the update that clears it",
              (r.get("job") or {}).get("prev_error") == "planted by the test",
              repr((r.get("job") or {}).get("prev_error")))

        print("1b. the tool executes end to end, audit write included")
        from app.tools import builtin as _b
        async with db.acquire() as conn:
            await conn.execute(
                "UPDATE ingest_jobs SET status='failed', error='planted again', "
                "agent_retries=0 WHERE id=$1", job_id)
        res = await _b.BUILTIN_TOOLS["retry_ingest_job"]["execute"](
            {"job_id": str(job_id)}, {"agent_name": "main"})
        check("it returns a result, not an exception or an Error:",
              not str(res).startswith("Error:"), str(res)[:120])

        print("2. the second is refused BY THE DATABASE")
        # Put it back to failed, as the worker would after it fails again.
        async with db.acquire() as conn:
            await conn.execute(
                "UPDATE ingest_jobs SET status='failed', error='failed again' "
                "WHERE id = $1", job_id)
        r = await ingest_jobs.retry_by_agent(job_id, agent_name="main")
        check("refused, and it says WHICH wall", r["status"] == "budget_spent",
              str(r["status"]))
        async with db.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT status, agent_retries FROM ingest_jobs WHERE id = $1",
                job_id)
        check("the job was NOT re-queued", row["status"] == "failed")
        check("and the counter did not move past the budget",
              row["agent_retries"] == ingest_jobs.AGENT_RETRY_BUDGET,
              str(row["agent_retries"]))

        print("3. the model has no path to refill it")
        src = open("/app/backend/app/ingest_jobs.py").read()
        # Zeroing is opt-in and there is exactly one switch for it, so the
        # question "who can refill the budget" is answered by grepping for
        # callers that pass it rather than by reading every UPDATE.
        resets = src.count("agent_retries = CASE WHEN")
        check("the budget is zeroed by ONE guarded statement", resets == 1,
              f"{resets} found")
        check("...and never unconditionally", "agent_retries = 0," not in src)
        check("...and the switch is keyword-only, so no caller sets it by "
              "accident with a positional argument",
              "*, refill_agent_budget" in src)
        # The tool layer must not be able to reach the operator reset.
        from app.tools import builtin
        tool_src = builtin.BUILTIN_TOOLS["retry_ingest_job"]["execute"].__doc__ or ""
        check("the tool documents that the refusal is not its own",
              "retry_by_agent" in tool_src or "WHERE clause" in tool_src)

        print("4. the operator's Retry DOES refill it")
        await ingest_jobs.retry(job_id, refill_agent_budget=True)
        async with db.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT status, agent_retries FROM ingest_jobs WHERE id = $1",
                job_id)
        check("operator retry re-queues", row["status"] == "queued")
        check("and refills the agent budget", row["agent_retries"] == 0)

        print("4b. a job that SUCCEEDED is never reported as having failed again")
        # Found by review, reproduced: the budget check ran BEFORE the status
        # check, so a job she retried that then INGESTED FINE came back as
        # 'budget_spent' and the tool told her "it failed again". That is the
        # bug this lane exists to remove, pointing the other way.
        async with db.acquire() as conn:
            await conn.execute(
                "UPDATE ingest_jobs SET status='done', agent_retries=1, "
                "error=NULL WHERE id=$1", job_id)
        r = await ingest_jobs.retry_by_agent(job_id, agent_name="main")
        check("done + budget spent reads as not_retryable, not budget_spent",
              r["status"] == "not_retryable", str(r["status"]))
        from app.tools import builtin as _b2
        msg = str(await _b2.BUILTIN_TOOLS["retry_ingest_job"]["execute"](
            {"job_id": str(job_id)}, {"agent_name": "main"}))
        check("...and the tool never claims it failed again",
              "failed again" not in msg, msg[:100])
        # And the same for a retry still in flight.
        async with db.acquire() as conn:
            await conn.execute(
                "UPDATE ingest_jobs SET status='queued' WHERE id=$1", job_id)
        r = await ingest_jobs.retry_by_agent(job_id, agent_name="main")
        check("an in-flight retry is not reported as a spent budget",
              r["status"] == "not_retryable", str(r["status"]))

        print("4c. the budget cannot refill itself through the poll path")
        # _enqueue_source_entries revives stuck jobs with ingest_jobs.retry(),
        # on the scheduled poll — a path a model can also trigger. If that
        # zeroed the counter, the WHERE clause would be a control the system
        # defeated for her, on a timer.
        async with db.acquire() as conn:
            await conn.execute(
                "UPDATE ingest_jobs SET status='failed', agent_retries=1 "
                "WHERE id=$1", job_id)
        await ingest_jobs.retry(job_id)                    # the poll's call
        async with db.acquire() as conn:
            spent = await conn.fetchval(
                "SELECT agent_retries FROM ingest_jobs WHERE id=$1", job_id)
        check("the default retry LEAVES the agent budget spent", spent == 1,
              str(spent))
        src = open("/app/backend/app/router_chat.py").read()
        check("only the operator endpoint asks for a refill",
              src.count("refill_agent_budget=True") == 1)

        print("5. a job that is not failed cannot be retried at all")
        async with db.acquire() as conn:
            await conn.execute(
                "UPDATE ingest_jobs SET status='done' WHERE id = $1", job_id)
        r = await ingest_jobs.retry_by_agent(job_id, agent_name="main")
        check("refused as not retryable", r["status"] == "not_retryable",
              str(r["status"]))

        print("6. an unknown id is refused, not invented")
        r = await ingest_jobs.retry_by_agent(uuid.uuid4(), agent_name="main")
        check("says not_found", r["status"] == "not_found", str(r["status"]))

        print("7. the tool is a READER but TAINTS — it names a video title back")
        from app.tools import registry
        check("not an ACTOR: it re-runs enqueued work and cannot add a URL",
              not registry.is_actor("retry_ingest_job"))
        check("taints: the title is somebody else's text",
              registry.returns_untrusted("retry_ingest_job"))
    finally:
        async with db.acquire() as conn:
            await conn.execute("DELETE FROM ingest_jobs WHERE url = $1", marker)
        await db.close_pool()


def main() -> int:
    asyncio.run(run())
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES[:8]))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
