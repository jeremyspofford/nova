"""She cannot be told the system is healthy while it is not.

    docker compose exec backend python tests/test_failure_census.py

On 2026-08-02 the operator pointed at two red rows on the Activity page and
asked Nova what had happened. She had already called the tool for this;
`diagnose` had answered "8 error(s) recorded in the last 72h" and not one of
the eight was on his screen. The two failures lived in `ingest_jobs`, which
nothing in her toolset read, and the ingest worker declines to write to the
turn ledger on purpose.

Two properties are defended here, and the second is the one that matters in
six months:

1. COVERAGE. The census finds real failures in every shape this database
   uses, and does not invent them. Both halves are load-bearing — an earlier
   draft qualified a table on any `detail` column and reported 6747 failures
   in `resource_samples`, which is a different way of being useless.

2. COMPLETENESS REFUSES. `blind` is computed live from information_schema:
   every failure-shaped table, minus the ones censused, minus the ones
   explicitly declined with a reason. It must be empty. When someone lands a
   queue whose shape the census does not understand, THIS TEST GOES RED and
   names the table — and until it is handled, `note()` refuses to emit the
   all-clear at runtime. That pair is the control. Without it, a future queue
   reads as clean and re-teaches the operator that she cannot see.
"""

import asyncio
import sys

sys.path.insert(0, "/app/backend")

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


