"""The spend ceilings measure something: the coder's cost reaches the ledger.

    docker compose exec backend python tests/test_spend_metering.py

Migration 116 shipped a 2M-token/$10 daily ceiling and every row ever written
to `spend_ledger` was metered=false with NULL figures — the ceilings enforced
nothing and the pass count was the only limit that bound. The gap was not
"the protocol carries no cost data" (spend.py:37 believed the broker never
aggregates it); MEASURED 2026-08-08, the live broker's update streams end in
cumulative `usage_update` frames — last night's three finished sessions
carried $3.17, $2.53 and $7.51 — in a spelling and nesting nothing read:

    {"method": "session/update", "params": {"update": {
        "sessionUpdate": "usage_update", "used": 52632, "size": 200000,
        "cost": {"amount": 3.17296935, "currency": "USD"}}}}

WHAT IS DEFENDED HERE: the broker aggregates those frames into its snapshot,
the backend persists them per session (migration 130) and records them in the
ledger metered=true — and the honest path survives: a session nothing
measured stays NULL/unmetered, never zero, because a zero reads as free.
"""

import asyncio
import contextlib
import io
import os
import queue
import sys
import time
import uuid

sys.path.insert(0, "/app/backend")

from app import coder, spend                              # noqa: E402
from app.actions import code_change as cc                 # noqa: E402

FAILURES: list[str] = []

#: The frames as the live broker recorded them on 2026-08-08 (session
#: 3d66670b, the hour-long paid pass) — verbatim, so the parser is pinned to
#: what the adapter actually sends rather than to what its docs say.
FRAME_MID = {"method": "session/update", "params": {
    "sessionId": "f6bf9b5a", "update": {
        "sessionUpdate": "usage_update", "used": 52632, "size": 200000}}}
FRAME_LAST = {"method": "session/update", "params": {
    "sessionId": "f6bf9b5a", "update": {
        "sessionUpdate": "usage_update", "used": 52632, "size": 200000,
        "cost": {"amount": 3.17296935, "currency": "USD"},
        "_meta": {"_claude/origin": {"kind": "human"}}}}}
#: The final-response block, per the phase-0 notes (plan section 3).
FRAME_RESPONSE = {"method": "session/prompt#response",
                  "usage": {"inputTokens": 41210, "outputTokens": 6033,
                            "cachedReadTokens": 12000}}


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}"
          + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


def _broker():
    """The sidecar's own module, imported from the mounted project tree."""
    sys.path.insert(0, "/app/project/coder")
    try:
        import broker
        return broker
    finally:
        sys.path.pop(0)


# ── 1. the broker aggregates what its agent reports ─────────────────────────

def test_broker_aggregates():
    print("\n1. THE BROKER AGGREGATES USAGE FRAMES INTO ITS SNAPSHOT")
    if not os.path.exists("/app/project/coder/broker.py"):
        print("  SKIP  the project tree is not mounted here")
        return
    broker = _broker()

    got = broker._usage_figures(FRAME_LAST)
    check("1.1 the observed usage_update frame is read, nesting and all",
          got.get("usd") == 3.17296935 and got.get("context_used") == 52632,
          str(got))
    got = broker._usage_figures(FRAME_RESPONSE)
    check("1.2 the final response's token block is read too",
          got.get("tokens_in") == 41210 and got.get("tokens_out") == 6033
          and got.get("cached_tokens") == 12000, str(got))
    check("1.3 a frame with no figures reports NOTHING, not zeros",
          broker._usage_figures({"method": "session/update", "params": {
              "update": {"sessionUpdate": "agent_message_chunk",
                         "text": "token usage is fine"}}}) == {})
    check("1.4 a cost in a currency this code does not know is dropped, "
          "not mislabeled as dollars",
          "usd" not in broker._usage_figures(
              {"sessionUpdate": "usage_update",
               "cost": {"amount": 9.0, "currency": "EUR"}}))

    os.environ["ANTHROPIC_MODEL"] = "test/model-x"
    try:
        s = broker.Session(broker.StartSession(repo="x", task="t"))
    finally:
        del os.environ["ANTHROPIC_MODEL"]
    for f in (FRAME_MID, FRAME_LAST, FRAME_RESPONSE,
              {"method": "session/update", "params": {"update": {
                  "sessionUpdate": "agent_thought_chunk"}}}):
        s._saw(f)
    snap = s.snapshot()
    u = snap.get("usage") or {}
    check("1.5 the snapshot carries the aggregate — cumulative, last frame "
          "wins", u.get("usd") == 3.17296935, str(u))
    check("1.6 …tokens from the response block beside the streamed dollars",
          u.get("tokens_in") == 41210 and u.get("tokens_out") == 6033)
    check("1.7 …and says how many frames that is, so a partial stream is "
          "legible", u.get("frames") == 3, str(u.get("frames")))
    check("1.8 the snapshot names the model the agent was pinned to",
          snap.get("model") == "test/model-x", str(snap.get("model")))
    check("1.9 every frame still reaches the update record — one path feeds "
          "both", len(s.updates) == 4)

    s2 = broker.Session(broker.StartSession(repo="x", task="t"))
    check("1.10 a session nothing measured reports usage None, never zeros",
          s2.snapshot().get("usage") is None)


