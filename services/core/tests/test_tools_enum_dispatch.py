"""Every `enum` a registered tool declares is enforced by dispatch's schema
check, before the executor runs.

Derived from the live registry, never a hand list: a tool that adds an enum
is covered the day it registers. For each enum site (a property's own `enum`,
or an array property's `items.enum`) the call is built valid — every required
argument filled from its schema — then that one value is moved outside the
enum. Dispatch must answer with its stated Error: refusal and the executor
must never be reached. A control asserts the same call with an in-enum value
passes the schema check, so the refusal is the enum's and nothing else's.

A schema refusal states that a call cannot run as written; it decides nothing
about whether it may (test_no_approvals pins that no such decision exists).
"""

from __future__ import annotations

import dataclasses
import uuid

import pytest

from app import tools
from app.identity import Person
from app.tools import schema
from app.tools.base import ERROR_PREFIX, ToolContext

OUTSIDE = "__outside_the_enum__"


def _valid(spec: dict):
    if spec.get("enum"):
        return spec["enum"][0]
    kind = spec.get("type")
    if kind == "integer":
        return spec.get("minimum", 1)
    if kind == "number":
        return spec.get("minimum", 1)
    if kind == "boolean":
        return True
    if kind == "array":
        items = spec.get("items") if isinstance(spec.get("items"), dict) else {}
        return [_valid(items)] * max(spec.get("minItems", 1), 1)
    if kind == "object":
        return {}
    return "x"


def _enum_sites() -> list[tuple[str, str, bool]]:
    """(tool, property, is_items) for every enum the registry declares."""
    sites = []
    for name, tool in sorted(tools.REGISTRY.items()):
        for prop, spec in (tool.parameters.get("properties") or {}).items():
            if spec.get("enum"):
                sites.append((name, prop, False))
            items = spec.get("items")
            if isinstance(items, dict) and items.get("enum"):
                sites.append((name, prop, True))
    return sites


SITES = _enum_sites()


def test_the_registry_declares_enums_to_check():
    # Silence is not coverage: an empty parametrization below would pass.
    assert len(SITES) >= 10


@pytest.mark.parametrize(
    ("name", "prop", "is_items"), SITES, ids=[f"{n}.{p}{'[]' if i else ''}" for n, p, i in SITES]
)
async def test_an_out_of_enum_value_is_refused_before_the_executor(
    monkeypatch, tmp_path, name, prop, is_items
):
    tool = tools.REGISTRY[name]
    properties = tool.parameters["properties"]
    args = {req: _valid(properties[req]) for req in tool.parameters.get("required") or []}
    args[prop] = _valid(properties[prop])
    assert schema.validate(tool.parameters, args) is None, "control: the valid call must pass"

    spec = properties[prop]
    enum = spec["items"]["enum"] if is_items else spec["enum"]
    assert OUTSIDE not in enum
    args[prop] = [OUTSIDE] if is_items else OUTSIDE

    calls: list[dict] = []

    async def spy(a: dict, ctx: ToolContext) -> str:
        calls.append(a)
        return "ran"

    monkeypatch.setitem(tools.REGISTRY, name, dataclasses.replace(tool, executor=spy))
    monkeypatch.setenv("WORKSPACE_ROOT", str(tmp_path))
    ctx = tools.context_for(None, Person(id=uuid.uuid4(), name="jeremy", role="owner"))

    result, ok = await tools.dispatch(name, args, ctx)
    assert ok is False
    assert result.startswith(ERROR_PREFIX)
    assert OUTSIDE in result
    assert calls == []
