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


# ── 7b. the endpoint stamp: LOCAL vs BILLED is derived, never declared ───────
#
# The SDK prices every frame off its own table whatever it is pointed at, so
# on 2026-08-08 three passes against local ollama summed $10.87 of fictional
# "usd" and tripped the real $10 ceiling — the improve lane sat blocked until
# midnight by paper money. sdk_estimate vs provider_billed is unknowable per
# frame; which ENDPOINT the coder points at is a fact, and it is derived by
# comparing CODER_BASE_URL (resolved the way compose resolves it) against the
# install's own local-inference endpoints.

def _kind_with(url_env, project_env_text=None):
    """endpoint_kind under a controlled env + a scratch project .env."""
    import tempfile
    saved_env = os.environ.pop("CODER_BASE_URL", None)
    saved_path = coder._PROJECT_ENV
    tmp = None
    try:
        if url_env is not None:
            os.environ["CODER_BASE_URL"] = url_env
        if project_env_text is not None:
            tmp = tempfile.NamedTemporaryFile(
                "w", suffix=".env", delete=False)
            tmp.write(project_env_text)
            tmp.close()
            coder._PROJECT_ENV = tmp.name
        else:
            coder._PROJECT_ENV = "/nonexistent/.env"
        return coder.endpoint_kind()
    finally:
        if url_env is not None:
            os.environ.pop("CODER_BASE_URL", None)
        if saved_env is not None:
            os.environ["CODER_BASE_URL"] = saved_env
        coder._PROJECT_ENV = saved_path
        if tmp is not None:
            os.unlink(tmp.name)


def test_endpoint_kind():
    print("\n7b. ENDPOINT PROVENANCE IS DERIVED FROM THE INSTALL'S OWN CONFIG")
    from app.config import settings as cfg

    got = _kind_with(cfg.bundled_ollama_url)
    check("7b.1 the bundled ollama URL is local",
          got["kind"] == "local" and got["url"] == cfg.bundled_ollama_url,
          str(got))
    got = _kind_with(cfg.bundled_ollama_url.rstrip("/") + "/v1")
    check("7b.2 …including with a path — same host:port is the same server",
          got["kind"] == "local", str(got))
    got = _kind_with("https://openrouter.ai/api")
    check("7b.3 OpenRouter is billed", got["kind"] == "billed", str(got))
    got = _kind_with(None)
    check("7b.4 no CODER_BASE_URL anywhere rounds toward BILLED — compose "
          "then defaults the coder to a paid endpoint, and 'unknown' must "
          "count against the ceilings, not slip past them",
          got["kind"] == "billed" and got["url"] is None, str(got))
    got = _kind_with(None,
                     "# comment\nCODER_BASE_URL=https://openrouter.ai/api\n"
                     f"CODER_BASE_URL={cfg.bundled_ollama_url}\n")
    check("7b.5 with the env var unset the install's .env decides — the same "
          "file compose interpolates, last assignment wins",
          got["kind"] == "local" and got["url"] == cfg.bundled_ollama_url,
          str(got))

    # The settings-store half: the operator's runtime Ollama URL (Settings →
    # Inference) is local too, hostname and all — nothing is hardcoded.
    from app import settings_store
    had = "inference.ollama_url" in settings_store._cache
    saved = settings_store._cache.get("inference.ollama_url")
    settings_store._cache["inference.ollama_url"] = \
        "http://host.docker.internal:11434"
    try:
        got = _kind_with("http://host.docker.internal:11434/v1")
    finally:
        if had:
            settings_store._cache["inference.ollama_url"] = saved
        else:
            settings_store._cache.pop("inference.ollama_url", None)
    check("7b.6 a host-run Ollama the operator configured is local by "
          "derivation, no code change", got["kind"] == "local", str(got))

    # The broker-reported half: the container's own launch env outranks
    # config read at record time, because .env can be edited without the
    # container being recreated (the documented trap) — and the divergent
    # direction that matters would stamp a real OpenRouter session 'local'.
    saved_env = os.environ.pop("CODER_BASE_URL", None)
    try:
        os.environ["CODER_BASE_URL"] = cfg.bundled_ollama_url
        got = coder.endpoint_kind(reported="https://openrouter.ai/api")
        check("7b.7 a broker that says it launched against OpenRouter is "
              "BILLED even while config says local — real spend cannot "
              "escape the ceilings on a stale container",
              got["kind"] == "billed"
              and got["url"] == "https://openrouter.ai/api", str(got))
        os.environ["CODER_BASE_URL"] = "https://openrouter.ai/api"
        got = coder.endpoint_kind(reported=cfg.bundled_ollama_url)
        check("7b.8 …and the reported URL wins in the other direction too — "
              "the container cannot diverge from itself",
              got["kind"] == "local", str(got))
        got = coder.endpoint_kind(reported="")
        check("7b.9 an old broker image reports nothing and config still "
              "decides", got["kind"] == "billed", str(got))
    finally:
        if saved_env is not None:
            os.environ["CODER_BASE_URL"] = saved_env
        else:
            os.environ.pop("CODER_BASE_URL", None)


