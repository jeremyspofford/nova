"""Operator-set identity (nova.name / nova.persona from platform_config).

Cortex prompts speak as the operator's configured assistant — the same
identity every chat prompt gets — not a hardcoded "Nova".
"""

from __future__ import annotations

import json
import logging
import time

from .db import get_pool

log = logging.getLogger(__name__)

_TTL_SECONDS = 60.0
_cache: tuple[float, tuple[str, str]] | None = None


async def get_identity() -> tuple[str, str]:
    """(name, persona), cached briefly. ("Nova", "") on any failure."""
    global _cache
    if _cache and time.monotonic() - _cache[0] < _TTL_SECONDS:
        return _cache[1]
    name, persona = "Nova", ""
    try:
        pool = get_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT key, value #>> '{}' AS val FROM platform_config "
                "WHERE key IN ('nova.name', 'nova.persona')"
            )
        vals = {r["key"]: r["val"] for r in rows}
        raw_name = vals.get("nova.name") or "Nova"
        raw_persona = vals.get("nova.persona") or ""
        # Strip one layer of JSON quoting if double-encoded
        name = json.loads(raw_name) if raw_name.startswith('"') else raw_name
        persona = json.loads(raw_persona) if raw_persona.startswith('"') else raw_persona
        name = str(name).strip() or "Nova"
        persona = str(persona).strip()
    except Exception as exc:
        log.warning("Could not load platform identity: %s", exc)
    _cache = (time.monotonic(), (name, persona))
    return name, persona
