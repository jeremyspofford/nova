"""The self-improvement loop stops wasting the night on one unchanged wall.

    docker compose exec backend python tests/test_improve_walls.py

MEASURED 2026-08-08, goal 71973ec9: thirteen passes in one night, every one
dying on the same OpenRouter HTTP 402 or the operator's own dirty tree. Four
defects, each pinned below:

  1. a refund made the next charge re-use its pass number, so the card
     dedupe key collided with an already-decided card and the freshly
     charged action was burnt with nothing to show — eight of twenty went
     that way;
  2. preflight said 'ready' for passes doomed at the staging step, because
     nothing asked the landing sidecar whether the host repo was clean
     before charging an action and paying for an hour of coding;
  3. the flat one-hour cooldown was shorter than the ~90-minute tick, so it
     gated nothing, and every doomed pass raised a fresh card + push — 24+
     notifications about one unchanged wall;
  4. a beat whose model returned nothing delivered the runner's empty-final
     floor to the phone as a real alert and recorded ok/notified.

Everything runs against fakes — no live rows are read or written, because the
live ledger really does hold last night's refusals and a suite that depended
on them would mean something different every hour.
"""

import asyncio
import sys
import uuid
from contextlib import asynccontextmanager

sys.path.insert(0, "/app/backend")
sys.path.insert(0, ".")

from app import action_worker, heartbeat, spend               # noqa: E402

FAILURES: list[str] = []

GOAL = "22222222-2222-2222-2222-222222222222"


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}"
          + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


# ── 1. a refund does not make the next charge collide with a decided card ───

print("\n1. the dedupe key counts charges EVER MADE, so it never repeats")

g9 = {"id": GOAL, "actions_used": 9}
check("1.1 same charge, same key — the heartbeat cannot stack cards for "
      "one pass",
      action_worker.pass_dedupe_key(g9, 0)
      == action_worker.pass_dedupe_key(g9, 0))
check("1.2 THE DEFECT: after a refund the same actions_used is a NEW charge "
      "and gets a NEW key",
      action_worker.pass_dedupe_key(g9, 0)
      != action_worker.pass_dedupe_key(g9, 1),
      action_worker.pass_dedupe_key(g9, 1))
# The key exists only AT a charge, after the atomic increment — so the
# reachable (actions_used, refunds) pairs are the charge points of a history.
# charge, charge, refund, charge, refund, charge:
seen = {action_worker.pass_dedupe_key({"id": GOAL, "actions_used": u}, r)
        for u, r in [(1, 0), (2, 0), (2, 1), (3, 1), (3, 2)]}
check("1.3 every charge point of a charge/refund/recharge history yields a "
      "distinct key", len(seen) == 5, str(sorted(seen)))


class _Conn:
    """Just enough asyncpg for enqueue_goal_run, routed by SQL substring."""

    def __init__(self, state):
        self.state = state

    def transaction(self):
        @asynccontextmanager
        async def _t():
            yield
        return _t()

    async def fetchval(self, sql, *args):
        if "goal_action_refunds" in sql:
            return self.state["refunds"]
        if "FROM goals" in sql:
            return 1                                   # the goal is live
        if "FROM action_runs" in sql:
            return None                                # not busy
        raise AssertionError(f"unexpected fetchval: {sql[:60]}")

    async def fetchrow(self, sql, *args):
        if "UPDATE recommendations" in sql:
            rid = args[0]
            if self.state["status"].get(rid) == "new":
                self.state["status"][rid] = "approved"
                return {"id": rid}
            return None                                # already decided
        if "INSERT INTO action_runs" in sql:
            return {"id": str(uuid.uuid4())}
        raise AssertionError(f"unexpected fetchrow: {sql[:60]}")


def _fake_acquire(state):
    @asynccontextmanager
    async def acquire():
        yield _Conn(state)
    return acquire


