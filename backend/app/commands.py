"""Slash commands — operator verbs that never reach a model.

`/clear` is the first, and the reason the mechanism exists rather than a
one-off endpoint: the command SET has to be discoverable. A verb nobody can
find is folklore, so the registry is the source of truth for both the
executor and the palette the composer shows while you type.

Two rules that keep this from being annoying:

  * A leading slash is only a command when it MATCHES one. "/home/jeremy/
    workspace/nova is the path" is a sentence, and swallowing it because it
    starts with a slash would be worse than not having commands at all.
  * Commands run on the server. The palette is frontend sugar, but the verb
    is an endpoint — so voice, the phone and any later surface get the same
    behaviour without reimplementing it.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Awaitable, Callable, Optional

from app import conversations

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Command:
    name: str                 # without the slash
    summary: str              # one line, shown in the palette
    detail: str = ""          # shown when the palette row is highlighted
    run: Optional[Callable[[str], Awaitable[dict]]] = None


async def _clear(_arg: str) -> dict:
    conversation = await conversations.get_or_create_active_conversation()
    result = await conversations.clear_context(conversation["id"])
    kept = result.get("messages_kept", 0)
    return {
        "ok": result.get("cleared", False),
        # Said in full because "cleared" alone reads like a delete, and the
        # whole design of this command is that nothing was deleted.
        "message": (
            f"Context cleared. Nova starts fresh from here — she keeps her "
            f"memory, her skills and the journals, so ask about anything "
            f"from before and she can still look it up. {kept} messages are "
            f"kept on disk; only the working window reset."),
    }


REGISTRY: dict[str, Command] = {
    c.name: c for c in [
        Command(
            name="clear",
            summary="Clear the conversation context",
            detail=("Starts a fresh context window. Nothing is deleted — "
                    "memory, skills and journals are untouched, so Nova can "
                    "still recall earlier work when asked."),
            run=_clear,
        ),
        Command(
            name="help",
            summary="List the available commands",
            detail="Shows every slash command and what it does.",
            run=None,      # answered from the registry itself, below
        ),
    ]
}


async def _help(_arg: str) -> dict:
    lines = "\n".join(f"/{c.name} — {c.summary}" for c in REGISTRY.values())
    return {"ok": True, "message": "Commands:\n" + lines}


REGISTRY["help"] = Command(**{**REGISTRY["help"].__dict__, "run": _help})


def parse(text: str) -> tuple[Optional[Command], str]:
    """(command, argument) for a slash command, (None, "") for a message.

    Unknown slashes deliberately fall through to the model: the operator may
    simply be talking about a path, and refusing to answer would be a worse
    failure than not recognising a typo'd command.
    """
    stripped = (text or "").strip()
    if not stripped.startswith("/"):
        return None, ""
    head, _, rest = stripped[1:].partition(" ")
    return REGISTRY.get(head.lower()), rest.strip()


def catalog() -> list[dict]:
    """The palette's data — name, summary, detail."""
    return [{"name": c.name, "summary": c.summary, "detail": c.detail}
            for c in sorted(REGISTRY.values(), key=lambda c: c.name)]
