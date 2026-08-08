"""A billing wall is not a flaky failure.

    docker compose exec backend python tests/test_provider_wall.py

MEASURED 2026-08-07. The self-improvement loop ran four passes unattended.
Every coding session failed with the same reply, and each pass retried it three
times before giving up:

    the coding agent returned an error: {"code": -32603, "message": "Internal
    error: API Error: 402 This request requires more credits, or fewer
    max_tokens. You requested up to 32000 tokens, but can only afford 15846.
    To increase, visit https://openrouter.ai/... and adjust the key's monthly
    limit"}

Twelve coding sessions, four goal actions and four `action_runs` spent against
a wall that cannot clear itself by retrying, and what Jeremy saw was "the self
improvement pass failed".

WHAT IS BEING DEFENDED HERE, in the order the failure happened:

  1. the classifier reads the STATUS, through the JSON-RPC envelope, and does
     not decide anything from English;
  2. a terminal fault stops the pass at the attempt it happened on;
  3. it does not spend a build entry, and it gives the goal action back —
     exactly once;
  4. the one retry the provider licensed (it named the affordable budget) is
     taken only when the sidecar can actually apply it, and never twice.

No database and no sidecar: every question above is answered by driving the
real functions against fakes, so this suite means the same thing in the
sandbox as on the operator's install.
"""

import asyncio
import sys
import uuid

sys.path.insert(0, "/app/backend")

from app import actions                                    # noqa: E402
from app import provider_errors as pe                      # noqa: E402
from app.actions import code_change as cc                  # noqa: E402

FAILURES: list[str] = []

#: The exact text the broker wrote into `coding_sessions.error`, twelve times.
#: `str()` of a JSON-RPC error dict — note the single-quoted keys and the
#: apostrophe in "key's", which is why it is a Python literal and not JSON.
REAL_402 = (
    "the coding agent returned an error: {'code': -32603, 'message': "
    "\"Internal error: API Error: 402 This request requires more credits, or "
    "fewer max_tokens. You requested up to 32000 tokens, but can only afford "
    "15846. To increase, visit https://openrouter.ai/settings/keys and adjust "
    "the key's monthly limit\"}")

#: The same thing as real JSON, which is how it arrives over HTTP.
REAL_402_JSON = (
    '{"code": -32603, "message": "Internal error: API Error: 402 This request '
    'requires more credits, or fewer max_tokens. You requested up to 32000 '
    'tokens, but can only afford 15846."}')


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}"
          + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


# ── 1. the classifier ───────────────────────────────────────────────────────

def test_classify():
    print("\n1. A WALL AND WEATHER ARE TOLD APART BY THE STATUS, NOT BY PROSE")
    f = pe.classify(REAL_402)
    check("1.1 the 402 survives the JSON-RPC envelope", f.status == 402,
          f"status={f.status}")
    check("1.2 …and is terminal — retrying cannot succeed", f.terminal,
          f.kind)
    check("1.3 …for a billing reason, not a vague one", f.reason == "billing")
    check("1.4 the JSON-RPC -32603 is NOT read as an HTTP status",
          f.status == 402, "codes outside 100..599 are not statuses")
    check("1.5 the same error as real JSON classifies identically",
          pe.classify(REAL_402_JSON).terminal
          and pe.classify(REAL_402_JSON).status == 402)

    check("1.6 401 is terminal (the key itself is refused)",
          pe.classify("LLM API error 401: {\"error\": {\"message\": \"no\"}}",
                      status=401).reason == "credentials")
    check("1.7 403 is terminal (this key may not do that)",
          pe.classify("nope", status=403).terminal)

    for st in (429, 500, 502, 503, 504):
        f2 = pe.classify(f"HTTP {st} from upstream")
        check(f"1.8 {st} is transient — a retry is exactly right",
              f2.kind == pe.TRANSIENT and not f2.terminal, f2.kind)

    # THE ONE THAT WOULD HAVE BEEN GOT WRONG BY A STATUS ALONE. OpenAI answers
    # an exhausted account with 429 + insufficient_quota; reading only the
    # status turns a wall into "be patient" forever.
    openai = ('{"error": {"message": "You exceeded your current quota", '
              '"type": "insufficient_quota", "code": "insufficient_quota"}}')
    f3 = pe.classify(openai, status=429)
    check("1.9 a provider's own `insufficient_quota` token outranks its 429",
          f3.terminal and f3.reason == "billing", f"{f3.kind}/{f3.reason}")

    # AND THE CONSERVATIVE DIRECTION. Anything unrecognised keeps the old
    # behaviour — retrying — because abandoning real work is worse than the
    # waste a wrong guess would save.
    unknown = pe.classify("the agent returned an error")
    check("1.10 an unreadable failure is UNKNOWN and still retries",
          unknown.kind == pe.UNKNOWN and not unknown.terminal, unknown.kind)
    check("1.11 …and so is no error at all", not pe.classify(None).terminal)
    check("1.12 a sentence about credits with no status decides NOTHING",
          not pe.classify("we could not bill your card for more credits"
                          ).terminal,
          "prose is not evidence — providers word rate limits the same way")


