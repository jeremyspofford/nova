"""Phase 3 mechanical rails (docs/plans/turn-speed.md): error classification,
the guarded fallback, the local-overflow refusal, and the dispatch budget.

The gates that decide whether specialists actually MOVE local are empirical
and live on the box; these are the rails that make either outcome safe.

    docker compose exec backend python tests/test_local_tier.py
"""

import asyncio
import json
import shutil
import sys
import tempfile

sys.path.insert(0, "/app/backend")

from app import narration, settings_store, trace            # noqa: E402
from app.agents import runner                               # noqa: E402
from app.llm import openai_compat, router as llm_router     # noqa: E402
from app.memory import memory as memory_mod                 # noqa: E402
from app.tools import registry as tool_registry             # noqa: E402

SCRATCH_MEM = tempfile.mkdtemp(prefix="nova-local-tier-")
FAILURES: list[str] = []

AGENT = {"id": "a1", "name": "ingestion", "model": "ollama:qwen3:14b",
         "system_prompt": "You are a specialist.", "allowed_tools": None}


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


# ── 1. error classification ──────────────────────────────────────────────

class FakeResponse:
    def __init__(self, status_code=200, lines=None, body=b""):
        self.status_code = status_code
        self._lines = lines or []
        self._body = body

    async def aread(self):
        return self._body

    async def aiter_lines(self):
        for line in self._lines:
            if isinstance(line, Exception):
                raise line
            yield line

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


class FakeClient:
    def __init__(self, response=None, raise_on_connect=None):
        self._response = response
        self._raise = raise_on_connect

    def stream(self, *a, **kw):
        if self._raise:
            raise self._raise
        return self._response

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


async def collect(client_factory):
    # The seam is app.http.client() now, not httpx.AsyncClient: the LLM path
    # takes its client from the shared connection pool instead of building a
    # throwaway one per request. Patch where the client comes FROM.
    from app import http as http_pool
    saved = http_pool.client
    http_pool.client = lambda: client_factory()
    try:
        c = openai_compat.OpenAICompatClient("http://x/v1", "k")
        return [e async for e in c.stream([{"role": "user", "content": "hi"}], "m")]
    finally:
        http_pool.client = saved


def _chunk(**delta):
    return "data: " + json.dumps({"choices": [{"delta": delta}]})


async def test_error_classes():
    print("1. error classification: connect vs http_status vs mid_stream")
    import httpx

    events = await collect(lambda **kw: FakeClient(
        raise_on_connect=httpx.ConnectError("connection refused")))
    err = next(e for e in events if e["type"] == "error")
    check("a refused connection is connect_failed",
          err["error_class"] == "connect_failed", str(err))

    events = await collect(lambda **kw: FakeClient(
        FakeResponse(status_code=404, body=b'{"error":"model not found"}')))
    err = next(e for e in events if e["type"] == "error")
    check("a 404 is http_status with the code",
          err["error_class"] == "http_status" and err["status_code"] == 404, str(err))
    check("...and says the model may not be pulled",
          "not pulled" in err["error"], err["error"][:80])

    # output first, THEN the connection dies
    events = await collect(lambda **kw: FakeClient(FakeResponse(lines=[
        _chunk(content="partial answer"),
        httpx.ReadError("stream broke")])))
    err = next(e for e in events if e["type"] == "error")
    check("a break AFTER output is mid_stream (never auto-retried)",
          err["error_class"] == "mid_stream", str(err))

    # a tool-call delta counts as output too — those have side effects
    events = await collect(lambda **kw: FakeClient(FakeResponse(lines=[
        _chunk(tool_calls=[{"index": 0, "id": "c1",
                            "function": {"name": "write_memory", "arguments": "{}"}}]),
        httpx.ReadError("stream broke")])))
    err = next(e for e in events if e["type"] == "error")
    check("a tool-call delta counts as output", err["error_class"] == "mid_stream")


# ── 2. the fallback decision ─────────────────────────────────────────────