def test_loop_stamps_endpoint():
    print("\n7c. EVERY LEDGER ROW THE CODER WRITES CARRIES THE STAMP")
    from app.config import settings as cfg
    saved = os.environ.pop("CODER_BASE_URL", None)
    try:
        os.environ["CODER_BASE_URL"] = cfg.bundled_ollama_url
        _, charges = _drive_loop([
            {"state": "done", "commit": "c0ffee", "model": "qwen3.6:27b",
             "usage": {"tokens_in": 100, "tokens_out": 10, "usd": 1.58}}])
        c = next((c for c in charges if c["kind"] == spend.KIND_BUILD), {})
        d = c.get("detail") or {}
        check("7c.1 a build against local ollama is stamped endpoint=local, "
              "with the URL beside it",
              d.get("endpoint") == "local"
              and d.get("endpoint_url") == cfg.bundled_ollama_url, str(d))

        wall = ('{"code": -32603, "message": "Internal error: API Error: 402 '
                'This request requires more credits, or fewer max_tokens. You '
                'requested up to 32000 tokens, but can only afford 15846."}')
        _, charges = _drive_loop([
            {"state": "failed", "error": wall, "usage": {"usd": 1.23}}])
        r = next((c for c in charges if c["kind"] == spend.KIND_REFUSED), {})
        check("7c.2 a refusal row is stamped too — its dollars join the same "
              "sums", (r.get("detail") or {}).get("endpoint") == "local",
              str(r.get("detail")))

        os.environ["CODER_BASE_URL"] = "https://openrouter.ai/api"
        _, charges = _drive_loop([
            {"state": "done", "commit": "c0ffee",
             "usage": {"tokens_in": 5, "tokens_out": 1, "usd": 0.02}}])
        c = next((c for c in charges if c["kind"] == spend.KIND_BUILD), {})
        check("7c.3 the same loop against OpenRouter stamps billed — the "
              "stamp follows the config, not the code",
              (c.get("detail") or {}).get("endpoint") == "billed",
              str(c.get("detail")))
    finally:
        os.environ.pop("CODER_BASE_URL", None)
        if saved is not None:
            os.environ["CODER_BASE_URL"] = saved


# ── 7d. the ceilings sum billed endpoints only — against the REAL SQL ────────

def test_ceilings_exclude_local():
    print("\n7d. LOCAL PLAY-MONEY CANNOT SPEND THE REAL CEILINGS")
    from app import db

    lane = f"test-{uuid.uuid4().hex[:12]}"
    r1, r2, r3, r4 = (str(uuid.uuid4()) for _ in range(4))

    async def _scenario():
        out = {}
        await db.init_pool()
        try:
            async with db.acquire() as conn:
                await conn.execute(
                    "INSERT INTO spend_ceilings (lane, max_passes, max_tokens,"
                    " max_usd, updated_by) VALUES ($1, 10, 2000000, 10.0,"
                    " 'test')", lane)

                async def row(kind, run, tin, tout, usd, detail):
                    await conn.execute(
                        "INSERT INTO spend_ledger (lane, kind, run_id, "
                        "tokens_in, tokens_out, usd, metered, detail) VALUES "
                        "($1,$2,$3::uuid,$4,$5,$6,true,$7::jsonb)",
                        lane, kind, run, tin, tout, usd, detail)

                # Oldest first: a refusal at the HEAD would arm the wall
                # backoff and this section is about the ceilings.
                await row(spend.KIND_REFUSED, None, None, None, 2.00,
                          '{"endpoint": "local", "wall": "provider"}')
                await row(spend.KIND_BUILD, r1, 1000, 100, 1.10,
                          '{"endpoint": "billed"}')
                await row(spend.KIND_BUILD, r2, 1000000, 5000, 9.50,
                          '{"endpoint": "local"}')
                # No stamp at all — a row from before the stamp existed.
                await row(spend.KIND_BUILD, r3, None, None, 0.40, '{}')

            out["today"] = await spend.today(lane)
            out["ok"] = await spend.may_start(lane)

            async with db.acquire() as conn:
                await conn.execute(
                    "INSERT INTO spend_ledger (lane, kind, run_id, usd, "
                    "metered, detail) VALUES ($1,$2,$3::uuid,9.00,true,"
                    "'{\"endpoint\": \"billed\"}'::jsonb)",
                    lane, spend.KIND_BUILD, r4)
            out["usd_wall"] = await spend.may_start(lane)

            async with db.acquire() as conn:
                await conn.execute(
                    "UPDATE spend_ceilings SET max_usd = 50, max_passes = 4 "
                    "WHERE lane = $1", lane)
            out["pass_wall"] = await spend.may_start(lane)
            return out
        finally:
            async with db.acquire() as conn:
                await conn.execute(
                    "DELETE FROM spend_ledger WHERE lane = $1", lane)
                await conn.execute(
                    "DELETE FROM spend_ceilings WHERE lane = $1", lane)
            await db.close_pool()

    out = asyncio.run(_scenario())
    t = out["today"]
    check("7d.1 usd sums billed rows only — and an UNSTAMPED row counts as "
          "billed, because unknown rounds toward spending less",
          abs(t["usd"] - 1.50) < 1e-9, str(t["usd"]))
    check("7d.2 tokens sum billed rows only", t["tokens"] == 1100,
          str(t["tokens"]))
    check("7d.3 the local figures are REPORTED beside them, not dropped",
          abs(t["local_usd"] - 11.50) < 1e-9 and t["local_tokens"] == 1005000
          and t["local_entries"] == 2,
          f"local_usd={t['local_usd']} local_tokens={t['local_tokens']}")
    check("7d.4 passes count local and billed alike — the pass ceiling is "
          "the GPU/attention throttle", t["passes"] == 3 and t["attempts"] == 3)
    check("7d.5 every usd figure is labelled the SDK estimate it is",
          t["usd_basis"] == "sdk_estimate")

    allowed, why = out["ok"]
    check("7d.6 $11.50 of local play-money does NOT spend the $10 ceiling",
          allowed is True, why)
    check("7d.7 …and the exclusion is SAID, with the numbers",
          "not counted against the money ceilings" in why
          and "$11.50" in why and "estimated, not billed" in why, why)

    allowed, why = out["usd_wall"]
    check("7d.8 billed dollars still spend it — $10.50 real is over $10",
          allowed is False and "cost ceiling" in why, why)
    check("7d.9 …with the local exclusion still visible in the refusal",
          "not counted against the money ceilings" in why, why)

    allowed, why = out["pass_wall"]
    check("7d.10 the pass ceiling binds on local passes exactly as before",
          allowed is False and "4" in why and "ceiling is spent" in why, why)


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


