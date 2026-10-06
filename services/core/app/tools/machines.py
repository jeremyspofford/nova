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
leaves {"device", "connected"}, the same shape a device tool leaves, plus —
when the ledger holds one — its last update in machine_update's shape
{"machine_update", "outcome", "version", "confirmed"} (S42b), and "current" in
that shape when its line says it is on the hub's build (Task 32) — so what she
then says about either is checkable against a record rather than a sentence. Run
unasked (live_facts), its result reaches her cut short, and an agent's facts
are kept only when its line was shown (device_line_shown).

machine_configure sets `serving`: whether that machine runs models for the
routing chains. It reports the value the gateway READS BACK, never the value
it sent (the models.py chat.model pattern), and a read-back that disagrees is
a failure, stated, with nothing called changed. Neither is an approval of
anything (owner ruling 2026-09-03).

machine_update (S42b) sends the hub's agent build to a paired machine now —
the owner's "update it now" — and says what the update ledger holds when it
answers: sent until the agent's reconnect on the new build confirms it (P8),
never "updated" on the strength of the send. Its span carries
{"machine_update", "hub", "outcome", "version", "confirmed"} beside the
connectivity fact the send determined. It waits on no one: nothing asks the
owner, and a cannot is stated with the one step there is (P12).
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from app import agent_updates, device_facts, machines, schedule
from app.tools.base import (
    RESULT_KIND_LISTING,
    Tool,
    ToolContext,
    ToolFailure,
    listing_line_shown,
)

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


# How each line of the agents section begins, below its header: a machine, one
# line per agent on it, and — under each agent's line — what she needs to act
# on it (Task 22 fix round 1). device_line_shown reads a listing back by these,
# so both the writer and the reader take them from here.
_MACHINE_LINE = "- machine "
_AGENT_LINE = "  agent "
_ACTING_INDENT = "    "


# The ledger's outcome tokens (agent_updates), as words on an agent's line.
_OUTCOME_WORDS = {"rolled_back": "rolled back", "not_confirmed": "not confirmed"}


def _last_update_words(last: dict) -> str:
    """The agent's latest update attempt as the ledger holds it (S42b): the
    build, what was decided and when — a `sent` one is not confirmed — and
    the stored reason AS STORED: one line of at most
    agent_updates.REASON_MAX characters, made so when it was written
    (agent_updates._close), and never cut or cleaned again here.

    A `refused` attempt is a machine that could not take the build — its
    agent said no, or a bootstrap step failed — said in machine_update's
    words, "cannot take it", never as the ledger's token (fix round 1). A
    reason stored as a cannot ("cannot: …", agent_updates' own refusals) says
    its "cannot" once, as the update job's words do (_sent_words; Task 32,
    L477)."""
    outcome = last["outcome"]
    at = last["at"] or "an unknown time"
    if outcome == "refused":
        reason = (last.get("reason") or "no reason was given").removeprefix("cannot: ")
        return f"last update: {last['version']} at {at} — cannot take it: {reason}"
    said = f"last update: {last['version']} {_OUTCOME_WORDS.get(outcome, outcome)} at {at}"
    if outcome == "sent":
        said += ", not confirmed"
    elif last.get("reason"):
        said += f" ({last['reason']})"
    return said


def _build_words(agent: dict) -> str:
    """Its agent's build against the hub's — a hash has no order, so "behind
    the hub's build", never "older" (P2) — and unknown said as unknown."""
    build = agent["build"]
    if build["state"] == "current":
        return "on the hub's build"
    if build["state"] == "behind":
        return f"behind the hub's build {build['hub_version']}"
    if agent["agent_version"] is None:
        return "agent version unknown (none on record)"
    return "no hub build could be read to compare its agent's build with"


