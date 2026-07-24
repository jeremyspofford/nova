"""Phase 1 verification (docs/plans/turn-speed.md): parallel read-only tool
calls + the cancellation contract.

No pytest in the backend image on purpose — this is a self-contained script,
the same shape as the Phase 0 stub tests. It stubs the LLM stream and the
tool registry, so it needs no database, no network, and no model:

    docker compose exec backend python tests/test_tool_concurrency.py

What it pins down (each maps to a rail in the plan):
  1. concurrency=1 is byte-for-byte the old sequential behavior
  2. read-only calls in one round actually overlap
  3. web_search never exceeds 2 in flight (SearXNG rate-limit protection)
  4. a mutating call ends the parallel run — writes never overlap and
     nothing is reordered across one
  5. every tool_call id gets a tool message even when a call blows up
  6. cancel mid-gather: no stray tasks, spans stamped cancelled, no tool
     side effect lands after the cancel
  7. a malformed-args call inside a run still gets its correctable error
"""

import asyncio
import json
import sys
import time
from datetime import datetime, timezone

sys.path.insert(0, "/app/backend")

from app import narration, settings_store, trace          # noqa: E402
from app.agents import runner                             # noqa: E402
from app.llm import router as llm_router                  # noqa: E402
from app.tools import registry as tool_registry           # noqa: E402

# ── stub world ───────────────────────────────────────────────────────────

AGENT = {"id": "test-agent", "name": "main", "model": "openrouter:test",
         "system_prompt": "You are a test agent.", "allowed_tools": None}


class ToolRecorder:
    """Stands in for the whole tool layer and records how the runner drove
    it: when each call started/ended, how many overlapped, and whether any
    side effect landed after a cancel."""

    def __init__(self, duration=0.05, fail: set[str] | None = None):
        self.duration = duration
        self.fail = fail or set()
        self.events: list[tuple[str, str, float]] = []   # (phase, name, t)
        self.order: list[str] = []                       # completion order
        self.side_effects: list[tuple[str, float]] = []  # post-sleep writes
        self.live = 0
        self.peak = 0
        self.peak_by_name: dict[str, int] = {}
        self.live_by_name: dict[str, int] = {}
        self.cancelled_at: float | None = None

    async def execute_tool(self, name, args, ctx):
        tag = f"{name}:{json.dumps(args, sort_keys=True)}"
        self.live += 1
        self.live_by_name[name] = self.live_by_name.get(name, 0) + 1
        self.peak = max(self.peak, self.live)
        self.peak_by_name[name] = max(self.peak_by_name.get(name, 0),
                                      self.live_by_name[name])
        self.events.append(("start", tag, time.monotonic()))
        try:
            if name in self.fail:
                raise RuntimeError("boom")
            await asyncio.sleep(self.duration)
            # anything after the sleep is a "side effect": it must NOT
            # happen once the turn has been cancelled
            self.side_effects.append((tag, time.monotonic()))
            return f"result of {tag}"
        finally:
            self.live -= 1
            self.live_by_name[name] -= 1
            self.events.append(("end", tag, time.monotonic()))
            self.order.append(tag)


def _call(cid, name, args):
    return {"id": cid, "name": name,
            "arguments": args if isinstance(args, str) else json.dumps(args)}


class LLMScript:
    """Scripted rounds. Round N yields its tool_calls; the last round yields
    the final text. Records the exact `messages` list it was handed, which
    is how the tool-message guarantee and ordering are asserted."""

    def __init__(self, rounds):
        self.rounds = rounds
        self.seen: list[list[dict]] = []

    def stream_chat(self, messages, model, tools=None):
        self.seen.append([dict(m) for m in messages])
        rnd = self.rounds[min(len(self.seen) - 1, len(self.rounds) - 1)]

        async def gen():
            if rnd:
                yield {"type": "tool_calls", "tool_calls": rnd}
            else:
                yield {"type": "text", "text": "Done."}

        return gen()


def install_stubs(recorder: ToolRecorder, script: LLMScript, tool_names):
    llm_router.stream_chat = script.stream_chat
    llm_router.effective_model = lambda m: m
    tool_registry.execute_tool = recorder.execute_tool

    async def get_agent_tools(agent, exclude=None):
        return [{"type": "function",
                 "function": {"name": n, "description": n, "parameters": {}}}
                for n in tool_names if n not in (exclude or set())]

    tool_registry.get_agent_tools = get_agent_tools

    # prompt assembly: keep it off the filesystem/DB entirely
    async def _empty(*a, **kw):
        return ""

    runner._platform_block = _empty
    runner._entities_block = _empty
    runner._mcp_index_block = _empty

    async def _ctx(_q):
        return {"context": ""}

    runner.memory.context = _ctx
    runner.memory.skills_context = _ctx
    runner.memory.soul = _empty
    narration.detect = lambda text, calls: None


def set_concurrency(n):
    settings_store._cache["agents.tool_concurrency"] = n


