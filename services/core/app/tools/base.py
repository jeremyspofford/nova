"""What a tool IS, and what one is given when it runs.

Kept in its own module so the executor modules (workspace, memory, web,
util) and the registry that assembles them can both import these types
without importing each other.
"""
from __future__ import annotations

import uuid
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
    tools — a tool never picks its own owner — and, with `agent`, is the
    principal the policy kernel binds a consent to. `workspace_root` is
    resolved once per turn so a single env read decides the boundary for every
    filesystem call in that turn. `conversation_id` is where a consent card is
    raised, so it renders inline where it was asked for (a NULL one hides it).

    `consent_sink`, when present, is the return channel for a raised card: the
    funnel appends each card_spec it raises so the caller (the chat loop / T2's
    inline card) can surface it without changing dispatch's (text, ok) result.

    `facts_sink` is the same idiom for FACTS A CALL DETERMINED, whether or not
    it then ran. It exists because a REFUSAL can settle a fact: a device tool
    refused with "not connected — its tile is stale" has *established* that the
    machine is offline, and a caller that reads only ok=True would treat the
    honest reply "I checked and it is offline" as unbacked and correct a TRUE
    sentence (the state-claim guard's worst failure mode). So the per-device
    layer appends {"device": <name>, "connected": <bool>} the moment it decides
    connectivity — True when the check passes, even if a later grant/path check
    then refuses; False when it does not. A refusal that settles NOTHING (an
    unknown device name) appends nothing. Structured, never prose: no caller
    ever sniffs a refusal string.
    """

    app: Any
    person: Any
    workspace_root: Path
    agent: str = "chat"
    conversation_id: uuid.UUID | None = None
    consent_sink: list[dict] | None = None
    facts_sink: list[dict] | None = None


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
    # A REFUSAL-ONLY check dispatch() runs after schema validation and BEFORE
    # the policy kernel. It raises ToolFailure to refuse and returns None to
    # let the call go on to policy.authorize — it can never allow anything
    # (D-012: only the kernel constructs an ALLOW; this only ever adds a
    # refusal in front of it). It exists for the facts a tool can settle
    # WITHOUT running that the kernel does not know about — a device that is
    # not paired, not connected, not granted the capability, a path outside
    # its roots. Checking those only in the executor (after the kernel) meant
    # an approval was raised, and on re-attempt BURNED, for a call that could
    # never execute. The executor keeps its own identical checks: a grant can
    # change between the precheck and the run.
    precheck: Callable[[dict, ToolContext], Awaitable[None]] | None = None
