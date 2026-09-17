"""A skill that RUNS: the step program, its validator, and what running it does.

An S17 skill is procedure text — she reads it and then makes every call
herself, one model round per step, each carrying the whole context. A SCRIPT
is that procedure as a list of steps the backend dispatches, so the model
chooses the skill and fills its inputs and then leaves the middle of the loop.

WHY THE STEPS ARE TOOL CALLS AND NOT A SHELL SCRIPT. Every honesty control in
v4 reads `turn_spans`: the narration guard backs a claim with a span, the
capability verifier reads the live tool list, the S17 ledger counts a turn's
failed calls. A shell script produces ONE span holding stdout and the per-step
record is gone. Here each step goes through `tools.dispatch` — the same
registry funnel, the same schema validation, the same stated refusals — and
through the turn's `step` seam, which files a span under the REAL tool's name.
Every existing reader keeps working without being told scripts exist.

WHAT A SCRIPT MAY SAY, and why it is so little. Steps run in order, and a step
may repeat over a list the caller supplied. There is no branching, because
`tools.dispatch` answers with PROSE (`tuple[str, bool]`) and a condition over
prose is exactly the guesswork this slice removes. A script that needs to
decide something is a script that should stop and let her decide.

WHERE THE VALUES COME FROM. `{{ name }}` resolves from the run's inputs or the
enclosing step's loop variable, and nothing else: no expressions, no indexing,
no filters. A string that IS a placeholder keeps the value's type; one that
merely contains a placeholder substitutes its text.

VALIDATED TWICE, ON PURPOSE. At save, so a person editing JSON is told what is
wrong where they are looking, and because the argument KEYS can be checked
against the tool's own schema long before any value exists. At run, because the
registry is live and a tool can leave between the two.
"""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import Any

from app import tools
from app.tools import schema as tool_schema
from app.tools.base import ToolContext

# The whole expansion of one run. A script that repeats over a list the caller
# chose is a script whose length the caller chooses, so the bound is checked
# BEFORE anything runs: a runaway that is refused is better than one that is
# noticed forty calls in.
MAX_STEPS = 50

# The tool a script may never name (see validate). Spelled as the constant the
# tool module exports so a rename moves this rule with it.
SCRIPT_TOOL = "run_skill"

_PLACEHOLDER = re.compile(r"\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}")
_WHOLE = re.compile(r"^\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}$")


class ScriptError(ValueError):
    """A script that does not describe a runnable procedure, refused by name."""


@dataclass(frozen=True)
class Step:
    """One dispatch the run will make: which tool, with which arguments, and
    the loop item it came from when it came from one."""

    index: int
    tool: str
    args: dict
    item: Any = None


# The seam the turn binds: run one tool call and file its span. Returns what
# dispatch returns. None outside a turn (see run).
StepRunner = Callable[..., Awaitable[tuple[str, bool]]]


def _names_in(value: Any) -> set[str]:
    if isinstance(value, str):
        return set(_PLACEHOLDER.findall(value))
    if isinstance(value, dict):
        return set().union(*(_names_in(v) for v in value.values())) if value else set()
    if isinstance(value, list):
        return set().union(*(_names_in(v) for v in value)) if value else set()
    return set()


def render(value: Any, bindings: dict) -> Any:
    """Substitute `{{ name }}` from `bindings`, recursively.

    A string that IS a placeholder becomes the value with its type intact — a
    number stays a number, a list stays a list — because a tool's schema
    checks types and "3" is not 3. A placeholder inside a longer string
    substitutes its text, which is how a path gets built.
    """
    if isinstance(value, str):
        whole = _WHOLE.match(value)
        if whole:
            return _bound(whole.group(1), bindings)
        return _PLACEHOLDER.sub(lambda m: str(_bound(m.group(1), bindings)), value)
    if isinstance(value, dict):
        return {key: render(item, bindings) for key, item in value.items()}
    if isinstance(value, list):
        return [render(item, bindings) for item in value]
    return value


def _bound(name: str, bindings: dict):
    """The value for a name, or a stated refusal.

    validate() proves every name RESOLVES to something declared; it cannot
    prove the caller supplied it, because a declared input may be optional and
    a schema that allows its absence is a schema the caller satisfies without
    it. So the miss lands here, as a sentence, rather than as a KeyError out of
    a template — the shape that would have been a 500 instead of a refusal she
    could act on.
    """
    if name not in bindings:
        raise ScriptError(
            f"the script needs {name!r} and it was not given — supplied: "
            f"{', '.join(sorted(bindings)) or 'nothing'}"
        )
    return bindings[name]


