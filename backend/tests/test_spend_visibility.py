"""The spend/improve machinery and turn tokens have a READ surface.

    docker compose exec backend python tests/test_spend_visibility.py

MEASURED 2026-08-08: ten provider refusals sat in spend_ledger with the
operator's own instructions in their detail, the wall backoff held the lane
for six hours, ~6.3M prompt tokens went to OpenRouter overnight — and not one
of those facts was reachable without psql. `set_ceiling` ("lowering it takes
effect now") had zero callers. The observability headline error rate was
measuring the eval harness (2017 of 2650 traces), and 177 errored eval runs
rendered as 12 recent rows.

These suites pin the routes that make each of those visible:

  GET   /api/v1/spend           the loop's would-it-start answer, the hold
                                as a held_until, the ledger with its notes
  PATCH /api/v1/spend/ceilings  the operator can actually move a ceiling
  GET   /api/v1/spend/tokens    tokens by day x source x model
  GET   /api/v1/traces          source/status/window filters + token sums
  GET   /api/v1/observability/summary   evals excluded unless asked
  GET   /api/v1/evals/runs      status/window filters + the status census

Everything runs against fakes — no live rows are read or written; the live
ledger really does hold last night's refusals, and a suite that depended on
them would mean something different every hour.
"""

import asyncio
import sys
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

sys.path.insert(0, "/app/backend")
sys.path.insert(0, ".")

from fastapi import HTTPException                              # noqa: E402

import app.db as db_mod                                        # noqa: E402
import app.goals as goals_mod                                  # noqa: E402
import app.heartbeat as heartbeat_mod                          # noqa: E402
import app.spend as spend_mod                                  # noqa: E402
from app import router_chat, router_system                     # noqa: E402

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}"
          + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


NOW = datetime.now(timezone.utc)


class _Conn:
    """Just enough asyncpg, routed by SQL substring. Unexpected SQL raises —
    a query this suite did not anticipate must fail loudly, not return None."""

    def __init__(self, state):
        self.state = state
        self.calls: list[tuple[str, tuple]] = state.setdefault("calls", [])

    async def fetch(self, sql, *args):
        self.calls.append((sql, args))
        if "operator_note" in sql:
            return self.state.get("notes", [])
        if "goal_action_refunds" in sql:
            return self.state.get("goal_rows", [])
        if "GROUP BY status" in sql:
            return self.state.get("census_rows", [])
        if "FROM eval_runs" in sql:
            return self.state.get("eval_rows", [])
        if "FROM turn_spans s JOIN turn_traces t" in sql:
            return self.state.get("rollup_rows", [])
        if "FROM turn_traces t" in sql:
            return self.state.get("trace_rows", [])
        if "GROUP BY source" in sql:
            return self.state.get("src_rows", [])
        if "GROUP BY s.name" in sql:
            return self.state.get("model_rows", [])
        raise AssertionError(f"unexpected fetch: {sql[:80]}")

    async def fetchrow(self, sql, *args):
        self.calls.append((sql, args))
        if "FROM spend_ledger" in sql:
            return self.state.get("last_refusal_row")
        if "FROM action_runs" in sql:
            return self.state.get("busy_row")
        if "FROM goals" in sql:
            return self.state.get("spent_goal_row")
        if "FROM turn_traces" in sql:
            return self.state.get("agg_row")
        raise AssertionError(f"unexpected fetchrow: {sql[:80]}")

    async def fetchval(self, sql, *args):
        self.calls.append((sql, args))
        if "source = 'eval'" in sql:
            self.state["eval_count_asked"] = True
            return self.state.get("eval_count", 0)
        raise AssertionError(f"unexpected fetchval: {sql[:80]}")


def _fake_acquire(state):
    @asynccontextmanager
    async def acquire():
        yield _Conn(state)
    return acquire


WALL_NOTE = ("the model provider refused the last pass and retrying cannot "
             "fix that, so nothing starts for another 230 minute(s).")
PASS_LINE = "pass 2 of 4 today; 0 tokens and $0.00 measured so far"


