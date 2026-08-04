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
        really_failed = await conn.fetchval(
            "SELECT count(*) FROM ingest_jobs WHERE status = 'failed'")
    counted = c["sources"].get("ingest_jobs", {}).get("failed", 0)
    check("a skipped job carrying a reason is NOT counted as a failure",
          counted == really_failed,
          f"counted={counted} failed={really_failed} skipped_with_text={skipped_with_text}")

    print("3b. a GRADE is not a fault, and the rule is derived not listed")
    # eval_runs writes status='failed' when the model under test scored below
    # the pass bar on a run the harness completed perfectly, and reserves
    # 'error' for a harness crash. Counting the grade put 4 false failures in
    # front of her. The excuse must come from the SCHEMA (a score pair beside
    # the status), not from someone remembering to add eval_runs to a list.
    check("eval_runs is excused", "eval_runs" in c.get("declined", {}),
          str(c.get("declined", {}).get("eval_runs", ""))[:60])
    check("...and NOT by being named in _DECLINED",
          "eval_runs" not in failures.declined())
    check("...but by carrying a score pair next to its status",
          "GRADE" in c["declined"]["eval_runs"])
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