def _steps_of(script: object) -> list[dict]:
    if not isinstance(script, dict):
        raise ScriptError(f"a script must be a JSON object, got {type(script).__name__}")
    steps = script.get("steps")
    if not isinstance(steps, list) or not steps:
        raise ScriptError("a script needs a non-empty 'steps' list")
    for step in steps:
        if not isinstance(step, dict):
            raise ScriptError(f"a step must be a JSON object, got {type(step).__name__}")
    return steps


def validate(script: object, inputs_schema: object) -> None:
    """Refuse a script that cannot run, naming what is wrong. Silent when it can.

    Everything here is checkable without a single value: which tools exist,
    which names resolve, which argument keys the tool actually has. The values
    are checked at run by `tools.schema.validate`, the same call every tool
    goes through — this function deliberately does not reimplement it.
    """
    if not isinstance(inputs_schema, dict) or not isinstance(inputs_schema.get("properties"), dict):
        raise ScriptError(
            "the inputs schema must be a JSON object with a 'properties' object — "
            "a script that takes nothing declares empty properties, which is not "
            "the same as declaring nothing"
        )
    declared: dict = inputs_schema["properties"]

    for position, step in enumerate(_steps_of(script), start=1):
        name = step.get("tool")
        if not isinstance(name, str) or not name:
            raise ScriptError(f"step {position} names no tool")
        if name == SCRIPT_TOOL:
            raise ScriptError(
                f"step {position} calls {SCRIPT_TOOL} — a script that runs a script is a "
                "loop nobody bounded, and the step cap cannot see it"
            )
        tool = tools.REGISTRY.get(name)
        if tool is None:
            raise ScriptError(
                f"step {position} names {name!r}, which is not a tool that exists — "
                f"the tools are: {', '.join(tools.tool_names())}"
            )
        args = step.get("args", {})
        if not isinstance(args, dict):
            raise ScriptError(f"step {position}'s args must be a JSON object")

        bindable = set(declared)
        loop = step.get("for_each")
        if loop is not None:
            if loop not in declared:
                raise ScriptError(
                    f"step {position} repeats over {loop!r}, which is not a declared input — "
                    f"the inputs are: {', '.join(declared) or 'none'}"
                )
            if declared[loop].get("type") != "array":
                raise ScriptError(
                    f"step {position} repeats over {loop!r}, which is declared "
                    f"{declared[loop].get('type', 'untyped')!r} and not an array"
                )
            variable = step.get("as")
            if not isinstance(variable, str) or not variable:
                raise ScriptError(f"step {position} repeats but does not name the item ('as')")
            if variable in declared:
                raise ScriptError(
                    f"step {position} names its item {variable!r}, which is already an input — "
                    "one name must mean one thing inside a step"
                )
            bindable.add(variable)
        elif step.get("as") is not None:
            raise ScriptError(f"step {position} names an item ('as') but repeats over nothing")

        unknown = sorted(_names_in(args) - bindable)
        if unknown:
            # A loop variable belongs to its own step; a later step reaching for
            # it is the script that reads fine and breaks on the second run.
            raise ScriptError(
                f"step {position} uses {', '.join(repr(n) for n in unknown)}, which "
                f"{'name' if len(unknown) > 1 else 'names'} nothing it can see — "
                f"available here: {', '.join(sorted(bindable)) or 'nothing'}"
            )

        properties = (tool.parameters.get("properties") or {}).keys()
        extra = sorted(set(args) - set(properties))
        if extra:
            raise ScriptError(
                f"step {position} passes {', '.join(repr(k) for k in extra)} to {name}, which "
                f"takes {', '.join(sorted(properties)) or 'no arguments'}"
            )
        missing = sorted(set(tool.parameters.get("required") or ()) - set(args))
        if missing:
            raise ScriptError(
                f"step {position} does not pass {', '.join(repr(k) for k in missing)}, which "
                f"{name} requires"
            )