def test_the_numbers_come_from_the_provider():
    print("\n2. THE AFFORDABLE BUDGET IS THE PROVIDER'S NUMBER OR NO NUMBER")
    f = pe.classify(REAL_402)
    check("2.1 the requested budget is read", f.requested_tokens == 32000,
          str(f.requested_tokens))
    check("2.2 …and the affordable one", f.affordable_tokens == 15846,
          str(f.affordable_tokens))
    check("2.3 …and that licenses ONE smaller retry", f.adaptable)

    bare = pe.classify("LLM API error 402: payment required", status=402)
    check("2.4 a 402 with no numbers licenses nothing",
          bare.terminal and not bare.adaptable,
          "a guessed budget is the same failed call with a smaller number")
    check("2.5 …and no number is invented",
          bare.affordable_tokens is None and bare.requested_tokens is None)

    backwards = pe.classify("API Error: 402 You requested up to 100 tokens, "
                            "but can only afford 4000")
    check("2.6 an affordable figure that is not smaller licenses nothing",
          not backwards.adaptable, "there would be nothing to adapt to")


def test_the_operator_is_told_what_to_do():
    print("\n3. THE OPERATOR IS TOLD WHICH KEY, WHICH LIMIT, WHICH NUMBERS")
    note = pe.classify(REAL_402).operator_note()
    check("3.1 it says the provider refused for money", "MONEY" in note, note[:60])
    check("3.2 …names the status", "402" in note)
    check("3.3 …carries both of the provider's numbers",
          "32,000" in note and "15,846" in note, note[:120])
    check("3.4 …says retrying cannot fix it", "cannot fix" in note)
    check("3.5 …and says what WOULD", "top up" in note and "limit" in note)
    check("3.6 …and quotes the provider verbatim rather than paraphrasing",
          "openrouter.ai" in note)


# ── 4. the loop stops ───────────────────────────────────────────────────────

class FakeCoder:
    """Stands in for `app.coder` — same shape as tests/test_build_loop.py."""

    def __init__(self, outcomes, *, supports_max_tokens=None):
        self.outcomes = list(outcomes)
        self.starts: list[dict] = []
        self.checked: list[str] = []
        self.supports = supports_max_tokens

    async def start(self, workspace, task, *, requested_by=None,
                    continue_from=None, max_tokens=0, **kw):
        sid = str(uuid.uuid4())
        self.starts.append({"session": sid, "task": task,
                            "continue_from": continue_from,
                            "max_tokens": max_tokens})
        i = len(self.starts) - 1
        if i < len(self.outcomes) and self.outcomes[i][0] == "start_refused":
            return {"status": "error", "detail": self.outcomes[i][1]}
        return {"status": "started", "session_id": sid}

    async def refresh(self, session_id):
        i = [s["session"] for s in self.starts].index(session_id)
        kind, detail = self.outcomes[i]
        if kind == "wall":
            return {"state": "failed", "error": detail}
        if kind == "crash":
            return {"state": "failed", "error": detail}
        return {"state": "done", "commit": f"c0ffee{i}"}

    async def sandbox_check(self, session_id, *, lane="operator"):
        self.checked.append(session_id)
        i = [s["session"] for s in self.starts].index(session_id)
        kind, detail = self.outcomes[i]
        return ({"status": "ok", "detail": "green",
                 "eval": {"state": "unmeasured"}} if kind == "green"
                else {"status": "failed", "stage": "suite", "detail": detail})

    async def broker_supports(self, field):
        return self.supports


class FakeCtx:
    def __init__(self):
        self.records: list[tuple] = []
        self.scratch: dict = {}

    async def record(self, name, status, detail=""):
        self.records.append((name, status, detail))


