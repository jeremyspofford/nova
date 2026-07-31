"""Per-agent thinking control.

    docker compose exec backend python tests/test_thinking.py

The rail that matters most here is NEGATIVE: capability must come from the
inference server, never from a model's name. A hardcoded list would be
wrong the day a new model is pulled, and wrong silently — Nova would just
stop offering thinking on a model that supports it. So the tests below
drive the resolver with a stubbed server and check that the ANSWER follows
the server, including for model names chosen to look like the opposite of
what the server says.
"""

import asyncio
import sys

sys.path.insert(0, "/app/backend")

from app.llm import capabilities, router as llm_router     # noqa: E402

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


def server_says(mapping):
    """Stub the capability probe with a fixed server answer per model."""
    async def _caps(model):
        name = model.split(":", 1)[1] if model.startswith("ollama:") else model
        return mapping.get(name)
    capabilities.capabilities = _caps


async def test_follows_the_server_not_the_name():
    print("1. capability comes from the server, never from the model name")
    # deliberately perverse: the name says one thing, the server the other
    server_says({
        "qwen3:14b": frozenset({"completion", "tools"}),          # can NOT think
        "definitely-not-a-thinker": frozenset({"completion", "thinking"}),
    })
    check("a 'thinking-sounding' model the server says cannot -> no param",
          await llm_router.resolve_thinking("ollama:qwen3:14b", "on") is None)
    check("a 'dumb-sounding' model the server says CAN -> think=True",
          await llm_router.resolve_thinking("ollama:definitely-not-a-thinker", "on") is True)
    check("...and off is honored the same way",
          await llm_router.resolve_thinking("ollama:definitely-not-a-thinker", "off") is False)


async def test_auto_changes_nothing():
    print("2. auto sends nothing at all — the pre-existing behavior")
    server_says({"qwen3:14b": frozenset({"completion", "tools", "thinking"})})
    check("auto on a capable model still sends no param",
          await llm_router.resolve_thinking("ollama:qwen3:14b", "auto") is None)
    check("an unknown preference is treated as auto",
          await llm_router.resolve_thinking("ollama:qwen3:14b", "") is None)


async def test_unknown_is_not_no():
    print("3. an unreachable server means UNKNOWN, which is not 'no'")
    server_says({})            # every lookup returns None
    check("capability unknown -> send nothing, never a wrong boolean",
          await llm_router.resolve_thinking("ollama:qwen3:14b", "on") is None)
    check("supports() reports None rather than False",
          await capabilities.supports("ollama:qwen3:14b", "thinking") is None)


async def test_cloud_models_untouched():
    print("4. `think` is ollama's extension — cloud calls never carry it")
    server_says({"qwen3:14b": frozenset({"thinking"})})
    for pref in ("on", "off", "auto"):
        check(f"cloud model with thinking={pref} sends nothing",
              await llm_router.resolve_thinking("openrouter:z-ai/glm-5.2", pref) is None)


async def test_reasoning_is_not_text():
    print("5. reasoning deltas surface as their own event, never as text")
    from app.llm import openai_compat
    import httpx

    frames = [
        'data: ' + '{"choices":[{"delta":{"reasoning":"let me count the words"}}]}',
        'data: ' + '{"choices":[{"delta":{"content":"Hello there friend"}}]}',
        'data: [DONE]',
    ]

    class Resp:
        status_code = 200

        async def aiter_lines(self):
            for f in frames:
                yield f

        async def aread(self):
            return b""

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

    class Client:
        def __init__(self, **kw):
            pass

        def stream(self, *a, **kw):
            Client.payload = kw.get("json")
            return Resp()

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

    saved = httpx.AsyncClient
    httpx.AsyncClient = Client
    try:
        c = openai_compat.OpenAICompatClient("http://x/v1", "k")
        events = [e async for e in c.stream([{"role": "user", "content": "hi"}],
                                            "m", think=True)]
    finally:
        httpx.AsyncClient = saved

    kinds = [e["type"] for e in events]
    check("a reasoning event was emitted", "reasoning" in kinds, str(kinds))
    reasoning = next(e for e in events if e["type"] == "reasoning")
    text = next(e for e in events if e["type"] == "text")
    check("the scratchpad is in the reasoning event",
          "count the words" in reasoning["text"])
    check("the ANSWER is in the text event, uncontaminated",
          text["text"] == "Hello there friend", text["text"])
    check("think=True reached the request payload",
          Client.payload.get("think") is True, str(Client.payload.get("think")))


async def test_tools_outrank_thinking_off():
    """The rail: a turn that carries tools never gets think=false.

    Measured 2026-07-30 against the real 20-tool schema, n=8 per arm.
    ollama:qwen3:8b, asked a question whose tool it HELD, with the voice
    brevity suffix in the prompt: 8/8 tool calls with `think` unset, 0/8
    with think=false. Every one of Jeremy's ARIA Labs turns took the 0/8
    path and ended on a promise it never kept.

    So the check reads the TOOLS on the request, not a list of models known
    to be fragile — that list would be wrong the day a model is pulled, and
    wrong silently, which is the same argument the rest of this file makes
    about capability.
    """
    print("6. a turn carrying tools never gets think=false")
    server_says({"qwen3:8b": frozenset({"completion", "tools", "thinking"})})

    from app import local_context

    seen: dict = {}

    class FakeClient:
        async def stream(self, messages, model_name, tools=None, **kw):
            seen["think"] = kw.get("think")
            seen["tools"] = tools
            return
            yield          # pragma: no cover — makes this an async generator

    async def _no_refusal(*a, **kw):
        return None

    async def _ctx(*a, **kw):
        return 8192

    async def _noop(*a, **kw):
        return None

    saved = (llm_router._refuse_local_overflow, llm_router._resolve_local,
             local_context.resolve, local_context.note_spill)
    llm_router._refuse_local_overflow = _no_refusal
    llm_router._resolve_local = lambda name: (FakeClient(), name)
    local_context.resolve = _ctx
    local_context.note_spill = _noop

    msgs = [{"role": "user", "content": "does ARIA Labs exist on GitHub?"}]
    toolset = [{"type": "function",
                "function": {"name": "github-profile-fetch", "parameters": {}}}]
    try:
        seen.clear()
        async for _ in llm_router.stream_chat(msgs, "ollama:qwen3:8b",
                                              toolset, thinking="off"):
            pass
        check("think=off + tools -> no think param reaches the client",
              seen.get("think") is None, repr(seen.get("think")))
        check("...and the tools still go out untouched",
              seen.get("tools") == toolset)

        # The setting is not being ignored wholesale — with no tools on the
        # turn there is no tool selection to protect, so `off` still means off.
        seen.clear()
        async for _ in llm_router.stream_chat(msgs, "ollama:qwen3:8b",
                                              None, thinking="off"):
            pass
        check("think=off with NO tools is still honored",
              seen.get("think") is False, repr(seen.get("think")))

        # And the rail is one-directional: it suppresses `off`, never forces on.
        seen.clear()
        async for _ in llm_router.stream_chat(msgs, "ollama:qwen3:8b",
                                              toolset, thinking="on"):
            pass
        check("think=on + tools is untouched",
              seen.get("think") is True, repr(seen.get("think")))
    finally:
        (llm_router._refuse_local_overflow, llm_router._resolve_local,
         local_context.resolve, local_context.note_spill) = saved


async def main():
    for t in (test_follows_the_server_not_the_name, test_auto_changes_nothing,
              test_unknown_is_not_no, test_cloud_models_untouched,
              test_reasoning_is_not_text, test_tools_outrank_thinking_off):
        await t()
        print()
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
