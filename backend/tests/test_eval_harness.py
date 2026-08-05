"""Phase 1 verification (docs/plans/model-eval-pipeline.md): the memory
sandbox and the tool fixture shim.

Self-contained script, same shape as the other backend tests — pytest is not
in the backend image on purpose. Needs no database, no network and no model:

    docker compose exec backend python tests/test_eval_harness.py

What it pins down (each maps to a rail in the plan):
  1. a sandbox OkfMemory writes only inside its own dir; real memory's
     content hash is byte-identical before and after
  2. the `memory` proxy resolves to the real store outside a sandbox, the
     scratch store inside one, and unwinds correctly when nested
  3. a module that did `from app.memory.memory import memory` at import time
     — i.e. every consumer in the codebase — follows the sandbox
  4. delete_item on a sandbox instance does NOT reach the media_ingests
     ledger (proved by the absence of a "Pool not initialized" blowup)
  5. fixture lookup: subset match, first match wins, default fallback,
     {{args.x}} substitution, result_file loading, traversal refusal
  6. intercept policy: replay-only never executes, fixtured tools are
     served, unfixtured tools fall through to live, banned tools are
     refused, and a miss is recorded rather than silently falling through
  7. execute_tool end to end: a fixtured tool answers from the corpus with
     no network, an unfixtured memory tool really writes the scratch store,
     and the full untruncated result is captured for grading
  8. the suite loader reads the authored format (skipped when the suites
     lane has not landed yet)
  9. valid vs gradeable: a run that died mid-stream is not scored as a bad
     answer
 10. the suite's tool-round cap binds the graded turn and its dispatched
     sub-turns and NOTHING else — a concurrent chat turn keeps the
     operator's cap, and an operator's mid-run Settings write survives
 11. and something actually consumes that cap: the turn path resolves it
     through the pin, and the eval ledger records it from inside the pin
"""

import ast
import asyncio
import hashlib
import inspect
import json
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, "/app/backend")

from app.config import settings                          # noqa: E402
from app.memory import memory as memory_mod              # noqa: E402
from app.memory.memory import OkfMemory                  # noqa: E402
from app.tools import builtin, fixtures                  # noqa: E402
from app.tools import registry as tool_registry          # noqa: E402

PASS, FAIL = [], []


def check(name, condition, detail=""):
    (PASS if condition else FAIL).append(name)
    mark = "ok  " if condition else "FAIL"
    print(f"  {mark} {name}" + (f" — {detail}" if detail and not condition else ""))


def hash_tree(root: Path) -> str:
    """Content-only digest: mtime churn must not read as a change."""
    h = hashlib.sha256()
    if not root.exists():
        return "missing"
    for path in sorted(p for p in root.rglob("*") if p.is_file()):
        h.update(str(path.relative_to(root)).encode())
        h.update(path.read_bytes())
    return h.hexdigest()


def scratch_memory(tmp: Path, name: str = "memory") -> OkfMemory:
    mem = OkfMemory(base_dir=str(tmp / name))
    asyncio.run(mem.startup())
    return mem


# ── 1: sandbox isolation ─────────────────────────────────────────────────

def test_sandbox_isolation(tmp: Path):
    print("\n[1] sandbox isolation")
    real_dir = Path(settings.okf_memory_dir)
    before = hash_tree(real_dir)

    mem = scratch_memory(tmp)
    check("scratch instance is marked sandboxed", mem.sandboxed is True)
    check("the real instance is not", memory_mod.real().sandboxed is False)

    async def write_inside():
        with memory_mod.sandbox(mem):
            return await memory_mod.memory.write(
                "Kimi K3 is a sparse mixture-of-experts model.", type="topic",
                title="Sandbox Probe", tags=["kimi-k3"])

    written = asyncio.run(write_inside())
    doc_id = written.get("id") or written.get("item_id")
    check("the write landed in the scratch store",
          bool(doc_id) and (mem.store.base_dir / doc_id).exists(), str(written))
    check("real memory content is unchanged", hash_tree(real_dir) == before,
          "the whole point of the lane")


# ── 2 + 3: the proxy ─────────────────────────────────────────────────────