def test_env_parser() -> None:
    """_env_file_value handles compose-style .env: export prefix, inline comments."""
    import tempfile
    env = (
        "# comment\n"
        "SIMPLE=bar\n"
        "export PREFIXED=qux\n"
        "DUPED=http://first\n"
        "export DUPED=http://second\n"
        "COMMENT=value # this is ignored\n"
        "EMPTY=\n"
        "QUOTED='quoted value'\n"
        'DOUBLE_QUOTED="double quoted"\n'
        "HASH_URL=https://example.com/page#section\n"
        "HASH_QUOTED='https://example.com/#fragment'\n"
    )
    with tempfile.NamedTemporaryFile(mode="w", suffix=".env", delete=False) as f:
        f.write(env)
        path = f.name

    from app.coder import _env_file_value

    assert _env_file_value("SIMPLE", path) == "bar"
    assert _env_file_value("PREFIXED", path) == "qux"  # export stripped
    assert _env_file_value("DUPED", path) == "http://second"  # last wins, export stripped
    assert _env_file_value("COMMENT", path) == "value"  # inline comment removed
    assert _env_file_value("EMPTY", path) == ""
    assert _env_file_value("QUOTED", path) == "quoted value"
    assert _env_file_value("DOUBLE_QUOTED", path) == "double quoted"
    assert _env_file_value("HASH_URL", path) == "https://example.com/page#section"  # no space before #
    assert _env_file_value("HASH_QUOTED", path) == "https://example.com/#fragment"  # quoted preserves #
    assert _env_file_value("NONEXISTENT", path) is None

    import os
    os.unlink(path)


def test_netloc_normalization() -> None:
    """_netloc produces comparable host:port for endpoint matching."""
    from app.coder import _netloc

    # Basic cases
    assert _netloc("http://ollama:11434") == "ollama:11434"
    assert _netloc("HTTP://OLLAMA:11434/V1") == "ollama:11434"  # path ignored, lowercased

    # Default ports applied
    assert _netloc("http://host.docker.internal") == "host.docker.internal:80"
    assert _netloc("https://openrouter.ai/api") == "openrouter.ai:443"

    # Empty / None / malformed
    assert _netloc("") == ""
    assert _netloc(None) == ""  # type: ignore[arg-type]
    assert _netloc("   ") == ""

    # No scheme defaults to http
    assert _netloc("ollama:11434") == "ollama:11434"


def main() -> int:
    test_broker_aggregates()
    test_acp_forwards_response_usage()
    test_snapshot_usage()
    test_shape_carries_cost()
    test_metered_derivation()
    test_loop_charges_real_figures()
    test_endpoint_kind()
    test_env_parser()
    test_netloc_normalization()
    test_loop_stamps_endpoint()
    test_ceilings_exclude_local()
    test_migration_130()
    if FAILURES:
        print(f"\nFAILED ({len(FAILURES)}): " + "; ".join(FAILURES[:8]))
        return 1
    print("\nall checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
