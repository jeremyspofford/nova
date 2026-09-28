"""Her machines: where models run, and the one switch she may set on each (S40).

A MACHINE here is an engine the gateway serves models through (the bundled
`hub` today; S44 adds one per paired machine). Everything she says about one
is read from the gateway at the moment she is asked, through app/machines.py
— core's one reader — and nothing is kept between turns.

machine_status reads. It changes nothing: it reaches the gateway's engine
list, and — for Nova's agents (S42a) — core's OWN device rows plus the hub's
live connection registry, never a second network call. Its one argument is a
name checked against BOTH lists, which is why the backend may run it unasked
(live_facts.AUTO_RUN). Each machine it reports leaves a structured fact on
the span — {"machine", "answering", "checked_now", "at"} — and each agent
leaves {"device", "connected"}, the same shape a device tool leaves — so what
she then says about either is checkable against a record rather than a
sentence. Run unasked (live_facts), its result reaches her cut short, and an
agent's fact is kept only when its line was shown (device_line_shown).

machine_configure sets `serving`: whether that machine runs models for the
routing chains. It reports the value the gateway READS BACK, never the value
it sent (the models.py chat.model pattern), and a read-back that disagrees is
a failure, stated, with nothing called changed. Neither is an approval of
anything (owner ruling 2026-09-03).
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from app import device_facts, machines
from app.tools.base import RESULT_KIND_LISTING, Tool, ToolContext, ToolFailure

logger = logging.getLogger("core")

# How a model id says where it runs — the TRUE rule (S40 fix wave B4). A bare
# id's first colon is its tag's own, so the part before it is not a machine.
# Split in two so the per-call header (machine_status) can slot its own
# {first}:<model> example after the clause it illustrates — the QUALIFIED
# one — rather than after the bare-id clause, where it read as though the
# filtered machine were the default (S40 fix wave: example placement).
_ID_RULE_QUALIFIED = "A model id qualified with a machine's name (machine:model) names that machine"
_ID_RULE_BARE = "a bare id, whose own colon is its tag (<name>:<tag>), means the default machine"
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
    reader = machines.plant()
    try:
        views = await reader.engines(ctx.app, live=True)
    except machines.PlantUnavailable as exc:
        raise ToolFailure(f"could not ask the gateway where models run — {exc}") from exc
    agents, agents_error = await _agents(reader, ctx)
    if wanted:
        named = [view for view in views if view["name"] == wanted]
        if agents_error is not None:
            # Fix round 1 (Important 1): Nova's agents could not be read AT
            # ALL, so their absence is not evidence of anything. Never say
            # "Nova's agents: none" — that claims a checked, empty list — and
            # never fold "or Nova's agent" into the not-found clause, which
            # would assert no agent of this name exists. Only the gateway's
            # own list is asserted; the agents half states its own failure.
            named_agents: list[dict] = []
            if not named:
                engines_listed = ", ".join(view["name"] for view in views) or "none"
                raise ToolFailure(
                    f"no machine named {wanted!r} runs models — the gateway lists: "
                    f"{engines_listed}; Nova's agents could not be read — {agents_error}"
                )
        else:
            named_agents = [
                agent
                for agent in agents
                if wanted.casefold() in (agent["name"].casefold(), agent["hostname"].casefold())
            ]
            if not named and not named_agents:
                engines_listed = ", ".join(view["name"] for view in views) or "none"
                agents_listed = ", ".join(agent["name"] for agent in agents) or "none"
                raise ToolFailure(
                    f"no machine named {wanted!r} runs models or Nova's agent — the gateway "
                    f"lists: {engines_listed}; Nova's agents: {agents_listed}"
                )
        views, agents = named, named_agents
    lines: list[str] = []
    if views:
        first = views[0]["name"]
        lines.append(
            f"{len(views)} machine(s) run models for Nova, read from the gateway now. "
            f"{_ID_RULE_QUALIFIED} ({first}:<model> runs on {first}); {_ID_RULE_BARE}."
        )
    elif not wanted:
        lines.append("The gateway lists no machine that runs models.")
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
    lines.extend(_describe_agents(agents, agents_error, ctx, filtered=bool(wanted)))
    return "\n".join(lines)


async def _agents(reader, ctx: ToolContext) -> tuple[list[dict], str | None]:
    """Nova's agents, or the reason they could not be read. A failure here is
    STATED in the result, never raised: the engines are still a true reading,
    and the agents failing must not hide them. It holds one way only: the
    gateway is read first, and a gateway that cannot be asked fails the whole
    call (machine_status raises before this runs), so no agent is reported
    then."""
    try:
        return await reader.agents(ctx.app), None
    except Exception as exc:  # noqa: BLE001 — stated in the result, in words
        logger.warning("machine_status: Nova's agents could not be read", exc_info=True)
        return [], f"{type(exc).__name__}: {exc}"


def _role(name: str, role: dict) -> str:
    if role["state"] == "cannot":
        return f"{name}: {role['reason']}"
    return f"{name}: {role['state']}" + (
        f" ({role['reason']})" if role["state"] == "available" else f" — {role['reason']}"
    )


# How each line of the agents section begins, below its header: a machine, then
# one line per agent on it. device_line_shown reads a listing back by these
# two, so both the writer and the reader take them from here.
_MACHINE_LINE = "- machine "
_AGENT_LINE = "  agent "


def _describe_agent(agent: dict) -> str:
    where = device_facts.place(agent)
    if agent["agent_version"]:
        where += f"; agent {agent['agent_version']}"
    state = (
        "connected now"
        if agent["connected"]
        else f"offline (last seen {agent['last_seen'] or 'never'})"
    )
    roles = agent["roles"]
    return (
        f"{_AGENT_LINE}{agent['name']} ({where}): {state}; "
        f"{_role('hands', roles['hands'])}; {_role('facts', roles['facts'])}."
    )


def _describe_agents(
    agents: list[dict], error: str | None, ctx: ToolContext, *, filtered: bool
) -> list[str]:
    """Nova's agents grouped by MACHINE — the agents that report one
    machine_uid. An agent that reported none is a machine of its own: its
    group is never merged with another by name, but nothing in the output
    says so either — a lone agent's listing reads exactly like any other
    one-agent machine's. Each listed agent leaves {"device", "connected"}
    on the span, the record a device tool leaves, so what she says about its
    connection is backed (guards._checked_a_device) — on an unasked check,
    only for an agent whose line she was shown (device_line_shown)."""
    if error is not None:
        return [f"Nova's agents could not be read — {error}."]
    if not agents:
        return [] if filtered else ["No Nova agent is paired to any machine."]
    groups: dict[str, list[dict]] = {}
    for agent in agents:
        groups.setdefault(agent["machine"] or f"agent:{agent['name']}", []).append(agent)
    lines = [
        f"Nova's agents, by machine — {len(groups)} machine(s), read from Nova's records and "
        "live connections now:"
    ]
    for members in groups.values():
        host = members[0]["hostname"]
        if len(members) > 1:
            names = ", ".join(agent["name"] for agent in members)
            lines.append(
                f"{_MACHINE_LINE}{host}: {len(members)} Nova agents report this one machine "
                f"({names}) — a machine runs one agent; the owner revokes the extra in "
                "Settings → Devices."
            )
        else:
            lines.append(f"{_MACHINE_LINE}{host}:")
        for agent in members:
            lines.append(_describe_agent(agent))
            if ctx.facts_sink is not None:
                ctx.facts_sink.append({"device": agent["name"], "connected": agent["connected"]})
    return lines


def device_line_shown(name: str, result: str, shown: int) -> bool:
    """Did the first `shown` characters of machine_status's `result` hold agent
    `name`'s WHOLE line? machine_status's Tool.device_line_shown: a live check
    keeps that agent's {"device", "connected"} fact only when this says yes
    (live_facts._shown_facts; S42a final review I2).

    Exact for the format _describe_agents writes, never the name found
    anywhere: the line begins, at a line start, with "  agent <name> (", and
    ends at the newline before the agents section's next line (another agent,
    or a "- machine" line) or at the end of the result — the agents section is
    the result's last. It fails closed, answering False, when there is no such
    line; when a line runs on past a newline this format never writes (text an
    agent reported can carry one); and when ANY line that could be this
    agent's ends past `shown` — "dell"'s head also begins the line of an agent
    named "dell (old)", and a line that cannot be told apart from another is
    not confirmed shown.
    """
    head = f"{_AGENT_LINE}{name} ("
    found = False
    start = result.find(head)
    while start != -1:
        if start == 0 or result[start - 1] == "\n":
            end = result.find("\n", start + len(head))
            if end == -1:
                end = len(result)
            elif not result.startswith((_AGENT_LINE, _MACHINE_LINE), end + 1):
                return False
            if end > shown:
                return False
            found = True
        start = result.find(head, start + 1)
    return found


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
        f"installed. {_ID_RULE}. Also Nova's agent on each paired machine, grouped by "
        "machine: the OS it runs (and whether it runs inside WSL), whether it is connected "
        "now, and what it can do there, with the reason. Use it before saying where a model "
        "runs, whether a machine is up, what is installed on it, or which agent can act on "
        "a machine. Reads only."
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
    # Its result states each machine's state as read now: a read of a machine
    # for the state guard (guards._machine_read_tools; S40b fix wave C2).
    reads_machines=True,
    # One result, one line per agent, each leaving a connectivity fact: a
    # live check keeps an agent's fact only when its line was shown (S42a
    # final review I2).
    device_line_shown=device_line_shown,
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