def _drive_spend(state, *, wall, may, goal, dirty=None, entries=None):
    """Run spend_overview with every collaborator faked; nothing is charged."""
    async def ceilings(lane="improve"):
        return {"lane": lane, "max_passes": 4, "max_tokens": 2_000_000,
                "max_usd": 10.0, "updated_at": None, "updated_by": "migration"}

    async def today(lane="improve", **kw):
        return {"lane": lane, "passes": 1, "attempts": 3, "entries": 11,
                "unmetered": 11, "tokens_in": 0, "tokens_out": 0, "tokens": 0,
                "usd": 0.0}

    async def active_wall(lane="improve", **kw):
        return wall

    async def may_start(lane="improve", **kw):
        return may

    async def entries_fn(lane="improve", limit=50):
        return [dict(e) for e in (entries or [])]

    async def standing_for(verb):
        return goal

    async def host_repo_wall():
        return dirty

    saved = (spend_mod.ceilings, spend_mod.today, spend_mod.active_wall,
             spend_mod.may_start, spend_mod.entries, goals_mod.standing_for,
             heartbeat_mod.host_repo_wall, db_mod.acquire)
    (spend_mod.ceilings, spend_mod.today, spend_mod.active_wall,
     spend_mod.may_start, spend_mod.entries, goals_mod.standing_for,
     heartbeat_mod.host_repo_wall) = (ceilings, today, active_wall, may_start,
                                      entries_fn, standing_for, host_repo_wall)
    db_mod.acquire = _fake_acquire(state)
    try:
        return asyncio.run(router_system.spend_overview())
    finally:
        (spend_mod.ceilings, spend_mod.today, spend_mod.active_wall,
         spend_mod.may_start, spend_mod.entries, goals_mod.standing_for,
         heartbeat_mod.host_repo_wall, db_mod.acquire) = saved


# ── 1. GET /api/v1/spend — walled: the hold is a time, the reason is his ────

print("\n1. /api/v1/spend while the lane is walled")

wall = {"wall": "provider", "streak": 3, "age_s": 600.0, "cooldown_s": 14400.0,
        "at": str(NOW - timedelta(seconds=600)), "detail": {},
        "note": WALL_NOTE}
refusal_entry = {"id": "aaaaaaaa-0000-0000-0000-000000000001",
                 "day": "2026-08-08", "lane": "improve",
                 "kind": spend_mod.KIND_REFUSED, "model": "", "tokens_in": None,
                 "tokens_out": None, "usd": None, "metered": False,
                 "session_id": None, "run_id": None, "goal_id": None,
                 "created_at": str(NOW)}
build_entry = dict(refusal_entry, id="aaaaaaaa-0000-0000-0000-000000000002",
                   kind=spend_mod.KIND_BUILD)
state = {
    "notes": [{"id": refusal_entry["id"], "note": "Fix the key — top up.",
               "wall": "provider", "reason": "billing"}],
    "last_refusal_row": {"id": refusal_entry["id"], "run_id": None,
                         "goal_id": None, "created_at": NOW,
                         "detail": {"wall": "provider", "reason": "billing",
                                    "status": 402,
                                    "operator_note": "Fix the key — top up."}},
    "busy_row": None,
}
out = _drive_spend(state, wall=wall, may=(False, WALL_NOTE),
                   goal={"id": "g", "title": "Improve yourself",
                         "actions_used": 13, "max_actions": 20},
                   entries=[refusal_entry, build_entry])

check("1.1 hold.held with the wall kind and streak",
      out["hold"]["held"] and out["hold"]["wall"] == "provider"
      and out["hold"]["streak"] == 3)
until = datetime.fromisoformat(out["hold"]["held_until"])
left = (until - NOW).total_seconds()
check("1.2 held_until is a real time ~ cooldown - age from now",
      13700 < left < 13900, f"{left:.0f}s")
check("1.3 hold.reason is the wall's own sentence",
      out["hold"]["reason"] == WALL_NOTE)
check("1.4 last_refusal carries the operator_note",
      out["hold"]["last_refusal"]["operator_note"] == "Fix the key — top up."
      and out["hold"]["last_refusal"]["status"] == 402)
check("1.5 would_start is False and the reason is the FIRST failing gate's",
      out["improve"]["would_start"] is False
      and out["improve"]["reason"] == WALL_NOTE)
by_name = {c["check"]: c for c in out["improve"]["checks"]}
check("1.6 the five gates are all present and answered",
      set(by_name) == {"goal", "busy", "wall", "ceiling", "host_repo"},
      str(sorted(by_name)))
check("1.7 goal/busy/host_repo pass, wall/ceiling refuse",
      by_name["goal"]["ok"] and by_name["busy"]["ok"]
      and by_name["host_repo"]["ok"] and not by_name["wall"]["ok"]
      and not by_name["ceiling"]["ok"])
