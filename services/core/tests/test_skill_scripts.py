"""What a script IS, what makes one valid, and what running one does.

The validator is the interesting half. A script is saved by a person editing
JSON in a textarea, so every way of writing a wrong one has to come back as a
sentence naming what is wrong — and the ones that cannot be checked until the
values exist are checked again at run, by the same funnel every tool call goes
through.
"""

from __future__ import annotations

import pytest

from app import skill_scripts
from app.tools.base import ToolContext


def _script(*steps) -> dict:
    return {"version": 1, "steps": list(steps)}


def _inputs(**properties) -> dict:
    return {
        "type": "object",
        "properties": properties,
        "required": list(properties),
        "additionalProperties": False,
    }


STRINGS = {"type": "array", "items": {"type": "string"}}


# ── the validator ──────────────────────────────────────────────────────────


def test_a_straightforward_script_validates():
    skill_scripts.validate(
        _script(
            {"tool": "workspace_read_file", "args": {"path": "{{ note }}"}},
            {"tool": "workspace_delete", "args": {"path": "{{ note }}"}},
        ),
        _inputs(note={"type": "string"}),
    )


def test_a_step_naming_a_tool_that_does_not_exist_is_refused():
    with pytest.raises(skill_scripts.ScriptError) as exc:
        skill_scripts.validate(_script({"tool": "make_coffee", "args": {}}), _inputs())
    assert "make_coffee" in str(exc.value)


def test_a_script_that_runs_a_script_is_refused():
    """Not a loop anyone bounded, and the step cap would not see it: each
    nested run is a fresh expansion."""
    with pytest.raises(skill_scripts.ScriptError) as exc:
        skill_scripts.validate(
            _script({"tool": "run_skill", "args": {"name": "x"}}), _inputs()
        )
    assert "run_skill" in str(exc.value)


def test_a_placeholder_that_resolves_to_nothing_is_refused_at_save():
    with pytest.raises(skill_scripts.ScriptError) as exc:
        skill_scripts.validate(
            _script({"tool": "workspace_read_file", "args": {"path": "{{ typo }}"}}),
            _inputs(note={"type": "string"}),
        )
    assert "typo" in str(exc.value)


def test_an_argument_key_the_tool_does_not_have_is_refused_at_save():
    """The VALUES cannot be checked before they exist; the KEYS can, and a
    misspelled argument is the mistake a textarea invites."""
    with pytest.raises(skill_scripts.ScriptError) as exc:
        skill_scripts.validate(
            _script({"tool": "workspace_read_file", "args": {"paht": "x"}}), _inputs()
        )
    assert "paht" in str(exc.value)


def test_a_missing_required_argument_is_refused_at_save():
    with pytest.raises(skill_scripts.ScriptError) as exc:
        skill_scripts.validate(_script({"tool": "workspace_read_file", "args": {}}), _inputs())
    assert "path" in str(exc.value)


def test_for_each_must_name_a_declared_array_input():
    with pytest.raises(skill_scripts.ScriptError) as exc:
        skill_scripts.validate(
            _script(
                {
                    "tool": "workspace_delete",
                    "args": {"path": "{{ p }}"},
                    "for_each": "note",
                    "as": "p",
                }
            ),
            _inputs(note={"type": "string"}),
        )
    assert "array" in str(exc.value)


def test_a_loop_variable_may_not_shadow_an_input():
    with pytest.raises(skill_scripts.ScriptError) as exc:
        skill_scripts.validate(
            _script(
                {
                    "tool": "workspace_delete",
                    "args": {"path": "{{ note }}"},
                    "for_each": "notes",
                    "as": "note",
                }
            ),
            _inputs(note={"type": "string"}, notes=STRINGS),
        )
    assert "note" in str(exc.value)


def test_a_loop_variable_is_a_name_the_step_may_use():
    skill_scripts.validate(
        _script(
            {
                "tool": "workspace_delete",
                "args": {"path": "{{ p }}"},
                "for_each": "notes",
                "as": "p",
            }
        ),
        _inputs(notes=STRINGS),
    )


def test_a_placeholder_from_another_steps_loop_does_not_leak():
    """A loop variable belongs to its own step. Letting it reach the next one
    would make a script that reads fine and breaks on the second run."""
    with pytest.raises(skill_scripts.ScriptError) as exc:
        skill_scripts.validate(
            _script(
                {
                    "tool": "workspace_read_file",
                    "args": {"path": "{{ p }}"},
                    "for_each": "notes",
                    "as": "p",
                },
                {"tool": "workspace_delete", "args": {"path": "{{ p }}"}},
            ),
            _inputs(notes=STRINGS),
        )
    assert "p" in str(exc.value)


