"""The execution-record adapter maps five lifecycles without touching any.

    docker compose exec backend python tests/test_execution_records.py
    PYTHONPATH=backend python backend/tests/test_execution_records.py   (CI)

Slice 3 (TA-9 / D-019). app/execution_records.py is a read-only derived
view — no table, no writer, no migration, internal test/admin-only. Pinned:

  1. Per-source mapping: canonical fields come only from authoritative
     columns; provenance marks source/derived/absent per field; large text
     columns are omitted and NAMED as omitted.
  2. The approved status normalization, including: turn status from
     turn_traces.status (the outcome column) with turn_traces.source
     carried separately as turn_source and never used for status; coding
     non-terminal -> running derived from coder.TERMINAL; unmapped -> other
     with status_raw preserved verbatim.
  3. NO INFERENCE: principal / credential_assurance / release_id are absent
     everywhere; trace_id exists only for turns (identity); an automation
     firing and the same-named turn are never linked.
  4. Query semantics: newest-first total order, keyset pagination, kind and
     status_class filters, limit cap.
  5. SURFACE SCAN: nothing in app/ outside the module itself references it —
     no route, tool, prompt, agent, or runtime path consumes the view.
  6. Probe rows in all five source tables are removed in finally, with a
     zero-residue assertion. Probe automations are inserted enabled=false so
     the live scheduler can never fire them.
"""

import asyncio
import json
import re
import sys
import uuid
from pathlib import Path

sys.path.insert(0, "/app/backend")

from app import db, execution_records as xr                    # noqa: E402

FAILURES: list[str] = []
APP = Path(__file__).resolve().parents[1] / "app"


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}"
          + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


