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
    # (2.1 of 4.9 GB)"): chat binds it per call to an activity frame with
    # `detail`, so the bubble shows the download moving. None outside a turn.
    # An output channel is not a principal a permission could bind to.
    progress: Callable[[str], None] | None = None


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