async def run() -> None:
    from app import db, failures
    await db.init_pool()

    print("1. the stores are DERIVED — no list of tables in the module")
    src = open("/app/backend/app/failures.py").read()
    c = await failures.census()
    check("something was actually scanned", len(c["scanned"]) >= 3,
          f"{len(c['scanned'])} stores")
    # The decline map names tables on purpose; the CENSUS must not. Comments
    # are stripped first: naming a real table as the EXAMPLE that motivated a
    # rule is how the rest of this codebase explains itself, and it is only a
    # hardcoded list when the code branches on it.
    body = src.split("_DECLINED = {", 1)[1].split("}", 1)[1]
    code = "\n".join(ln for ln in body.splitlines()
                     if not ln.strip().startswith("#"))
    for chunk in code.split('"""')[1::2]:      # drop docstrings
        code = code.replace(chunk, "")
    named = [t for t in c["scanned"] if f'"{t}"' in code or f"'{t}'" in code]
    check("no censused table is named in the scanning code — a queue that "
          "lands next month is covered with no edit here", not named, str(named))

    print("2. every shape this database uses is understood")
    async with db.acquire() as conn:
        schema = await failures._schema(conn)
    shapes = {}
    for t in c["scanned"]:
        shapes.setdefault(failures._Store(t, schema[t]).shape, []).append(t)
    for want, why in (
            ("status", "ingest_jobs, mcp_servers — status decides"),
            ("alert", "monitor_alerts — raise/clear, no status or error col"),
            ("counter", "push_subscriptions — a failures tally, the push "
                        "outage shape"),
            ("error", "attachments — text_error, no status at all")):
        check(f"shape {want!r} is covered ({why})", want in shapes,
              ", ".join(shapes.get(want, [])))

    print("3. the status column DECIDES where there is one")
    # ingest_jobs.mark_skipped writes the skip REASON into `error`, so an
    # error-IS-NOT-NULL predicate reports a successful dedupe as a failure.
    async with db.acquire() as conn:
        skipped_with_text = await conn.fetchval(
            "SELECT count(*) FROM ingest_jobs WHERE status = 'skipped' "
            "AND error IS NOT NULL AND error <> ''")
        # A dismissed row is a row the operator has taken off his screen, and
        # the control has to say the same thing the census does or it is
        # pinning the pre-dismissal contract. Both of his members-only videos
        # are here: failed forever, dismissed on purpose.
        really_failed = await conn.fetchval(
            "SELECT count(*) FROM ingest_jobs WHERE status = 'failed' "
            "AND dismissed_at IS NULL")
    counted = c["sources"].get("ingest_jobs", {}).get("failed", 0)
    check("a skipped job carrying a reason is NOT counted as a failure",
          counted == really_failed,
          f"counted={counted} failed={really_failed} skipped_with_text={skipped_with_text}")

    print("3a. dismissing a row REMOVES it from the count")
    # The two failures the operator dismissed are members-only videos that
    # will never succeed. Clearing them off the Activity page has to clear
    # them here too, or the button empties one screen while she goes on
    # reporting them in the FACTS block of every system prompt. Proved by
    # doing it — inside a transaction that is rolled back, so the property is
    # tested on every run rather than only while the live queue is red.
    store = failures._Store("ingest_jobs", schema["ingest_jobs"])
    check("the suppression is DERIVED from the column, not from a table name",
          store.dismissed_col == "dismissed_at", str(store.dismissed_col))
    where, args = store.predicate()
    async with db.acquire() as conn:
        tx = conn.transaction()
        await tx.start()
        try:
            job = await conn.fetchval(
                "INSERT INTO ingest_jobs (url, status, error) VALUES "
                "($1, 'failed', 'synthetic; this transaction is rolled back') "
                "RETURNING id", "https://example.invalid/census-probe")
            before = await conn.fetchval(
                f'SELECT count(*) FROM ingest_jobs WHERE {where}', *args)
            await conn.execute(
                "UPDATE ingest_jobs SET dismissed_at = now() WHERE id = $1", job)
            after = await conn.fetchval(
                f'SELECT count(*) FROM ingest_jobs WHERE {where}', *args)
        finally:
            await tx.rollback()
    check("a failed job is counted", before >= 1, f"{before} failed")
    check("...and dismissing it takes it out — exactly that one row",
          after == before - 1, f"{before} -> {after}")

    print("3b. a GRADE is not a fault, and a HARNESS CRASH is not a grade")
    # eval_runs writes status='failed' when the model under test scored below
    # the pass bar on a run the harness completed perfectly, and reserves
    # 'error' for a crash ("a harness failure is not a verdict", eval_runs.py).
    # Counting the grade put 4 false failures in front of her — but excusing
    # the whole TABLE on that evidence hid the crashes: measured 2026-08-05,
    # 175 rows at status='error', every run since 2026-08-03 dead and no suite
    # ever passed, while the census total read 14 and the prompt line carried
    # no eval signal at all. So the score pair must narrow the VOCABULARY, not
    # excuse the store, and it must do it from the SCHEMA rather than from
    # someone remembering to name eval_runs somewhere.
    check("eval_runs is censused, not excused", "eval_runs" in c["scanned"])
    check("...and is named in no list — the narrowing reads the schema",
          "eval_runs" not in failures.declined())
    ev = failures._Store("eval_runs", schema["eval_runs"])
    check("the score pair beside the status is what narrows it",
          ev.score_pair is not None, str(ev.score_pair))
    check("a scored store loses the GRADE words",
          not set(failures._GRADE_WORDS) & set(ev.failed_words),
          str(ev.failed_words))
    check("...and keeps the FAULT words, or a dead harness reads as a low score",
          {"error", "crashed", "timeout"} <= set(ev.failed_words))
    check("a store with no score pair keeps the whole vocabulary",
          failures._Store("automation_runs",
                          schema["automation_runs"]).failed_words
          == failures._FAILED)
    async with db.acquire() as conn:
        harness_dead = await conn.fetchval(
            "SELECT count(*) FROM eval_runs WHERE status = 'error'")
        graded_down = await conn.fetchval(
            "SELECT count(*) FROM eval_runs WHERE status = 'failed'")
    counted_evals = c["sources"].get("eval_runs", {}).get("failed", 0)
    check("every harness crash is counted and no graded run is",
          counted_evals == harness_dead,
          f"counted={counted_evals} error={harness_dead} graded_failed={graded_down}")
    check("a run-outcome table with no score pair is still counted",
          "automation_runs" in c["scanned"])

    print("4. counts are the truth, not the sample size")
    for table, v in c["sources"].items():
        check(f"{table}: count is unbounded, samples are illustrations",
              v["failed"] >= len(v["recent"]),
              f"failed={v['failed']} samples={len(v['recent'])}")

    print("5. an unreadable store is never a silent zero")
    check("the census reports what it could not read",
          isinstance(c["unreadable"], list))
    broken = {"scanned": [], "sources": {}, "total": 0, "recent_total": 0,
              "days": 7, "unreadable": [{"store": "ingest_jobs", "why": "boom"}],
              "unclassified": []}
    check("a store that failed to read forces INCOMPLETE, not an all-clear",
          failures.note(broken).startswith("INCOMPLETE")
          and "ingest_jobs" in failures.note(broken))

    print("6. THE CONTROL: nothing failure-shaped is silently uncovered")
    # Computed against the LIVE catalog. This is what goes red the day a
    # migration lands a queue the census does not understand.
    check("every failure-shaped table is either censused or declined WITH A "
          "REASON — add yours to _DECLINED or teach the census its shape",
          not c["unclassified"], ", ".join(c["unclassified"]))
    for table, why in failures.declined().items():
        check(f"decline of {table!r} carries a reason", len(why) > 20)

    print("6b. an OPEN condition is never aged out of the nudge")
    # monitor_alerts stamps raised_at once at INSERT and never touches it
    # while the alert is open, so windowing it by that column means a LONGER
    # outage is a staler one — a disk that filled up ten days ago and is
    # still full would silently drop out of the prompt line. The longer it
    # lasts, the more certainly it would be silenced.
    for table in ("monitor_alerts", "push_subscriptions"):
        st = failures._Store(table, schema[table])
        check(f"{table} is present-tense, so it is not windowed",
              st.present_tense, f"shape={st.shape}")
    aged = await failures.census(days=0)          # nothing is 'recent'
    for table, v in aged["sources"].items():
        st = failures._Store(table, schema[table])
        if st.present_tense:
            check(f"{table} survives a zero-day window",
                  v["recent_failed"] == v["failed"])

    print("6c. something switched OFF is not something that is failing")
    for table in ("mcp_servers", "source_subscriptions", "llm_providers"):
        where, _ = failures._Store(table, schema[table]).predicate()
        check(f"{table}'s predicate excludes disabled rows",
              "enabled" in where, where[:70])

    print("7. and the refusal is enforced at runtime, not just here")
    blind = {"scanned": ["ingest_jobs"], "sources": {}, "total": 0,
             "recent_total": 0, "days": 7, "unreadable": [],
             "unclassified": ["some_future_queue"]}
    note = failures.note(blind)
    check("an unclassified store makes the clean verdict unreachable",
          note.startswith("INCOMPLETE") and "some_future_queue" in note)
    clean = {**blind, "unclassified": []}
    check("...and with nothing unclassified the all-clear is available again",
          "RECORDED" in failures.note(clean))

    # Solving "confidently clean" must not invent "confidently blank": one
    # unreadable store used to delete every failure NUMBER from the sentence.
    both = {"scanned": ["ingest_jobs"], "days": 7, "unclassified": ["zz"],
            "unreadable": [], "total": 2, "recent_total": 2,
            "sources": {"ingest_jobs": {"failed": 2, "recent_failed": 2}}}
    n = failures.note(both)
    check("incompleteness PREFIXES the counts, never replaces them",
          n.startswith("INCOMPLETE") and "ingest_jobs 2" in n, n[:80])

    # "no errors in the ledger" is only sayable when a count was taken.
    n = failures.note({**clean, "unclassified": []}, None)
    check("with no ledger count taken, the ledger is not pronounced clean",
          "turn ledger" not in n, n[:90])

    print("8. third-party failure text is scrubbed before a model sees it")
    leaky = "auth failed for https://api.example.com/v1/x?api_key=sk-abcd1234efgh"
    check("redact is on the path", failures.redact.scrub_text(leaky) != leaky)

    print("9. the prompt nudge carries COUNTS, never third-party text")
    line = await failures.prompt_line()
    if line:
        for table, v in c["sources"].items():
            for s in v["recent"]:
                if s.get("error"):
                    check("no error text leaks into the system prompt",
                          s["error"][:40] not in line, s["error"][:40])
                    break
            break
    check("the nudge is bounded and short", len(line) < 400, f"{len(line)} chars")

    print("10. the failure a count can never see: backups that STOP")
    # `backup_attempts` records one row per attempt, so counting rows can find
    # a refusal and can NEVER find the disaster: an interval of 0, an unmounted
    # bundle store, or a scheduler that has stopped ticking each write no row
    # at all, and an empty history counts the same as a healthy one. Absence is
    # invisible to count(*) by construction, so it is asked max(at) instead —
    # and the store owes the module's own invariant a reason for not being
    # censused, exactly like any other decline.
    from app import backup_service
    why = failures.declined().get("backup_attempts", "")
    check("backup_attempts is declined, so the report stays honest about it",
          bool(why), why[:60])
    check("...and the reason names the check that replaces counting",
          "freshness" in why)
    v = failures._Store("backup_attempts", schema["backup_attempts"])
    check("counting it would find nothing anyway — outcome/reason are outside "
          "the census vocabulary", not v.qualifies,
          f"status={v.status_col} err={v.qualifying_col}")

    # The verdict is a pure function of three numbers, so the rule is tested
    # here rather than by waiting a day for a real history to go stale.
    off = backup_service._verdict(every_hours=0, age_hours=None, outcome=None)
    check("an interval of 0 is a DECISION, not an alarm",
          not off["alarm"] and "OFF" in off["note"], off["note"][:60])
    never = backup_service._verdict(every_hours=24, age_hours=None, outcome=None)
    check("a history with nothing in it is STALE, never clean",
          never["stale"] and never["headline"], never["headline"][:70])
    stopped = backup_service._verdict(every_hours=24, age_hours=73, outcome="ok")
    check("three days since the last attempt on a daily schedule is stale",
          stopped["stale"], stopped["headline"][:70])
    fresh = backup_service._verdict(every_hours=24, age_hours=2, outcome="ok")
    check("a backup taken two hours ago is not", not fresh["stale"]
          and not fresh["alarm"] and not fresh["headline"])
    refused = backup_service._verdict(every_hours=24, age_hours=2,
                                      outcome="refused")
    check("...but running on time and producing no bundle still alarms",
          refused["alarm"] and not refused["stale"], refused["headline"][:70])
    live = await backup_service.freshness()
    check("the live verdict carries the facts it was computed from",
          {"stale", "alarm", "headline", "note", "every_hours", "at",
           "outcome"} <= set(live), str(sorted(live))[:80])
    clause = await failures._backup_clause()
    check("the prompt clause matches the verdict, both ways",
          bool(clause) == bool(live["headline"]), f"{live['headline']!r}")
    if live.get("reason"):
        check("no refusal text — which quotes paths — reaches the prompt",
              live["reason"][:40] not in clause)

    # The whole chain, driven from a STALE history. Everything above holds
    # while backups happen to be healthy, so on this machine today none of it
    # exercises the wiring: delete the append in `prompt_line` and every check
    # so far stays green. So the verdict is forced and the FACTS line is read.
    real = backup_service.freshness

    async def _stopped():
        return {"stale": True, "alarm": True,
                "headline": "the last attempt was 73h ago and one is due "
                            "every 24h",
                "note": "The last backup attempt was 73h ago.",
                "every_hours": 24.0, "at": None, "age_hours": 73.0,
                "outcome": "ok", "bundle": None, "reason": None}

    backup_service.freshness = _stopped
    try:
        failures._LINE_CACHE = (0.0, "")
        stale_line = await failures.prompt_line()
    finally:
        backup_service.freshness = real
        failures._LINE_CACHE = (0.0, "")
    check("a stopped backup reaches the FACTS block, not just diagnose",
          "73h ago" in stale_line, stale_line[-90:])
    check("...APPENDED to the counts, never instead of them — a run where "
          "work is failing AND backups stopped is where either fact alone "
          "reads like the whole answer",
          all(t in stale_line for t in c["sources"]) if c["sources"] else True,
          stale_line[:60])
    check("...and the line is still bounded", len(stale_line) < 400,
          f"{len(stale_line)} chars")

    # `note` is the sentence she quotes back, and it is the one place the
    # all-clear is supposed to be structurally unreachable. A stopped backup
    # is a failure the census CANNOT count — no row is written — so without
    # the verdict passed in, "no open failures" was sayable through a week of
    # no backups at all.
    clean_census = {"scanned": ["ingest_jobs"], "sources": {}, "total": 0,
                    "recent_total": 0, "days": 7, "unreadable": [],
                    "unclassified": []}
    check("with a healthy verdict the all-clear is still available",
          "RECORDED" in failures.note(clean_census, backups=fresh))
    stopped_note = failures.note(clean_census, backups=await _stopped())
    check("a stopped backup makes the all-clear unreachable",
          "RECORDED" not in stopped_note and "73h" in stopped_note,
          stopped_note[:70])
    unreadable_note = failures.note(clean_census, backups={"note": "could "
                                                          "not be read"})
    check("...and so does a verdict with no verdict in it — an unreadable "
          "backup story is not a healthy one",
          "RECORDED" not in unreadable_note, unreadable_note[:70])
    check("omitting the verdict entirely invents nothing",
          "backup" not in failures.note(clean_census).lower())

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