# ── 2. the wire driver hands the response's usage to the aggregator ─────────

def test_acp_forwards_response_usage():
    print("\n2. THE FINAL RESPONSE'S USAGE BLOCK IS NOT DROPPED ON THE FLOOR")
    if not os.path.exists("/app/project/coder/acp.py"):
        print("  SKIP  the project tree is not mounted here")
        return
    sys.path.insert(0, "/app/project/coder")
    try:
        from acp import AcpSession
    finally:
        sys.path.pop(0)

    class FakeProc:
        def __init__(self):
            self.stdin = io.StringIO()

        def poll(self):
            return 0

        def kill(self):
            pass

    seen: list[dict] = []
    s = object.__new__(AcpSession)
    s.proc, s._q, s._nid = FakeProc(), queue.Queue(), 0
    s._closed, s.session_id, s.on_update = False, "sid", seen.append
    s._q.put({"jsonrpc": "2.0", "id": 1,
              "result": {"stopReason": "end_turn",
                         "usage": {"inputTokens": 12, "outputTokens": 3}}})
    stop, err = s.prompt("hi", deadline=time.time() + 5)
    check("2.1 the turn still completes", stop == "end_turn" and err is None,
          f"stop={stop} err={err}")
    check("2.2 the response's usage block went through on_update, where the "
          "meter and the tail both see it",
          any(u.get("usage") == {"inputTokens": 12, "outputTokens": 3}
              for u in seen), str(seen))


# ── 3. the backend reads both sidecar generations ───────────────────────────

def test_snapshot_usage():
    print("\n3. THE BACKEND READS NEW AND OLD SNAPSHOTS, AND NEVER INVENTS")
    check("3.1 a rebuilt broker's aggregate is taken as-is",
          coder.snapshot_usage({"usage": {"usd": 7.51, "frames": 14}})
          == {"usd": 7.51, "frames": 14})
    got = coder.snapshot_usage({"tail": [FRAME_MID, FRAME_LAST]})
    check("3.2 an OLD broker's tail is dug through for the observed frames",
          (got or {}).get("usd") == 3.17296935, str(got))
    got = coder.snapshot_usage(
        {"tail": [{"usage": {"inputTokens": 5, "outputTokens": 2}}]})
    check("3.3 …and the documented token spelling still works, via "
          "spend.usage_from_updates",
          (got or {}).get("tokens_in") == 5, str(got))
    check("3.4 a snapshot with no figures anywhere is None — unmetered, "
          "never zero",
          coder.snapshot_usage({"tail": [{"method": "session/update",
                                          "params": {}}], "state": "done"})
          is None)
    check("3.5 …including the empty snapshot an old broker sends",
          coder.snapshot_usage({}) is None)


# ── 4. what lands on the row is what was measured ───────────────────────────

