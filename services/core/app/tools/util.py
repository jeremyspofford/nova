"""Small utility tools. Today: what time it is."""
from __future__ import annotations

from datetime import UTC, datetime
from zoneinfo import ZoneInfo

from app import db, peers
from app.tools import timers as timer_tools
from app.tools.base import Tool, ToolContext

NO_ARGUMENTS = {"type": "object", "properties": {}, "additionalProperties": False}


async def get_time(args: dict, ctx: ToolContext) -> str:
    """The clock in the household's zone (`nova.timezone`), with UTC beside it.

    Which clock is being quoted is stated in the text, every time: a bare
    timestamp reads as local time to a model that has been told nothing. With
    the zone set the answer leads with the local wall time and its offset and
    carries the UTC instant too; with the zone unset it says so and names where
    it is set (S9: reminders at an absolute time are refused until then); when
    the setting cannot be read at all the reason is stated beside the UTC time
    rather than guessed past — the time is still a fact, the zone is not.
    """
    now = datetime.now(UTC)
    epoch = f"unix epoch {int(now.timestamp())}"
    try:
        zone, zone_set = await timer_tools.household_timezone(await db.get_pool())
    except Exception as exc:
        reason = peers.reason(exc)
        return (
            f"{now.isoformat()} (UTC — the local timezone setting could not be read: "
            f"{reason}); {epoch}"
        )
    if not zone_set:
        return (
            f"{now.isoformat()} (UTC — this instance has no local timezone configured yet; "
            f"set it in Settings → General); {epoch}"
        )
    local = now.astimezone(ZoneInfo(zone))
    return f"{local.isoformat()} ({zone}, UTC{local:%z}); UTC {now.isoformat()}; {epoch}"


TOOLS: tuple[Tool, ...] = (
    Tool(
        name="get_time",
        description=(
            "The current date and time in the household's timezone (when one is set) and in "
            "UTC, plus the unix epoch. Takes no arguments."
        ),
        parameters=NO_ARGUMENTS,
        executor=get_time,
    ),
)
