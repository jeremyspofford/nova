"""Tool record/replay for eval runs (docs/plans/model-eval-pipeline.md).

Champion and challenger have to research the same frozen mini-web, or the
comparison measures the internet's mood rather than the models. This module
is the seam: `tool_registry.execute_tool` asks it, on every call, whether a
canned result should be served instead of executing.

Mode rides a contextvar, not the tool ctx dict — ctx is rebuilt from scratch
inside every `run_agent` call (runner.py:482) and only `automation`
propagates into dispatch sub-turns, so a ctx key could not survive the trip.
A contextvar does: async generators run in their consumer's context, and
tasks copy it at creation.

WHAT EXECUTES, in replay mode — an ALLOWLIST, which is the rule that makes
the comparison mean anything:

  * a tool in `live_ok` (the memory tools) -> EXECUTED, against the scratch
    store. This is the point: contract checks grade what the agent actually
    wrote, so those writes have to really happen.
  * everything else                        -> served from a fixture, or the
    suite's replay-only default, or recorded as a MISS

Allowlist, not blacklist, and the difference is not academic: the first cut
of this file let any granted-but-unfixtured tool fall through to the real
implementation, which meant 8 of the 18 authored tasks would have run
web_search/fetch_url against the live internet. Champion and challenger
research a minute apart, get different pages, and the score difference is
the internet's rather than the model's — with nothing in the output saying
so. A grading harness that silently degrades to "unfair" is worse than one
that refuses.

An unmatched call to a fixtured tool likewise never reaches the live tool:
it returns an error string and records a miss, and the harness marks the run
invalid. Returning rather than raising is deliberate — execute_tool never
raises, and an exception here would escape its try blocks and kill the turn
mid-round with a half-written transcript.

Fixture format is authored by the suites and documented in
`app/evals/tasks/README.md` — this module is its only consumer.
"""

from __future__ import annotations

import contextlib
import contextvars
import json
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

log = logging.getLogger(__name__)

MODE_RECORD = "record"
MODE_REPLAY = "replay"

# Tools with real, un-sandboxable side effects. Suites are expected to keep
# these out of the toolset entirely (`exclude_tools`); this set is the second
# rail, so a suite that forgets one still cannot reach the operator's world.
# delete_memory_item is here because OkfMemory.delete_item drops rows from the
# real media_ingests ledger (memory.py:356-364) — Postgres, which no
# filesystem sandbox contains.
NEVER_EXECUTE = frozenset({
    "pull_model",                      # starts a multi-GB download
    "notify_operator",                 # pushes to Jeremy's phone
    "request_operator_confirmation",   # posts a consent card in live chat
    "remember_speaker",                # writes a household voice profile
    "raise_recommendation",            # posts a card + bell badge
    "delete_memory_item",              # reaches the real media_ingests ledger
    "manage_agents",                   # writes the very table an eval reads
    "manage_tools",                    # a created tool goes live for everyone
    "manage_rules",                    # rules CRUD, and burns operator consents
    "manage_automations",              # schedules real jobs
})

# The only tools allowed to really execute during a replay run: they touch
# nothing but the scratch OkfMemory bound for this context, and the contract
# checks grade their effects. Everything outside this set must come from a
# fixture — see the allowlist note in the module docstring.
LIVE_OK = frozenset({
    "search_memory", "write_memory", "read_memory_item", "list_stale_topics",
})

_ARG_REF = re.compile(r"\{\{args\.([A-Za-z0-9_]+)\}\}")


def _substitute(result: str, args: dict) -> str:
    """Fill `{{args.query}}`-style placeholders from the ACTUAL call args.

    web_search really does echo the query it was given
    (tools/web_search.py:117). A frozen echo that disagreed with the call
    would be an incoherence one contestant might notice and another might
    not — so the canned corpus quotes back whatever was actually asked.
    """
    return _ARG_REF.sub(lambda m: str(args.get(m.group(1), "")), result)