def test_shape_carries_cost():
    print("\n4. THE SESSION ROW CARRIES ITS COST, AND NULL STAYS ABSENT")
    base = {"id": uuid.uuid4(), "state": "done", "task": "t", "branch": "b",
            "commit_sha": None, "diffstat": None, "error": None,
            "created_at": None}
    shaped = coder._shape({**base, "model": "test/model-x", "tokens_in": 10,
                           "tokens_out": 4, "usd": 2.5})
    check("4.1 measured figures ride every listing",
          shaped["usage"] == {"tokens_in": 10, "tokens_out": 4, "usd": 2.5}
          and shaped["model"] == "test/model-x", str(shaped["usage"]))
    shaped = coder._shape(base)
    check("4.2 an unmeasured session says usage None — not tokens 0",
          shaped["usage"] is None and shaped["model"] is None)
    shaped = coder._shape({**base, "usd": 0.0})
    check("4.3 a REPORTED zero is a measurement and survives",
          shaped["usage"] == {"usd": 0.0},
          "the provider said $0; that is a fact, not a fallback")


# ── 5. the ledger's metered flag matches what arrived ───────────────────────

def _capture_record(**kw):
    """Drive the real spend.record against a fake connection; return the
    INSERT's bind args. The live ledger is never touched — a test row would
    join today's totals and could spend the operator's real ceiling."""
    from app import db
    captured = {}

    class FakeConn:
        async def fetchrow(self, sql, *args):
            captured["args"] = args
            return {"id": uuid.uuid4(), "day": "2026-08-08",
                    "metered": args[9]}

    @contextlib.asynccontextmanager
    async def fake_acquire():
        yield FakeConn()

    saved = db.acquire
    db.acquire = fake_acquire
    try:
        out = asyncio.run(spend.record("improve", spend.KIND_BUILD, **kw))
    finally:
        db.acquire = saved
    return captured["args"], out


def test_metered_derivation():
    print("\n5. METERED MEANS MEASURED — IN EITHER UNIT")
    args, out = _capture_record(usage={"usd": 3.17}, usd=3.17)
    check("5.1 a dollars-only report is METERED — the live adapter sends "
          "cost without token counts",
          args[9] is True and out["metered"] is True)
    check("5.2 …with token columns left NULL, not zero",
          args[6] is None and args[7] is None and float(args[8]) == 3.17)
    args, _ = _capture_record(usage={"tokens_in": 10, "tokens_out": 2})
    check("5.3 a tokens-only report is metered too", args[9] is True)
    args, _ = _capture_record(usage=None)
    check("5.4 no figures means metered=false and every figure NULL",
          args[9] is False and args[6] is None and args[7] is None
          and args[8] is None)


# ── 6. the build loop charges what the session really cost ──────────────────

class FakeCoder:
    """Stands in for `app.coder`, returning canned refresh snapshots —
    the same pattern as test_build_loop's, with usage in the reply."""

    def __init__(self, results):
        self.results = list(results)
        self.starts: list[str] = []

    async def start(self, workspace, task, **kw):
        sid = str(uuid.uuid4())
        self.starts.append(sid)
        return {"status": "started", "session_id": sid}

    async def refresh(self, session_id):
        return self.results[self.starts.index(session_id)]

    async def sandbox_check(self, session_id, *, lane="operator"):
        return {"status": "ok", "detail": "green",
                "eval": {"state": "unmeasured", "detail": ""}}

    async def broker_supports(self, field):
        return False


def _drive_loop(results):
    import app.coder as real_coder
    import app.spend as real_spend
    from app import actions

    fake = FakeCoder(results)
    charges: list[dict] = []

    async def _record(lane, kind, **kw):
        charges.append({"lane": lane, "kind": kind, **kw})
        return {"id": str(uuid.uuid4()), "metered": bool(kw.get("usage"))}

    saved = {k: getattr(real_coder, k)
             for k in ("start", "refresh", "sandbox_check", "broker_supports")}
    saved_record, saved_poll = real_spend.record, cc._POLL_S
    for k in saved:
        setattr(real_coder, k, getattr(fake, k))
    real_spend.record, cc._POLL_S = _record, 0.0

    class Ctx:
        scratch: dict = {}

        async def record(self, *a, **kw):
            pass

    doc = actions.parse({"type": "code_change.build", "workspace": "nova",
                         "task": "Add a docstring to backend/app/health.py "
                                 "explaining the readiness contract.",
                         "why": "because"})
    try:
        out = asyncio.run(cc._step_build(doc, {}, Ctx()))
    finally:
        for k, v in saved.items():
            setattr(real_coder, k, v)
        real_spend.record, cc._POLL_S = saved_record, saved_poll
    return out, charges


