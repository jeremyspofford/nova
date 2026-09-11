"""No approvals: the line of code that refuses the day someone rebuilds a gate.

Owner ruling 2026-09-03: v4 makes NO authorization decisions. Nothing asks the
owner, nothing refuses on his behalf, every registered tool runs. This suite is
the reverse of the old D-012 pin ("only policy constructs an ALLOW"): it pins
that there is no policy at all, and it is written so the shapes a gate would
take — a table dispatch consults, a module that decides, an await between the
schema check and the executor, a "waiting on you" result — each redden a test
here rather than land quietly.
"""

from __future__ import annotations

import ast
import uuid
from pathlib import Path

import pytest

from app import tools
from app.identity import Person
from app.tools.base import Tool, ToolContext
from tests.conftest import requires_db

APP_DIR = Path(tools.__file__).resolve().parent.parent
TOOLS_INIT = Path(tools.__file__).resolve()
CHAT_PY = APP_DIR / "chat.py"

# The modules the approval system lived in. A file by any of these names under
# app/ is the gate coming back under its old name.
GATE_MODULES = {"policy", "consents", "consents_api", "autonomy", "autonomy_api"}

# The tool result that told the model to stop and wait for the operator.
AWAITING = "Awaiting your approval"

SCHEMA = {"type": "object", "properties": {}, "additionalProperties": False}


def _person() -> Person:
    return Person(id=uuid.uuid4(), name="jeremy", role="owner")


# -- (a) a registered tool runs: no database, no seed, no grant ---------------


async def test_a_registered_tool_runs_through_dispatch_with_no_database(monkeypatch, tmp_path):
    """No DATABASE_URL at all: if dispatch reached for a table — a disposition,
    a grant, a consent — db.get_pool() would raise and the call would come back
    as an Error. It comes back as the executor's own words."""
    monkeypatch.setenv("DATABASE_URL", "")
    calls: list[dict] = []

    async def spy(args: dict, ctx: ToolContext) -> str:
        calls.append(args)
        return "ran"

    monkeypatch.setitem(
        tools.REGISTRY,
        "spy_tool",
        Tool(name="spy_tool", description="d", parameters=SCHEMA, executor=spy),
    )
    monkeypatch.setenv("WORKSPACE_ROOT", str(tmp_path))
    ctx = tools.context_for(None, _person())

    result, ok = await tools.dispatch("spy_tool", "{}", ctx)
    assert (result, ok) == ("ran", True)
    assert calls == [{}]


def test_context_for_states_a_missing_person_as_a_bug(monkeypatch, tmp_path):
    """Not a permission check: a turn without an identity is a caller bug (every
    route resolves a person before a turn starts), and it is said at the call
    site instead of being quietly allowed or quietly refused downstream."""
    monkeypatch.setenv("WORKSPACE_ROOT", str(tmp_path))
    with pytest.raises(ValueError, match="person"):
        tools.context_for(None, None)
    ctx = tools.context_for(None, _person(), facts_sink=[])
    assert ctx.facts_sink == []
    # The context carries no principal a permission could bind to.
    # `progress` (S10a-3) is an OUTPUT channel a long call reports through —
    # a pull's percentage into an activity frame. Like facts_sink it is not a
    # principal a permission could bind to; nothing reads it to decide.
    assert set(ctx.__dataclass_fields__) == {
        "app",
        "person",
        "workspace_root",
        "facts_sink",
        "progress",
    }


def test_tool_carries_no_precheck_or_gate_field():
    """The deleted approval shape hung a SYNCHRONOUS `Tool.precheck` off the
    dataclass and called it in dispatch between schema.validate and the
    executor — a shape the single-await pin below cannot see, because a sync
    call adds no await. Pin the fields EXACTLY (mirroring the ToolContext pin
    above): a precheck/gate/consent field re-added to Tool reddens here before
    any gate can be wired to it."""
    # 2026-09-10 (S14): `reads_only` joins the set, deliberately. It is a fact
    # about the executor — does running this CHANGE anything — and it is NOT a
    # permission: nothing reads it to refuse her, every tool stays hers to
    # call, and the test below asserts dispatch never looks at it. It exists
    # for a question v4 has never had to ask, which is what the BACKEND may
    # run when nobody asked it to: a distilled note carries the call that
    # answers it NOW, and something that changes the world must never run
    # unasked. If this set ever gains a field dispatch consults, that field is
    # a gate whatever it is called.
    assert set(Tool.__dataclass_fields__) == {
        "name",
        "description",
        "parameters",
        "executor",
        "ephemeral",
        "result_kind",
        "reads_only",
    }


def test_dispatch_never_reads_reads_only():
    """The line that keeps a property from becoming a gate.

    `reads_only` says whether an executor changes anything. The moment
    dispatch consults it to decide whether to run something, it stops being a
    description and becomes permission — the exact shape the field-set pin
    above exists to refuse. So: it may be read by the code that decides what
    the backend runs UNASKED, and by nothing on the path of a call she made.
    """
    tree = ast.parse(TOOLS_INIT.read_text(encoding="utf-8"))
    names = [node.attr for node in ast.walk(_dispatch_def(tree)) if isinstance(node, ast.Attribute)]
    assert "reads_only" not in names, (
        "dispatch reads Tool.reads_only — a property dispatch consults to decide "
        "is a gate, whatever it is named"
    )


# -- (b) dispatch's shape: lookup, parse, validate, executor — nothing else ----


def _dispatch_def(tree: ast.Module) -> ast.AsyncFunctionDef:
    for node in tree.body:
        if isinstance(node, ast.AsyncFunctionDef) and node.name == "dispatch":
            return node
    raise AssertionError("app/tools/__init__.py no longer defines async dispatch")