# ── templating ─────────────────────────────────────────────────────────────


def test_a_whole_placeholder_keeps_the_value_s_type():
    rendered = skill_scripts.render({"n": "{{ count }}"}, {"count": 3})
    assert rendered == {"n": 3}


def test_a_placeholder_inside_a_string_substitutes_its_text():
    rendered = skill_scripts.render({"path": "notes/{{ name }}.md"}, {"name": "kv"})
    assert rendered == {"path": "notes/kv.md"}


# ── expansion ──────────────────────────────────────────────────────────────


def test_a_repeat_step_becomes_one_call_per_item():
    expanded = skill_scripts.expand(
        _script(
            {
                "tool": "workspace_delete",
                "args": {"path": "{{ p }}"},
                "for_each": "notes",
                "as": "p",
            }
        ),
        {"notes": ["a.md", "b.md"]},
    )
    assert [(e.tool, e.args) for e in expanded] == [
        ("workspace_delete", {"path": "a.md"}),
        ("workspace_delete", {"path": "b.md"}),
    ]
    assert [e.item for e in expanded] == ["a.md", "b.md"]


def test_an_expansion_over_the_cap_is_refused_before_anything_runs():
    with pytest.raises(skill_scripts.ScriptError) as exc:
        skill_scripts.expand(
            _script(
                {
                    "tool": "workspace_delete",
                    "args": {"path": "{{ p }}"},
                    "for_each": "notes",
                    "as": "p",
                }
            ),
            {"notes": [f"{i}.md" for i in range(skill_scripts.MAX_STEPS + 1)]},
        )
    assert str(skill_scripts.MAX_STEPS) in str(exc.value)


# ── running ────────────────────────────────────────────────────────────────


def _ctx(tmp_path) -> ToolContext:
    root = tmp_path / "workspace"
    root.mkdir()
    return ToolContext(app=None, person=None, workspace_root=root)


async def test_a_run_reports_every_step_and_dispatches_through_the_registry(tmp_path):
    ctx = _ctx(tmp_path)
    (ctx.workspace_root / "a.md").write_text("hello", encoding="utf-8")

    text, ok = await skill_scripts.run(
        _script({"tool": "workspace_read_file", "args": {"path": "{{ note }}"}}),
        {"note": "a.md"},
        _inputs(note={"type": "string"}),
        ctx=ctx,
    )

    assert ok
    assert "workspace_read_file" in text
    assert "hello" in text


async def test_a_failed_step_stops_the_run_and_says_which_one(tmp_path):
    ctx = _ctx(tmp_path)
    (ctx.workspace_root / "a.md").write_text("hello", encoding="utf-8")

    text, ok = await skill_scripts.run(
        _script(
            {"tool": "workspace_read_file", "args": {"path": "gone.md"}},
            {"tool": "workspace_delete", "args": {"path": "a.md"}},
        ),
        {},
        _inputs(),
        ctx=ctx,
    )

    assert not ok
    assert "step 1" in text
    assert "1 later step was not attempted" in text
    # And the step after it really did not run.
    assert (ctx.workspace_root / "a.md").is_file()


async def test_her_inputs_are_validated_before_any_step_runs(tmp_path):
    ctx = _ctx(tmp_path)
    (ctx.workspace_root / "a.md").write_text("hello", encoding="utf-8")

    text, ok = await skill_scripts.run(
        _script({"tool": "workspace_delete", "args": {"path": "{{ note }}"}}),
        {"wrong": "a.md"},
        _inputs(note={"type": "string"}),
        ctx=ctx,
    )

    assert not ok
    assert "note" in text
    assert (ctx.workspace_root / "a.md").is_file()


async def test_each_step_is_spanned_through_the_seam_when_the_turn_binds_one(tmp_path):
    """The property the whole slice rests on: a step is a span under the REAL
    tool's name, so the ledger, the guards and Activity keep working without
    being told scripts exist."""
    ctx = _ctx(tmp_path)
    (ctx.workspace_root / "a.md").write_text("hello", encoding="utf-8")
    seen: list[tuple[str, dict]] = []

    async def step(tool: str, args: dict, *, index: int, item):
        seen.append((tool, args))
        from app import tools

        return await tools.dispatch(tool, args, ctx)

    text, ok = await skill_scripts.run(
        _script(
            {
                "tool": "workspace_read_file",
                "args": {"path": "{{ p }}"},
                "for_each": "notes",
                "as": "p",
            }
        ),
        {"notes": ["a.md"]},
        _inputs(notes=STRINGS),
        ctx=ctx,
        step=step,
    )

    assert ok
    assert seen == [("workspace_read_file", {"path": "a.md"})]


