"""Loader for the authored eval suites under `tasks/`.

The format contract is `tasks/README.md` — written by the suite-authoring
lane, and the authority here. This module only reads it; it never invents
defaults the README does not describe, because a silently-supplied default
would change what a suite measures without bumping its `suite_version`.

Every path inside a spec is relative to its suite directory and must stay
inside it.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Optional

log = logging.getLogger(__name__)

TASKS_ROOT = Path(__file__).parent / "tasks"


def _inside(base: Path, rel: str, what: str) -> Path:
    target = (base / rel).resolve()
    if not target.is_relative_to(base.resolve()):
        raise ValueError(f"{what} '{rel}' escapes its suite directory")
    if not target.exists():
        raise FileNotFoundError(f"{what} '{rel}' does not exist ({target})")
    return target


@dataclass
class Suite:
    name: str
    version: int
    agent: str
    execution_class: str
    directory: Path
    task_ids: list[str]
    max_tool_rounds: Optional[int]
    budget_seconds: Optional[float]
    exclude_tools: list[str]
    replay_only_tools: list[str]
    replay_only_default: Optional[str]
    description: str = ""
    notes: str = ""


@dataclass
class Task:
    id: str
    suite: Suite
    title: str
    intent: str
    prompt: str
    budget_seconds: float
    seed_corpus: list[Path] = field(default_factory=list)
    fixtures: list[Path] = field(default_factory=list)
    contract: dict = field(default_factory=dict)
    judge: dict = field(default_factory=dict)

    @property
    def ref(self) -> str:
        return f"{self.suite.name}/{self.id}"


def dynamic_tools(granted: "Iterable[str]") -> set[str]:
    """Granted tools a suite FILE could never have anticipated.

    A suite is authored once and its fixtures with it. MCP tools arrive
    afterwards — the operator approves a recommendation, a server registers,
    and its tools land in an agent's grants the same minute. No `fixtures/`
    entry can exist for them, and the harness cannot execute them in replay,
    so they are replay-only by construction rather than by somebody
    remembering to list them.

    `find_mcp_tools` is here for the same reason at one remove: the registry
    offers it only when the agent has a lazily-granted MCP server, so it
    appears and disappears with them.

    THIS EXISTS BECAUSE THE ALTERNATIVE WAS A HUMAN. Approving one MCP
    recommendation on 2026-08-04 reddened two guards — the grant snapshot no
    longer matched live grants, and three tools were granted with no way to
    answer them — and both were cleared by hand-editing granted.json and
    suite.json. That is a maintenance debt the approve-a-recommendation loop
    creates every time it succeeds and cannot discharge itself. Derived here,
    it never accrues.
    """
    out = set()
    for name in granted or ():
        if name.startswith("mcp:") or name.startswith("mcp__"):
            out.add(name)
        elif name == "find_mcp_tools":
            out.add(name)
    return out


def list_suites(root: Path = TASKS_ROOT) -> list[str]:
    if not root.exists():
        return []
    return sorted(p.name for p in root.iterdir() if (p / "suite.json").is_file())


def load_suite(name: str, root: Path = TASKS_ROOT) -> Suite:
    directory = (root / name).resolve()
    spec_path = directory / "suite.json"
    if not spec_path.is_file():
        raise FileNotFoundError(
            f"no eval suite '{name}' — have: {', '.join(list_suites(root)) or '(none)'}")
    spec = json.loads(spec_path.read_text())
    run = spec.get("run") or {}
    return Suite(
        name=spec.get("suite", name),
        version=int(spec.get("suite_version", 1)),
        agent=spec["agent"],
        execution_class=spec.get("execution_class", "live-tool"),
        directory=directory,
        task_ids=list(spec.get("tasks") or []),
        max_tool_rounds=run.get("max_tool_rounds"),
        budget_seconds=run.get("budget_seconds"),
        exclude_tools=list(run.get("exclude_tools") or []),
        replay_only_tools=list(run.get("replay_only_tools") or []),
        replay_only_default=run.get("replay_only_default"),
        description=spec.get("description", ""),
        notes=spec.get("notes", ""),
    )


def load_task(suite: Suite, task_id: str) -> Task:
    path = suite.directory / "tasks" / f"{task_id}.json"
    if not path.is_file():
        raise FileNotFoundError(
            f"no task '{task_id}' in suite '{suite.name}' — have: "
            f"{', '.join(suite.task_ids)}")
    spec = json.loads(path.read_text())

    has_inline = "prompt" in spec
    has_file = "prompt_file" in spec
    if has_inline == has_file:
        raise ValueError(f"{path}: needs exactly one of prompt / prompt_file")
    prompt = (spec["prompt"] if has_inline
              else _inside(suite.directory, spec["prompt_file"], "prompt_file").read_text())

    return Task(
        id=spec.get("id", task_id),
        suite=suite,
        title=spec.get("title", task_id),
        intent=spec.get("intent", ""),
        prompt=prompt,
        # per-task budget wins over the suite's; the suite's is the fallback,
        # and 300s matches automations.run_timeout_seconds' default
        budget_seconds=float(spec.get("budget_seconds")
                             or suite.budget_seconds or 300),
        seed_corpus=[_inside(suite.directory, p, "seed_corpus")
                     for p in (spec.get("seed_corpus") or [])],
        fixtures=[_inside(suite.directory, p, "fixtures")
                  for p in (spec.get("fixtures") or [])],
        contract=spec.get("contract") or {},
        judge=spec.get("judge") or {},
    )


def load_tasks(suite: Suite, only: Optional[list[str]] = None) -> list[Task]:
    ids = only if only else suite.task_ids
    return [load_task(suite, tid) for tid in ids]


def resolve(ref: str, root: Path = TASKS_ROOT) -> list[Task]:
    """`ingestion` -> the whole suite; `ingestion/tag-hygiene` -> one task."""
    suite_name, _, task_id = ref.partition("/")
    suite = load_suite(suite_name, root)
    return load_tasks(suite, [task_id] if task_id else None)
