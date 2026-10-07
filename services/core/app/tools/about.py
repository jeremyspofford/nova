"""What this instance of Nova is, in her own hands (app/about.py).

The owner asked about her architecture and she left out the phone he was
holding: the installed web app was invisible to her, because nothing recorded
it. And "which version are you running, and is there a newer one?" had no
answer anywhere. One read answers both, and the About page reads the same
function — so the page and her words cannot disagree about what is running.
"""

from __future__ import annotations

from app import about
from app.tools.base import Tool, ToolContext

NOVA_ABOUT = "nova_about"


async def nova_about(args: dict, ctx: ToolContext) -> str:
    data = await about.about(
        ctx.app, refresh=bool(args.get("check_updates_now")), facts_sink=ctx.facts_sink
    )
    return about.render(data)


TOOLS: tuple[Tool, ...] = (
    Tool(
        name=NOVA_ABOUT,
        description=(
            "What this instance of Nova is, read live: the build running (commit, version, when "
            "./install brought it up) and whether GitHub's default branch has newer commits to "
            "pull (listed); the hub this runs on (its tailnet address, its own agent, the "
            "gateway and memory services); every other machine running Nova's agent; the "
            "machines that run models; and every client people use her from — the installed "
            "web app (PWA) or a browser tab, on which device, last used when. Use it for "
            "questions about her version, updates, architecture or setup. The update check is "
            "cached for ten minutes; check_updates_now asks GitHub again."
        ),
        parameters={
            "type": "object",
            "properties": {
                "check_updates_now": {
                    "type": "boolean",
                    "description": "Re-ask GitHub instead of using the last ten minutes' answer.",
                }
            },
            "additionalProperties": False,
        },
        executor=nova_about,
        ephemeral=True,
        reads_only=True,
    ),
)