def _describe_agent(agent: dict) -> str:
    """ONE line per agent (device_line_shown reads it back whole): where it
    runs, its connection and roles, then — S42b — the door it came in
    through when that was the hub machine's own, its build against the
    hub's, how it starts and its last update, joined with "; ". What she
    needs to act on it goes on the lines under it (_describe_agents), never
    on this one: joined on, a probed agent's line ran ~1,690 characters, so a
    clip that showed its connection still cut the line and the check kept no
    fact of it (Task 22 fix round 1)."""
    where = device_facts.place(agent)
    if agent["agent_version"]:
        where += f"; agent {agent['agent_version']}"
    state = (
        "connected now"
        if agent["connected"]
        else f"offline (last seen {agent['last_seen'] or 'never'})"
    )
    roles = agent["roles"]
    extra = []
    if agent["hub"]:
        # The door is not identity (the controller's ruling): a relay on the
        # hub — the owner's tunnel, an ssh -L — comes in through the same
        # loopback door, so this says the door, never "the hub's own machine".
        extra.append("came in through the hub machine's own door")
    extra.append(_build_words(agent))
    starts = agent["starts"]
    extra.append(f"how it starts: {starts}" if starts.startswith("unknown") else f"starts {starts}")
    if agent["last_update"]:
        extra.append(_last_update_words(agent["last_update"]))
    line = (
        f"{_AGENT_LINE}{agent['name']} ({where}): {state}; "
        f"{_role('hands', roles['hands'])}; {_role('facts', roles['facts'])}; " + "; ".join(extra)
    )
    return line if line.endswith(".") else line + "."


def _describe_agents(
    agents: list[dict], error: str | None, ctx: ToolContext, *, filtered: bool
) -> list[str]:
    """Nova's agents grouped by MACHINE — the agents that report one
    machine_uid. An agent that reported none is a machine of its own: its
    group is never merged with another by name, but nothing in the output
    says so either — a lone agent's listing reads exactly like any other
    one-agent machine's. Each listed agent leaves {"device", "connected"}
    on the span, the record a device tool leaves, so what she says about its
    connection is backed (guards._checked_a_device), and the last update its
    line states, so what she says about that machine is backed too (guards.
    _update_backed; S42b Task 23 fix rounds 1-2) — and, when its line says it
    is on the hub's build, that, as machine_update's "current" (Task 32, L497)
    — on an unasked check, all only for an agent whose line she was shown
    (device_line_shown). Under each agent's line, indented, what she needs to
    act on it (device_facts.acting_lines, the probe's time first) — as
    device_list writes it."""
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
            lines.extend(f"{_ACTING_INDENT}{line}" for line in agent["acting"])
            if ctx.facts_sink is not None:
                ctx.facts_sink.append({"device": agent["name"], "connected": agent["connected"]})
                last = agent["last_update"]
                if last:
                    # The ledger row its line states, in machine_update's own
                    # shape (S42b Task 23 fix round 1, I3): a true report of a
                    # confirmed update in a later turn — most follow the job's
                    # unasked updates — is backed by what she read.
                    ctx.facts_sink.append(
                        {
                            "machine_update": agent["name"],
                            "outcome": last["outcome"],
                            "version": last["version"],
                            "confirmed": last["outcome"] == "confirmed",
                        }
                    )
                if agent["build"]["state"] == "current":
                    # Its line says "on the hub's build" (_build_words), with or
                    # without a ledger row: an agent paired already on it has
                    # none, and one put on it by hand after a failed update has
                    # a row that says otherwise. What the line states is
                    # machine_update's "current" — its agent last reported the
                    # hub's build — so it backs the state, never an update she
                    # made (Task 32, L497: "minipc's agent is updated" beside
                    # that line was corrected, the guard contradicting a true
                    # line she had just read).
                    ctx.facts_sink.append(
                        {
                            "machine_update": agent["name"],
                            "outcome": "current",
                            "version": agent["build"]["hub_version"],
                            "confirmed": False,
                        }
                    )
    return lines


def device_line_shown(name: str, result: str, shown: int) -> bool:
    """Did the first `shown` characters of machine_status's `result` hold agent
    `name`'s WHOLE line? machine_status's Tool.device_line_shown: a live check
    keeps that agent's {"device", "connected"} fact, and its last-update fact,
    only when this says yes (live_facts._shown_facts; S42a final review I2).

    Exact for the format _describe_agents writes, never the name found
    anywhere: the line begins, at a line start, with "  agent <name> (", and
    ends at the newline before the agents section's next line (a line under
    it, another agent, or a "- machine" line) or at the end of the result —
    the agents section is the result's last. It fails closed, answering
    False, when there is no such line; when a line runs on past a newline
    this format never writes (text an agent reported can carry one); and
    when ANY line that could be this agent's ends past `shown` — "dell"'s
    head also begins the line of an agent named "dell (old)", and a line
    that cannot be told apart from another is not confirmed shown. The scan
    is the one device_list's reader uses too (tools.base.listing_line_shown,
    S42b Task 22).
    """
    return listing_line_shown(
        f"{_AGENT_LINE}{name} (", result, shown, (_AGENT_LINE, _MACHINE_LINE, _ACTING_INDENT)
    )


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


