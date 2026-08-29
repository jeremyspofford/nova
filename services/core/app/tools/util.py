"""Small utility tools. Today: what time it is."""
from __future__ import annotations

from datetime import UTC, datetime

from app.tools.base import Tool, ToolContext

NO_ARGUMENTS = {"type": "object", "properties": {}, "additionalProperties": False}


async def get_time(args: dict, ctx: ToolContext) -> str:
    """UTC is stated in the text, not left to be inferred.

    A bare timestamp reads as local time to a model that has been told
    nothing, and the household's timezone is a later slice's problem — so
    this says which clock it is quoting, every time.
    """
    now = datetime.now(UTC)
    return (
        f"{now.isoformat()} (UTC — this instance has no local timezone configured yet); "
        f"unix epoch {int(now.timestamp())}"
    )


TOOLS: tuple[Tool, ...] = (
    Tool(
        name="get_time",
        description=(
            "The current date and time in UTC, plus the unix epoch. Takes no arguments."
        ),
        parameters=NO_ARGUMENTS,
        executor=get_time,
    ),
)
