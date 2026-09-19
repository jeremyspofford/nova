"""Her machines: where models run, and the one switch she may set on each (S40).

A MACHINE here is an engine the gateway serves models through (the bundled
`hub` today; S44 adds one per paired machine). Everything she says about one
is read from the gateway at the moment she is asked, through app/machines.py
— core's one reader — and nothing is kept between turns.

machine_status reads. It changes nothing, reaches only the gateway's own
list, and its one argument is a name checked against that list, which is why
the backend may run it unasked (live_facts.AUTO_RUN). Each machine it reports
leaves a structured fact on the span — {"machine", "answering",
"checked_now", "at"} — so what she then says about it is checkable against a
record rather than a sentence.

machine_configure sets `serving`: whether that machine runs models for the
routing chains. It reports the value the gateway READS BACK, never the value
it sent (the models.py chat.model pattern), and a read-back that disagrees is
a failure, stated, with nothing called changed. Neither is an approval of
anything (owner ruling 2026-09-03).
"""

from __future__ import annotations

from datetime import UTC, datetime

from app import machines
from app.tools.base import RESULT_KIND_LISTING, Tool, ToolContext, ToolFailure

# How a model id says where it runs — the TRUE rule (S40 fix wave B4). A bare
# id's first colon is its tag's own, so the part before it is not a machine.
# Split in two so the per-call header (machine_status) can slot its own
# {first}:<model> example after the clause it illustrates — the QUALIFIED
# one — rather than after the bare-id clause, where it read as though the
# filtered machine were the default (S40 fix wave: example placement).
_ID_RULE_QUALIFIED = "A model id qualified with a machine's name (machine:model) names that machine"
_ID_RULE_BARE = "a bare id, whose own colon is its tag (qwen3.8:27b), means the default machine"
_ID_RULE = f"{_ID_RULE_QUALIFIED}; {_ID_RULE_BARE}"


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _size(size: object) -> str:
    if isinstance(size, int) and not isinstance(size, bool):
        return f"{size / 1024**3:.1f} GB"
    return "size not stated"


def _switch(serving: bool) -> str:
    return "on" if serving else "off"


def _answering(view: dict) -> bool | None:
    """Did it answer the gateway? Only what the reading says — the view's own
    `answered` (the EngineView contract): True or False when the gateway
    asked it, None when it did not (a machine left asleep), whatever its
    switch reads. Never inferred from a stored list."""
    answered = view.get("answered")
    return answered if isinstance(answered, bool) else None


def _describe(view: dict, checked_now: bool) -> str:
    name, state = view["name"], view.get("state")
    when = view.get("observed_at") or "never"
    heard = f"checked now, {when}" if checked_now else f"not checked now — last read {when}"
    if state == "ready":
        head = f"{name}: answering ({heard})"
    elif state == "unreachable":
        reason = view.get("reason") or "the gateway stated no reason"
        head = f"{name}: NOT answering ({heard}) — {reason}"
    elif state == "switched_off":
        head = f"{name}: switched off for models, so routing skips it ({heard})"
    else:
        reason = view.get("reason") or "the gateway did not contact it"
        head = f"{name}: not checked now — {reason}; last read {when}"
    serving = view.get("serving")
    if serving is True:
        switch = "serving is on"
    elif serving is False:
        switch = "serving is off"
    else:
        switch = "serving not stated"
    lifecycle = view.get("lifecycle")
    bits = [
        switch,
        "always on" if lifecycle == "always_on" else f"lifecycle {lifecycle}",
        f"computes on {view['compute']}" if view.get("compute") else "compute not stated",
        f"runtime {view['runtime']}" if view.get("runtime") else "runtime not stated",
    ]
    tags = view.get("tags")
    if isinstance(tags, dict) and tags:
        listed = ", ".join(f"{model} ({_size(size)})" for model, size in sorted(tags.items()))
        as_of = view.get("tags_as_of")
        bits.append(f"installed{f' as of {as_of}' if as_of else ''}: {listed}")
    elif isinstance(tags, dict):
        bits.append("no models installed")
    else:
        bits.append("what is installed could not be read")
    return f"{head}; " + "; ".join(bits) + "."