check("1.8 the refusal LEDGER ROW carries its operator_note back",
      out["entries"][0]["operator_note"] == "Fix the key — top up."
      and out["entries"][0]["wall"] == "provider")
check("1.9 ...and a build row is left alone",
      "operator_note" not in out["entries"][1])


# ── 2. GET /api/v1/spend — clear, and the goal-spent distinction ────────────

print("\n2. /api/v1/spend when the loop would start, and when the goal ran out")

state2 = {"last_refusal_row": None, "busy_row": None, "goal_rows": []}
out2 = _drive_spend(state2, wall=None, may=(True, PASS_LINE),
                    goal={"id": "g", "title": "Improve yourself",
                          "actions_used": 1, "max_actions": 4})
check("2.1 no wall: hold.held False, no held_until, no last_refusal",
      out2["hold"] == {"held": False, "wall": None, "streak": 0,
                       "since": None, "cooldown_s": None, "held_until": None,
                       "reason": None, "last_refusal": None})
check("2.2 would_start True and the reason is may_start's pass line",
      out2["improve"]["would_start"] is True
      and out2["improve"]["reason"] == PASS_LINE)

state3 = {"last_refusal_row": None, "busy_row": None, "goal_rows": [],
          "spent_goal_row": {"title": "Improve yourself", "actions_used": 20,
                             "max_actions": 20, "expired": False}}
out3 = _drive_spend(state3, wall=None, may=(True, PASS_LINE), goal=None)
g = next(c for c in out3["improve"]["checks"] if c["check"] == "goal")
check("2.3 a spent goal says OUT OF ACTIONS, not 'no goal'",
      not g["ok"] and "out of actions" in g["note"], g["note"])
check("2.4 ...and it is the reason (first failing gate)",
      out3["improve"]["reason"] == g["note"])

state4 = {"last_refusal_row": None, "busy_row": None, "goal_rows": [],
          "spent_goal_row": None}
out4 = _drive_spend(state4, wall=None, may=(True, PASS_LINE), goal=None)
g4 = next(c for c in out4["improve"]["checks"] if c["check"] == "goal")
check("2.5 no goal at all says so — the off switch, not a failure",
      "no live goal" in g4["note"], g4["note"])

state5 = {"last_refusal_row": None, "goal_rows": [],
          "busy_row": {"id": "bbbbbbbb-0000-0000-0000-000000000001",
                       "status": "running"}}
out5 = _drive_spend(state5, wall=None, may=(True, PASS_LINE),
                    goal={"id": "g", "title": "Improve yourself",
                          "actions_used": 1, "max_actions": 4})
b5 = next(c for c in out5["improve"]["checks"] if c["check"] == "busy")
check("2.6 a pass in flight refuses with its run id",
      not b5["ok"] and "bbbbbbbb" in b5["note"], b5["note"])

out6 = _drive_spend({"last_refusal_row": None, "busy_row": None,
                     "goal_rows": []},
                    wall=None, may=(True, PASS_LINE),
                    goal={"id": "g", "title": "Improve yourself",
                          "actions_used": 1, "max_actions": 4},
                    dirty="your own working tree on main has 57 file(s)")
r6 = next(c for c in out6["improve"]["checks"] if c["check"] == "host_repo")
check("2.7 a dirty host tree refuses with the tree's own sentence",
      not r6["ok"] and "57" in r6["note"]
      and out6["improve"]["reason"] == r6["note"])


# ── 3. PATCH /api/v1/spend/ceilings ─────────────────────────────────────────

print("\n3. PATCH /api/v1/spend/ceilings reaches set_ceiling")

def _drive_patch(body, *, raises=None):
    got = {}

    async def set_ceiling(lane="improve", *, updated_by, **limits):
        if raises:
            raise raises
        got.update(lane=lane, updated_by=updated_by, **limits)
        return {"lane": lane, **limits}

    saved = spend_mod.set_ceiling
    spend_mod.set_ceiling = set_ceiling
    try:
        try:
            out = asyncio.run(router_system.spend_set_ceilings(body))
            return out, got, None
        except HTTPException as e:
            return None, got, e
    finally:
        spend_mod.set_ceiling = saved