# ── driver ───────────────────────────────────────────────────────────────

async def drive(rounds, *, concurrency, tool_names, recorder=None,
                cancel_after_starts=None):
    """Run one turn inside a real trace turn, driving the runner exactly the
    way router_chat does (async for + aclose in a finally).

    cancel_after_starts reproduces the interject/disconnect path for real:
    the turn runs in its own task, and that task is CANCELLED once the
    round's tools are in flight — the same thing Starlette does to a
    streaming response when the client goes away."""
    rec = recorder or ToolRecorder()
    script = LLMScript(rounds)
    install_stubs(rec, script, tool_names)
    set_concurrency(concurrency)
    trace._flush = _capture_flush          # never touch the DB

    holder: dict = {"events": []}
    ready = asyncio.Event()

    async def body():
        starts = 0
        async with trace.turn("test") as turn:
            holder["turn"] = turn
            agen = runner.run_agent(AGENT, [{"role": "user", "content": "go"}])
            try:
                async for ev in agen:
                    holder["events"].append(ev)
                    if ev.get("kind") == "tool_start":
                        starts += 1
                        if cancel_after_starts and starts >= cancel_after_starts:
                            ready.set()
            finally:
                await agen.aclose()

    if cancel_after_starts:
        task = asyncio.create_task(body(), name="turn")
        await ready.wait()
        await asyncio.sleep(0.1)           # tools are now really running
        rec.cancelled_at = time.monotonic()
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
    else:
        await body()
    return rec, script, holder["events"], holder["turn"]


async def _capture_flush(_turn):
    return None


# ── assertions ───────────────────────────────────────────────────────────

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}"
          + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


def tool_messages(script: LLMScript, round_index=1):
    """The tool messages the model saw on the given round."""
    msgs = script.seen[round_index]
    return [m for m in msgs if m["role"] == "tool"]


async def test_sequential_default():
    print("1. concurrency=1 keeps the old sequential behavior")
    calls = [_call("a", "web_search", {"query": "one"}),
             _call("b", "web_search", {"query": "two"}),
             _call("c", "fetch_url", {"url": "https://x"})]
    rec, script, events, _ = await drive(
        [calls, []], concurrency=1,
        tool_names=["web_search", "fetch_url"])
    check("no two tools overlap", rec.peak == 1, f"peak={rec.peak}")
    tm = tool_messages(script)
    check("one tool message per call in call order",
          [m["tool_call_id"] for m in tm] == ["a", "b", "c"],
          str([m["tool_call_id"] for m in tm]))
    check("results routed to the right call",
          all(m["content"].startswith("result of") for m in tm))


async def test_parallel_overlap():
    print("2. read-only calls in one round overlap")
    calls = [_call("a", "fetch_url", {"url": "1"}),
             _call("b", "fetch_url", {"url": "2"}),
             _call("c", "search_memory", {"query": "m"}),
             _call("d", "get_weather", {"location": "here"})]
    t0 = time.monotonic()
    rec, script, events, _ = await drive(
        [calls, []], concurrency=4,
        tool_names=["fetch_url", "search_memory", "get_weather"],
        recorder=ToolRecorder(duration=0.2))
    elapsed = time.monotonic() - t0
    check("all four ran at once", rec.peak == 4, f"peak={rec.peak}")
    check("wall clock is one call, not four", elapsed < 0.5,
          f"{elapsed:.2f}s vs 0.8s sequential")
    tm = tool_messages(script)
    check("every tool_call id got a message, in call order",
          [m["tool_call_id"] for m in tm] == ["a", "b", "c", "d"],
          str([m["tool_call_id"] for m in tm]))
    starts = [e for e in events if e.get("kind") == "tool_start"]
    results = [e for e in events if e.get("kind") == "tool_result"]
    check("4 tool_start + 4 tool_result events",
          len(starts) == 4 and len(results) == 4,
          f"{len(starts)}/{len(results)}")
    check("tool_result events carry the args brief",
          all(r.get("args") for r in results))


async def test_web_search_cap():
    print("3. web_search stays capped at 2 concurrent")
    calls = [_call(str(i), "web_search", {"query": f"q{i}"}) for i in range(5)]
    rec, script, _, _ = await drive(
        [calls, []], concurrency=6, tool_names=["web_search"],
        recorder=ToolRecorder(duration=0.1))
    check("never more than 2 searches in flight",
          rec.peak_by_name.get("web_search", 0) <= 2,
          f"peak={rec.peak_by_name.get('web_search')}")
    check("all five still ran", len(rec.side_effects) == 5,
          str(len(rec.side_effects)))
    check("five tool messages", len(tool_messages(script)) == 5)