async def test_fallback_decision():
    print("2. fallback: only for unreachable LOCAL models, never in circles")
    settings_store._cache["agents.local_fallback_enabled"] = True
    # pinned, not inherited: the chain's MIDDLE link is this setting, and a
    # test that reads whatever the install happens to hold asserts nothing
    settings_store._cache["inference.local_fallback_model"] = "qwen2.5:3b"
    saved_effective = llm_router.effective_model
    llm_router.effective_model = lambda m: m

    from app.agents import registry as agent_registry
    saved_get = agent_registry.get_agent_by_name

    async def main_on(model):
        async def _get(name):
            return {"name": "main", "model": model}
        return _get

    try:
        agent_registry.get_agent_by_name = await main_on("openrouter:z-ai/glm-5.2")
        target = await runner._fallback_target(
            AGENT, "ollama:qwen3:14b", {"error_class": "connect_failed"})
        check("local unreachable -> the main agent's cloud model",
              target == "openrouter:z-ai/glm-5.2", str(target))

        target = await runner._fallback_target(
            AGENT, "ollama:qwen3:14b", {"error_class": "mid_stream"})
        check("mid_stream never falls back", target is None, str(target))

        # REVERSED 2026-07-28. This asserted that a cloud provider's own error
        # is not rerouted. Then the OpenRouter monthly budget ran out, every
        # turn 403'd, and Nova stopped answering entirely with four capable
        # local models installed and idle. Dying because somebody else's
        # invoice lapsed is the wrong failure for a local-first system, so the
        # local server is the standby in this direction too.
        target = await runner._fallback_target(
            {**AGENT, "model": "openrouter:z-ai/glm-5.2"},
            "openrouter:z-ai/glm-5.2", {"error_class": "http_status"})
        check("a cloud provider refusing DOES reroute to the local standby",
              target == "ollama:qwen2.5:3b", str(target))

        # ...but only when the standby can actually do the job. An agent
        # holding tools, rerouted onto a model without tool support, answers
        # confidently having called nothing — the failure capability_claims.py
        # exists to catch. A loud error beats a quiet wrong answer.
        import app.model_fitness as mf
        real_assess = mf.assess

        async def _no_tools(model, **kw):
            return [{"severity": mf.BLOCKING, "check": "tools",
                     "detail": "no tool support"}]
        mf.assess = _no_tools
        try:
            target = await runner._fallback_target(
                {**AGENT, "model": "openrouter:z-ai/glm-5.2"},
                "openrouter:z-ai/glm-5.2", {"error_class": "http_status"})
            check("a standby that cannot call this agent's tools is refused, "
                  "and the turn fails loudly instead", target is None, str(target))
        finally:
            mf.assess = real_assess

        # keyless local-first install: main is on the SAME dead server
        agent_registry.get_agent_by_name = await main_on("ollama:qwen3:8b")
        target = await runner._fallback_target(
            AGENT, "ollama:qwen3:14b", {"error_class": "connect_failed"})
        check("no fallback onto the same local server (fail fast)",
              target is None, str(target))

        # ...but "same server" only makes a local target pointless when the
        # SERVER is what died. _FALLBACK_CLASSES also carries http_status, and
        # an Ollama 404 for a model that was never pulled is a healthy server
        # answering — the very case the setting advertises ("server down,
        # model not pulled"). Refusing every local target on that error made
        # the whole feature inert on a keyless local-first install, which is
        # the install this system says it exists for.
        target = await runner._fallback_target(
            AGENT, "ollama:qwen3:14b", {"error_class": "http_status"})
        check("a model that is not pulled DOES reach another local model on "
              "the same healthy server", target == "ollama:qwen2.5:3b", str(target))

        # ── the ordered chain (pass 2) ───────────────────────────────────
        #
        agent_registry.get_agent_by_name = await main_on("openrouter:z-ai/glm-5.2")
        # The agent's OWN standby first. Before this there was no such thing:
        # the whole install shared one answer, so a specialist holding
        # fourteen tools and the voice agent holding two fell back onto the
        # same model.
        target = await runner._fallback_target(
            {**AGENT, "fallback_model": "ollama:qwen3:8b"},
            "ollama:qwen3:14b", {"error_class": "http_status"})
        check("the agent's own standby wins over the install-wide setting",
              target == "ollama:qwen3:8b", str(target))

        # ...and each link is only skipped when it cannot serve, never
        # because of which provider failed. `tried` is what bounds the loop:
        # the comment claiming "at most twice" stopped being true when the
        # cloud->local branch landed, and a cloud<->local alternation is real
        # billed calls, not a spin.
        target = await runner._fallback_target(
            {**AGENT, "fallback_model": "ollama:qwen3:8b"},
            "ollama:qwen3:14b", {"error_class": "http_status"},
            {"ollama:qwen3:8b", "ollama:qwen2.5:3b"})
        check("models already tried this turn are never asked twice — it "
              "falls through to the main agent's model",
              target == "openrouter:z-ai/glm-5.2", str(target))

        target = await runner._fallback_target(
            {**AGENT, "fallback_model": "ollama:qwen3:8b"},
            "ollama:qwen3:14b", {"error_class": "http_status"},
            {"ollama:qwen3:8b", "ollama:qwen2.5:3b", "openrouter:z-ai/glm-5.2"})
        check("an exhausted chain surfaces the failure instead of looping",
              target is None, str(target))

        # the fitness gate now covers BOTH directions; it used to apply only
        # when a cloud provider had refused
        mf.assess = _no_tools
        try:
            target = await runner._fallback_target(
                {**AGENT, "fallback_model": "ollama:qwen3:8b"},
                "ollama:qwen3:14b", {"error_class": "http_status"})
            check("a local->local reroute is fitness-gated too",
                  target is None, str(target))
        finally:
            mf.assess = real_assess

        agent_registry.get_agent_by_name = await main_on("openrouter:z-ai/glm-5.2")
        settings_store._cache["agents.local_fallback_enabled"] = False
        target = await runner._fallback_target(
            AGENT, "ollama:qwen3:14b", {"error_class": "connect_failed"})
        check("the operator can turn it off entirely", target is None)
    finally:
        settings_store._cache["agents.local_fallback_enabled"] = True
        agent_registry.get_agent_by_name = saved_get
        llm_router.effective_model = saved_effective


