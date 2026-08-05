"""Champion/challenger eval runs (docs/plans/model-eval-pipeline.md, phase 1).

One task, one model, one turn — cloned from `scheduler.run_one`, which is the
shipped template for driving `run_agent` with no SSE consumer and a wall-clock
budget. Evals never go through the HTTP chat route: that route journals to the
memory singleton, appends conversation rows, fires compaction and pushes a
notification (router_chat.py:196-227).

Isolation comes from three contextvars bound around the drain:

  * `memory.sandbox(...)` — a scratch OkfMemory. Because the module-level
    `memory` name is a proxy, this redirects the runner's prompt-assembly
    reads and its fire-and-forget narration journal write as well as every
    memory tool, without editing runner.py (which lane 1 owns).
  * `fixtures.using(...)` — the frozen mini-web, so both contestants research
    identical inputs.
  * `EVAL_MAX_TOOL_ROUNDS` — the suite's tool-round cap. Unlike the other
    two this one only binds if the turn path resolves the cap through
    `effective_max_tool_rounds` instead of reading the setting directly;
    test_eval_harness [11] is the check that refuses when it does not.
    See `_pinned_rounds`.

Phase 1 produces the material; it does not grade. Contract checkers, the
pairwise judge, and the eval_runs/eval_results tables are phase 2, and the
result shape below is what they consume.
"""

from __future__ import annotations

import asyncio
import contextlib
import contextvars
import hashlib
import logging
import shutil
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from app import settings_store, trace
from app.evals import suites
from app.agents import registry as agent_registry
from app.evals.suites import Suite, Task
from app.llm import router as llm_router
from app.memory import memory as memory_mod
from app.memory.memory import OkfMemory
from app.tools import fixtures
from app.tools.registry import BUILTIN_TOOLS

log = logging.getLogger(__name__)

# Never offered to a graded agent, whatever the suite says. These have real,
# un-sandboxable side effects and no eval needs them in the toolset — unlike
# the manage_* family, which a phase-4 replay-only suite grades by inspecting
# the CALLS, so those stay offered and are blocked at execution instead
# (tools/fixtures.py NEVER_EXECUTE).
HARD_EXCLUDED_TOOLS = frozenset({
    "pull_model",
    "notify_operator",
    "request_operator_confirmation",
    "remember_speaker",
    "raise_recommendation",
    "delete_memory_item",
})

# Which tools may really execute lives in tools/fixtures.py (LIVE_OK), where
# it is enforced. Named here only to report grants that will be refused.
_SANDBOX_SAFE_TOOLS = fixtures.LIVE_OK


@dataclass
class RunResult:
    """Everything phase 2 needs to grade one contestant's run."""

    label: str
    task: str
    suite: str
    suite_version: int
    agent: str
    model: str
    effective_model: str
    # the operator's words for this task — service_claims needs them to tell a
    # scenario the prompt POSED from a live-state claim the model invented
    prompt: str = ""
    trace_id: Optional[str] = None
    final: str = ""
    errors: list[str] = field(default_factory=list)
    timed_out: bool = False
    duration_s: float = 0.0

    rounds: int = 0
    max_tool_rounds: Optional[int] = None
    usage: dict = field(default_factory=dict)
    activity: list[dict] = field(default_factory=list)
    spans: list[dict] = field(default_factory=list)

    tool_calls: list[dict] = field(default_factory=list)
    malformed_args: int = 0
    fixture_misses: list[dict] = field(default_factory=list)
    fixture_violations: list[dict] = field(default_factory=list)
    unfixtured_grants: list[str] = field(default_factory=list)

    memory: dict = field(default_factory=dict)
    scratch_dir: str = ""

    @property
    def valid(self) -> bool:
        """False when the harness itself failed the run, not the model."""
        return not (self.fixture_misses or self.fixture_violations)

    @property
    def gradeable(self) -> bool:
        """Produced an answer worth comparing to the other contestant.

        Separate from `valid` on purpose: a model that 404s because it was
        never pulled, or dies mid-stream, yields an error event and then
        returns with NO final event (runner.py:520-529). That is an empty
        string, not a bad answer, and scoring it as one would quietly hand
        the other contestant the win.
        """
        return (self.valid and not self.errors and not self.timed_out
                and bool(self.final.strip()))


# ── toolset ──────────────────────────────────────────────────────────────