def _drive_enqueue():
    """Tick, wall, refund, re-tick — the measured night, against fakes.

    `recommendations.create` behaves like the real one: an existing dedupe
    key returns the EXISTING card, which is exactly how the collision burnt
    the action — the old card was already decided, so the status flip found
    nothing and the charge had bought nothing.
    """
    import app.actions as actions_mod
    import app.db as db_mod
    import app.recommendations as rec_mod

    state = {"refunds": 0, "status": {}, "by_key": {}, "keys": []}

    async def create(kind, title, body, source=None, action=None,
                     dedupe_key=None, **kw):
        state["keys"].append(dedupe_key)
        if dedupe_key in state["by_key"]:
            return dict(state["by_key"][dedupe_key])
        rec = {"id": str(uuid.uuid4())}
        state["status"][rec["id"]] = "new"
        state["by_key"][dedupe_key] = rec
        return dict(rec)

    async def preflight(rec_id):
        return {"action_state": "ready", "action_detail": "ok"}

    saved = (rec_mod.create, actions_mod.preflight, db_mod.acquire)
    rec_mod.create, actions_mod.preflight = create, preflight
    db_mod.acquire = _fake_acquire(state)
    action = {"type": "code_change.build", "workspace": "nova",
              "task": "Improve one small thing and stop, honestly.",
              "why": "test", "goal_id": GOAL}
    try:
        goal = {"id": GOAL, "actions_used": 9, "max_actions": 20,
                "title": "Improve yourself"}
        first = asyncio.run(action_worker.enqueue_goal_run(
            goal, action, title="pass 9", body="b", source="improvement"))
        # The wall: the pass died, the action was refunded, the next tick's
        # atomic charge lands on the SAME actions_used.
        state["refunds"] = 1
        second = asyncio.run(action_worker.enqueue_goal_run(
            goal, action, title="pass 9 again", body="b", source="improvement"))
    finally:
        rec_mod.create, actions_mod.preflight, db_mod.acquire = saved
    return first, second, state


first, second, st = _drive_enqueue()
check("1.4 the first pass enqueues", first["status"] == "queued",
      str(first)[:80])
check("1.5 after refund + re-tick the key DIFFERS from the decided card's",
      len(st["keys"]) == 2 and st["keys"][0] != st["keys"][1],
      str(st["keys"]))
check("1.6 ...so the re-tick starts a real pass instead of burning the "
      "charge on 'the card was already decided'",
      second["status"] == "queued", str(second)[:100])


# ── 2. the dirty host repo refuses BEFORE anything is charged ───────────────

print("\n2. host_repo_wall: asked before the charge, honest about unknowns")


def _repo(status):
    import app.coder as coder_mod

    async def repo_status():
        return status
    saved = coder_mod.repo_status
    coder_mod.repo_status = repo_status
    try:
        return asyncio.run(heartbeat.host_repo_wall())
    finally:
        coder_mod.repo_status = saved


why = _repo({"branch": "main", "head": "8f32abce", "dirty": True,
             "dirty_files": 57, "dirty_sample": ["ROADMAP.md", "a.py"]})
check("2.1 a dirty tree refuses, naming the OPERATOR'S own tree",
      why is not None and "your own working tree" in why, str(why)[:90])
check("2.2 ...with the count and a sample he can act on",
      "57" in str(why) and "ROADMAP.md" in str(why), str(why)[:120])
check("2.3 ...and says nothing was charged", "no action was charged" in str(why))
why_old = _repo({"branch": "main", "dirty": True})
check("2.4 an older sidecar image (no summary fields) still refuses",
      why_old is not None and "uncommitted changes" in str(why_old),
      str(why_old)[:80])
check("2.5 a clean tree proceeds",
      _repo({"branch": "main", "dirty": False}) is None)
check("2.6 an unreachable sidecar is UNKNOWN and proceeds — the landing "
      "gate stays the enforcement, this is spend protection",
      _repo({"error": "the git-landing sidecar is unreachable: boom"}) is None)
check("2.7 a reply with no dirty field at all is UNKNOWN too, never 'clean'",
      _repo({"branch": "main", "head": "abc"}) is None)


# ── 3. walls escalate instead of nagging ────────────────────────────────────

print("\n3a. the backoff doubles per consecutive hit and caps at six hours")

check("3.1 first hit waits the base hour", spend.wall_backoff_s(1) == 3600)
check("3.2 second hit waits two", spend.wall_backoff_s(2) == 7200)
check("3.3 third waits four", spend.wall_backoff_s(3) == 14400)
check("3.4 fourth hits the cap", spend.wall_backoff_s(4) == 21600)
check("3.5 ...and it never grows past it", spend.wall_backoff_s(13) == 21600)
check("3.6 the base is still shorter than the cap it doubles toward",
      spend.REFUSAL_COOLDOWN_S < spend.WALL_BACKOFF_CAP_S)

R = lambda **kw: {"kind": spend.KIND_REFUSED,                 # noqa: E731
                  "detail": kw.get("detail", {"wall": "provider"}),
                  "created_at": "t", "age_s": kw.get("age_s", 0.0)}