# ── 3. the local overflow refusal ────────────────────────────────────────

async def test_local_overflow_refusal():
    print("3. an oversized local prompt is refused, not silently truncated")
    # The refusal measures against the window the call will ACTUALLY get, and
    # there is exactly one thing that knows it. The flat setting this used to
    # pin was deleted 2026-07-31 — a typed number and a measurement are two
    # sources of truth for one value, and the stale one won silently. Stub the
    # window so this asserts the wiring, not the GPU.
    from app import local_context
    saved_window = local_context.effective_window
    big = [{"role": "system", "content": "S" * 60_000},
           {"role": "user", "content": "go"}]
    small = [{"role": "user", "content": "hello"}]
    try:
        async def _narrow(model):
            return 8192
        local_context.effective_window = _narrow
        refusal = await llm_router._refuse_local_overflow("ollama:qwen3:14b", big)
        check("an over-window prompt is refused", refusal is not None)
        check("classified so callers never retry it elsewhere",
              (refusal or {}).get("error_class") == "prompt_too_long")
        check("the message says the window was MEASURED, so nobody goes "
              "looking for the setting that used to be here",
              "measured, not configured" in (refusal or {}).get("error", ""),
              (refusal or {}).get("error", "")[:80])
        check("a normal prompt passes through",
              await llm_router._refuse_local_overflow("ollama:qwen3:14b", small)
              is None)

        async def _wide(model):
            return 262144
        local_context.effective_window = _wide
        check("...and the threshold follows the per-model window, so a call "
              "about to be handed 262,144 is not refused by bookkeeping",
              await llm_router._refuse_local_overflow("ollama:qwen3:14b", big)
              is None)

        async def _unknown(model):
            return None
        local_context.effective_window = _unknown
        check("when NOTHING knows the window — nothing sized, nothing "
              "resident — the call goes through rather than being refused on "
              "a number nobody has",
              await llm_router._refuse_local_overflow("ollama:qwen3:14b", big)
              is None)
    finally:
        local_context.effective_window = saved_window


# ── 4. the dispatch budget, in a real turn ───────────────────────────────

class DispatchScript:
    """Rounds 1..N each ask for one dispatch; the last round answers."""

    def __init__(self, n):
        self.n = n
        self.calls = 0

    def stream_chat(self, messages, model, tools=None, **kwargs):
        self.calls += 1
        i = self.calls

        async def gen():
            if i <= self.n:
                yield {"type": "tool_calls", "tool_calls": [
                    {"id": f"d{i}", "name": "dispatch_to_agent",
                     "arguments": json.dumps({"agent_name": "ingestion",
                                              "message": f"task {i}"})}]}
            else:
                yield {"type": "text", "text": "Done."}
        return gen()


async def test_dispatch_budget():
    print("4. the per-turn dispatch budget stops an unbounded fan-out")
    settings_store._cache["agents.max_dispatches_per_turn"] = 2
    script = DispatchScript(4)
    llm_router.stream_chat = script.stream_chat
    llm_router.effective_model = lambda m: m
    narration.detect = lambda text, calls: None

    async def get_agent_tools(agent, exclude=None):
        return [{"type": "function", "function": {
            "name": "dispatch_to_agent", "description": "d", "parameters": {}}}]

    tool_registry.get_agent_tools = get_agent_tools

    dispatched = []

    async def fake_dispatch(args, depth, automation=None, **_kw):
        dispatched.append(args["message"])
        yield {"type": "final", "text": f"report for {args['message']}"}

    runner._run_dispatch = fake_dispatch

    async def _empty(*a, **kw):
        return ""

    runner._platform_block = _empty
    runner._entities_block = _empty
    runner._mcp_index_block = _empty
    trace._flush = lambda t: asyncio.sleep(0)

    events = []
    with memory_mod.sandbox(memory_mod.OkfMemory(base_dir=SCRATCH_MEM)):
        async for ev in runner.run_agent(
                {**AGENT, "name": "main", "model": "openrouter:test"},
                [{"role": "user", "content": "go"}]):
            events.append(ev)

    check("only the budgeted dispatches actually ran", len(dispatched) == 2,
          str(dispatched))
    refusals = [e for e in events if e.get("kind") == "tool_result"
                and "already used its 2 specialist dispatches" in (e.get("detail") or "")]
    check("the over-budget calls got a usable error result", len(refusals) == 2,
          str(len(refusals)))
    final = next((e["text"] for e in events if e["type"] == "final"), "")
    check("the turn still finished with an answer", "Done." in final, final[:60])


async def main():
    for t in (test_error_classes, test_fallback_decision,
              test_local_overflow_refusal, test_dispatch_budget):
        await t()
        print()
    shutil.rmtree(SCRATCH_MEM, ignore_errors=True)
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