async def test_write_breaks_the_run():
    print("4. a mutating call ends the run — no reordering, no overlap")
    calls = [_call("a", "web_search", {"query": "1"}),
             _call("b", "search_memory", {"query": "2"}),
             _call("w", "write_memory", {"content": "note"}),
             _call("c", "fetch_url", {"url": "3"}),
             _call("d", "read_memory_item", {"item_id": "x"})]
    rec, script, _, _ = await drive(
        [calls, []], concurrency=4,
        tool_names=["web_search", "search_memory", "write_memory",
                    "fetch_url", "read_memory_item"],
        recorder=ToolRecorder(duration=0.1))
    starts = [tag for phase, tag, _t in rec.events if phase == "start"]
    write_pos = next(i for i, s in enumerate(starts) if s.startswith("write_memory"))
    check("the write ran after both reads before it and before both after it",
          write_pos == 2, f"start order={starts}")
    check("the write never overlapped anything",
          rec.peak_by_name.get("write_memory", 0) == 1)
    check("the reads on each side did overlap", rec.peak == 2, f"peak={rec.peak}")
    tm = tool_messages(script)
    check("transcript keeps the model's exact call order",
          [m["tool_call_id"] for m in tm] == ["a", "b", "w", "c", "d"],
          str([m["tool_call_id"] for m in tm]))


async def test_failure_still_answers():
    print("5. a failing call in a batch still yields its tool message")
    calls = [_call("a", "fetch_url", {"url": "good"}),
             _call("b", "get_weather", {"location": "bad"})]
    rec, script, _, turn = await drive(
        [calls, []], concurrency=4, tool_names=["fetch_url", "get_weather"],
        recorder=ToolRecorder(duration=0.05, fail={"get_weather"}))
    tm = tool_messages(script)
    check("both tool messages present",
          [m["tool_call_id"] for m in tm] == ["a", "b"],
          str([m["tool_call_id"] for m in tm]))
    bad = next(m for m in tm if m["tool_call_id"] == "b")
    check("the failure reads as an error result, not a dropped call",
          bad["content"].startswith("Error executing get_weather"),
          bad["content"][:60])
    good = next(m for m in tm if m["tool_call_id"] == "a")
    check("the healthy call completed normally",
          good["content"].startswith("result of"))
    spans = [s for s in turn.spans if s["kind"] == "tool"]
    check("both tool spans closed", len(spans) == 2
          and all(s["finished_at"] for s in spans))


async def test_cancel_mid_gather():
    print("6. cancel mid-gather: no stray tasks, spans cancelled, no side effects")
    calls = [_call(c, "fetch_url", {"url": c}) for c in "abcd"]
    rec = ToolRecorder(duration=5.0)          # long enough to still be running
    before = {t for t in asyncio.all_tasks()}
    _, script, events, turn = await drive(
        [calls, []], concurrency=4, tool_names=["fetch_url"],
        recorder=rec, cancel_after_starts=1)
    await asyncio.sleep(0.05)                 # give any orphan a chance to show
    strays = [t for t in asyncio.all_tasks()
              if t not in before and t.get_name().startswith("tool:")
              and not t.done()]
    check("no stray tool tasks after the close", not strays,
          str([t.get_name() for t in strays]))
    check("no tool side effect landed after the cancel",
          not rec.side_effects, str(rec.side_effects))
    tool_spans = [s for s in turn.spans if s["kind"] == "tool"]
    check("every in-flight tool span exists", len(tool_spans) == 4,
          str(len(tool_spans)))
    check("all stamped status=cancelled",
          all(s["status"] == "cancelled" for s in tool_spans),
          str([s["status"] for s in tool_spans]))
    check("all stamped finished_at",
          all(isinstance(s["finished_at"], datetime) for s in tool_spans))
    check("the turn itself is cancelled", turn.status == "cancelled",
          turn.status)
    check("nothing was yielded after the close",
          not any(e.get("kind") == "tool_result" for e in events))


async def test_malformed_inside_a_run():
    print("7. malformed args inside a read-only run stay correctable")
    calls = [_call("a", "web_search", {"query": "1"}),
             _call("b", "web_search", "{not json"),
             _call("c", "search_memory", {"query": "2"}),
             _call("d", "search_memory", {"query": "3"})]
    rec, script, events, _ = await drive(
        [calls, []], concurrency=4, tool_names=["web_search", "search_memory"],
        recorder=ToolRecorder(duration=0.05))
    tm = tool_messages(script)
    check("all four ids answered in order",
          [m["tool_call_id"] for m in tm] == ["a", "b", "c", "d"],
          str([m["tool_call_id"] for m in tm]))
    bad = next(m for m in tm if m["tool_call_id"] == "b")
    check("the malformed call reports invalid JSON",
          "not valid JSON" in bad["content"], bad["content"][:60])
    check("the malformed call executed nothing — only the 3 valid ones ran",
          len(rec.side_effects) == 3, str([t for t, _ in rec.side_effects]))


async def main():
    for t in (test_sequential_default, test_parallel_overlap,
              test_web_search_cap, test_write_breaks_the_run,
              test_failure_still_answers, test_cancel_mid_gather,
              test_malformed_inside_a_run):
        await t()
        print()
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