B = {"kind": spend.KIND_BUILD, "detail": {}, "created_at": "t", "age_s": 0.0}

check("3.7 no rows, no wall", spend._leading_wall([]) is None)
check("3.8 a BUILD at the head is the reset — a pass got past preflight, "
      "no switch to find",
      spend._leading_wall([B, R(), R()]) is None)
got = spend._leading_wall([R(), R(), R(), B, R(), R()])
check("3.9 the streak counts leading refusals only, back to the last build",
      got is not None and got[:2] == ("provider", 3), str(got and got[:2]))
got = spend._leading_wall([R(), R(detail={"wall": "other"}), R()])
check("3.10 a DIFFERENT wall kind ends the streak — a new problem starts "
      "its own doubling from one",
      got is not None and got[:2] == ("provider", 1), str(got and got[:2]))
got = spend._leading_wall([R(detail={"attempt": 1, "reason": "billing"})])
check("3.11 a row that predates the wall key reads as a provider refusal — "
      "the only wall the ledger ever recorded",
      got is not None and got[0] == "provider")


def _wall_with(rows):
    import app.db as db_mod

    class _C:
        async def fetch(self, sql, *args):
            return rows
    saved = db_mod.acquire

    @asynccontextmanager
    async def acquire():
        yield _C()
    db_mod.acquire = acquire
    try:
        return asyncio.run(spend.active_wall())
    finally:
        db_mod.acquire = saved


three = [R(age_s=4000.0), R(age_s=9000.0), R(age_s=15000.0)]
w = _wall_with(three)
check("3.12 THE MEASURED DEFECT: an hour-old refusal that the flat cooldown "
      "would have waved through is still WALLED on the third consecutive hit",
      w is not None and w["streak"] == 3 and w["cooldown_s"] == 14400.0,
      str(w and (w["streak"], w["cooldown_s"])))
check("3.13 ...and the reason says the wait doubled",
      w is not None and "doubled" in w["note"], str(w and w["note"])[:120])
check("3.14 an expired backoff clears on its own — never a switch he has "
      "to find and reset", _wall_with([R(age_s=4000.0)]) is None)
check("3.15 a build at the head clears it too", _wall_with([B] + three) is None)


def _err_wall():
    import app.db as db_mod
    saved = db_mod.acquire

    @asynccontextmanager
    async def acquire():
        raise RuntimeError("db is gone")
        yield
    db_mod.acquire = acquire
    try:
        return asyncio.run(spend.active_wall())
    finally:
        db_mod.acquire = saved


check("3.16 an unreadable ledger does not block work — the ceiling above "
      "it is the control", _err_wall() is None)


print("\n3b. a walled tick raises NO per-pass card and NO per-pass push — "
      "one durable record per wall kind, counting repeats")


def _tick(*, wall=None, may=(True, "ok"), dirty=None, prior=None,
          charge=None):
    """Drive improve_tick with every collaborator recorded."""
    import app.db as db_mod
    import app.goals as goals_mod
    import app.notifications as ntf_mod
    import app.notify as notify_mod
    import app.recommendations as rec_mod
    import app.spend as spend_mod
    calls = {"pushes": [], "cards": [], "repeats": [], "charges": [],
             "enqueued": []}

    async def standing_for(verb):
        return {"id": GOAL, "title": "Improve", "actions_used": 9,
                "max_actions": 20}

    async def active_wall(lane, **kw):
        return wall

    async def may_start(lane, **kw):
        return may

    async def repo_status():
        return dirty if dirty is not None else {"dirty": False}

    async def spend_standing(verb, *, lane):
        calls["charges"].append(verb)
        return None if charge is None else charge

    async def find_repeat(fp, window_s=None):
        return prior

    async def note_repeat(nid):
        calls["repeats"].append(nid)

    async def send(message, **kw):
        calls["pushes"].append((kw.get("dedupe_key"), message))
        return {"ok": True, "deduped": False}

    async def create(*a, **kw):
        calls["cards"].append(kw.get("dedupe_key"))
        return {"id": "x"}

    async def enqueue(goal, act, *, title, body, source):
        calls["enqueued"].append(title)
        return {"status": "queued", "recommendation": "r",
                "run": "1234567890ab", "detail": "ok"}

    import app.coder as coder_mod
    saved = (goals_mod.standing_for, spend_mod.active_wall,
             spend_mod.may_start, goals_mod.spend_standing,
             ntf_mod.find_repeat, ntf_mod.note_repeat, notify_mod.send,
             rec_mod.create, db_mod.acquire, coder_mod.repo_status,
             action_worker.enqueue_goal_run)
    (goals_mod.standing_for, spend_mod.active_wall, spend_mod.may_start,
     goals_mod.spend_standing, ntf_mod.find_repeat, ntf_mod.note_repeat,
     notify_mod.send, rec_mod.create) = (
        standing_for, active_wall, may_start, spend_standing, find_repeat,
        note_repeat, send, create)
    db_mod.acquire = _fake_acquire({"refunds": 0, "status": {}})
    coder_mod.repo_status = repo_status
    action_worker.enqueue_goal_run = enqueue
    try:
        out = asyncio.run(heartbeat.improve_tick())
    finally:
        (goals_mod.standing_for, spend_mod.active_wall, spend_mod.may_start,
         goals_mod.spend_standing, ntf_mod.find_repeat, ntf_mod.note_repeat,
         notify_mod.send, rec_mod.create, db_mod.acquire,
         coder_mod.repo_status, action_worker.enqueue_goal_run) = saved
    return out, calls


