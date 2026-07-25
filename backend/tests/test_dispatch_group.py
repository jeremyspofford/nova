"""Phase 4 verification (docs/plans/turn-speed.md): concurrent sibling
dispatches.

    docker compose exec backend python tests/test_dispatch_group.py

The three the plan names: two dispatches on DIFFERENT backends overlap;
two on the SAME ollama server provably serialize; and a client that
disappears mid-turn leaves no stray tasks, with both children cancelled and
their spans marked. Plus the contextvar rail that makes the ledger readable
— every child span must nest under ITS OWN dispatch.
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

SCRATCH_MEM = tempfile.mkdtemp(prefix="nova-dispatch-group-")
FAILURES: list[str] = []

AGENT = {"id": "a1", "name": "main", "model": "openrouter:test",
         "system_prompt": "You coordinate.", "allowed_tools": None}


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


class Fleet:
    """Stands in for the specialists: records overlap per backend and can be
    made slow, or made to hang so a cancel has something to catch."""

    def __init__(self, duration=0.2, models=None):
        self.duration = duration
        self.models = models or {}
        self.live = 0
        self.peak = 0
        self.live_local = 0
        self.peak_local = 0
        self.started: list[tuple[str, float]] = []
        self.finished: list[str] = []
        self.completed_after_cancel: list[str] = []
        self.cancelled_at: float | None = None

    def agent_row(self, name):
        return {"id": name, "name": name, "enabled": True,
                "model": self.models.get(name, "openrouter:test"),
                "system_prompt": "s", "allowed_tools": []}

    async def dispatch(self, args, depth, automation=None):
        name = args.get("agent_name", "")
        local = llm_router.is_local(self.models.get(name, "openrouter:test"))
        self.live += 1
        self.peak = max(self.peak, self.live)
        if local:
            self.live_local += 1
            self.peak_local = max(self.peak_local, self.live_local)
        self.started.append((name, time.monotonic()))
        try:
            yield {"type": "activity", "kind": "tool_start", "name": "web_search",
                   "agent": name, "detail": "{}"}
            await asyncio.sleep(self.duration)
            if self.cancelled_at:
                self.completed_after_cancel.append(name)
            self.finished.append(name)
            yield {"type": "final", "text": f"report from {name}"}
        finally:
            self.live -= 1
            if local:
                self.live_local -= 1


class Script:
    """Round 1 asks for the given dispatches; round 2 answers."""

    def __init__(self, agent_names):
        self.agent_names = agent_names
        self.calls = 0
        self.seen: list[list[dict]] = []

    def stream_chat(self, messages, model, tools=None, **kwargs):
        self.seen.append([dict(m) for m in messages])
        self.calls += 1
        first = self.calls == 1

        async def gen():
            if first:
                yield {"type": "tool_calls", "tool_calls": [
                    {"id": f"d{i}", "name": "dispatch_to_agent",
                     "arguments": json.dumps({"agent_name": n,
                                              "message": f"do {n}"})}
                    for i, n in enumerate(self.agent_names)]}
            else:
                yield {"type": "text", "text": "Done."}
        return gen()


def install(fleet: Fleet, script: Script, concurrency=3):
    llm_router.stream_chat = script.stream_chat
    llm_router.effective_model = lambda m: m
    runner._run_dispatch = fleet.dispatch
    settings_store._cache["agents.tool_concurrency"] = concurrency
    settings_store._cache["agents.max_dispatches_per_turn"] = 5
    settings_store._cache["agents.dispatch_timeout_s"] = 30
    narration.detect = lambda text, calls: None
    trace._flush = lambda t: asyncio.sleep(0)

    from app.agents import registry as agent_registry
    agent_registry.get_agent_by_name = lambda n: _row(fleet, n)

    async def get_agent_tools(agent, exclude=None):
        return [{"type": "function", "function": {
            "name": "dispatch_to_agent", "description": "d", "parameters": {}}}]

    tool_registry.get_agent_tools = get_agent_tools

    async def _empty(*a, **kw):
        return ""

    runner._platform_block = _empty
    runner._entities_block = _empty
    runner._mcp_index_block = _empty


async def _row(fleet, name):
    return fleet.agent_row(name)


async def drive(fleet, script, *, cancel_after_events=None):
    holder: dict = {"events": [], "turn": None}
    ready = asyncio.Event()

    async def body():
        with memory_mod.sandbox(memory_mod.OkfMemory(base_dir=SCRATCH_MEM)):
            async with trace.turn("test") as t:
                holder["turn"] = t
                agen = runner.run_agent(AGENT, [{"role": "user", "content": "go"}])
                try:
                    async for ev in agen:
                        holder["events"].append(ev)
                        if (cancel_after_events
                                and len(holder["events"]) >= cancel_after_events):
                            ready.set()
                finally:
                    await agen.aclose()

    if cancel_after_events:
        task = asyncio.create_task(body(), name="turn")
        await ready.wait()
        await asyncio.sleep(0.1)
        fleet.cancelled_at = time.monotonic()
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
    else:
        await body()
    return holder


# ── 1. different backends overlap ────────────────────────────────────────

async def test_cloud_pair_overlaps():
    print("1. two cloud dispatches in one round overlap")
    fleet = Fleet(duration=0.4, models={"ingestion": "openrouter:a",
                                        "model-manager": "openrouter:b"})
    script = Script(["ingestion", "model-manager"])
    install(fleet, script)
    t0 = time.monotonic()
    holder = await drive(fleet, script)
    elapsed = time.monotonic() - t0
    check("both ran at once", fleet.peak == 2, f"peak={fleet.peak}")
    check("wall clock is one dispatch, not two", elapsed < 0.75,
          f"{elapsed:.2f}s vs 0.8s sequential")
    replies = [e for e in holder["events"] if e.get("kind") == "agent_reply"]
    check("both replies came back", len(replies) == 2, str(len(replies)))
    tool_msgs = [m for m in script.seen[1] if m["role"] == "tool"]
    check("both tool messages, in the model's call order",
          [m["tool_call_id"] for m in tool_msgs] == ["d0", "d1"],
          str([m["tool_call_id"] for m in tool_msgs]))
    check("each carries its own specialist's report",
          all("report from" in m["content"] for m in tool_msgs))


async def test_mixed_pair_overlaps():
    print("2. a cloud + local pair still overlaps")
    fleet = Fleet(duration=0.4, models={"ingestion": "ollama:qwen3:14b",
                                        "model-manager": "openrouter:b"})
    script = Script(["ingestion", "model-manager"])
    install(fleet, script)
    await drive(fleet, script)
    check("both ran at once", fleet.peak == 2, f"peak={fleet.peak}")
    check("only one of them was on the local lane", fleet.peak_local == 1)


# ── 2. the same local server serializes ──────────────────────────────────

async def test_same_ollama_serializes():
    print("3. two dispatches on the SAME ollama server serialize")
    fleet = Fleet(duration=0.4, models={"ingestion": "ollama:qwen3:14b",
                                        "news-summarizer": "ollama:qwen3:8b"})
    script = Script(["ingestion", "news-summarizer"])
    install(fleet, script)
    t0 = time.monotonic()
    holder = await drive(fleet, script)
    elapsed = time.monotonic() - t0
    check("never two local generations at once", fleet.peak_local == 1,
          f"peak_local={fleet.peak_local}")
    check("they took a full two dispatches of wall clock", elapsed >= 0.75,
          f"{elapsed:.2f}s")
    replies = [e for e in holder["events"] if e.get("kind") == "agent_reply"]
    check("both still completed", len(replies) == 2, str(len(replies)))


# ── 3. cancellation ──────────────────────────────────────────────────────

async def test_cancel_mid_group():
    print("4. a client that disappears mid-group leaves nothing running")
    fleet = Fleet(duration=5.0, models={"ingestion": "openrouter:a",
                                        "model-manager": "openrouter:b"})
    script = Script(["ingestion", "model-manager"])
    install(fleet, script)
    before = {t for t in asyncio.all_tasks()}
    holder = await drive(fleet, script, cancel_after_events=3)
    await asyncio.sleep(0.1)
    strays = [t.get_name() for t in asyncio.all_tasks()
              if t not in before and t.get_name().startswith("dispatch:")
              and not t.done()]
    check("no stray dispatch tasks", not strays, str(strays))
    check("no specialist completed after the cancel",
          not fleet.completed_after_cancel, str(fleet.completed_after_cancel))
    spans = [s for s in holder["turn"].spans if s["kind"] == "dispatch"]
    check("both dispatch spans exist", len(spans) == 2, str(len(spans)))
    check("both marked cancelled with an end time",
          all(s["status"] == "cancelled" and s["finished_at"] for s in spans),
          str([s["status"] for s in spans]))
    check("the turn itself is cancelled", holder["turn"].status == "cancelled")


# ── 4. the ledger stays readable ─────────────────────────────────────────

async def test_span_parentage():
    print("5. every child span nests under ITS OWN dispatch")
    fleet = Fleet(duration=0.2, models={"ingestion": "openrouter:a",
                                        "model-manager": "openrouter:b"})
    script = Script(["ingestion", "model-manager"])
    install(fleet, script)

    # each child opens a span of its own inside its dispatch
    original = fleet.dispatch

    async def dispatch_with_span(args, depth, automation=None):
        name = args.get("agent_name", "")
        async with trace.span("llm_call", f"child-of-{name}"):
            async for ev in original(args, depth, automation):
                yield ev

    runner._run_dispatch = dispatch_with_span
    holder = await drive(fleet, script)

    spans = holder["turn"].spans
    dispatches = {s["id"]: s["name"] for s in spans if s["kind"] == "dispatch"}
    children = [s for s in spans if s["name"].startswith("child-of-")]
    check("both children recorded", len(children) == 2, str(len(children)))
    mismatched = [c["name"] for c in children
                  if dispatches.get(c["parent_span_id"]) != c["name"].removeprefix("child-of-")]
    check("each child's parent is its own dispatch span", not mismatched,
          str(mismatched))


# ── 5. the budget still applies inside a group ───────────────────────────

async def test_budget_inside_group():
    print("6. the per-turn dispatch budget applies to a parallel group too")
    fleet = Fleet(duration=0.1, models={n: "openrouter:x" for n in "abcd"})
    script = Script(["a", "b", "c", "d"])
    install(fleet, script)
    settings_store._cache["agents.max_dispatches_per_turn"] = 2
    await drive(fleet, script)          # this case asserts on fleet/script only
    check("only the budgeted two ran", len(fleet.started) == 2,
          str([n for n, _ in fleet.started]))
    tool_msgs = [m for m in script.seen[1] if m["role"] == "tool"]
    check("all four ids still answered",
          [m["tool_call_id"] for m in tool_msgs] == ["d0", "d1", "d2", "d3"],
          str([m["tool_call_id"] for m in tool_msgs]))
    refused = [m for m in tool_msgs if "already used its 2" in m["content"]]
    check("the two over budget got the budget message", len(refused) == 2,
          str(len(refused)))
    settings_store._cache["agents.max_dispatches_per_turn"] = 5


# ── 6. a stuck specialist cannot hold the turn ───────────────────────────

async def test_dispatch_timeout():
    print("7. a stuck specialist is stopped at the wall-clock cap")
    fleet = Fleet(duration=10.0, models={"ingestion": "openrouter:a"})
    script = Script(["ingestion", "model-manager"])
    fleet.models["model-manager"] = "openrouter:b"
    install(fleet, script)
    settings_store._cache["agents.dispatch_timeout_s"] = 0.5
    t0 = time.monotonic()
    holder = await drive(fleet, script)
    elapsed = time.monotonic() - t0
    check("the turn finished near the cap, not the specialist's runtime",
          elapsed < 3, f"{elapsed:.2f}s")
    tool_msgs = [m for m in script.seen[1] if m["role"] == "tool"]
    check("both ids still answered", len(tool_msgs) == 2, str(len(tool_msgs)))
    check("the timeout is stated in the result",
          all("did not finish within" in m["content"] for m in tool_msgs),
          str([m["content"][:40] for m in tool_msgs]))
    spans = [s for s in holder["turn"].spans if s["kind"] == "dispatch"]
    check("the spans record the timeout",
          all(s["detail"].get("error") == "timeout" for s in spans),
          str([s["detail"].get("error") for s in spans]))
    settings_store._cache["agents.dispatch_timeout_s"] = 300


async def main():
    for t in (test_cloud_pair_overlaps, test_mixed_pair_overlaps,
              test_same_ollama_serializes, test_cancel_mid_group,
              test_span_parentage, test_budget_inside_group,
              test_dispatch_timeout):
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