def expand(script: object, inputs: dict) -> list[Step]:
    """Every dispatch this run will make, in order, with its values resolved.

    Whole-script, before anything runs: the cap is only a bound if it is
    checked while refusing still costs nothing.
    """
    steps = _steps_of(script)
    out: list[Step] = []
    for position, step in enumerate(steps, start=1):
        loop = step.get("for_each")
        args = step.get("args", {})
        if loop is None:
            out.append(Step(index=position, tool=step["tool"], args=render(args, inputs)))
            continue
        items = inputs.get(loop) or []
        if not isinstance(items, list):
            raise ScriptError(f"step {position} repeats over {loop!r}, which is not a list")
        for item in items:
            bindings = {**inputs, step["as"]: item}
            out.append(
                Step(index=position, tool=step["tool"], args=render(args, bindings), item=item)
            )
        if len(out) > MAX_STEPS:
            break
    if len(out) > MAX_STEPS:
        raise ScriptError(
            f"this would run {len(out)} calls and the limit is {MAX_STEPS} — nothing was run; "
            "give it fewer items, or split the work"
        )
    return out


def _where(step: Step) -> str:
    at = f"step {step.index} ({step.tool}"
    return f"{at}, {step.item!r})" if step.item is not None else f"{at})"


async def run(
    script: object,
    inputs: object,
    inputs_schema: object,
    *,
    ctx: ToolContext,
    step: StepRunner | None = None,
) -> tuple[str, bool]:
    """Run a validated script and report what RAN.

    Her inputs are checked against the skill's own schema first, by the same
    validator every tool call goes through — a script is a tool with a schema
    someone wrote, and it earns no exemption from that.

    `step` is the turn's seam: it files a span and dispatches. Without one
    (an eval replay, a test) the calls still go through `tools.dispatch` and
    the result SAYS the steps are not on the trace, rather than leaving a
    reader to assume they are.
    """
    if not isinstance(inputs, dict):
        return f"Error: the inputs must be a JSON object, got {type(inputs).__name__}", False
    problem = tool_schema.validate(inputs_schema, inputs)
    if problem is not None:
        return f"Error: {problem}", False
    try:
        validate(script, inputs_schema)
        planned = expand(script, inputs)
    except ScriptError as exc:
        return f"Error: {exc}", False

    lines: list[str] = []
    for position, planned_step in enumerate(planned):
        if step is None:
            result, ok = await tools.dispatch(planned_step.tool, planned_step.args, ctx)
        else:
            result, ok = await step(
                planned_step.tool,
                planned_step.args,
                index=planned_step.index,
                item=planned_step.item,
            )
        head = result.strip().splitlines()[0] if result.strip() else ""
        lines.append(f"{_where(planned_step)}: {'ok' if ok else 'FAILED'} — {head}")
        if not ok:
            remaining = len(planned) - position - 1
            lines.append(
                f"Stopped at {_where(planned_step)}. "
                + (
                    f"{remaining} later step{'s were' if remaining != 1 else ' was'} not attempted."
                    if remaining
                    else "It was the last step."
                )
            )
            return _report(lines, step is None), False
    lines.append(f"All {len(planned)} steps ran.")
    return _report(lines, step is None), True


def _report(lines: Sequence[str], unspanned: bool) -> str:
    text = "\n".join(lines)
    if unspanned:
        text += "\n(These steps ran outside a turn, so they are not recorded on the trace.)"
    return text


# ── deriving a draft from what actually happened ───────────────────────────

_JSON_TYPES = {str: "string", bool: "boolean", int: "integer", float: "number", list: "array"}


def _json_type(value: object) -> str:
    return _JSON_TYPES.get(type(value), "string")


def _runs(walk: Sequence[tuple[str, dict]]) -> list[tuple[str, list[dict]]]:
    """One walk as its RUNS: consecutive calls to the same tool grouped.

    The same collapse `skills.shape` makes, keeping the arguments — a run is
    the same call over a list, and the list is what becomes an input.
    """
    out: list[tuple[str, list[dict]]] = []
    for tool, args in walk:
        if out and out[-1][0] == tool:
            out[-1][1].append(args)
        else:
            out.append((tool, [args]))
    return out


def _unique(name: str, taken: set[str]) -> str:
    candidate, n = name, 1
    while candidate in taken:
        n += 1
        candidate = f"{name}_{n}"
    taken.add(candidate)
    return candidate