BILLING = {"wall": "provider", "streak": 2, "age_s": 100.0,
           "cooldown_s": 7200.0, "at": "t", "detail": {},
           "note": "the model provider refused the last pass and retrying "
                   "cannot fix that, so nothing starts for another 118 "
                   "minute(s)."}

(started, why), calls = _tick(wall=BILLING)
check("3.17 a billing wall refuses the tick with the wall's own reason",
      started is False and "provider refused" in why, why[:90])
check("3.18 nothing was CHARGED — the wall is checked before the goal",
      not calls["charges"])
check("3.19 no per-pass card was raised", not calls["cards"])
check("3.20 the first occurrence notifies ONCE, keyed on the wall kind",
      [k for k, _ in calls["pushes"]] == ["improve-wall:provider"],
      str(calls["pushes"])[:80])

(_, _), calls = _tick(wall=BILLING, prior={"id": "n-1", "repeats": 3})
check("3.21 a repeat of the SAME wall increments the existing row and "
      "pushes NOTHING", not calls["pushes"] and calls["repeats"] == ["n-1"],
      str(calls["repeats"]))

(started, why), calls = _tick(may=(False, "the daily ceiling is spent: 4"))
check("3.22 a spent ceiling is its own wall kind, same shape",
      started is False and not calls["cards"] and not calls["charges"]
      and [k for k, _ in calls["pushes"]] == ["improve-wall:ceiling"],
      str(calls["pushes"])[:80])

(started, why), calls = _tick(
    dirty={"branch": "main", "dirty": True, "dirty_files": 3,
           "dirty_sample": ["a.py"]})
check("3.23 a dirty tree is its own wall kind and charges nothing",
      started is False and not calls["charges"]
      and [k for k, _ in calls["pushes"]] == ["improve-wall:dirty_repo"]
      and "working tree" in why, why[:80])

(started, why), calls = _tick(charge={"id": GOAL, "title": "Improve",
                                      "actions_used": 10, "max_actions": 20})
check("3.24 with every wall clear the tick still charges and starts — "
      "the guards added nothing to the happy path",
      started is True and calls["charges"] == ["improve_self"]
      and len(calls["enqueued"]) == 1 and not calls["pushes"],
      f"started={started} why={why[:60]}")


# ── 4. a beat that checked nothing must not report ──────────────────────────

print("\n4. the runner's empty-final floor never reaches the phone as news")

FLOOR = ("[This turn produced no reply. The model returned an empty answer "
         "and called nothing — nothing was done.]")

check("4.1 no spans at all is INDETERMINATE, never proof",
      heartbeat.model_wrote_nothing(None) is False
      and heartbeat.model_wrote_nothing([]) is False)
check("4.2 llm rounds that all wrote zero characters mean the model wrote "
      "nothing — the floor's own trigger, read structurally",
      heartbeat.model_wrote_nothing(
          [{"kind": "llm_call", "detail": {"completion_chars": 0}},
           {"kind": "tool", "detail": {}},
           {"kind": "llm_call", "detail": {}}]) is True)
check("4.3 one round with real text means the model DID write",
      heartbeat.model_wrote_nothing(
          [{"kind": "llm_call", "detail": {"completion_chars": 0}},
           {"kind": "llm_call", "detail": {"completion_chars": 42}}]) is False)


class _Turn:
    def __init__(self, spans):
        self.spans = spans

    def set_error(self, *_):
        ...

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        return False