def test_proxy_resolution(tmp: Path):
    print("\n[2] proxy resolution")
    mem_a = scratch_memory(tmp, "a")
    mem_b = scratch_memory(tmp, "b")

    check("outside a sandbox the proxy is the real store",
          memory_mod.current() is memory_mod.real())
    with memory_mod.sandbox(mem_a):
        check("inside, the proxy is the scratch store",
              memory_mod.current() is mem_a)
        check("attribute reach-through follows too (memory.store)",
              memory_mod.memory.store is mem_a.store)
        with memory_mod.sandbox(mem_b):
            check("nesting binds the inner store",
                  memory_mod.current() is mem_b)
        check("unwinding restores the outer store",
              memory_mod.current() is mem_a)
    check("and finally the real store",
          memory_mod.current() is memory_mod.real())

    try:
        with memory_mod.sandbox(memory_mod.real()):
            pass
        check("binding the real store as a sandbox is refused", False)
    except ValueError:
        check("binding the real store as a sandbox is refused", True)

    # a scratch root inside real memory would let the CLI's rmtree of the
    # scratch dir delete the operator's entire memory
    real_root = Path(settings.okf_memory_dir)
    for label, bad in (("inside real memory", real_root / "scratch"),
                       ("containing real memory", real_root.parent),
                       ("real memory itself", real_root)):
        try:
            OkfMemory(base_dir=str(bad))
            check(f"a sandbox root {label} is refused", False)
        except ValueError:
            check(f"a sandbox root {label} is refused", True)


def test_import_by_value_follows(tmp: Path):
    print("\n[3] modules that imported the singleton by value")
    mem = scratch_memory(tmp, "byvalue")
    # tools/builtin.py did `from app.memory.memory import memory` at import
    # time, as do runner.py, scheduler.py, router_chat.py and three more. They
    # hold the proxy, so they follow the sandbox — which is what lets the
    # runner's prompt reads and narration write redirect with no edit to it.
    check("builtin.py holds the proxy, not an OkfMemory",
          builtin.memory is memory_mod.memory)
    with memory_mod.sandbox(mem):
        check("and it resolves to the scratch store",
              builtin.memory.store is mem.store)


def test_sandbox_delete_skips_ledger(tmp: Path):
    print("\n[4] delete_item does not reach the real ledger")
    mem = scratch_memory(tmp, "del")

    async def go():
        written = await mem.write("disposable", type="topic", title="Trash Me")
        doc_id = written.get("id") or written.get("item_id")
        # No DB pool exists in this process. If delete_item still called
        # media_ingests.delete_by_item_id it would raise RuntimeError
        # ("Pool not initialized") — i.e. reach real Postgres from a sandbox.
        return doc_id, await mem.delete_item(doc_id)

    try:
        doc_id, deleted = asyncio.run(go())
        check("delete succeeded without touching Postgres", deleted is True)
        check("the file is really gone, not marked deleted",
              not (mem.store.base_dir / doc_id).exists())
    except RuntimeError as e:
        check("delete succeeded without touching Postgres", False, str(e))


# ── 5: fixture lookup ────────────────────────────────────────────────────

def test_fixture_lookup(tmp: Path):
    print("\n[5] fixture lookup")
    fdir = tmp / "fx"
    (fdir / "pages").mkdir(parents=True)
    (fdir / "pages" / "vendor.txt").write_text("[source: vendor]\n512K context.")
    (fdir / "fetch_url.json").write_text(json.dumps({
        "tool": "fetch_url",
        "entries": [
            {"match": {"url": "https://vendor/a"}, "result_file": "pages/vendor.txt"},
            {"match": {"url": "https://other/b"}, "result": "other page"},
        ],
        "default": {"result": "Error: not in the frozen mini-web"},
    }))
    (fdir / "web_search.json").write_text(json.dumps({
        "tool": "web_search",
        "default": {"result": "Search results for: {{args.query}}\n1. vendor"},
    }))

    fx = fixtures.Fixtures.for_replay([fdir / "fetch_url.json",
                                       fdir / "web_search.json"])
    check("result_file is served verbatim",
          fx.intercept("fetch_url", {"url": "https://vendor/a"})
          == "[source: vendor]\n512K context.")
    check("an inline result is served",
          fx.intercept("fetch_url", {"url": "https://other/b"}) == "other page")
    check("an unmatched call falls back to the default",
          fx.intercept("fetch_url", {"url": "https://nope"})
          == "Error: not in the frozen mini-web")
    check("match is a SUBSET predicate, not equality",
          fx.intercept("fetch_url", {"url": "https://other/b", "extra": 1})
          == "other page")
    check("{{args.x}} echoes the real call",
          fx.intercept("web_search", {"query": "kimi k3"})
          == "Search results for: kimi k3\n1. vendor")
    check("a missing key substitutes empty rather than crashing",
          fx.intercept("web_search", {}) == "Search results for: \n1. vendor")

    (fdir / "escape.json").write_text(json.dumps({
        "tool": "fetch_url",
        "entries": [{"match": {}, "result_file": "../../../etc/hostname"}]}))
    try:
        fixtures.load_fixture_file(fdir / "escape.json")
        check("result_file cannot escape the fixture dir", False)
    except ValueError:
        check("result_file cannot escape the fixture dir", True)

    (fdir / "both.json").write_text(json.dumps({
        "tool": "x", "entries": [{"match": {}, "result": "a", "result_file": "b"}]}))
    try:
        fixtures.load_fixture_file(fdir / "both.json")
        check("result and result_file together are rejected", False)
    except ValueError:
        check("result and result_file together are rejected", True)


