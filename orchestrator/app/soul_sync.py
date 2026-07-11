"""
Soul sync — two-way binding between Settings → Nova Identity and the
memory bundle's soul file.

The soul file's BODY is `nova.persona`, verbatim. Edit either surface and
the other follows:

  Settings → soul   PATCH /api/v1/config/nova.persona reconciles inline.
  soul → Settings   A background loop polls the memory item and writes the
                    body back into platform_config (with audit + activity),
                    covering Brain-page edits, agent file tools, and direct
                    file edits — none of which pass through the orchestrator.

Direction is decided by a last-synced hash in Redis: whichever side still
matches the hash is stale and gets overwritten by the side that moved. If
both moved between polls (or the hash is missing, e.g. first boot),
Settings wins and a WARNING is logged — platform_config is the audited
operator surface, so it is the safer arbiter of a genuine race.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging

log = logging.getLogger(__name__)

SOUL_MEMORY_ID = "self/soul.md"
POLL_SECONDS = 20.0
_LAST_SYNCED_KEY = "nova:soul:last_synced_sha256"

# Applied on every soul write so the file self-describes the binding.
_SOUL_FRONTMATTER = {
    "title": "Soul",
    "description": (
        "Who Nova is — two-way synced with Settings → Nova Identity "
        "(nova.persona). Edit here or there; both stay consistent."
    ),
    "nova_synced_with": "settings:nova.persona",
    # One-way-mirror marker from the first iteration of this module; None
    # deletes it on the next write (frontmatter patches shallow-merge).
    "nova_managed_by": None,
}


def _sha(text: str) -> str:
    return hashlib.sha256(text.strip().encode("utf-8")).hexdigest()


async def _read_last_synced() -> str | None:
    from app.store import get_redis
    try:
        return await get_redis().get(_LAST_SYNCED_KEY)
    except Exception as exc:
        log.warning("Soul sync: could not read last-synced hash: %s", exc)
        return None


async def _write_last_synced(text: str) -> None:
    from app.store import get_redis
    try:
        await get_redis().set(_LAST_SYNCED_KEY, _sha(text))
    except Exception as exc:
        log.warning("Soul sync: could not store last-synced hash: %s", exc)


async def _write_soul(client, body: str) -> bool:
    resp = await client.put(
        f"/api/v1/memory/item/{SOUL_MEMORY_ID}",
        json={"frontmatter": _SOUL_FRONTMATTER, "content": body},
    )
    if resp.status_code == 501:
        log.warning(
            "Soul sync: memory backend does not support item updates — "
            "soul will not mirror Settings → Nova Identity"
        )
        return False
    resp.raise_for_status()
    return True


async def _write_persona(persona: str) -> None:
    """Write the soul body back into platform_config, with the same audit
    trail as a Settings save, plus an activity event so the change is
    operator-visible."""
    from app.db import get_pool

    encoded = json.dumps(persona)
    pool = get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            """
            WITH audit AS (
                INSERT INTO platform_config_audit (config_key, old_value, new_value)
                SELECT 'nova.persona',
                       (SELECT value FROM platform_config WHERE key = 'nova.persona'),
                       $1::jsonb
                WHERE (SELECT value FROM platform_config WHERE key = 'nova.persona')
                      IS DISTINCT FROM $1::jsonb
            )
            INSERT INTO platform_config (key, value, updated_at)
            VALUES ('nova.persona', $1::jsonb, NOW())
            ON CONFLICT (key) DO UPDATE
            SET value = EXCLUDED.value, updated_at = NOW()
            """,
            encoded,
        )
    try:
        from app.activity import emit_activity
        await emit_activity(
            get_pool(), "config_updated", "orchestrator",
            "Config 'nova.persona' updated from soul.md edit",
            metadata={"key": "nova.persona", "source": SOUL_MEMORY_ID},
        )
    except Exception:
        pass


async def reconcile_soul() -> bool:
    """Converge nova.persona and the soul file, whichever side moved.

    Returns True when the two surfaces are in sync (or syncing is
    impossible and retrying won't help); False for transient failures
    worth retrying (memory-service unreachable / not ready). Never raises.
    """
    from app.agents.runner import _get_platform_identity
    from app.clients import get_memory_client_async

    try:
        _name, persona = await _get_platform_identity()

        client = await get_memory_client_async()
        current = await client.get(f"/api/v1/memory/item/{SOUL_MEMORY_ID}")
        if current.status_code == 404:
            # ensure_bundle seeds the file at memory-service startup, so this
            # points at a misconfigured bundle — retrying won't create it.
            log.warning("Soul sync: %s not found in memory bundle", SOUL_MEMORY_ID)
            return True
        current.raise_for_status()
        body = current.json().get("content", "").strip()
        persona = persona.strip()

        if body == persona:
            await _write_last_synced(persona)
            return True

        last = await _read_last_synced()
        if last is not None and _sha(persona) == last:
            # Settings still matches the last sync → the soul file moved.
            await _write_persona(body)
            await _write_last_synced(body)
            log.info("Soul sync: soul.md edit written back to nova.persona")
            return True

        if last is not None and _sha(body) != last:
            # Neither side matches the last sync — both moved between polls.
            log.warning(
                "Soul sync: nova.persona and soul.md both changed since last "
                "sync — Settings wins, the soul.md edit is overwritten"
            )

        if await _write_soul(client, persona):
            await _write_last_synced(persona)
            log.info("Soul sync: %s updated from nova.persona", SOUL_MEMORY_ID)
        return True
    except Exception as exc:
        log.warning("Soul sync failed (will retry): %s", exc)
        return False


async def soul_sync_loop() -> None:
    """Reconcile at startup (retrying until memory-service is up), then keep
    polling so soul.md edits made anywhere flow back into Settings."""
    while not await reconcile_soul():
        await asyncio.sleep(15.0)
    while True:
        await asyncio.sleep(POLL_SECONDS)
        await reconcile_soul()