def test_loop_charges_real_figures():
    print("\n6. THE LOOP'S LEDGER ENTRY CARRIES THE SESSION'S REAL FIGURES")
    out, charges = _drive_loop([
        {"state": "done", "commit": "c0ffee",
         "model": "anthropic/claude-sonnet-4.6",
         "usage": {"tokens_in": 41210, "tokens_out": 6033, "usd": 3.17}}])
    builds = [c for c in charges if c["kind"] == spend.KIND_BUILD]
    c = builds[0] if builds else {}
    check("6.1 the build entry carries the measured usage",
          c.get("usage", {}).get("usd") == 3.17
          and c.get("usage", {}).get("tokens_in") == 41210, str(c.get("usage")))
    check("6.2 …the dollars as the ledger's own usd column",
          c.get("usd") == 3.17)
    check("6.3 …and the model that spent them",
          c.get("model") == "anthropic/claude-sonnet-4.6")
    check("6.4 the run went green", out.get("status") == "ok")

    out, charges = _drive_loop([{"state": "done", "commit": "c0ffee"}])
    c = next((c for c in charges if c["kind"] == spend.KIND_BUILD), {})
    check("6.5 a session nothing measured is still charged UNMETERED — "
          "usage None, not zeros",
          c and c.get("usage") is None and c.get("usd") is None, str(c))

    wall = ('{"code": -32603, "message": "Internal error: API Error: 402 '
            'This request requires more credits, or fewer max_tokens. You '
            'requested up to 32000 tokens, but can only afford 15846."}')
    out, charges = _drive_loop([
        {"state": "failed", "error": wall,
         "model": "anthropic/claude-sonnet-4.6", "usage": {"usd": 1.23}}])
    refusals = [c for c in charges if c["kind"] == spend.KIND_REFUSED]
    check("6.6 a wall mid-pass is recorded as a refusal, not a build",
          len(refusals) == 1
          and not any(c["kind"] == spend.KIND_BUILD for c in charges),
          str([c["kind"] for c in charges]))
    check("6.7 …but the dollars it burned before the wall are ON the row — "
          "this is that pass's only ledger entry",
          refusals and refusals[0].get("usage", {}).get("usd") == 1.23
          and refusals[0].get("usd") == 1.23, str(refusals[:1]))
    check("6.8 the pass still stops", out.get("status") == "error")


# ── 7. migration 130 says what the columns mean ─────────────────────────────

def test_migration_130():
    print("\n7. MIGRATION 130 EXISTS AND ADDS THE COST COLUMNS")
    import glob
    hits = glob.glob("/app/backend/app/migrations/130_*.sql")
    check("7.1 exactly one migration carries number 130", len(hits) == 1,
          str(hits))
    body = open(hits[0]).read() if hits else ""
    for col in ("model", "tokens_in", "tokens_out", "usd"):
        check(f"7.2 …adding coding_sessions.{col}",
              f"ADD COLUMN IF NOT EXISTS {col}" in body)
    check("7.3 the columns are nullable — no NOT NULL, no DEFAULT 0, so an "
          "unmeasured session cannot read as free",
          "NOT NULL" not in body and "DEFAULT 0" not in body)


def main() -> int:
    test_broker_aggregates()
    test_acp_forwards_response_usage()
    test_snapshot_usage()
    test_shape_carries_cost()
    test_metered_derivation()
    test_loop_charges_real_figures()
    test_migration_130()
    if FAILURES:
        print(f"\nFAILED ({len(FAILURES)}): " + "; ".join(FAILURES[:8]))
        return 1
    print("\nall checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
