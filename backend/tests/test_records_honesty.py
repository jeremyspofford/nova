"""Her records tell the truth — five defects from the 2026-08-08 audit.

    docker compose exec backend python tests/test_records_honesty.py

What is pinned, and the incident behind each pin:

1. TEST TRAFFIC CANNOT REACH THE OPERATOR'S CONVERSATION. Suite runs against
   the live database wrote 139 junk notification rows into Jeremy's real
   chat ('Nova recommends: t', eval announcements for suites 'fake' and
   'fake-durability'), and the eval announcement backlog sweep re-manufactured
   a fresh batch at 12:15Z on 2026-08-08 from unannounced test rows.
   `notifications.record` now refuses a test context loudly, eval rows a
   suite touches are STAMPED, `_announce` closes a stamped row silently, and
   the backlog sweep skips them. This very file is a test process against
   the live database, so the guard is exercised by simply being here.

2. GOAL-LANE ACTIONS ARE ATTRIBUTED TO THEIR GOAL. `_action_rows` hardcoded
   actor='operator (approved)' while the table's `lane` column said 'goal' —
   her most autonomous work rendered as the operator's clicks.

3. RETENTION IS AGE-BASED AND THE LOG SAYS WHERE HISTORY BEGINS. The 50-row
   cap kept ~4.3h of a 5-minute automation while 7d windows claimed
   complete:true. Now automations keep RUNS_KEPT_DAYS and activity_log
   reports per-source history_begins + refuses completeness for a window
   wider than a source's retention.

4. REFUSED-BY IS A RECORDED FACT. The refusing gate stamps its id
   (registry._refuse -> span detail.refused_by) and the classifier prefers
   the record; text markers survive only as the fallback for old rows.
"""

import asyncio
import json
import sys
import uuid
from datetime import datetime, timedelta, timezone

sys.path.insert(0, "/app/backend")

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