def _matches(pattern: dict, args: dict) -> bool:
    """Subset predicate: every key the entry names must be present and equal."""
    return all(k in args and args[k] == v for k, v in pattern.items())


@dataclass
class _Entry:
    match: dict
    result: str


@dataclass
class _ToolFixture:
    tool: str
    entries: list[_Entry] = field(default_factory=list)
    default: Optional[str] = None

    def lookup(self, args: dict) -> Optional[str]:
        for entry in self.entries:
            if _matches(entry.match, args):
                return _substitute(entry.result, args)
        if self.default is not None:
            return _substitute(self.default, args)
        return None


def load_fixture_file(path: Path) -> _ToolFixture:
    """Parse one authored fixture file, resolving `result_file` references.

    Paths are relative to the fixture file's own directory and must stay
    inside it — a spec is data, and data does not get to read /etc/passwd.
    """
    spec = json.loads(path.read_text())
    tool = spec.get("tool")
    if not tool:
        raise ValueError(f"{path}: fixture file has no 'tool'")
    base = path.parent.resolve()

    def _result_of(entry: dict, where: str) -> str:
        has_inline = "result" in entry
        has_file = "result_file" in entry
        if has_inline == has_file:
            raise ValueError(
                f"{path}: {where} needs exactly one of result / result_file")
        if has_inline:
            return str(entry["result"])
        target = (base / entry["result_file"]).resolve()
        if not target.is_relative_to(base):
            raise ValueError(f"{path}: {where} result_file escapes the fixture dir")
        return target.read_text()

    fx = _ToolFixture(tool=tool)
    for i, entry in enumerate(spec.get("entries") or []):
        fx.entries.append(_Entry(match=dict(entry.get("match") or {}),
                                 result=_result_of(entry, f"entries[{i}]")))
    if spec.get("default") is not None:
        fx.default = _result_of(spec["default"], "default")
    return fx