def test_the_only_await_in_dispatch_is_the_executor():
    """A gate is an await between the schema check and the executor — a kernel,
    a precheck, a burn, a ledger write. There is exactly one await, and it is
    the tool's own executor."""
    tree = ast.parse(TOOLS_INIT.read_text(encoding="utf-8"))
    awaits = [n for n in ast.walk(_dispatch_def(tree)) if isinstance(n, ast.Await)]
    assert len(awaits) == 1, f"dispatch awaits {len(awaits)} things; it may await only the executor"
    call = awaits[0].value
    assert isinstance(call, ast.Call)
    assert isinstance(call.func, ast.Attribute)
    assert isinstance(call.func.value, ast.Name)
    assert (call.func.value.id, call.func.attr) == ("tool", "executor")


# -- (b') the chat entry path: where the model's call actually arrives ---------
#
# dispatch is where a tool runs, but the model's call arrives one layer up, in
# chat. A gate wired between "the call arrived" and "dispatch ran it" — a
# precheck, a consent burn, a disposition read — would be an extra await on this
# path, so pinning each function to its SINGLE await catches a gate inserted
# here the same way (b) catches one inserted inside dispatch.


def _async_def(tree: ast.Module, name: str) -> ast.AsyncFunctionDef:
    for node in ast.walk(tree):
        if isinstance(node, ast.AsyncFunctionDef) and node.name == name:
            return node
    raise AssertionError(f"app/chat.py no longer defines async {name}")


def _await_targets(fn: ast.AsyncFunctionDef) -> list[str]:
    """The dotted name each await in `fn` calls, in source order —
    'tools.dispatch', '_run_tool'. A gate inserted on this path is a new await
    (a burn, a kernel, a disposition read) and so changes this list."""
    targets: list[str] = []
    for node in ast.walk(fn):
        if not isinstance(node, ast.Await):
            continue
        call = node.value
        assert isinstance(call, ast.Call), f"await of a non-call in {fn.name}"
        func = call.func
        if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name):
            targets.append(f"{func.value.id}.{func.attr}")
        elif isinstance(func, ast.Name):
            targets.append(func.id)
        else:  # a subscript/attribute chain — dump it so a gate can't hide here
            targets.append(ast.dump(func))
    return targets


def test_run_tool_awaits_only_dispatch():
    """The model's call arrives at chat._run_tool. Its ONLY await is
    tools.dispatch — a gate wired in front of the executor here (a precheck, a
    consent burn, a disposition read) would be a second await and reddens."""
    tree = ast.parse(CHAT_PY.read_text(encoding="utf-8"))
    assert _await_targets(_async_def(tree, "_run_tool")) == ["tools.dispatch"]


def test_dispatch_calls_awaits_only_run_tool():
    """chat._dispatch_calls runs a round's calls; its ONLY await is _run_tool.
    A gate awaited here — before, instead of, or after running the call —
    reddens, so no round can acquire a second, weaker path to a decision."""
    tree = ast.parse(CHAT_PY.read_text(encoding="utf-8"))
    assert _await_targets(_async_def(tree, "_dispatch_calls")) == ["_run_tool"]


def test_the_tools_package_imports_nothing_that_could_decide():
    """Every import in app/tools/__init__.py is top-level and, when it names
    this app, stays inside app.tools — no app.db, no app.governance, no module
    that reads a table. The old gate arrived as a function-local
    `from app import policy`; a local import anywhere in the module is that
    shape and fails here regardless of its name."""
    tree = ast.parse(TOOLS_INIT.read_text(encoding="utf-8"))
    top_level = {id(n) for n in tree.body}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            assert id(node) in top_level, f"local import at line {node.lineno}"
            for alias in node.names:
                # This app's package only — not a third-party module that merely
                # starts with "app" (e.g. appdirs).
                assert not (alias.name == "app" or alias.name.startswith("app.")), alias.name
        elif isinstance(node, ast.ImportFrom):
            assert id(node) in top_level, f"local import at line {node.lineno}"
            module = node.module or ""
            if module == "app" or module.startswith("app."):
                assert module == "app.tools" or module.startswith("app.tools."), (
                    f"app/tools/__init__.py imports {module} — dispatch must not reach "
                    "outside its own package"
                )


# -- (c) the gate's modules and vocabulary are gone from app/ -----------------


def test_no_module_under_app_is_a_gate_module():
    present = {p.stem for p in APP_DIR.rglob("*.py")} & GATE_MODULES
    assert present == set(), f"gate modules back under app/: {sorted(present)}"


def test_nothing_under_app_tells_the_model_to_wait_for_approval():
    offenders = [
        str(p.relative_to(APP_DIR))
        for p in sorted(APP_DIR.rglob("*.py"))
        if AWAITING in p.read_text(encoding="utf-8")
    ]
    assert offenders == [], f"{AWAITING!r} appears in: {offenders}"


# -- (d) the schema carries no approval state ----------------------------------


@requires_db
async def test_the_schema_carries_no_approval_state(pool):
    """Migration 017 dropped the tables and columns a gate would read. A later
    migration recreating any of them is a gate being rebuilt as data."""
    tables = {
        r["table_name"]
        for r in await pool.fetch(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
        )
    }
    assert not ({"consents", "action_classes"} & tables), tables

    async def columns(table: str) -> set[str]:
        rows = await pool.fetch(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_schema = 'public' AND table_name = $1",
            table,
        )
        return {r["column_name"] for r in rows}

    assert not ({"capabilities", "fs_roots", "home_dir"} & await columns("devices"))
    assert "kind" not in await columns("messages")
    assert "action_class" not in await columns("governance_events")
    assert await pool.fetchval(
        "SELECT count(*) FROM settings WHERE key = 'autonomy.graduation_runs'"
    ) == 0