def _doc(**over):
    raw = {"type": "code_change.build", "workspace": "nova",
           "task": "Add a docstring to backend/app/health.py explaining the "
                   "readiness contract.",
           "why": "because", **over}
    return actions.parse(raw)


def _run(outcomes, *, doc=None, rec=None, supports=None):
    """Drive `_step_build` against a fake coder, fake ledger and fake goals."""
    import app.coder as real_coder
    import app.goals as real_goals
    import app.spend as real_spend

    fake = FakeCoder(outcomes, supports_max_tokens=supports)
    charges: list[dict] = []
    refunds: list[dict] = []
    saved_coder = {k: getattr(real_coder, k)
                   for k in ("start", "refresh", "sandbox_check",
                             "broker_supports")}
    saved_record = real_spend.record
    saved_may = real_spend.may_start
    saved_refund = real_goals.refund_action

    async def _record(lane, kind, **kw):
        charges.append({"lane": lane, "kind": kind, **kw})
        return {"id": None, "metered": bool(kw.get("usage"))}

    async def _may_start(lane, **kw):
        return True, "ok"

    async def _refund(goal_id, *, run_id, reason, lane="goal"):
        refunds.append({"goal": goal_id, "run": run_id, "reason": reason})
        return {"refunded": True, "actions_used": 0, "max_actions": 4,
                "detail": "given back"}

    for k in saved_coder:
        setattr(real_coder, k, getattr(fake, k))
    real_spend.record = _record
    real_spend.may_start = _may_start
    real_goals.refund_action = _refund
    saved_poll, cc._POLL_S = cc._POLL_S, 0.0
    try:
        out = asyncio.run(cc._step_build(doc or _doc(), rec or {}, FakeCtx()))
    finally:
        for k, v in saved_coder.items():
            setattr(real_coder, k, v)
        real_spend.record = saved_record
        real_spend.may_start = saved_may
        real_goals.refund_action = saved_refund
        cc._POLL_S = saved_poll
    return out, fake, charges, refunds


GOAL = "22222222-2222-2222-2222-222222222222"
RUN = "33333333-3333-3333-3333-333333333333"


def test_the_loop_stops_at_the_wall():
    print("\n4. THE PASS STOPS AT THE WALL INSTEAD OF HITTING IT THREE TIMES")
    out, fake, charges, _refunds = _run(
        [("wall", REAL_402), ("green", ""), ("green", "")],
        doc=_doc(attempts=3))

    check("4.1 exactly ONE coding session was started, not three",
          len(fake.starts) == 1, f"{len(fake.starts)} session(s)")
    check("4.2 the pass reports failure", out.get("status") == "error")
    detail = str(out.get("detail"))
    check("4.3 …and the reason is the provider's, in his terms",
          "MONEY" in detail and "402" in detail, detail[:100])
    check("4.4 …with the numbers the provider gave",
          "32,000" in detail and "15,846" in detail, detail[:160])

    builds = [c for c in charges if c["kind"] == "coding_session"]
    check("4.5 NO build entry was written — nothing was built",
          not builds, f"{len(builds)} build entr(ies)")
    walls = [c for c in charges if c["kind"] == "provider_refusal"]
    check("4.6 …but the wall IS recorded, so the next pass can see it",
          len(walls) == 1, f"{len(walls)}")
    check("4.7 …carrying the note the operator has to read",
          walls and "402" in str(walls[0].get("detail", {}).get(
              "operator_note", "")))


def test_a_normal_failure_still_retries():
    print("\n5. A FAILURE THAT IS NOT A WALL STILL RETRIES — UNCHANGED")
    out, fake, charges, _r = _run(
        [("crash", "the agent returned an error"), ("green", "")])
    check("5.1 an unclassifiable failure is retried, as before",
          len(fake.starts) == 2, f"{len(fake.starts)}")
    check("5.2 …and the pass can still go green", out.get("status") == "ok")
    check("5.3 …and both attempts are metered as builds",
          len([c for c in charges if c["kind"] == "coding_session"]) == 2)

    out2, fake2, _c, _r2 = _run([("crash", "HTTP 503 upstream is overloaded"),
                                 ("green", "")])
    check("5.4 a 5xx is weather: it retries and succeeds",
          len(fake2.starts) == 2 and out2.get("status") == "ok")