def eval_toolset(agent: dict, suite: Suite) -> list[str]:
    """The agent's real grants, minus what an eval must never offer.

    `allowed_tools=None` means all builtins plus all DB tools and zero MCP
    tools (registry.py:196-198, :114-116). Materializing that as an explicit
    list is what makes the ban enforceable, and the resulting toolset is the
    same — an eval should measure the agent as configured.

    One nuance for the None case: an explicit list sets has_grants=True in
    _granted_mcp_tools, so get_agent_tools walks _load_mcp_tools() where None
    short-circuits. It still grants no MCP tool (none are named), but it can
    kick off a background server refresh. Every agent in this install has an
    explicit allowed_tools list, so today this branch never runs.
    """
    banned = HARD_EXCLUDED_TOOLS | set(suite.exclude_tools)
    allowed = agent.get("allowed_tools")
    if allowed is None:
        return [n for n in BUILTIN_TOOLS if n not in banned] + ["db:*"]
    return [n for n in allowed if n not in banned]


def unfixtured_grants(toolset: list[str], task: Task) -> list[str]:
    """Granted tools this task can neither serve nor safely execute.

    Calling one is not a model failure and not a crash — it is refused and
    recorded as a fixture miss, which marks the run invalid. Surfacing the
    list up front turns "why did this run come back invalid" into a suite
    fix: author a fixture, or add the tool to the suite's replay_only_tools
    (which already carries a replay_only_default for exactly this).
    """
    fixtured = {fixtures.load_fixture_file(p).tool for p in task.fixtures}
    # Dynamic grants (MCP servers approved after this suite was
    # authored) are replay-only by construction — see
    # suites.dynamic_tools. Without this, approving one server makes
    # every run of every suite warn about tools no fixture can cover.
    replay_only = set(task.suite.replay_only_tools)
    replay_only |= suites.dynamic_tools(toolset)
    loose = sorted(t for t in toolset
                   if t not in fixtured and t not in replay_only
                   and t not in _SANDBOX_SAFE_TOOLS and t != "db:*"
                   and t not in fixtures.NEVER_EXECUTE)
    if loose:
        log.warning("eval %s: granted but unservable — a call to any of these "
                    "is refused and invalidates the run: %s",
                    task.ref, ", ".join(loose))
    return loose


# ── scratch memory ───────────────────────────────────────────────────────

def _digest(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def seed_scratch_memory(task: Task, memory_dir: Path) -> OkfMemory:
    """Materialize the task's frozen corpus and index it.

    Files listed in `seed_corpus` keep their path below `corpus/`, so
    `corpus/topics/kimi-k3.md` lands at `<scratch>/topics/kimi-k3.md`.
    `startup()` then seeds soul.md and builds the BM25 index over exactly
    that corpus — which is also what makes write-time `_link_pass`
    deterministic.
    """
    memory_dir.mkdir(parents=True, exist_ok=True)
    corpus_root = (task.suite.directory / "corpus").resolve()
    for src in task.seed_corpus:
        rel = src.resolve().relative_to(corpus_root)
        dest = memory_dir / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dest)
    return OkfMemory(base_dir=str(memory_dir))


def _snapshot(mem: OkfMemory) -> dict[str, str]:
    return {doc_id: _digest(mem.store.read_file(doc_id)[1] or "")
            for doc_id, _ in mem.store.iter_files()
            if mem.store.read_file(doc_id)}


def _memory_report(mem: OkfMemory, before: dict[str, str]) -> dict:
    """What the run did to the scratch store, ready for contract checks."""
    items, created, modified = [], [], []
    for doc_id, _mtime in mem.store.iter_files():
        parsed = mem.store.read_file(doc_id)
        if not parsed:
            continue
        fm, body = parsed
        digest = _digest(body or "")
        if doc_id not in before:
            created.append(doc_id)
        elif before[doc_id] != digest:
            modified.append(doc_id)
        items.append({"id": doc_id, "frontmatter": fm, "body": body,
                      "new": doc_id not in before})
    return {"created": created, "modified": modified,
            "deleted": sorted(set(before) - {i["id"] for i in items}),
            "items": items}


# ── the tool-round pin ───────────────────────────────────────────────────