async def main():
    await db.init_pool()
    ids = {}          # table -> [pks]
    try:
        async with db.acquire() as conn:
            # ---- probes, one per interesting raw status ----
            ids["turn_traces"] = []
            for status in ("ok", "error", "cancelled"):
                tid = uuid.uuid4()
                await conn.execute(
                    "INSERT INTO turn_traces (id, source, status, model, error, "
                    "started_at, finished_at) VALUES ($1,'heartbeat',$2,'m:probe',"
                    "$3, now() - interval '1 minute', now())",
                    tid, status, "boom" if status == "error" else None)
                ids["turn_traces"].append(tid)

            # One recommendation per run: a partial unique index allows only
            # one LIVE action_run per recommendation.
            ids["recommendations"] = []
            ids["action_runs"] = []
            for status in ("queued", "blocked", "succeeded"):
                rec_id = await conn.fetchval(
                    "INSERT INTO recommendations (kind,title,body,source) "
                    "VALUES ('probe','xr probe','b','xr-test') RETURNING id")
                ids["recommendations"].append(rec_id)
                rid = await conn.fetchval(
                    "INSERT INTO action_runs (recommendation_id, action, "
                    "action_type, status, started_at, finished_at, lane) "
                    "VALUES ($1,'{}','probe.noop',$2,"
                    "CASE WHEN $2 <> 'queued' THEN now() - interval '50 seconds' END,"
                    "CASE WHEN $2 = 'succeeded' THEN now() END,'operator') "
                    "RETURNING id", rec_id, status)
                ids["action_runs"].append(rid)

            auto_id = await conn.fetchval(
                "INSERT INTO automations (name, instruction, agent_name, "
                "interval_minutes, enabled) VALUES "
                "('xr-probe-auto','probe','main',999999,false) RETURNING id")
            ids["automations"] = [auto_id]
            ids["automation_runs"] = []
            for status in ("ok", "error", "weird-status"):
                rid = await conn.fetchval(
                    "INSERT INTO automation_runs (automation_id, status, summary, "
                    "started_at, duration_seconds) VALUES ($1,$2,'probe',"
                    "now() - interval '40 seconds', 2.5) RETURNING id",
                    auto_id, status)
                ids["automation_runs"].append(rid)
            # A turn that LOOKS like this automation's firing — must never link.
            bait = uuid.uuid4()
            await conn.execute(
                "INSERT INTO turn_traces (id, source, status, automation, "
                "started_at, finished_at) VALUES ($1,'automation','ok',"
                "'xr-probe-auto', now() - interval '40 seconds', now())", bait)
            ids["turn_traces"].append(bait)

            ids["coding_sessions"] = []
            for state in ("done", "killed", "stalled", "booting"):
                rid = await conn.fetchval(
                    "INSERT INTO coding_sessions (task, mode, state, "
                    "requested_by, commit_sha) VALUES ('probe','build',$1,"
                    "'xr-test','deadbeef') RETURNING id", state)
                ids["coding_sessions"].append(rid)

            ids["eval_runs"] = []
            for status in ("running", "measured", "unmeasured"):
                rid = await conn.fetchval(
                    "INSERT INTO eval_runs (suite, agent_name, model, status, "
                    "started_at, finished_at, duration_s) VALUES "
                    "('xr-probe','main','m:probe',$1, now() - interval '30 seconds',"
                    "CASE WHEN $1 <> 'running' THEN now() END, 3.0) RETURNING id",
                    status)
                ids["eval_runs"].append(rid)

        recs = await xr.list_records(limit=200)
        mine = {(r["source_table"], r["source_id"]): r for r in recs}

        def rec_for(table, pk):
            return mine.get((table, str(pk)))

        print("1. turns: outcome from status, origin kept separate")
        for tid, raw, cls in zip(ids["turn_traces"][:3],
                                 ("ok", "error", "cancelled"),
                                 ("succeeded", "failed", "cancelled")):
            r = rec_for("turn_traces", tid)
            check(f"turn {raw} -> {cls}", r and r["status_raw"] == raw
                  and r["status_class"] == cls)
            if raw == "ok":
                check("turn_source is its own field, not a status",
                      r["turn_source"] == "heartbeat"
                      and r["provenance"]["turn_source"] == "source")
                check("trace_id is the turn's own id (identity, marked source)",
                      r["trace_id"] == str(tid)
                      and r["provenance"]["trace_id"] == "source")

        print("2. action runs")
        for rid, raw, cls in zip(ids["action_runs"],
                                 ("queued", "blocked", "succeeded"),
                                 ("waiting", "waiting", "succeeded")):
            r = rec_for("action_runs", rid)
            check(f"action_run {raw} -> {cls}", r and r["status_class"] == cls)
            if raw == "queued":
                check("queued run's start falls back to created_at, and says so",
                      r["provenance"]["started_at"] == "source: created_at")
                check("lane is a label, never a principal",
                      r["actor_label"] == "lane:operator"
                      and r["principal"] is None
                      and r["provenance"]["principal"] == "absent")
                check("large columns omitted BY NAME",
                      "action" in r["provenance"]["omitted"])

        print("3. automation firings")
        for rid, raw, cls in zip(ids["automation_runs"],
                                 ("ok", "error", "weird-status"),
                                 ("succeeded", "failed", "other")):
            r = rec_for("automation_runs", rid)
            check(f"automation_run {raw!r} -> {cls}",
                  r and r["status_class"] == cls and r["status_raw"] == raw)
        r = rec_for("automation_runs", ids["automation_runs"][0])
        check("automation name/agent come from the JOIN, marked derived",
              r["automation_name"] == "xr-probe-auto"
              and r["provenance"]["automation_name"] == "derived"
              and r["provenance"]["actor_label"] == "derived")
        check("duration comes from the source column here",
              r["duration_s"] == 2.5 and r["provenance"]["duration_s"] == "source")
        b = rec_for("turn_traces", bait)
        check("NO INFERENCE: the same-named turn is a separate record with "
              "no link to the firing",
              b is not None and b["trace_id"] == str(bait)
              and r["trace_id"] is None
              and r["provenance"]["trace_id"] == "absent"
              and "automation_run" not in json.dumps(b["extra"]))

        print("4. coding sessions")
        for rid, raw, cls in zip(ids["coding_sessions"],
                                 ("done", "killed", "stalled", "booting"),
                                 ("succeeded", "cancelled", "other", "running")):
            r = rec_for("coding_sessions", rid)
            check(f"coding {raw} -> {cls}", r and r["status_class"] == cls)
        from app import coder
        check("the non-terminal rule is derived from coder.TERMINAL",
              xr._classify("coding_session", "booting") == "running"
              and all(xr._classify("coding_session", s) != "running"
                      for s in coder.TERMINAL))

        print("5. eval runs")
        for rid, raw, cls in zip(ids["eval_runs"],
                                 ("running", "measured", "unmeasured"),
                                 ("running", "succeeded", "other")):
            r = rec_for("eval_runs", rid)
            check(f"eval {raw} -> {cls} (execution status, never quality)",
                  r and r["status_class"] == cls)

        print("6. absent means absent, everywhere")
        sample = [rec_for("action_runs", ids["action_runs"][0]),
                  rec_for("coding_sessions", ids["coding_sessions"][0]),
                  rec_for("eval_runs", ids["eval_runs"][0]),
                  rec_for("automation_runs", ids["automation_runs"][0])]
        check("principal/assurance/release are NULL + 'absent' on every kind",
              all(r["principal"] is None and r["credential_assurance"] is None
                  and r["release_id"] is None
                  and all(r["provenance"][f] == "absent" for f in
                          ("principal", "credential_assurance", "release_id"))
                  for r in sample))
        check("trace_id is absent for every non-turn kind",
              all(r["trace_id"] is None for r in sample))

        print("7. query semantics")
        allr = await xr.list_records(limit=200)
        keys = [(r["started_at"], r["source_table"], r["source_id"]) for r in allr]
        check("newest-first total order", keys == sorted(keys, reverse=True))
        page1 = await xr.list_records(limit=5)
        last = page1[-1]
        page2 = await xr.list_records(
            limit=5, before=(last["started_at"], last["source_table"],
                             last["source_id"]))
        check("keyset pagination never repeats a row",
              not ({(r["source_table"], r["source_id"]) for r in page1}
                   & {(r["source_table"], r["source_id"]) for r in page2}))
        only = await xr.list_records(kinds=["eval_run"], limit=200)
        check("kind filter", {r["kind"] for r in only} == {"eval_run"})
        waiting = await xr.list_records(status_class="waiting", limit=200)
        check("status_class filter",
              waiting and all(r["status_class"] == "waiting" for r in waiting))
        try:
            await xr.list_records(kinds=["nope"])
            check("unknown kind refuses", False)
        except ValueError:
            check("unknown kind refuses", True)
        check("limit is capped", len(await xr.list_records(limit=99999)) <= xr.LIMIT_MAX)

        print("8. surface scan: nobody at runtime consumes the view")
        users = [p.name for p in APP.rglob("*.py")
                 if p.name != "execution_records.py"
                 and re.search(r"execution_records", p.read_text())]
        check("no app/ module imports or references execution_records",
              not users, ",".join(users))
    finally:
        async with db.acquire() as conn:
            await conn.execute("DELETE FROM eval_runs WHERE id = ANY($1::uuid[])",
                               ids.get("eval_runs", []))
            await conn.execute("DELETE FROM coding_sessions WHERE id = ANY($1::uuid[])",
                               ids.get("coding_sessions", []))
            await conn.execute("DELETE FROM turn_traces WHERE id = ANY($1::uuid[])",
                               ids.get("turn_traces", []))
            # recommendations cascade-deletes its action_runs; automations
            # cascade-deletes its runs — delete parents, then verify all.
            await conn.execute("DELETE FROM recommendations WHERE id = ANY($1::uuid[])",
                               ids.get("recommendations", []))
            await conn.execute("DELETE FROM automations WHERE id = ANY($1::uuid[])",
                               ids.get("automations", []))
            left = 0
            for table, pks in ids.items():
                left += await conn.fetchval(
                    f"SELECT count(*) FROM {table} WHERE id = ANY($1::uuid[])", pks)
        print(f"\n  cleanup: {left} probe row(s) left behind")
        if left:
            FAILURES.append("probe rows survived cleanup")

    print()
    if FAILURES:
        print(f"FAILED: {len(FAILURES)}")
        for f in FAILURES:
            print(f"  - {f}")
        sys.exit(1)
    print("all checks passed")


asyncio.run(main())
