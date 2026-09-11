"""What a tool IS, and what one is given when it runs.

Kept in its own module so the executor modules (workspace, memory, web,
util) and the registry that assembles them can both import these types
without importing each other.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

# Every failure a tool reports to the model starts with this, so a model
# reading its own transcript can tell a refusal from an answer without
# guessing at prose. Nothing downstream decides ok/failed by looking for
# it — dispatch() returns that flag separately — but the model only ever
# sees text, so the text has to say it too.
ERROR_PREFIX = "Error: "

# A tool whose successful result IS a listing — an enumeration of named
# entries (files, directories, apps, devices) — declares it on `Tool.result_kind`
# with this value. The presented-listing guard (app/guards.py) derives "a
# listing-producing call ran this turn" from that declaration (via
# tools.tool_names_by_result_kind), so a new listing tool self-registers by
# setting the one field, and the guard never has to be told about it.
RESULT_KIND_LISTING = "listing"


class ToolFailure(Exception):
    """A refusal an executor states on purpose: containment, a missing
    file, an unreachable peer, a cap exceeded. dispatch() turns it into an
    `Error: <reason>` result. Anything an executor raises that is NOT this
    is a bug, and dispatch says so in different words — see dispatch()."""


class TurnStopped(Exception):
    """The owner asked to stop the turn this call belongs to (S15).

    NOT a tool failure and not a bug — nothing is wrong with the call. It is
    the turn's own control flow passing THROUGH the tool layer, raised by the
    `progress` callback chat binds on the context, so any long call that
    reports progress becomes interruptible without knowing Stop exists.
    dispatch() re-raises it rather than turning it into an `Error:` result: the
    model must not be told its tool failed, because it did not, and the turn is
    about to end anyway.

    It lives here, beside ToolContext, because it is part of that context's
    contract: a tool that calls `ctx.progress` must be prepared for this to
    come back out of it.

    `reason` is who asked and why. `where` is what the turn was doing when the
    stop actually landed, carried from the raise site because that is the only
    thing that knows: reading the turn's live "doing" map instead named a tool
    that had already returned, and then said its outcome was unknowable.
    """

    def __init__(self, reason: str, where: str = "working") -> None:
        super().__init__(reason)
        self.reason = reason
        self.where = where


@dataclass(frozen=True)
class ToolContext:
    """Everything an executor is allowed to know about the turn it serves.

    `app` carries the outbound seams (peer links, and the by-URL transport
    map tests mount local ASGI stand-ins on). `person` scopes the memory
    tools — a tool never picks its own owner. `workspace_root` is resolved
    once per turn so a single env read decides the boundary for every
    filesystem call in that turn. Nothing here is a principal anything binds
    a permission to: a tool runs because it was called.

    `facts_sink` is the return channel for FACTS A CALL DETERMINED, whether or
    not it then ran. It exists because a REFUSAL can settle a fact: a device
    tool refused with "not connected — its tile is stale" has *established*
    that the machine is offline, and a caller that reads only ok=True would
    treat the honest reply "I checked and it is offline" as unbacked and
    correct a TRUE sentence (the state-claim guard's worst failure mode). So
    the per-device layer appends {"device": <name>, "connected": <bool>} the
    moment it decides connectivity — True when the check passes, even if a
    later path check then refuses; False when it does not. A refusal that
    settles NOTHING (an unknown device name) appends nothing. Structured,
    never prose: no caller ever sniffs a refusal string.
    """

    app: Any
    person: Any
    workspace_root: Path
    facts_sink: list[dict] | None = None
    # The OUTPUT channel for a long call's progress ("pulling qwen3:4b — 42%
    # (2.1 of 4.9 GB)"): chat binds it per call to an activity frame, so the
    # bubble shows the call moving. None outside a turn. A str is a detail
    # line, shown as-is. A dict is a structured report — a delegation
    # relaying the steps of the agent turn it is running ("coder is
    # working…", which tool the agent is on, whether that step failed) — and
    # chat._activity_frame copies ONLY allow-listed keys from it onto the
    # frame, so a tool cannot forge the frame's own `tool`/`status` and an
    # old client that reads tool/status/detail still sees the line move.
    # An output channel is not a principal a permission could bind to.
    progress: Callable[[str | dict], None] | None = None


@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    parameters: dict  # JSON Schema, advertised verbatim and validated against
    executor: Callable[[dict, ToolContext], Awaitable[str]]
    # A live, point-in-time READ whose result goes stale (a web fetch, a clock).
    # The turn loop does not ingest such a turn into long-term memory: recalling
    # a cached fetch later and serving it as "the latest" is a lie the model
    # cannot see through — it re-narrates the stale snapshot instead of fetching
    # again. Durable, reversible writes (files, memory_save) are NOT ephemeral.
    ephemeral: bool = False
    # What a successful result IS, when that is worth stating: RESULT_KIND_LISTING
    # for a tool whose output is an enumeration of named entries. None means
    # "whatever the tool returns" (a shell run, a file's contents, search hits).
    # A guard that needs to know whether a listing was produced this turn reads
    # this off the registry — never a name list of its own.
    result_kind: str | None = None
    # Does running this CHANGE anything? (S14, 2026-09-10.)
    #
    # A fact about the executor, never a permission: every tool stays hers to
    # call and nothing reads this to refuse her. dispatch does not look at it
    # — the pin in test_no_approvals asserts dispatch is still lookup, parse,
    # validate, executor and nothing else — because the moment dispatch
    # consults a field to decide, that field is a gate.
    #
    # It exists for a question v4 has never had to ask: what may the BACKEND
    # run when NOBODY asked it to. A distilled note can carry the call that
    # answers it now ("how much VRAM" is answered by the machine, not by a
    # note from three weeks ago), and the backend runs that call before she
    # answers. Something that changes the world must never run unasked.
    #
    # NECESSARY, NOT SUFFICIENT, and the gap is deliberate: fetch_url and
    # web_search change nothing and are true here, but they reach an address
    # the caller chose, so whatever decides the auto-run set must narrow this
    # further. One concept per flag — this one answers only "does it change
    # anything", and a policy smuggled in here would be a policy nobody could
    # find.
    reads_only: bool = False
    # Does a successful result PUT A LEDGER FIGURE in front of her? (S15.)
    #
    # The spend guard retracts a dollar figure she states with no ledger read
    # behind it, and its backing set used to be a list of one name kept in the
    # guard. `list_agents` reports each agent's cap and month-to-date spend, so
    # a figure read straight out of that result was retracted as unbacked — a
    # TRUE sentence, corrected, twice in a row on 2026-09-11, once contradicting
    # its own body. A false retraction is worse than the claim it corrects: it
    # teaches the owner that her corrections are noise.
    #
    # So the guard derives its set from this field (tools.tool_names_reporting_
    # spend) and a tool self-registers by declaring it — the same shape
    # `result_kind` already uses for the listing guard. A fact about the
    # OUTPUT, never a permission: nothing reads it to refuse a call.
    reports_spend: bool = False