# What machine_update says for each outcome the ledger can hold when the tool
# answers (agent_updates.UpdateOutcome). A `cannot` is raised, never said
# here. Each says only what the ledger shows: a send is never an update (P8),
# and only `confirmed` — the agent's reconnect on the new build — says it is.
_UPDATE_WORDS = {
    # From the agent's STORED facts, read before any connection was checked —
    # what it last reported, never "already runs" (fix round 1).
    "current": "{machine}'s agent last reported the hub's build {version} — nothing was sent.",
    "sent": (
        "Sent the hub's build {version} to {machine} (its agent ran {from_version}). Not "
        "confirmed yet: only {machine}'s agent reconnecting on {version} confirms the update, "
        "and it has not yet — machine_status and device_list show when it has."
    ),
    "confirmed": (
        "{machine}'s agent reconnected on the hub's build {version} (it ran {from_version}) — "
        "the update is confirmed."
    ),
    "rolled_back": (
        "{machine}'s agent did not come up on {version}, so its supervisor put {from_version} "
        "back{reason}. The update is rolled back."
    ),
    "not_confirmed": (
        "Sent the hub's build {version} to {machine}, and the update is not confirmed: {reason}."
    ),
    # A machine that could not take the build — its agent said no, or a
    # bootstrap step failed: the words the update job and the check use.
    "refused": "{machine} cannot take the hub's build {version}: {reason}.",
}
# A reason the ledger left empty, said per outcome — never "None".
_NO_REASON = {
    "rolled_back": "",
    "not_confirmed": "nothing has confirmed it",
    "refused": "no reason was given",
}


def _cancelled_words(outcome: str, count: int) -> str:
    """F15: how many commands were running there when the update went out —
    a count, since the hub keeps futures, not capability names (P25 as
    amended). A restart ends a running command "cancelled"; whether one
    finished first is not known here, so it is never said that it did not."""
    if not count:
        return ""
    plural = count != 1
    if outcome == "sent":
        return (
            f" {count} command{'s' if plural else ''} running there "
            f'{"end" if plural else "ends"} "cancelled" unless '
            f"{'they finish' if plural else 'it finishes'} before the agent restarts."
        )
    return (
        f" {count} command{'s' if plural else ''} {'were' if plural else 'was'} running there "
        'when it was sent, and a restart ends a running command "cancelled".'
    )


async def machine_update(args: dict, ctx: ToolContext) -> str:
    """Her "update it now" (S42b decision 2): the plant sends the hub's build
    and answers with what the ledger holds once the agent's reconnect
    decided it or the wait ran out (P8). Its facts — {"machine_update",
    "hub", "outcome", "version", "confirmed"} — go on the span for the
    guards (Task 23's narration backing reads `confirmed`), beside the
    connectivity fact update_now recorded on the same sink. A cannot is a
    stated ToolFailure naming the owner's one step where there is one
    (P12) — no card is sent from here."""
    name = str(args.get("machine") or "").strip()
    if not name:
        raise ToolFailure(
            "cannot: machine_update needs a machine's name — device_list and machine_status "
            "list them"
        )
    try:
        # Her facts_sink and progress ride down to update_now: the facts it
        # determines land on her span, and the wait is said on her activity
        # line, where a Stop can land (fix round 1) — the attempt then stays
        # `sent` for the reconnect or expire_stale to decide.
        out = await machines.plant().update_agent(
            ctx.app, name, requested_by="nova", facts_sink=ctx.facts_sink, progress=ctx.progress
        )
    except machines.UnknownMachine as exc:
        raise ToolFailure(str(exc)) from exc
    outcome = out["outcome"]
    if ctx.facts_sink is not None:
        ctx.facts_sink.append(
            {
                "machine_update": name,
                "hub": bool(out.get("hub")),
                "outcome": outcome,
                "version": out["version"],
                "confirmed": outcome == "confirmed",
            }
        )
    if outcome == "cannot":
        # P12: the one step is named in the reason; no card is sent from here.
        raise ToolFailure(out["reason"] or "cannot: no reason was given")
    # A reason the ledger stored as a cannot says its "cannot" once: "minipc
    # cannot take the hub's build …: cannot: …" said it twice (Task 32, L477;
    # the update job's _sent_words strips it the same way).
    reason = (out["reason"] or "").removeprefix("cannot: ")
    if outcome == "rolled_back":
        reason = f" — {reason}" if reason else ""
    elif not reason:
        reason = _NO_REASON.get(outcome, "")
    said = _UPDATE_WORDS[outcome].format(
        machine=name,
        version=out["version"],
        from_version=out["from_version"] or "a build not on record",
        reason=reason,
    )
    return said + _cancelled_words(outcome, out.get("in_flight") or 0)