async def main() -> int:
    from app import activity_log, automations, db, eval_runs, notifications
    from app import settings_store, trace
    from app.agents import runner as rn
    from app.tools import registry as tool_registry

    await db.init_pool()
    await settings_store.warm()

    # ── 1a. the guard sees THIS process for what it is ────────────────────
    print("1. a test process cannot write into the operator's conversation")
    why = notifications.test_context()
    check("this suite is recognised as a test context", why is not None,
          str(why))
    check("...by its entry point, not by a maintained name list",
          why is not None and "test_records_honesty.py" in why, str(why))

    marker = f"records-honesty-suite-{uuid.uuid4().hex[:8]}"
    raised = ""
    try:
        await notifications.record(f"junk body {marker}", title="junk")
    except RuntimeError as e:
        raised = str(e)
    check("notifications.record REFUSES, loudly", bool(raised), raised[:80])
    async with db.acquire() as conn:
        n = await conn.fetchval(
            "SELECT count(*) FROM notifications WHERE body LIKE $1",
            f"%{marker}%")
    check("...and wrote nothing", n == 0, str(n))

    # note_repeat must SKIP rather than raise — notify.send calls it outside
    # any try, so a raise would break its never-raises contract.
    try:
        await notifications.note_repeat(str(uuid.uuid4()))
        skipped = True
    except Exception as e:                                    # noqa: BLE001
        skipped = False
        print(f"        note_repeat raised: {e}")
    check("note_repeat skips silently in a test context", skipped)

    # ── 1b. eval rows a suite touches are stamped, and stamped rows are
    #        closed silently instead of announced ─────────────────────────
    print("\n2. a suite's eval rows never become announcements")
    made: list[str] = []

    async def new_run(*, status: str, detail: str = "{}",
                      claimed: bool = False) -> str:
        async with db.acquire() as conn:
            rid = await conn.fetchval(
                "INSERT INTO eval_runs (suite, agent_name, model, status, "
                "  finished_at, detail, announce_claimed_at, "
                "  announce_claimed_by) "
                "VALUES ($1,'model-manager','none:none',$2, "
                "        CASE WHEN $2 <> 'running' THEN now() END, "
                "        $3::jsonb, "
                "        CASE WHEN $4 THEN now() END, "
                "        CASE WHEN $4 THEN 'records-honesty' END) "
                "RETURNING id", f"honesty-{uuid.uuid4().hex[:8]}", status,
                detail, claimed)
        made.append(str(rid))
        return str(rid)

    # _persist_progress stamps rows it touches — including rows a suite
    # INSERTed raw, which `start`'s stamp can never reach.
    rid = await new_run(status="running")
    await eval_runs._persist_progress(
        rid, index=1, total=4, passed=1, graded=1, tin=1, tout=1,
        duration=0.1, details=[{"task": "t/0", "passed": True,
                                "gradeable": True}])
    async with db.acquire() as conn:
        stamped = await conn.fetchval(
            "SELECT COALESCE((detail->>'test')::boolean, false) "
            "  FROM eval_runs WHERE id = $1::uuid", rid)
    check("a progress write from a suite stamps the row `test`", stamped)

    # A STAMPED terminal row: announce closes it with a suppression doc and
    # writes NO notification. Inserted with a live announce lease so the real
    # backend's 60s sweep cannot race this suite to the row — the suppression
    # path deliberately ignores the lease, so the shield costs nothing here.
    rid2 = await new_run(status="failed", detail='{"test": true}',
                         claimed=True)
    doc = await eval_runs.announce(rid2)
    async with db.acquire() as conn:
        row2 = await conn.fetchrow(
            "SELECT announced_at, announcement FROM eval_runs "
            " WHERE id = $1::uuid", rid2)
        leaked = await conn.fetchval(
            "SELECT count(*) FROM notifications WHERE body LIKE '%honesty-%'")
    ann = row2["announcement"]
    ann = json.loads(ann) if isinstance(ann, str) else (ann or {})
    check("announce CLOSES a stamped row (the sweep cannot re-manufacture it)",
          row2["announced_at"] is not None)
    check("...with an honest suppression account, not a delivery claim",
          bool(doc and doc.get("suppressed")) and ann.get("suppressed") is True,
          str(ann)[:100])
    check("...and no notification row was written", leaked == 0, str(leaked))

    # The backlog sweep's own WHERE skips stamped rows — scoped to this row
    # for the reason _claim_stale documents: an unscoped pass reaches every
    # live row.
    rid3 = await new_run(status="failed", detail='{"test": true}')
    done = await eval_runs._announce_backlog(only_run=rid3)
    async with db.acquire() as conn:
        still_open = await conn.fetchval(
            "SELECT announced_at IS NULL FROM eval_runs WHERE id = $1::uuid",
            rid3)
    check("the backlog sweep SKIPS a stamped row", done == 0 and still_open,
          f"announced={done} still_open={still_open}")

    async with db.acquire() as conn:
        await conn.execute("DELETE FROM eval_runs WHERE id = ANY($1::uuid[])",
                           [uuid.UUID(i) for i in made])

    # ── 2. goal-lane action runs are attributed to their goal ────────────
    print("\n3. the activity log attributes goal-lane work to the goal")
    goal_title = "Improve yourself, continuously"
    gid = rec_id = rec2_id = run_goal = run_op = None
    async with db.acquire() as conn:
        gid = await conn.fetchval(
            "INSERT INTO goals (title, status, approved_verbs) "
            "VALUES ($1, 'done', '{}') RETURNING id", goal_title)
        rec_id = await conn.fetchval(
            "INSERT INTO recommendations (kind, title, body, source) "
            "VALUES ('idea', 'records-honesty goal plan', 'b', 'suite') "
            "RETURNING id")
        rec2_id = await conn.fetchval(
            "INSERT INTO recommendations (kind, title, body, source) "
            "VALUES ('idea', 'records-honesty operator plan', 'b', 'suite') "
            "RETURNING id")
        run_goal = await conn.fetchval(
            "INSERT INTO action_runs (recommendation_id, action, action_type, "
            "  status, lane, goal_id) "
            "VALUES ($1, '{}'::jsonb, 'plan', 'succeeded', 'goal', $2) "
            "RETURNING id", rec_id, gid)
        run_op = await conn.fetchval(
            "INSERT INTO action_runs (recommendation_id, action, action_type, "
            "  status, lane) "
            "VALUES ($1, '{}'::jsonb, 'plan', 'succeeded', 'operator') "
            "RETURNING id", rec2_id)
    try:
        page = await activity_log.fetch(window="1h", limit=300,
                                        kinds=["action"])
        rows = {r["id"]: r for r in page["rows"]}
        g = rows.get(f"action:{run_goal}")
        o = rows.get(f"action:{run_op}")
        check("the goal-lane run is on the page", g is not None)
        check("...attributed to the STANDING GOAL, not to an approval click",
              bool(g) and g["actor"] == f"under goal: {goal_title}",
              str(g and g["actor"]))
        check("the operator-lane run keeps the approval attribution",
              bool(o) and o["actor"] == "operator (approved)",
              str(o and o["actor"]))
        check("the lane rides along for the UI", bool(g) and g.get("lane") == "goal")
    finally:
        async with db.acquire() as conn:
            # recommendations cascade to action_runs; the goal row is its own
            await conn.execute(
                "DELETE FROM recommendations WHERE id = ANY($1::uuid[])",
                [rec_id, rec2_id])
            await conn.execute("DELETE FROM goals WHERE id = $1", gid)

    # ── 3. age-based retention + honest history ──────────────────────────
    print("\n4. automation runs survive by AGE, and the log says where "
          "history begins")
    aid = None
    async with db.acquire() as conn:
        aid = await conn.fetchval(
            "INSERT INTO automations (name, instruction, agent_name, "
            "  interval_minutes, enabled) "
            "VALUES ($1, 'suite probe', 'main', 60, false) RETURNING id",
            f"records-honesty-{uuid.uuid4().hex[:8]}")
        old_id = await conn.fetchval(
            "INSERT INTO automation_runs (automation_id, status, summary, "
            "  started_at) VALUES ($1, 'ok', 'old', now() - interval '35 days') "
            "RETURNING id", aid)
    try:
        await automations.record_run(str(aid), "ok", "fresh", 60, False)
        async with db.acquire() as conn:
            old_gone = await conn.fetchval(
                "SELECT count(*) = 0 FROM automation_runs WHERE id = $1", old_id)
            fresh_kept = await conn.fetchval(
                "SELECT count(*) FROM automation_runs WHERE automation_id = $1",
                aid)
        check("a run older than RUNS_KEPT_DAYS is pruned", old_gone)
        check("a fresh run is kept", fresh_kept == 1, str(fresh_kept))
        check("retention is measured in DAYS, long enough for the 30d window",
              automations.RUNS_KEPT_DAYS * 24 >= activity_log.WINDOWS["30d"],
              f"{automations.RUNS_KEPT_DAYS}d")
    finally:
        async with db.acquire() as conn:
            await conn.execute("DELETE FROM automations WHERE id = $1", aid)

    check("every source can say where its history begins — keyed like SOURCES",
          set(activity_log.HISTORY_BEGINS_SQL) == set(activity_log.SOURCES),
          str(sorted(set(activity_log.SOURCES)
                     ^ set(activity_log.HISTORY_BEGINS_SQL))))
    horizons = activity_log.retention_days()
    check("the automation horizon is READ from automations, never typed",
          horizons.get("automation") == float(automations.RUNS_KEPT_DAYS),
          str(horizons))
    check("tool spans' horizon is the trace retention setting",
          "tool" in horizons, str(horizons))

    # beyond_retention is pure; hold the module's own constant still to
    # prove the derivation rather than the arithmetic of today's settings.
    real = automations.RUNS_KEPT_DAYS
    try:
        automations.RUNS_KEPT_DAYS = 0.5
        outran = activity_log.beyond_retention(24, {"automation"})
        check("a window wider than a source's retention names the source",
              outran == {"automation"}, str(outran))
    finally:
        automations.RUNS_KEPT_DAYS = real
    check("a window equal to the retention does NOT indict the page",
          activity_log.beyond_retention(
              activity_log.WINDOWS["30d"], {"automation"}) == set())

    page = await activity_log.fetch(window="1h", limit=1, kinds=["action"])
    check("the response carries history_begins per source",
          "action" in (page.get("history_begins") or {}),
          str(page.get("history_begins")))
    check("...and says which sources the window outran",
          isinstance(page.get("beyond_retention"), list))
    wide = await activity_log.fetch(window="30d", limit=1, kinds=["tool"])
    if "tool" in activity_log.beyond_retention(activity_log.WINDOWS["30d"],
                                               {"tool"}):
        check("a 30d window over 14d trace retention is NOT called complete",
              wide["complete"] is False and wide["beyond_retention"] == ["tool"],
              str(wide["beyond_retention"]))
    else:
        print("  ....  trace.retention_days covers the 30d window on this "
              "install — the outrun branch is exercised by the pure check "
              "above instead")

    # ── 4. refused-by is recorded at refusal time ────────────────────────
    print("\n5. a refused call carries WHICH gate refused, in its span")
    out = await tool_registry.execute_tool(
        "pull_model", {"name": "x"},
        {"granted": {"search_memory"}, "agent_name": "records-honesty"})
    check("the grant gate still refuses", tool_registry.is_error_result(out),
          out[:60])
    check("...and records itself as the refusing gate",
          tool_registry.refused_by() == "grant",
          str(tool_registry.refused_by()))

    ok = await tool_registry.execute_tool(
        "search_memory", {"query": "records honesty probe"},
        {"granted": {"search_memory"}, "agent_name": "records-honesty"})
    check("a call that RAN clears the record — the previous refusal cannot "
          "leak onto it", tool_registry.refused_by() is None,
          str(tool_registry.refused_by()))

    async with trace.turn("chat", model="records-honesty-suite") as t:
        await rn._run_tool("pull_model", {"name": "x"},
                           {"granted": {"search_memory"},
                            "agent_name": "records-honesty"},
                           "records-honesty")
    span = t.spans[0]
    check("the span detail carries refused_by='grant'",
          span["detail"].get("refused_by") == "grant",
          str(span["detail"].get("refused_by")))
    check("...beside the error text it used to carry alone",
          bool(span["detail"].get("error")))
    # the turn flushed to the live ledger on exit; remove it
    await asyncio.sleep(0.5)
    async with db.acquire() as conn:
        await conn.execute("DELETE FROM turn_traces WHERE id = $1", t.id)

    # The classifier PREFERS the record: a rewording the text matcher has
    # never seen still classifies as refused, with the gate named.
    outcome, reason = activity_log.classify_tool_error(
        "Error: some future rewording nobody taught the classifier",
        refused_by="goal")
    check("a reworded gate with a recorded id is still REFUSED",
          outcome == activity_log.REFUSED, outcome)
    check("...with a reason from the gate's own vocabulary",
          bool(reason) and "goal" in (reason or "").lower(), str(reason))
    check("gate_of prefers the record too",
          activity_log.gate_of("unrecognisable", "containment") == "containment")
    outcome2, _ = activity_log.classify_tool_error(
        "Error: some future rewording nobody taught the classifier")
    check("without the record the fallback still degrades to FAILED, never ok",
          outcome2 == activity_log.FAILED, outcome2)

    # ...and the page reads the record: a span whose text matches NO marker
    # but which carries refused_by renders as refused with its gate.
    mark = f"records-honesty-{uuid.uuid4().hex[:8]}"
    tid = uuid.uuid4()
    now = datetime.now(timezone.utc)
    async with db.acquire() as conn:
        await conn.execute(
            "INSERT INTO turn_traces (id, source, model, status, started_at, "
            "finished_at) VALUES ($1, 'chat', 'suite', 'ok', $2, $2)", tid, now)
        await conn.execute(
            "INSERT INTO turn_spans (id, trace_id, seq, kind, name, status, "
            "started_at, finished_at, detail) "
            "VALUES ($1, $2, 1, 'tool', 'manage_tools', 'error', $3, $3, $4)",
            uuid.uuid4(), tid, now,
            json.dumps({"agent": mark, "args": "{}",
                        "error": "Error: wording from a future nobody taught",
                        "refused_by": "goal"}))
    try:
        page = await activity_log.fetch(window="1h", limit=50, agent=mark)
        row = next((r for r in page["rows"] if r.get("tool") == "manage_tools"),
                   None)
        check("the page renders the recorded refusal as REFUSED",
              bool(row) and row["outcome"] == activity_log.REFUSED,
              str(row and row["outcome"]))
        check("...naming the recorded gate", bool(row) and row["gate"] == "goal",
              str(row and row["gate"]))
        check("...and the window counts agree with the row",
              page["counts"].get(activity_log.REFUSED, 0) >= 1,
              str(page["counts"]))
    finally:
        async with db.acquire() as conn:
            await conn.execute("DELETE FROM turn_traces WHERE id = $1", tid)

    await db.close_pool()
    _ = ok
    return 1 if FAILURES else 0


if __name__ == "__main__":
    code = asyncio.run(main())
    if FAILURES:
        print(f"\nFAILED ({len(FAILURES)}): " + "; ".join(FAILURES[:8]))
    else:
        print("\nall checks passed")
    sys.exit(code)