out, got, err = _drive_patch({"max_passes": "5", "max_usd": 2.5})
check("3.1 numbers are coerced and reach set_ceiling as the operator",
      err is None and got["max_passes"] == 5 and got["max_usd"] == 2.5
      and got["max_tokens"] is None and got["updated_by"] == "operator",
      str(got))
_, _, err = _drive_patch({"max_usd": "ten"})
check("3.2 a non-number is a 422, not a 500",
      err is not None and err.status_code == 422)
_, _, err = _drive_patch({}, raises=ValueError("nothing to set"))
check("3.3 set_ceiling's own refusals surface as 422",
      err is not None and err.status_code == 422
      and "nothing to set" in err.detail)
_, _, err = _drive_patch({"max_passes": 3},
                         raises=spend_mod.NoCeiling("cannot read"))
check("3.4 an unreadable ceilings table is 503 — said, never defaulted",
      err is not None and err.status_code == 503)


# ── 4. GET /api/v1/spend/tokens — the rollup the ledger never saw ───────────

print("\n4. /api/v1/spend/tokens sums in SQL, by day x source x model")

rollup_state = {"rollup_rows": [
    {"day": "2026-08-08", "source": "eval", "model": "openrouter:glm",
     "calls": 100, "unmetered_calls": 0, "prompt": 6_000_000,
     "completion": 50_000},
    {"day": "2026-08-08", "source": "chat", "model": "openrouter:glm",
     "calls": 10, "unmetered_calls": 2, "prompt": 300_000,
     "completion": 4_000},
    {"day": "2026-08-07", "source": "heartbeat", "model": "ollama:gemma",
     "calls": 5, "unmetered_calls": 0, "prompt": 100_000, "completion": 900},
]}

def _drive_tokens(days):
    saved = db_mod.acquire
    db_mod.acquire = _fake_acquire(rollup_state)
    try:
        return asyncio.run(router_system.spend_tokens(days))
    finally:
        db_mod.acquire = saved


out = _drive_tokens(7)
check("4.1 totals add up across every row",
      out["totals"] == {"calls": 115, "unmetered_calls": 2,
                        "prompt_tokens": 6_400_000,
                        "completion_tokens": 54_900, "tokens": 6_454_900},
      str(out["totals"]))
check("4.2 by_source answers 'where did it go'",
      out["by_source"]["eval"]["prompt_tokens"] == 6_000_000
      and out["by_source"]["chat"]["calls"] == 10
      and out["by_source"]["heartbeat"]["prompt_tokens"] == 100_000)
check("4.3 each row carries its own day/source/model and a tokens sum",
      out["rows"][0]["tokens"] == 6_050_000
      and out["rows"][2]["day"] == "2026-08-07")
sql, args = rollup_state["calls"][-1]
check("4.4 the aggregation happens IN SQL over llm_call spans",
      "GROUP BY" in sql and "llm_call" in sql and args == (7,))
rollup_state["calls"].clear()
_drive_tokens(365)
check("4.5 the window is capped at 31 days",
      rollup_state["calls"][-1][1] == (31,))
rollup_state["calls"].clear()
_drive_tokens(0)
check("4.6 ...and floored at one", rollup_state["calls"][-1][1] == (1,))


# ── 5. GET /api/v1/traces — filters + per-trace token sums ──────────────────

print("\n5. /api/v1/traces filters and counts tokens per turn")

trace_state = {"trace_rows": [
    {"id": "cccccccc-0000-0000-0000-000000000001", "source": "heartbeat",
     "automation": "heartbeat", "model": "ollama:gemma", "status": "ok",
     "started_at": NOW, "secs": 12.5, "tools": 1, "dispatches": 0,
     "llm_calls": 2, "prompt_tokens": 28_647, "completion_tokens": 418},
]}

def _drive_traces(**kw):
    saved = db_mod.acquire
    db_mod.acquire = _fake_acquire(trace_state)
    try:
        return asyncio.run(router_chat.list_traces(**kw))
    finally:
        db_mod.acquire = saved


out = _drive_traces(limit=5, source="heartbeat", status="ok", window="7d")
sql, args = trace_state["calls"][-1]
check("5.1 source/status/window all reach the query as parameters",
      args == (5, "heartbeat", "ok", timedelta(days=7)), str(args))
check("5.2 the token sums ride on the row, summed in the existing GROUP BY",
      out[0]["prompt_tokens"] == 28_647 and out[0]["completion_tokens"] == 418
      and out[0]["tokens"] == 29_065 and "GROUP BY t.id" in sql)
