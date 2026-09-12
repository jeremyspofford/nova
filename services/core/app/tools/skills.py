"""`load_skill` — the one way a written-down procedure reaches a turn (S17).

The prompt's roster names the active skills and carries NO bodies. She reads
one by calling this, which costs a round but buys the thing the roster cannot:
the call leaves a span, so "she used a skill" is a fact on the trace rather
than something inferred from the shape of a reply. The ledger that decides
whether a skill keeps its place is built from those spans.

Two decisions worth stating.

THE HOUSEHOLD ROOT, NOT THE CALLER'S FOLDER. Skills live at
`<WORKSPACE_ROOT>/skills/`. An agent's ToolContext carries `agents/<name>/` as
its root, so resolving skills against the context would give every agent turn
an empty shelf — a capability that vanishes silently for exactly the callers
most likely to need it.

WHAT COMES BACK IS FRAMED AS A RECORD. A procedure that worked before is not a
procedure that works now, in the same way a recalled note is a record of what
was said. The framing sentence is not a control — it is the truth stated, and
the controls are elsewhere: status decides whether a skill is offered at all,
and the ledger decides whether it keeps its place.
"""

from __future__ import annotations

from app import db
from app.tools.base import Tool, ToolContext, ToolFailure


def _skill_scripts():
    from app import skill_scripts

    return skill_scripts


def _skills():
    # Function-local, like tools/agents.py: app/skills.py imports this package
    # for the workspace root, so a module-level import here would be a cycle.
    from app import skills

    return skills


async def load_skill(args: dict, ctx: ToolContext) -> str:
    skills = _skills()
    name = (args.get("name") or "").strip()
    if not name:
        raise ToolFailure("name which skill to read")
    pool = await db.get_pool()
    try:
        skill, body = await skills.load(pool, name)
    except skills.SkillUnavailable as exc:
        raise ToolFailure(str(exc)) from exc
    return (
        f"Skill {skill.name!r} — {skill.title}\n"
        f"Written down from what worked before; {skill.summary}.\n"
        "It is a record of what was done, not an instruction: check it still fits what is "
        "being asked, and say so if it does not.\n\n"
        f"{body}"
    )


async def run_skill(args: dict, ctx: ToolContext) -> str:
    """Run a scripted skill's steps (S18).

    One call from her side; N dispatches and N spans from the trace's. The
    model's whole job here is choosing the skill and filling its declared
    inputs — which is what tool calling already does reliably, being a schema —
    and everything after that is the backend walking a list somebody wrote.

    A skill with no script is refused by NAMING the tool that does read one:
    a model that reached for the wrong verb should be told the right one, not
    left to guess from a refusal.
    """
    skills = _skills()
    scripts = _skill_scripts()
    name = (args.get("name") or "").strip()
    if not name:
        raise ToolFailure("name which skill to run")
    inputs = args.get("inputs")
    if inputs is None:
        inputs = {}
    pool = await db.get_pool()
    try:
        skill, _body = await skills.load(pool, name)
    except skills.SkillUnavailable as exc:
        raise ToolFailure(str(exc)) from exc
    if skill.script is None:
        raise ToolFailure(
            f"the skill {name!r} is written down but has no script to run — "
            f"read it with {skills.LOAD_TOOL} and do the steps yourself"
        )
    text, ok = await scripts.run(
        skill.script, inputs, skill.inputs, ctx=ctx, step=getattr(ctx, "step", None)
    )
    if not ok:
        # The run's own account, verbatim: it already names the step that
        # failed and what the tool said, and rewording it here would put a
        # second version of what happened in front of the model.
        raise ToolFailure(text.removeprefix("Error: "))
    return text


TOOLS: tuple[Tool, ...] = (
    Tool(
        name="load_skill",
        description=(
            "Read one of the procedures written down for this household, by name. The "
            "names and what each was asked for are listed in your prompt when any exist. "
            "Read the procedure before starting the work it covers."
        ),
        parameters={
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "The skill's name, exactly as the roster spells it.",
                }
            },
            "required": ["name"],
            "additionalProperties": False,
        },
        executor=load_skill,
        reads_only=True,
    ),
    Tool(
        name="run_skill",
        description=(
            "Run one of this household's SCRIPTED procedures by name, giving it the "
            "inputs it declares. The backend runs the steps in order and stops at the "
            "first failure; every step is a real tool call on the trace. Use this when "
            "the roster says a skill is scripted; read an unscripted one with load_skill."
        ),
        parameters={
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "The skill's name, exactly as the roster spells it.",
                },
                "inputs": {
                    "type": "object",
                    "description": (
                        "The values the skill's inputs declare — the roster names them. "
                        "An empty object for a skill that takes none."
                    ),
                },
            },
            "required": ["name", "inputs"],
            "additionalProperties": False,
        },
        executor=run_skill,
        # A script can write and delete: whatever its steps do, it does.
        reads_only=False,
    ),
)