async def machine_status(args: dict, ctx: ToolContext) -> str:
    wanted = str(args.get("machine") or "").strip()
    try:
        views = await machines.plant().engines(ctx.app, live=True)
    except machines.PlantUnavailable as exc:
        raise ToolFailure(f"could not ask the gateway where models run — {exc}") from exc
    if wanted:
        named = [view for view in views if view["name"] == wanted]
        if not named:
            listed = ", ".join(view["name"] for view in views) or "none"
            raise ToolFailure(
                f"no machine named {wanted!r} runs models — the gateway lists: {listed}"
            )
        views = named
    if not views:
        return "The gateway lists no machine that runs models."
    first = views[0]["name"]
    lines = [
        f"{len(views)} machine(s) run models for Nova, read from the gateway now. "
        f"{_ID_RULE_QUALIFIED} ({first}:<model> runs on {first}); {_ID_RULE_BARE}."
    ]
    for view in views:
        checked_now = view.get("state") != "unobserved"
        lines.append(_describe(view, checked_now))
        if ctx.facts_sink is not None:
            ctx.facts_sink.append(
                {
                    "machine": view["name"],
                    "answering": _answering(view),
                    "checked_now": checked_now,
                    "at": view.get("observed_at") or _now(),
                }
            )
    return "\n".join(lines)


async def machine_configure(args: dict, ctx: ToolContext) -> str:
    name = str(args.get("machine") or "").strip()
    if not name:
        raise ToolFailure("machine_configure needs a machine's name — machine_status lists them")
    serving = args.get("serving")
    if not isinstance(serving, bool):
        raise ToolFailure("serving must be true or false")
    try:
        back = await machines.plant().set_serving(ctx.app, name, serving)
    except machines.UnknownMachine as exc:
        raise ToolFailure(f"no machine named {name!r} runs models — {exc}") from exc
    except machines.PlantUnavailable as exc:
        raise ToolFailure(f"{name}'s switch is not confirmed set — {exc}") from exc
    read = back.get("serving")
    if read is not serving:
        raise ToolFailure(
            f"{name}'s serving switch did not read back as {_switch(serving)} (it reads "
            f"{read!r}) — nothing is confirmed changed"
        )
    effect = (
        "the gateway's routing skips every link on it until it is switched back on"
        if not serving
        else "the gateway's routing may use it again"
    )
    return (
        f"{name} is switched {_switch(serving)} for models: serving read back as "
        f"{str(read).lower()} (state {back.get('state')}); {effect}."
    )


MACHINE_STATUS = Tool(
    name="machine_status",
    description=(
        "Where Nova's models run, read from the gateway right now: every machine that runs "
        "models, whether it is answering (checked now), whether it is switched on for "
        "models, what it computes on and in which runtime, and which models it has "
        f"installed. {_ID_RULE}. Use it before saying where a model runs, whether a machine "
        "is up, or what is installed on it. Reads only."
    ),
    parameters={
        "type": "object",
        "properties": {
            "machine": {
                "type": "string",
                "description": "One machine, by the name this tool lists; omit for every one.",
            },
        },
        "additionalProperties": False,
    },
    executor=machine_status,
    # A live, point-in-time reading: "hub is answering" recalled a week later
    # is exactly the stale present `ephemeral` exists to stop.
    ephemeral=True,
    reads_only=True,
    # It enumerates machines and their installed models (with sizes); declared
    # so a list she presents from it is never read as one nothing produced.
    result_kind=RESULT_KIND_LISTING,
)

MACHINE_CONFIGURE = Tool(
    name="machine_configure",
    description=(
        "Switch whether a machine runs models for Nova (its serving switch). Off: the "
        "gateway's routing skips every link on that machine and the next link in each chain "
        "answers. On: it may serve again. The result states the value the gateway read "
        "back — say what changed only from that line."
    ),
    parameters={
        "type": "object",
        "properties": {
            "machine": {
                "type": "string",
                "description": "The machine, by the name machine_status lists.",
            },
            "serving": {
                "type": "boolean",
                "description": "true lets it run models; false switches it off.",
            },
        },
        "required": ["machine", "serving"],
        "additionalProperties": False,
    },
    executor=machine_configure,
)

TOOLS: tuple[Tool, ...] = (MACHINE_STATUS, MACHINE_CONFIGURE)