def derive(walks: Sequence[Sequence[tuple[str, dict]]]) -> dict:
    """A candidate script from the calls those turns actually made.

    No model is asked anything. The rules are the ones a person would apply
    reading the walks side by side:

      * a RUN of one tool becomes a repeat over a list, because that is what a
        run is — writing it out as three steps would freeze the count of one
        afternoon into the procedure;
      * an argument whose value was the same in every walk becomes a constant;
      * an argument whose value differed becomes an input named after it.

    With ONE walk there is nothing to compare, so everything that does not
    repeat is taken as a constant and the note says so — the page shows that
    sentence, because a draft that quietly guessed would be worse than one
    that admits what it could not know. When the walks did different things,
    the NEWEST is the shape (it is the closest to how the thing is done now)
    and the note says they differed.

    Returns {"script", "inputs", "note"}; the result is valid by construction
    and a test pins that, because a starting point that cannot be saved is
    not a starting point.
    """
    walks = [list(walk) for walk in walks if walk]
    if not walks:
        raise ScriptError(
            "those turns ran no tool calls, so there is nothing to derive a script from"
        )

    shaped = [_runs(walk) for walk in walks]
    newest = shaped[-1]
    comparable = [s for s in shaped if [tool for tool, _ in s] == [tool for tool, _ in newest]]
    notes: list[str] = []
    if len(comparable) < len(shaped):
        notes.append(
            "The recorded walks differ in what they called, so this is the newest one; "
            "the others were used only where their steps line up."
        )
    if len(comparable) == 1:
        notes.append(
            "There is only one walk to read, so every argument that does not repeat was taken "
            "as a constant. Change the ones that should be inputs."
        )

    properties: dict[str, dict] = {}
    taken: set[str] = set()
    steps: list[dict] = []
    # Per walk, the values already standing behind an input name. A later step
    # that passes the SAME value an earlier step did — writing a file and then
    # reading it back is the whole reason this exists — reuses that input
    # instead of minting a second one. Without it the derived script wrote one
    # file and read a different one, which is a script that cannot do the thing
    # it was derived from (found on the S18 walk, against real spans).
    standing: list[dict[str, str]] = [{} for _ in comparable]

    for position, (tool, calls) in enumerate(newest):
        repeated = any(len(other[position][1]) > 1 for other in comparable)
        keys = list(calls[0])
        if repeated:
            # Which argument is the list? The one that varies within the run —
            # or, if a run of one is all we have, the only one there is.
            varying = [k for k in keys if len({repr(c.get(k)) for c in calls}) > 1] or keys
            item_key = varying[0]
            if len(varying) > 1:
                # Only one argument can be the list this step repeats over. The
                # others are frozen at the value the first call used, which is a
                # guess — so it is said rather than left to be discovered.
                notes.append(
                    f"Step {position + 1} varied in more than one argument "
                    f"({', '.join(varying)}); {item_key} was taken as the list and the rest "
                    "frozen at their first values."
                )
            plural = _unique(f"{item_key}s", taken)
            properties[plural] = {
                "type": "array",
                "items": {"type": _json_type(calls[0].get(item_key))},
            }
            args = {k: (f"{{{{ {item_key} }}}}" if k == item_key else calls[0][k]) for k in keys}
            steps.append({"tool": tool, "args": args, "for_each": plural, "as": item_key})
            continue

        args = {}
        for key in keys:
            values = [other[position][1][0].get(key) for other in comparable]
            if len({repr(v) for v in values}) == 1:
                args[key] = calls[0][key]
            else:
                already = {
                    walk_standing.get(repr(value))
                    for walk_standing, value in zip(standing, values, strict=True)
                }
                if len(already) == 1 and None not in already:
                    name = already.pop()
                else:
                    name = _unique(key, taken)
                    properties[name] = {"type": _json_type(calls[0].get(key))}
                    for walk_standing, value in zip(standing, values, strict=True):
                        walk_standing[repr(value)] = name
                args[key] = f"{{{{ {name} }}}}"
        steps.append({"tool": tool, "args": args})

    return {
        "script": {"version": 1, "steps": steps},
        "inputs": {
            "type": "object",
            "properties": properties,
            "required": sorted(properties),
            "additionalProperties": False,
        },
        "note": " ".join(notes),
    }