def test_the_goal_action_comes_back():
    print("\n6. AN ACTION SPENT ON A WALL IS GIVEN BACK — ONCE, AND ONLY IF "
          "NOTHING RAN")
    out, _f, _c, refunds = _run(
        [("wall", REAL_402)], doc=_doc(attempts=3, goal_id=GOAL),
        rec={"lane": "goal", "run_id": RUN})
    check("6.1 the goal action is refunded", len(refunds) == 1, str(refunds))
    check("6.2 …against the run that spent it, so it cannot happen twice",
          refunds and refunds[0]["run"] == RUN)
    check("6.3 …and the pass says so", "action back" in str(out.get("detail")),
          str(out.get("detail"))[-120:])

    # THE OTHER HALF: a pass that DID work has spent its action on work.
    out2, _f2, _c2, refunds2 = _run(
        [("red", "suite: FAILED test_a"), ("wall", REAL_402)],
        doc=_doc(attempts=3, goal_id=GOAL), rec={"lane": "goal", "run_id": RUN})
    check("6.4 a pass that built something first keeps its action",
          not refunds2, str(refunds2))
    check("6.5 …and says why", "stands" in str(out2.get("detail")),
          str(out2.get("detail"))[-120:])

    # An operator-triggered build has no goal to refund and must not try.
    _o3, _f3, _c3, refunds3 = _run([("wall", REAL_402)], doc=_doc(attempts=3))
    check("6.6 the operator's own build refunds nothing", not refunds3)


def test_the_licensed_retry():
    print("\n7. THE PROVIDER'S OWN NUMBER IS THE ONLY LICENCE TO RETRY SMALLER")
    # The sidecar cannot be told a cap today: the retry must be REFUSED, not
    # guessed at, because a cap it ignores is the identical failed call.
    out, fake, _c, _r = _run([("wall", REAL_402), ("green", "")],
                             doc=_doc(attempts=3), supports=False)
    check("7.1 with no way to apply the cap, it does NOT retry",
          len(fake.starts) == 1, f"{len(fake.starts)} session(s)")
    check("7.2 …and says exactly why, naming the missing field",
          "max_tokens" in str(out.get("detail")), str(out.get("detail"))[-200:])

    out2, fake2, _c2, _r2 = _run([("wall", REAL_402), ("green", "")],
                                 doc=_doc(attempts=3), supports=None)
    check("7.3 a sidecar whose schema cannot be READ is not assumed capable",
          len(fake2.starts) == 1, "unknown is not yes")

    # …and when it CAN be applied, exactly one retry, at the stated number.
    out3, fake3, _c3, _r3 = _run([("wall", REAL_402), ("green", "")],
                                 doc=_doc(attempts=3), supports=True)
    check("7.4 a sidecar that accepts a cap gets ONE retry",
          len(fake3.starts) == 2, f"{len(fake3.starts)}")
    check("7.5 …at the provider's number, not a guess",
          fake3.starts[1]["max_tokens"] == 15846,
          str(fake3.starts[1]["max_tokens"]))
    check("7.6 …and attempt 1 was uncapped", fake3.starts[0]["max_tokens"] == 0)
    check("7.7 …and it can then go green", out3.get("status") == "ok")

    # AND IT MUST NOT LOOP. Two walls in a row: the second one stops the pass
    # even though the provider is still volunteering a number.
    out4, fake4, _c4, _r4 = _run([("wall", REAL_402), ("wall", REAL_402),
                                  ("green", "")],
                                 doc=_doc(attempts=3), supports=True)
    check("7.8 a second wall ends the pass — the retry happens once",
          len(fake4.starts) == 2, f"{len(fake4.starts)}")
    check("7.9 …and it is reported as a failure",
          out4.get("status") == "error")


def test_a_refusal_at_start():
    print("\n8. A REFUSAL BEFORE THE SESSION EXISTS IS THE SAME WALL")
    out, fake, charges, refunds = _run(
        [("start_refused", "LLM API error 402: insufficient credits")],
        doc=_doc(attempts=3, goal_id=GOAL), rec={"lane": "goal", "run_id": RUN})
    check("8.1 it stops at the first attempt", len(fake.starts) == 1)
    check("8.2 …reports the provider refusal", out.get("status") == "error"
          and "402" in str(out.get("detail")), str(out.get("detail"))[:80])
    check("8.3 …spends no build entry",
          not [c for c in charges if c["kind"] == "coding_session"])
    check("8.4 …and still gives the action back", len(refunds) == 1)