def _beat(reply, spans, *, prior=None):
    import app.notifications as ntf_mod
    calls = {"pushes": [], "cards": [], "repeats": []}

    async def get_agent(name):
        return {"name": "main", "enabled": True, "model": "ollama:qwen3:8b"}

    async def run_agent(agent, messages, **kw):
        yield {"type": "final", "text": reply}

    async def send(message, **kw):
        calls["pushes"].append((kw.get("dedupe_key"), message))
        return {"ok": True, "deduped": False, "in_chat": True}

    async def create(kind, title, body, **kw):
        calls["cards"].append(body)
        return {"id": "x"}

    async def find_repeat(fp, window_s=None):
        return prior

    async def note_repeat(nid):
        calls["repeats"].append(nid)

    async def improve_tick():
        return False, "no live goal authorises self-improvement"

    saved = (heartbeat.agent_registry.get_agent_by_name,
             heartbeat.agent_runner.run_agent, heartbeat.notify.send,
             heartbeat.recommendations.create, heartbeat.trace.turn,
             heartbeat.settings_store.get, heartbeat.improve_tick,
             heartbeat.read_checklist, ntf_mod.find_repeat,
             ntf_mod.note_repeat)
    sget = heartbeat.settings_store.get
    heartbeat.agent_registry.get_agent_by_name = get_agent
    heartbeat.agent_runner.run_agent = run_agent
    heartbeat.notify.send = send
    heartbeat.recommendations.create = create
    heartbeat.trace.turn = lambda *a, **k: _Turn(spans)
    heartbeat.settings_store.get = lambda key: (
        "" if key in ("heartbeat.active_hours", "heartbeat.model")
        else "UTC" if key == "nova.timezone" else sget(key))
    heartbeat.improve_tick = improve_tick
    heartbeat.read_checklist = lambda: "- watch the oven\n"
    ntf_mod.find_repeat, ntf_mod.note_repeat = find_repeat, note_repeat
    try:
        ok, summary = asyncio.run(heartbeat.beat({"name": "heartbeat"}))
    finally:
        (heartbeat.agent_registry.get_agent_by_name,
         heartbeat.agent_runner.run_agent, heartbeat.notify.send,
         heartbeat.recommendations.create, heartbeat.trace.turn,
         heartbeat.settings_store.get, heartbeat.improve_tick,
         heartbeat.read_checklist, ntf_mod.find_repeat,
         ntf_mod.note_repeat) = saved
    return ok, summary, calls


DEAD = [{"kind": "llm_call", "detail": {"completion_chars": 0}},
        {"kind": "tool", "detail": {}},
        {"kind": "llm_call", "detail": {"completion_chars": 0}}]

ok, summary, calls = _beat(FLOOR, DEAD)
check("4.4 THE 12:15Z BEAT: a placeholder final is UNABLE, not ok",
      ok is False and summary.startswith(
          "unable — the checklist turn produced no reply"), summary[:80])
check("4.5 no report-shaped push — the floor text reaches nobody's phone",
      all(FLOOR not in m for _, m in calls["pushes"]),
      str(calls["pushes"])[:80])
check("4.6 and no inbox card wearing it either", not calls["cards"])
check("4.7 the broken model is reported through ONE stable fingerprint",
      [k for k, _ in calls["pushes"]] == ["heartbeat:no-reply"],
      str([k for k, _ in calls["pushes"]]))

ok, summary, calls = _beat(FLOOR, DEAD, prior={"id": "n-9", "repeats": 4})
check("4.8 five broken beats are one escalating record, not five pushes",
      not calls["pushes"] and calls["repeats"] == ["n-9"]
      and ok is False, str(calls["repeats"]))

ok, summary, calls = _beat("The backup drill failed twice overnight.",
                           [{"kind": "llm_call",
                             "detail": {"completion_chars": 40}}])
check("4.9 a REAL report from a model that really wrote still delivers",
      ok is True and summary.startswith("notified")
      and any("backup drill" in m for _, m in calls["pushes"]), summary[:80])

ok, summary, calls = _beat("HEARTBEAT_OK", DEAD)
check("4.10 quiet still wins first — an empty checklist turn that says "
      "nothing needs attention delivers nothing and fails nothing",
      ok is True and summary.startswith("quiet") and not calls["pushes"],
      summary[:60])


print()
if FAILURES:
    print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES[:8]))
    sys.exit(1)
print("all checks passed")
sys.exit(0)
