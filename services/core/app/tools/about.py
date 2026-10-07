"""What this instance of Nova is, in her own hands (app/about.py).

The owner asked about her architecture and she left out the phone he was
holding: the installed web app was invisible to her, because nothing recorded
it. And "which version are you running, and is there a newer one?" had no
answer anywhere. One read answers both, and the About page reads the same
function — so the page and her words cannot disagree about what is running.
"""

from __future__ import annotations

from app import about, db, nova_updates
from app.tools.base import Tool, ToolContext, ToolFailure

NOVA_ABOUT = "nova_about"
NOVA_UPDATE = "nova_update"


async def nova_about(args: dict, ctx: ToolContext) -> str:
    data = await about.about(
        ctx.app, refresh=bool(args.get("check_updates_now")), facts_sink=ctx.facts_sink
    )
    return about.render(data)


async def nova_update(args: dict, ctx: ToolContext) -> str:
    """Start the hub's update (app/nova_updates.py). It says it STARTED: the
    stack restarts under this very turn, and only the installer's report to
    the new core — checked against that core's own commit — confirms it."""
    try:
        row = await nova_updates.start(
            ctx.app, await db.get_pool(), requested_by="nova", facts_sink=ctx.facts_sink
        )
    except nova_updates.CannotUpdate as exc:
        raise ToolFailure(f"cannot update: {exc.reason}") from exc
    return (
        f"Started the update of the hub from {row['from_commit'][:7]} to "
        f"{(row['to_commit'] or '?')[:7]} on {row['device']} ({row['reason']}). ./install update "
        "now backs up, fast-forwards, rebuilds and restarts the stack, and rolls back if that "
        "fails — several minutes, and this conversation drops while core restarts. It is NOT "
        "installed yet: it is decided only when the installer reports to the new core and that "
        f"core is running the new commit; nova_about shows the result. Log on {row['device']}: "
        f"{row['log_path']}"
    )


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
    Tool(
        name=NOVA_UPDATE,
        description=(
            "Update this Nova to the newest commit on its GitHub branch: the hub's own agent runs "
            "./install update, which backs up, fast-forwards the checkout, rebuilds and restarts "
            "the stack, and rolls back if the rebuild fails. Takes no arguments. It returns once "
            "the update has STARTED; the stack restarts (this conversation drops for a few "
            "minutes), and nova_about shows whether it was confirmed. Fails with the reason when "
            "there is nothing to install, the checkout has diverged or has uncommitted changes, "
            "the hub's agent is not connected, or an update is already running."
        ),
        parameters={"type": "object", "properties": {}, "additionalProperties": False},
        executor=nova_update,
        ephemeral=True,
    ),
)