# ── 9. the router stops walking models that share the dead key ──────────────

def test_the_router_routes_around_a_dead_key():
    print("\n9. ONE DEAD KEY IS ONE REFUSAL, NOT ONE PER MODEL IN THE CHAIN")
    from app.llm import router

    pe.clear_refusal()
    check("9.1 nothing is refusing to start with", not pe.refusals())

    # FIRST, THE ONE THAT MUST **NOT** ARM IT. OpenRouter's 402 says "more
    # credits, OR FEWER max_tokens" — it is about the size of this request
    # against what is left, and the next smaller turn can succeed. Taking the
    # provider out of service on it would move every ordinary chat turn onto a
    # local model over one oversized request.
    sized = {"type": "error", "error": REAL_402_JSON,
             "error_class": "http_status", "status_code": 402}
    router.note_provider_failure("openrouter:z-ai/glm-5.2", sized)
    check("9.1a a 402 that named a smaller affordable budget does NOT take "
          "the provider out of service", not pe.refusals(), str(pe.refusals()))
    check("9.1b …but the event still says what happened",
          (sized.get("provider_fault") or {}).get("affordable_tokens") == 15846)

    dead_key = ('{"error": {"message": "No auth credentials found", '
                '"code": "invalid_api_key"}}')
    event = {"type": "error", "error": dead_key,
             "error_class": "http_status", "status_code": 401}
    router.note_provider_failure("openrouter:z-ai/glm-5.2", event)
    check("9.2 the refusal is remembered against the PROVIDER, not the model",
          "openrouter" in pe.refusals(), str(list(pe.refusals())))
    check("9.3 …and the event now says which fault it was",
          (event.get("provider_fault") or {}).get("reason") == "credentials",
          str(event.get("provider_fault")))
    check("9.4 …without changing error_class, so a LOCAL model is still "
          "reachable", event["error_class"] == "http_status")

    # Every model on that provider now resolves the same way an unconfigured
    # provider does, so a chain of four of them is one decision, not four.
    import app.settings_store as ss
    saved = ss.get
    ss.get = lambda key, *a, **k: ("qwen3:8b"
                                   if key == "inference.local_fallback_model"
                                   else saved(key, *a, **k))
    try:
        a = router.effective_model("openrouter:z-ai/glm-5.2")
        b = router.effective_model("openrouter:anthropic/claude-sonnet-4.6")
        check("9.5 model A on the dead key goes local", a == "ollama:qwen3:8b", a)
        check("9.6 …and so does model B — one wall, one answer",
              b == "ollama:qwen3:8b", b)
    finally:
        ss.get = saved

    # A TRANSIENT failure must NOT arm it: that is what the chain is for.
    pe.clear_refusal()
    router.note_provider_failure(
        "openrouter:z-ai/glm-5.2",
        {"type": "error", "error": "HTTP 503", "status_code": 503})
    check("9.7 a 503 does not take the provider out of the chain",
          not pe.refusals(), str(pe.refusals()))

    # …and a local model can never arm it — ollama has no billing.
    router.note_provider_failure(
        "ollama:qwen3:8b",
        {"type": "error", "error": "HTTP 401", "status_code": 401})
    check("9.8 the local server cannot arm a billing breaker",
          not pe.refusals(), str(pe.refusals()))

    # THE BREAKER FORGETS. It is a circuit breaker, not a state: the fix is a
    # person topping up an account, and a latch he has to find and reset is a
    # worse failure than the one it prevents.
    pe.note_refusal("openrouter", pe.classify(REAL_402), provider_version="v1")
    check("9.9 a changed provider row clears it (a rotated key is a new key)",
          pe.refusing("openrouter", provider_version="v2") is None)
    pe.clear_refusal()


def main() -> int:
    test_classify()
    test_the_numbers_come_from_the_provider()
    test_the_operator_is_told_what_to_do()
    test_the_loop_stops_at_the_wall()
    test_a_normal_failure_still_retries()
    test_the_goal_action_comes_back()
    test_the_licensed_retry()
    test_a_refusal_at_start()
    test_the_router_routes_around_a_dead_key()
    if FAILURES:
        print(f"\nFAILED ({len(FAILURES)}): " + "; ".join(FAILURES[:8]))
        return 1
    print("\nall checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