out = _drive_traces()
check("5.3 no filters is the old behaviour — NULLs match everything",
      trace_state["calls"][-1][1] == (50, None, None, None))
try:
    _drive_traces(window="99d")
    check("5.4 an unknown window is refused", False)
except HTTPException as e:
    check("5.4 an unknown window is refused", e.status_code == 422, e.detail)


# ── 6. observability/summary measures HER, not the harness ──────────────────

print("\n6. /api/v1/observability/summary excludes evals unless asked")

sum_state = {
    "agg_row": {"turns": 319, "errors": 4, "cancelled": 23, "p50": 10.0,
                "p95": 69.3},
    "src_rows": [{"source": "chat", "n": 216}],
    "model_rows": [], "eval_count": 1944,
}

def _drive_summary(**kw):
    sum_state["eval_count_asked"] = False
    saved = db_mod.acquire
    db_mod.acquire = _fake_acquire(sum_state)
    try:
        return asyncio.run(router_system.observability_summary(**kw))
    finally:
        db_mod.acquire = saved


out = _drive_summary(window="7d")
check("6.1 the DEFAULT excludes evals and says how many it left out",
      out["include_evals"] is False and out["eval_turns_excluded"] == 1944)
check("6.2 every aggregate query received the exclusion flag",
      all(False in a for _, a in sum_state["calls"]
          if "turn_traces" in _ and "source = 'eval'" not in _),
      str([a for _, a in sum_state["calls"]]))
out = _drive_summary(window="7d", include_evals=True)
check("6.3 include_evals=true keeps them and counts nothing as excluded",
      out["include_evals"] is True and out["eval_turns_excluded"] == 0
      and not sum_state["eval_count_asked"])


# ── 7. evals/runs — the census the 12-row list was hiding ───────────────────

print("\n7. /api/v1/evals/runs census + filters")

eval_state = {
    "eval_rows": [
        {"id": "dddddddd-0000-0000-0000-000000000001", "suite": "main",
         "agent_name": "main", "model": "openrouter:glm", "status": "error",
         "started_at": NOW, "finished_at": NOW, "tasks_total": 0,
         "tasks_passed": 0, "tokens_in": 0, "tokens_out": 0,
         "duration_s": 1.0, "error": "boom", "repeat_count": 1,
         "suite_version": 1, "task_index": 0, "resumes": 0,
         "announced_at": None, "announcement": None, "tasks_gradeable": None,
         "failure": '{"type": "harness", "message": "boom"}',
         "stalled_for_s": None},
    ],
    "census_rows": [{"status": "error", "n": 177},
                    {"status": "failed", "n": 78}],
}

def _drive_evals(**kw):
    saved = db_mod.acquire
    db_mod.acquire = _fake_acquire(eval_state)
    try:
        return asyncio.run(router_chat.evals_runs(**kw))
    finally:
        db_mod.acquire = saved


out = _drive_evals(status="error", window="24h", limit=5)
list_sql, list_args = next((s, a) for s, a in eval_state["calls"]
                           if "ORDER BY started_at" in s)
census_sql, census_args = next((s, a) for s, a in eval_state["calls"]
                               if "GROUP BY status" in s)
check("7.1 status and window reach the list query",
      list_args == (None, "error", timedelta(days=1), 5), str(list_args))
check("7.2 the census covers the window but IGNORES the status narrowing",
      census_args == (None, timedelta(days=1)), str(census_args))
check("7.3 zero passes is STATED, not absent — the headline of the night",
      out["census"] == {"running": 0, "passed": 0, "failed": 78,
                        "error": 177}, str(out["census"]))
check("7.4 rows keep eval_runs' own derived reading (outcome), one source",
      out["runs"][0]["outcome"]["code"] == "unmeasured"
      and out["runs"][0]["outcome"]["measurement"] is False,
      str(out["runs"][0]["outcome"])[:90])
check("7.5 the failure record is parsed for the caller",
      out["runs"][0]["failure"] == {"type": "harness", "message": "boom"})
try:
    _drive_evals(window="never")
    check("7.6 an unknown window is refused", False)
except HTTPException as e:
    check("7.6 an unknown window is refused", e.status_code == 422)


print()
if FAILURES:
    print(f"FAILED: {len(FAILURES)}")
    for f in FAILURES:
        print(f"  - {f}")
    sys.exit(1)
print("all spend-visibility checks passed")