# The tool-round cap the eval task running in THIS context was authored to
# get, or None anywhere else — which is everywhere the harness is not, so a
# live chat turn always falls through to the operator's setting.
#
# This used to be a write into `settings_store._cache`, which is one
# process-global dict: its own log line said "concurrent live chat turns see
# it too". Evals run continuously on this box, so that was live. A chat turn
# cleared for 10 rounds was cut off at 6 for the length of a tool-creator
# task and at 8 for every other suite, with nothing on the chat path aware an
# eval was running — and the narration and deferral retries, which spend the
# last round by design, lost theirs. Worse, the pin snapshotted the cap on
# entry and wrote it back on exit: an operator who changed "max tool rounds"
# in Settings mid-run had `set_value` commit to Postgres and to the cache,
# then had the cache silently reverted underneath. Nothing re-warms outside
# startup (main.py:105), so the DB and the Settings UI — which renders from
# the same cache — then disagreed until the next backend restart.
#
# A ContextVar rather than a `max_rounds=` argument on run_agent because
# run_agent re-enters ITSELF for dispatched sub-agents (agents/runner.py,
# `_run_dispatch`) and every re-entry re-reads the cap. An argument would have
# to be threaded through _run_dispatch into each sub-turn or one graded turn
# would measure two different caps; a ContextVar is inherited by the wait_for
# task and every child task it spawns with no threading at all.
EVAL_MAX_TOOL_ROUNDS: contextvars.ContextVar[Optional[int]] = \
    contextvars.ContextVar("eval_max_tool_rounds", default=None)


def effective_max_tool_rounds() -> Optional[int]:
    """The tool-round cap in force for the caller's context.

    The eval pin if one is bound here, otherwise the operator's live
    setting. Deliberately does NOT apply run_agent's `or 10` floor — the
    caller keeps its own default so this can be used to record what a run
    actually ran under as well as to drive it.
    """
    pinned = EVAL_MAX_TOOL_ROUNDS.get()
    if pinned is not None:
        return pinned
    return settings_store.get("agents.max_tool_rounds")


@contextlib.contextmanager
def _pinned_rounds(value: Optional[int]):
    """Bind the suite's tool-round cap to this context, and nothing wider.

    Writes no shared state: `settings_store._cache` is untouched, so a
    concurrent `set_value` from the Settings UI survives the pin's exit and
    a concurrent chat turn keeps the operator's cap. Consumers must read it
    through `effective_max_tool_rounds` (or the ContextVar directly) — a
    `settings_store.get` still answers with the operator's value here, on
    purpose: this pins one setting for one graded turn, not the store.
    """
    if value is None:
        yield
        return
    token = EVAL_MAX_TOOL_ROUNDS.set(value)
    try:
        yield
    finally:
        EVAL_MAX_TOOL_ROUNDS.reset(token)