# ── 6: intercept policy ──────────────────────────────────────────────────

def test_intercept_policy(tmp: Path):
    print("\n[6] intercept policy")
    fdir = tmp / "fx2"
    fdir.mkdir(parents=True)
    (fdir / "web_search.json").write_text(json.dumps({
        "tool": "web_search", "default": {"result": "frozen results"}}))

    fx = fixtures.Fixtures.for_replay(
        [fdir / "web_search.json"],
        replay_only={"ingest_media"},
        replay_only_default="Error: not available in eval replay mode.")

    check("a fixtured tool is served",
          fx.intercept("web_search", {"query": "x"}) == "frozen results")
    check("a scratch-store tool executes live (this is how memory grading works)",
          fx.intercept("search_memory", {"query": "x"}) is None)
    # the allowlist rail: without it, 8 of 18 authored tasks reached the real
    # internet and the two contestants saw different worlds
    loose = fx.intercept("fetch_url", {"url": "https://real.example.com"})
    check("an unfixtured NON-scratch tool is refused, NOT executed live",
          loose is not None and loose.startswith("Error:"), repr(loose))
    check("and it is recorded as a miss so the run reads invalid",
          [m["tool"] for m in fx.misses] == ["fetch_url"])
    check("a replay-only tool never executes",
          fx.intercept("ingest_media", {"url": "u"})
          == "Error: not available in eval replay mode.")
    banned = fx.intercept("notify_operator", {"message": "hi"})
    check("a destructive tool is refused with its OWN message, not absorbed "
          "by the suite's replay-only default",
          "real side effects" in banned)
    check("and the refusal is recorded as a violation",
          [v["tool"] for v in fx.violations] == ["notify_operator"])
    check("a destructive tool is not counted as a served call",
          "notify_operator" not in [c["tool"] for c in fx.calls])

    (fdir / "get_weather.json").write_text(json.dumps({
        "tool": "get_weather",
        "entries": [{"match": {"city": "Beacon"}, "result": "sunny"}]}))
    strict = fixtures.Fixtures.for_replay([fdir / "get_weather.json"])
    miss = strict.intercept("get_weather", {"city": "Nowhere"})
    check("an unmatched fixtured call errors instead of going live",
          miss.startswith("Error: this eval has no canned result"))
    check("and it is recorded as a miss",
          [m["tool"] for m in strict.misses] == ["get_weather"])
    check("the miss says which kind of gap it was",
          "no fixture entry matches" in strict.misses[0]["why"])

    rec = fixtures.Fixtures.for_record(
        replay_only={"ingest_media"},
        replay_only_default="Error: replay only.")
    check("record mode still never runs a replay-only tool",
          rec.intercept("ingest_media", {"url": "u"}) == "Error: replay only.")
    check("record mode lets an ordinary tool through",
          rec.intercept("web_search", {"query": "x"}) is None)


# ── 7: through execute_tool ──────────────────────────────────────────────

def test_execute_tool_end_to_end(tmp: Path):
    print("\n[7] execute_tool with the shim installed")
    fdir = tmp / "fx3"
    fdir.mkdir(parents=True)
    (fdir / "web_search.json").write_text(json.dumps({
        "tool": "web_search",
        "default": {"result": "Search results for: {{args.query}}\n1. frozen"}}))
    mem = scratch_memory(tmp, "e2e")
    fx = fixtures.Fixtures.for_replay([fdir / "web_search.json"])

    async def go():
        with memory_mod.sandbox(mem), fixtures.using(fx):
            searched = await tool_registry.execute_tool(
                "web_search", {"query": "kimi k3"}, {})
            written = await tool_registry.execute_tool(
                "write_memory",
                {"content": "x" * 3000, "type": "topic", "title": "Long Note",
                 "tags": ["kimi-k3"]}, {})
            return searched, written

    searched, written = asyncio.run(go())
    check("the fixtured tool answered from the corpus, no network",
          searched == "Search results for: kimi k3\n1. frozen")
    check("the unfixtured memory tool really executed",
          "long-note" in written, written[:200])
    check("and the write landed in the scratch store only",
          any("long-note" in doc for doc, _ in mem.store.iter_files()))

    executed = [c for c in fx.calls if not c["served"]]
    check("executed calls are captured for grading",
          [c["tool"] for c in executed] == ["write_memory"])
    check("captured args are FULL, not span-truncated at 2000 chars",
          bool(executed) and len(executed[0]["args"]["content"]) == 3000,
          f"got {len(executed[0]['args']['content']) if executed else 'nothing'}")
    served = [c for c in fx.calls if c["served"]]
    check("served calls are captured too",
          [c["tool"] for c in served] == ["web_search"])
    check("served calls carry their result (tool_errors_max counts canned "
          "'Error:' fixtures)",
          bool(served) and served[0]["result"] == searched)
    check("outside a run the shim is unbound (production path)",
          fixtures.active() is None)