async def test_a_run_with_no_seam_says_its_steps_are_not_on_the_trace(tmp_path):
    """An eval replay or a test runs outside a turn. The steps still run; the
    result says they left no spans rather than letting a reader assume they
    did."""
    ctx = _ctx(tmp_path)
    (ctx.workspace_root / "a.md").write_text("hello", encoding="utf-8")

    text, _ = await skill_scripts.run(
        _script({"tool": "workspace_read_file", "args": {"path": "a.md"}}),
        {},
        _inputs(),
        ctx=ctx,
    )
    assert "not recorded on the trace" in text


# ── deriving a draft from the trace ────────────────────────────────────────


def test_an_argument_that_differed_between_walks_becomes_an_input():
    draft = skill_scripts.derive(
        [
            [("workspace_write_file", {"path": "walk-1.md", "content": "one"})],
            [("workspace_write_file", {"path": "walk-2.md", "content": "two"})],
        ]
    )
    step = draft["script"]["steps"][0]
    assert step["args"] == {"path": "{{ path }}", "content": "{{ content }}"}
    assert set(draft["inputs"]["properties"]) == {"path", "content"}
    assert draft["inputs"]["properties"]["path"]["type"] == "string"


def test_an_argument_that_was_the_same_every_time_becomes_a_constant():
    draft = skill_scripts.derive(
        [
            [("workspace_read_file", {"path": "notes.md"})],
            [("workspace_read_file", {"path": "notes.md"})],
        ]
    )
    assert draft["script"]["steps"][0]["args"] == {"path": "notes.md"}
    assert draft["inputs"]["properties"] == {}


def test_a_run_of_the_same_call_becomes_a_repeat_over_a_list():
    """A run IS the same call over a list. Writing it out as three steps would
    freeze the count of one afternoon into the procedure."""
    draft = skill_scripts.derive(
        [
            [
                ("workspace_delete", {"path": "a.md"}),
                ("workspace_delete", {"path": "b.md"}),
                ("workspace_delete", {"path": "c.md"}),
            ]
        ]
    )
    (step,) = draft["script"]["steps"]
    assert step["for_each"] == "paths"
    assert step["as"] == "path"
    assert step["args"] == {"path": "{{ path }}"}
    assert draft["inputs"]["properties"]["paths"] == {
        "type": "array",
        "items": {"type": "string"},
    }


def test_one_walk_cannot_tell_a_constant_from_a_variable_and_says_so():
    draft = skill_scripts.derive([[("workspace_read_file", {"path": "notes.md"})]])
    assert "one" in draft["note"].lower()
    assert draft["script"]["steps"][0]["args"] == {"path": "notes.md"}


def test_walks_that_did_different_things_use_the_newest_and_say_which():
    draft = skill_scripts.derive(
        [
            [("workspace_read_file", {"path": "a.md"})],
            [("workspace_list_files", {}), ("workspace_read_file", {"path": "a.md"})],
        ]
    )
    assert [s["tool"] for s in draft["script"]["steps"]] == [
        "workspace_list_files",
        "workspace_read_file",
    ]
    assert "differ" in draft["note"].lower()


def test_a_derived_draft_is_valid_by_construction():
    """Whatever comes out of here must survive the validator, or the page would
    offer a starting point that cannot be saved."""
    draft = skill_scripts.derive(
        [
            [
                ("workspace_list_files", {}),
                ("workspace_read_file", {"path": "a.md"}),
                ("workspace_read_file", {"path": "b.md"}),
            ],
            [
                ("workspace_list_files", {}),
                ("workspace_read_file", {"path": "c.md"}),
                ("workspace_read_file", {"path": "d.md"}),
            ],
        ]
    )
    skill_scripts.validate(draft["script"], draft["inputs"])


def test_no_walks_is_refused_rather_than_answered_with_an_empty_script():
    with pytest.raises(skill_scripts.ScriptError):
        skill_scripts.derive([])