async def _settle(before: set, timeout: float = 8.0) -> None:
    """Let fire-and-forget work started by the run finish.

    The narration detector schedules its journal write with
    `asyncio.ensure_future` (runner.py:646) and trace flushes the same way
    (trace.py:132). Reading the scratch store — or tearing it down — before
    those land loses exactly the evidence an eval is looking for.
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        new = {t for t in asyncio.all_tasks()
               if t is not asyncio.current_task() and t not in before
               and not t.done()}
        if not new:
            return
        await asyncio.wait(new, timeout=0.25)


# ── one contestant ───────────────────────────────────────────────────────

async def run_task(task: Task, model: str, *, label: str, scratch_root: Path,
                   record: bool = False) -> RunResult:
    """Run one task with one model against a fresh sandbox."""
    # Imported here, not at module scope: agents/runner.py reads
    # EVAL_MAX_TOOL_ROUNDS from this module, and a module-level import back
    # into it would make that a cycle. Nothing else here reaches the runner,
    # so this file stays importable from the turn path.
    from app.agents import runner as agent_runner

    if ":" not in model:
        raise ValueError(
            f"model {model!r} needs a provider slug ('openrouter:…', "
            f"'ollama:…') — a bare name passes effective_model untouched and "
            f"then dies inside the client")

    # GUARD: effective_model silently swaps a model whose provider is not
    # configured to the local fallback, with only a log line
    # (llm/router.py:17-30). Without this we would grade qwen2.5:3b and
    # report it as the challenger. providers.warm() must have run.
    effective = llm_router.effective_model(model)
    if effective != model:
        raise RuntimeError(
            f"{model!r} resolves to {effective!r} — its provider is not "
            f"configured, so this run would grade the fallback. Configure the "
            f"provider (Settings -> Models -> Providers) or pick another model.")

    agent = await agent_registry.get_agent_by_name(task.suite.agent)
    if not agent:
        raise RuntimeError(
            f"suite '{task.suite.name}' grades agent '{task.suite.agent}', "
            f"which does not exist in this install")
    if not agent["enabled"]:
        log.warning("eval: agent '%s' is disabled; grading it anyway",
                    task.suite.agent)

    toolset = eval_toolset(agent, task.suite)
    contestant = {**agent, "model": model, "allowed_tools": toolset}

    scratch = scratch_root / f"{task.suite.name}__{task.id}__{label}"
    if scratch.exists():
        shutil.rmtree(scratch)
    mem = seed_scratch_memory(task, scratch / "memory")
    await mem.startup()
    before = _snapshot(mem)

    fx = (fixtures.Fixtures.for_record(
              replay_only=set(task.suite.replay_only_tools),
              replay_only_default=task.suite.replay_only_default)
          if record else
          fixtures.Fixtures.for_replay(
              task.fixtures,
              replay_only=set(task.suite.replay_only_tools),
              replay_only_default=task.suite.replay_only_default))

    tag = f"eval:{task.ref}"
    result = RunResult(label=label, task=task.id, suite=task.suite.name,
                       suite_version=task.suite.version,
                       agent=task.suite.agent, model=model,
                       effective_model=effective,
                       unfixtured_grants=unfixtured_grants(toolset, task),
                       prompt=task.prompt,
                       scratch_dir=str(scratch))
    turn: Any = None

    async def consume():
        nonlocal turn
        async with trace.turn("eval", automation=tag, model=effective) as t:
            turn = t                      # captured inside: wait_for cancels
            result.trace_id = str(t.id)   # consume() and it never returns
            async for event in agent_runner.run_agent(
                    contestant, [{"role": "user", "content": task.prompt}],
                    dispatch_depth=1, automation=tag):
                kind = event["type"]
                if kind == "final":
                    result.final = event["text"]
                elif kind == "error":
                    result.errors.append(event["error"])
                    t.set_error(event["error"])
                elif kind == "activity":
                    result.activity.append(
                        {k: event.get(k) for k in
                         ("kind", "name", "agent", "detail")})

    started = time.monotonic()
    tasks_before = set(asyncio.all_tasks())
    with memory_mod.sandbox(mem), fixtures.using(fx), \
            _pinned_rounds(task.suite.max_tool_rounds):
        try:
            await asyncio.wait_for(consume(), timeout=task.budget_seconds)
        except asyncio.TimeoutError:
            result.timed_out = True
            log.warning("eval %s [%s]: timed out after %ss",
                        task.ref, label, task.budget_seconds)
        # inside the sandbox on purpose — a late narration write must land in
        # the scratch store, and it must land before we read that store back
        await _settle(tasks_before)
        # and inside the pin, reading it the same way the runner does, or the
        # ledger records the operator's live setting instead of the cap the
        # turn actually ran under
        result.max_tool_rounds = effective_max_tool_rounds()

    result.duration_s = round(time.monotonic() - started, 2)
    result.memory = _memory_report(mem, before)
    result.tool_calls = fx.calls
    result.fixture_misses = fx.misses
    result.fixture_violations = fx.violations

    spans = list(getattr(turn, "spans", []) or [])
    result.spans = [{"kind": s["kind"], "name": s["name"], "status": s["status"],
                     "detail": s["detail"]} for s in spans]
    result.rounds = sum(1 for s in spans if s["kind"] == "llm_call")
    result.malformed_args = sum(
        1 for s in spans if s["kind"] == "tool"
        and s["detail"].get("error") == "malformed_arguments")
    result.usage = {
        field_name: sum(int(s["detail"].get(field_name) or 0)
                        for s in spans if s["kind"] == "llm_call")
        for field_name in ("prompt_tokens", "completion_tokens", "cached_tokens")
    }
    return result


# ── the pair ─────────────────────────────────────────────────────────────

async def run_pair(task: Task, champion: str, challenger: str, *,
                   scratch_root: Path, record: bool = False) -> dict:
    """Champion then challenger, back to back, on identical inputs.

    Back to back matters: the prompt's platform block is cached 300s and the
    entities block 15s (runner.py:110/156), so running them together is what
    keeps the two system prompts comparable.
    """
    runs = []
    for label, model in (("champion", champion), ("challenger", challenger)):
        log.info("eval %s [%s] %s", task.ref, label, model)
        runs.append(await run_task(task, model, label=label,
                                   scratch_root=scratch_root, record=record))
    return {"task": task.ref, "suite_version": task.suite.version,
            "champion": runs[0], "challenger": runs[1]}