# ── 8: the authored suite format ─────────────────────────────────────────

def test_result_gradeability():
    print("\n[9] valid vs gradeable")
    from app.evals.runner import RunResult
    base = dict(label="challenger", task="t", suite="s", suite_version=1,
                agent="ingestion", model="ollama:x", effective_model="ollama:x")

    ok = RunResult(final="a real answer", **base)
    check("a completed run is valid and gradeable", ok.valid and ok.gradeable)

    # run_agent yields an error event then RETURNS with no final event, so a
    # 404 for an unpulled model looks like an empty answer, not a failure
    died = RunResult(final="", errors=["LLM API error 404"], **base)
    check("a run that died in the stream is still 'valid' (harness was fine)",
          died.valid)
    check("but it is NOT gradeable — scoring '' would gift the other side",
          not died.gradeable)

    timed = RunResult(final="partial", timed_out=True, **base)
    check("a timed-out run is not gradeable", not timed.gradeable)

    missed = RunResult(final="an answer",
                       fixture_misses=[{"tool": "web_search"}], **base)
    check("a fixture miss makes the run invalid", not missed.valid)
    check("and therefore not gradeable", not missed.gradeable)


# ── 10: the tool-round pin stays inside the run ──────────────────────────

def test_pin_is_context_scoped():
    """The pin used to be a write into settings_store._cache.

    Two live consequences, one test each below. A chat turn cleared for 10
    rounds ran at the suite's cap (6 for tool-creator, 8 for the rest) for as
    long as an eval task held the pin, and evals run continuously here. And
    an operator who saved "max tool rounds" mid-run had the cache half of
    that write reverted by the pin's exit, leaving Postgres and the Settings
    UI disagreeing until the next restart.
    """
    print("\n[10] the tool-round pin stays inside the run")
    from app import settings_store
    from app.evals import runner as eval_runner

    key = "agents.max_tool_rounds"
    operator = settings_store.get(key)
    pinned = (operator or 10) + 3      # never equal to the live value
    had = key in settings_store._cache
    previous = settings_store._cache.get(key)

    check("outside a run the pin is unbound (production path)",
          eval_runner.EVAL_MAX_TOOL_ROUNDS.get() is None)
    check("so the cap resolves to the operator's setting",
          eval_runner.effective_max_tool_rounds() == operator)

    async def go():
        seen = {}

        async def live_turn(gate):
            # a chat turn already in flight when the eval starts: its context
            # was copied at create_task, before the pin existed
            await gate.wait()
            seen["live_cap"] = eval_runner.effective_max_tool_rounds()
            seen["live_store"] = settings_store.get(key)

        async def sub_turn():
            # what run_agent's re-entry from _run_dispatch sees
            seen["sub_cap"] = eval_runner.effective_max_tool_rounds()

        gate = asyncio.Event()
        live = asyncio.create_task(live_turn(gate))     # created OUTSIDE the pin
        with eval_runner._pinned_rounds(pinned):
            gate.set()
            await live
            seen["eval_cap"] = eval_runner.effective_max_tool_rounds()
            seen["eval_store"] = settings_store.get(key)
            await asyncio.create_task(sub_turn())
            # the operator saves a new value in Settings mid-run: set_value
            # commits to Postgres and then to the cache. Mimic the cache half.
            settings_store._cache[key] = 7
        seen["after_exit"] = settings_store._cache.get(key)
        seen["unbound"] = eval_runner.EVAL_MAX_TOOL_ROUNDS.get()
        return seen

    try:
        seen = asyncio.run(go())
    finally:
        if had:
            settings_store._cache[key] = previous
        else:
            settings_store._cache.pop(key, None)

    check("the graded turn runs under the suite's cap",
          seen["eval_cap"] == pinned, f"got {seen['eval_cap']}")
    check("and a dispatched sub-turn measures the same cap",
          seen["sub_cap"] == pinned, f"got {seen['sub_cap']}")
    check("a concurrent live turn keeps the operator's cap",
          seen["live_cap"] == operator, f"got {seen['live_cap']}")
    check("because the store itself is never rewritten",
          seen["eval_store"] == operator and seen["live_store"] == operator,
          f"eval saw {seen['eval_store']}, live saw {seen['live_store']}")
    check("an operator write during a run survives the run's exit",
          seen["after_exit"] == 7, f"got {seen['after_exit']}")
    check("and the pin unbinds itself on exit", seen["unbound"] is None)

    with eval_runner._pinned_rounds(None):
        check("a suite with no cap of its own pins nothing",
              eval_runner.EVAL_MAX_TOOL_ROUNDS.get() is None
              and eval_runner.effective_max_tool_rounds() == operator)


