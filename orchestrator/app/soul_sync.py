"""
Soul sync — Settings → Nova Identity is the single source of truth for
Nova's soul.

platform_config (nova.name / nova.persona) owns Nova's identity. The memory
bundle's `self/soul.md` is a *mirror* of it, so the Brain graph and memory
retrieval present the same identity that every system prompt gets. The mirror
refreshes at orchestrator startup (covers edits missed while services were
down) and on every PATCH of either key. Manual edits to soul.md do not
survive a sync — the persona field in Settings is where the soul is edited.
"""

from __future__ import annotations

import asyncio
import logging

log = logging.getLogger(__name__)

SOUL_MEMORY_ID = "self/soul.md"

# Frontmatter patch applied on every sync so the file self-describes its
# ownership regardless of which template originally seeded it.
_SOUL_FRONTMATTER = {
    "title": "Soul",
    "description": "Who Nova is — mirrored from Settings → Nova Identity. The graph grows from here.",
    "nova_managed_by": "settings:nova.persona",
}


def compose_soul_body(name: str, persona: str) -> str:
    """Render the soul document body from the operator-set identity."""
    lines = [
        "# Soul",
        "",
        "> Mirrored from Settings → Nova Identity. Edit the persona there — manual",
        "> edits to this file are overwritten on the next sync.",
        "",
        f"I am {name}.",
        "",
    ]
    if persona:
        lines.append(persona)
    else:
        lines.append("(No persona set — define one in Settings → Nova Identity.)")
    return "\n".join(lines) + "\n"


async def sync_soul() -> bool:
    """Mirror nova.name/nova.persona into the memory bundle's soul file.

    Returns True when the soul is in sync (already current, or updated now)
    or when syncing is impossible and retrying won't help (backend without
    update support, soul file missing). Returns False only for transient
    failures worth retrying (memory-service unreachable / not ready).
    Never raises.
    """
    from app.agents.runner import _get_platform_identity
    from app.clients import get_memory_client_async

    try:
        name, persona = await _get_platform_identity()
        body = compose_soul_body(name, persona)

        client = await get_memory_client_async()
        current = await client.get(f"/api/v1/memory/item/{SOUL_MEMORY_ID}")
        if current.status_code == 404:
            # ensure_bundle seeds the file at memory-service startup, so this
            # points at a misconfigured bundle — retrying won't create it.
            log.warning("Soul sync: %s not found in memory bundle", SOUL_MEMORY_ID)
            return True
        current.raise_for_status()
        if current.json().get("content", "").strip() == body.strip():
            return True

        resp = await client.put(
            f"/api/v1/memory/item/{SOUL_MEMORY_ID}",
            json={"frontmatter": _SOUL_FRONTMATTER, "content": body},
        )
        if resp.status_code == 501:
            log.warning(
                "Soul sync: memory backend does not support item updates — "
                "soul will not mirror Settings → Nova Identity"
            )
            return True
        resp.raise_for_status()
        log.info("Soul synced to memory: %s now mirrors nova.name/nova.persona", SOUL_MEMORY_ID)
        return True
    except Exception as exc:
        log.warning("Soul sync failed (will retry if at startup): %s", exc)
        return False


async def soul_sync_on_startup(attempts: int = 10, delay_seconds: float = 15.0) -> None:
    """Startup reconcile: retry until memory-service is up and the soul mirrors
    platform_config. Cancels quietly on shutdown."""
    for attempt in range(1, attempts + 1):
        if await sync_soul():
            return
        if attempt < attempts:
            await asyncio.sleep(delay_seconds)
    log.warning(
        "Soul sync gave up after %d attempts — soul.md may not reflect "
        "Settings → Nova Identity until the next persona save or restart",
        attempts,
    )