MACHINE_STATUS = Tool(
    name="machine_status",
    description=(
        "Where Nova's models run, read from the gateway right now: every machine that runs "
        "models, whether it is answering (checked now), whether it is switched on for "
        "models, what it computes on and in which runtime, and which models it has "
        f"installed. {_ID_RULE}. Also Nova's agent on each paired machine, grouped by "
        "machine: the OS it runs (and whether it runs inside WSL), whether it is connected "
        "now, and what it can do there, with the reason; whether its agent came in through the "
        "hub machine's own door, its agent's build against the hub's, how it starts and its "
        "last update — and, on the lines under it, what Nova needs to act on it (how it runs, "
        "elevating, WSL). Use it before saying where a model "
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


def _bound_words(seconds: float) -> str:
    """One of the update's bounds as her description says it: "2 minutes",
    "1 minute", "90 seconds"."""
    if seconds >= 60 and seconds % 60 == 0:
        minutes = int(seconds // 60)
        return f"{minutes} minute{'' if minutes == 1 else 's'}"
    return f"{seconds:g} second{'' if seconds == 1 else 's'}"


# Both bounds are read off agent_updates, the numbers the update waits on: the
# send's (COMMAND_TIMEOUT_S, its agent's download and stage) and the reconnect's
# (WAIT_S). Typed here, a change to either would leave her told the old one
# (Task 32, L477 — derived, never hardcoded). The job's cadence is too: its
# schedule (JOB_SCHEDULE, which timers.JOB_SCHEDULES runs it on), in the words
# the timers say, in UTC as the job is seeded (Task 32 Phase C, C4).
MACHINE_UPDATE = Tool(
    name="machine_update",
    description=(
        "Update Nova's agent on a paired machine to the hub's build now — the owner's \"update "
        "it now\". Nova already keeps her agents on the hub's build by herself, one idle machine "
        f"at a time {schedule.describe(agent_updates.JOB_SCHEDULE, 'UTC', None)}, so this is "
        "for now. It sends the build — the agent has up "
        f"to {_bound_words(agent_updates.COMMAND_TIMEOUT_S)} to download and stage it — then "
        f"waits up to {_bound_words(agent_updates.WAIT_S)} more for the agent "
        "to reconnect on it, saying so while it waits. The result says current (its agent last "
        "reported the hub's build), sent (not confirmed yet), confirmed (the agent reconnected "
        "on the new build), rolled back (the new build did not come up, so its supervisor put "
        "the old one back), not confirmed, cannot take it (with the reason), or cannot with the "
        "one step that can. An update is confirmed ONLY by the agent's reconnect, never by the "
        'send. A command running there ends "cancelled" when the agent restarts; the result '
        "counts them."
    ),
    parameters={
        "type": "object",
        "properties": {
            "machine": {
                "type": "string",
                "description": (
                    "The paired machine, by the name device_list or machine_status lists for "
                    "its agent — never 'hub', which names the bundled engine."
                ),
            },
        },
        "required": ["machine"],
        "additionalProperties": False,
    },
    executor=machine_update,
)

TOOLS: tuple[Tool, ...] = (MACHINE_STATUS, MACHINE_CONFIGURE, MACHINE_UPDATE)
