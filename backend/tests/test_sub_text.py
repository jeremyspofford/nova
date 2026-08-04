"""Phase 5 verification (docs/plans/turn-speed.md): streaming specialist text.

    docker compose exec backend python tests/test_sub_text.py

The rails: a specialist's deltas arrive as `sub_text` (never `text`, which
is what TTS speaks and what the assistant bubble shows), batched by
sentence rather than per token, and forwarded through all three nesting
layers so the operator sees a long dispatch working.
"""

import asyncio
import json
import shutil
import sys
import tempfile
import time

sys.path.insert(0, "/app/backend")

from app import narration, settings_store, trace            # noqa: E402
from app.agents import runner                               # noqa: E402
from app.llm import router as llm_router                    # noqa: E402
from app.memory import memory as memory_mod                 # noqa: E402
from app.tools import registry as tool_registry             # noqa: E402

SCRATCH_MEM = tempfile.mkdtemp(prefix="nova-sub-text-")
FAILURES: list[str] = []

AGENT = {"id": "a1", "name": "main", "model": "openrouter:test",
         "system_prompt": "You coordinate.", "allowed_tools": None}


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


# ── 1. the batcher ───────────────────────────────────────────────────────

def test_batcher():
    print("1. batching: a sentence at a time, not a token at a time")
    b = runner._SubTextBatcher()
    out = []
    for token in ["Check", "ing the ", "catalog", ". Next", " I will fetch", " it. "]:
        out += b.feed(token)
    check("two sentences released, mid-sentence tokens held",
          out == ["Checking the catalog. ", "Next I will fetch it. "], str(out))
    check("nothing left buffered", b.drain() == [])

    b = runner._SubTextBatcher()
    held = b.feed("a partial thought with no punctuation")
    check("an unfinished sentence is held back", held == [], str(held))
    check("...and drained at the end",
          b.drain() == ["a partial thought with no punctuation"])

    b = runner._SubTextBatcher()
    long_run = "x" * (runner._SUB_TEXT_MAX_CHARS + 10)
    check("a very long unpunctuated run flushes anyway",
          b.feed(long_run) == [long_run])

    b = runner._SubTextBatcher()
    b.feed("waiting")
    time.sleep(runner._SUB_TEXT_MAX_IDLE_S + 0.05)
    check("a pause flushes what is buffered", b.feed("") == ["waiting"])

    b = runner._SubTextBatcher()
    check("whitespace-only noise is never emitted", b.feed("\n\n") == [])


# ── 2. the event actually reaches the top ────────────────────────────────

class Script:
    """Depth 0 dispatches once; the specialist streams text, then answers."""

    def __init__(self):
        self.calls = 0

    def stream_chat(self, messages, model, tools=None, **kwargs):
        self.calls += 1
        n = self.calls

        async def gen():
            if n == 1:
                yield {"type": "tool_calls", "tool_calls": [
                    {"id": "d0", "name": "dispatch_to_agent",
                     "arguments": json.dumps({"agent_name": "ingestion",
                                              "message": "research"})}]}
            elif n == 2:      # the specialist's own round
                for token in ["Reading the ", "page. ", "Found the ", "answer. "]:
                    yield {"type": "text", "text": token}
            else:
                yield {"type": "text", "text": "Both done."}
        return gen()


def install(script, concurrency=1):
    llm_router.stream_chat = script.stream_chat
    llm_router.effective_model = lambda m: m
    settings_store._cache["agents.tool_concurrency"] = concurrency
    settings_store._cache["agents.max_dispatches_per_turn"] = 3
    narration.detect = lambda text, calls, called=None: None
    trace._flush = lambda t: asyncio.sleep(0)

    from app.agents import registry as agent_registry

    async def get_agent(name):
        return {"id": name, "name": name, "enabled": True,
                "model": "openrouter:test", "system_prompt": "s",
                "allowed_tools": []}

    agent_registry.get_agent_by_name = get_agent

    async def get_agent_tools(agent, exclude=None):
        if "dispatch_to_agent" in (exclude or set()):
            return []
        return [{"type": "function", "function": {
            "name": "dispatch_to_agent", "description": "d", "parameters": {}}}]

    tool_registry.get_agent_tools = get_agent_tools

    async def _empty(*a, **kw):
        return ""

    runner._platform_block = _empty
    runner._entities_block = _empty
    runner._mcp_index_block = _empty


async def run_turn():
    events = []
    with memory_mod.sandbox(memory_mod.OkfMemory(base_dir=SCRATCH_MEM)):
        async with trace.turn("test"):
            async for ev in runner.run_agent(
                    AGENT, [{"role": "user", "content": "go"}]):
                events.append(ev)
    return events


async def test_forwarding():
    print("2. a specialist's text reaches the operator as sub_text")
    script = Script()
    install(script)
    events = await run_turn()

    subs = [e for e in events if e["type"] == "sub_text"]
    texts = [e for e in events if e["type"] == "text"]
    check("the specialist's deltas arrived", subs, str(len(subs)))
    check("...through all three nesting layers, sentence-batched",
          "".join(e["text"] for e in subs) == "Reading the page. Found the answer. ",
          str([e["text"] for e in subs]))
    check("tagged with the specialist's name",
          all(e.get("agent") == "ingestion" for e in subs),
          str({e.get("agent") for e in subs}))
    check("the top-level answer is still plain text, never sub_text",
          "".join(e["text"] for e in texts) == "Both done.",
          str([e["text"] for e in texts]))
    check("no specialist text leaked into the spoken/persisted 'text' channel",
          not any("Reading the page" in e["text"] for e in texts))
    check("the specialist's reply still lands as an activity item",
          any(e.get("kind") == "agent_reply" for e in events))


async def test_forwarding_in_a_group():
    print("3. the same holds inside a parallel dispatch group")

    class GroupScript:
        def __init__(self):
            self.calls = 0

        def stream_chat(self, messages, model, tools=None, **kwargs):
            self.calls += 1
            n = self.calls

            async def gen():
                if n == 1:
                    yield {"type": "tool_calls", "tool_calls": [
                        {"id": f"d{i}", "name": "dispatch_to_agent",
                         "arguments": json.dumps({"agent_name": a,
                                                  "message": "go"})}
                        for i, a in enumerate(["ingestion", "model-manager"])]}
                elif n in (2, 3):
                    yield {"type": "text", "text": f"working {n}. "}
                else:
                    yield {"type": "text", "text": "Done."}
            return gen()

    script = GroupScript()
    install(script, concurrency=3)
    events = await run_turn()
    subs = [e for e in events if e["type"] == "sub_text"]
    check("both specialists streamed", len(subs) >= 2, str(len(subs)))
    check("each chunk is attributed to one of them",
          {e.get("agent") for e in subs} == {"ingestion", "model-manager"},
          str({e.get("agent") for e in subs}))


async def main():
    test_batcher()
    print()
    for t in (test_forwarding, test_forwarding_in_a_group):
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