@dataclass
class Fixtures:
    """One task's canned world, plus the ledger of how it was used."""

    mode: str
    tools: dict[str, _ToolFixture] = field(default_factory=dict)
    replay_only: frozenset[str] = frozenset()
    replay_only_default: Optional[str] = None
    live_ok: frozenset[str] = LIVE_OK

    # observations — the harness reads these after a run
    calls: list[dict] = field(default_factory=list)
    misses: list[dict] = field(default_factory=list)
    violations: list[dict] = field(default_factory=list)

    @classmethod
    def for_replay(cls, paths: list[Path], *, replay_only: set[str] | None = None,
                   replay_only_default: str | None = None) -> "Fixtures":
        fx = cls(mode=MODE_REPLAY,
                 replay_only=frozenset(replay_only or ()),
                 replay_only_default=replay_only_default)
        for p in paths:
            loaded = load_fixture_file(Path(p))
            fx.tools[loaded.tool] = loaded
        return fx

    @classmethod
    def for_record(cls, *, replay_only: set[str] | None = None,
                   replay_only_default: str | None = None) -> "Fixtures":
        return cls(mode=MODE_RECORD,
                   replay_only=frozenset(replay_only or ()),
                   replay_only_default=replay_only_default)

    # ── the two hooks execute_tool calls ─────────────────────────────────

    def _serve(self, name: str, args: dict, result: str) -> str:
        # The result rides along even when it came from a fixture: a canned
        # result is often an `Error: ` string on purpose (already-ingested
        # honesty tasks, replay_only_default), and the tool_errors_max
        # contract check counts those.
        self.calls.append({"tool": name, "args": args, "served": True,
                           "result": result})
        return result

    def intercept(self, name: str, args: dict) -> Optional[str]:
        """A canned result, or None to execute the real tool."""
        never = name in NEVER_EXECUTE
        replay_only = name in self.replay_only
        fixtured = name in self.tools

        if self.mode == MODE_REPLAY:
            # allowlist: only the scratch-store tools may reach a real
            # implementation. Everything else is served or missed.
            may_execute = name in self.live_ok and not never
        else:
            # recording: the live world IS the source, except for tools whose
            # "read" costs real work or real rows, and the destructive set
            may_execute = not (never or replay_only)
        if may_execute:
            return None

        # Past this line the tool will NOT execute, in either mode.
        if fixtured:
            hit = self.tools[name].lookup(args)
            if hit is not None:
                return self._serve(name, args, hit)

        # The suite's catch-all, but only for tools it actually declared
        # replay-only. A destructive tool that merely leaked into the toolset
        # must not be quietly absorbed by it — that would hide the leak.
        if replay_only and self.replay_only_default is not None:
            return self._serve(name, args,
                               _substitute(self.replay_only_default, args))

        if never:
            # The suite forgot to exclude a destructive tool. The model gets a
            # refusal, never the side effect, and the run is marked invalid so
            # nobody reads a verdict off it.
            self.violations.append({"tool": name, "args": args})
            log.error("eval: refused %s — real side effects are never "
                      "reachable from a graded run", name)
            return (f"Error: '{name}' is not available during an eval run "
                    f"(real side effects).")

        # No match and no default. Never fall through to the live tool: the
        # run is already invalid, and executing would poison the comparison
        # (one contestant on frozen data, the other on the live internet).
        why = ("no fixture entry matches these args" if fixtured
               else "the task authors no fixture for this tool, and it is not "
                    "in the suite's replay_only_tools")
        self.misses.append({"tool": name, "args": args, "why": why})
        log.error("eval: unserved call %s(%s) — %s", name,
                  json.dumps(args, default=str)[:300], why)
        return (f"Error: this eval has no canned result for {name} ({why}). "
                f"The run is invalid — that is a suite gap, not a tool failure.")

    def observe(self, name: str, args: dict, result: str) -> None:
        """Capture a call that actually executed — in BOTH modes.

        Called from inside execute_tool, so it sees full args and the full
        result. Everything downstream is lossy: the ledger keeps 500 chars of
        result and 2000 of args (trace.py:44-45), activity events 200. That
        makes `calls` the only complete tool transcript, and contract checks
        need it — `write_content` grades the content ARGUMENT of a write, and
        a distilled topic runs past the span's arg cap.
        """
        self.calls.append({"tool": name, "args": args, "served": False,
                           "result": result})

    # ── record-mode output ───────────────────────────────────────────────

    def to_specs(self) -> dict[str, dict]:
        """Recorded calls as authorable fixture files, keyed by tool name.

        Deliberately emits full-arg `match` entries (the plan's sha256-of-args
        form, spelled as data). Exact-arg replay WILL miss for a different
        contestant, so a recording is a STARTING POINT a human widens into
        `match` predicates and a `default` — that fallback is the fairness
        mechanism, and no recorder can invent it.
        """
        out: dict[str, dict] = {}
        for call in self.calls:
            if call.get("served"):
                continue
            spec = out.setdefault(call["tool"], {
                "tool": call["tool"],
                "notes": ("RECORDED, not authored — widen these into `match` "
                          "predicates and add a `default` before using this "
                          "as a fixture; see tasks/README.md."),
                "entries": [],
            })
            spec["entries"].append({"match": call["args"],
                                    "result": call["result"]})
        return out


_active: contextvars.ContextVar[Optional[Fixtures]] = contextvars.ContextVar(
    "eval_fixtures", default=None)


def active() -> Optional[Fixtures]:
    return _active.get()


@contextlib.contextmanager
def using(fx: Optional[Fixtures]):
    """Bind a fixture set for this async context and everything it spawns."""
    token = _active.set(fx)
    try:
        yield fx
    finally:
        _active.reset(token)


def intercept(name: str, args: dict) -> Optional[str]:
    """Module-level convenience for the execute_tool call site."""
    fx = _active.get()
    return fx.intercept(name, args) if fx else None


def observe(name: str, args: dict, result: str) -> None:
    fx = _active.get()
    if fx is not None:
        fx.observe(name, args, result)