# ── 11: the pin is worthless unless something reads it ───────────────────

def _records_ledger_cap_inside_pin(func) -> bool:
    """Does `func` assign `.max_tool_rounds` inside the `_pinned_rounds` with?

    Parsed rather than grepped so that reformatting the block, renaming the
    local or moving the assignment WITHIN the pin all still pass, and only
    moving it out of the pin fails. Does not check anything about the value
    assigned — that is what the [10] checks are for.
    """
    tree = ast.parse(inspect.getsource(func))
    for node in ast.walk(tree):
        if not isinstance(node, ast.With):
            continue
        pinned = any(isinstance(item.context_expr, ast.Call)
                     and getattr(item.context_expr.func, "id", "")
                     == "_pinned_rounds"
                     for item in node.items)
        if not pinned:
            continue
        for stmt in node.body:
            for inner in ast.walk(stmt):
                if isinstance(inner, ast.Assign) and any(
                        isinstance(t, ast.Attribute)
                        and t.attr == "max_tool_rounds"
                        for t in inner.targets):
                    return True
    return False


def test_pin_is_consumed():
    """A ContextVar nobody reads is a comment, and this one is worse than
    inert unread: run_task records `result.max_tool_rounds` from the same
    expression the turn is supposed to run under, so an unwired turn path
    writes the suite's cap into the eval ledger for a run that actually
    executed at the operator's. The ledger would say 6 for a 10-round run.

    Both checks are derived, not listed: the names come from whatever this
    module currently exposes about the cap, and the ledger check parses
    run_task rather than matching a line.
    """
    print("\n[11] something actually consumes the pin")
    from app.agents import runner as agent_runner
    from app.evals import runner as eval_runner

    resolvers = sorted(n for n in vars(eval_runner)
                       if "max_tool_rounds" in n.lower())
    turn_path = Path(agent_runner.__file__).read_text()
    check("the turn path resolves the cap through the pin",
          any(name in turn_path for name in resolvers),
          f"agents/runner.py mentions none of {resolvers} — it still reads "
          f"settings_store directly, so the suite cap never reaches the turn "
          f"while the ledger records it anyway")
    check("and the ledger records the cap from inside the pin",
          _records_ledger_cap_inside_pin(eval_runner.run_task),
          "result.max_tool_rounds is assigned outside the _pinned_rounds "
          "block, so it stores the operator's setting, not the run's cap")


def test_suite_loader():
    print("\n[8] suite loader")
    from app.evals import suites
    names = suites.list_suites()
    if not names:
        print("  skip  no suites on disk yet (authoring lane not merged)")
        return
    for name in names:
        suite = suites.load_suite(name)
        tasks = suites.load_tasks(suite)
        check(f"suite '{name}' loads all {len(suite.task_ids)} tasks",
              len(tasks) == len(suite.task_ids))
        for task in tasks:
            check(f"  {task.ref} has a prompt", bool(task.prompt.strip()))
            for path in task.fixtures:
                loaded = fixtures.load_fixture_file(path)
                check(f"  {task.ref} fixture {path.name} parses",
                      bool(loaded.tool))


def main():
    tmp = Path(tempfile.mkdtemp(prefix="nova-eval-test-"))
    try:
        test_sandbox_isolation(tmp)
        test_proxy_resolution(tmp)
        test_import_by_value_follows(tmp)
        test_sandbox_delete_skips_ledger(tmp)
        test_fixture_lookup(tmp)
        test_intercept_policy(tmp)
        test_execute_tool_end_to_end(tmp)
        test_result_gradeability()
        test_suite_loader()
        test_pin_is_context_scoped()
        test_pin_is_consumed()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    for name in FAIL:
        print(f"  FAILED: {name}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
