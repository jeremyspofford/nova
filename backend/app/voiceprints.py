"""Household voice profiles — who Nova recognizes when someone speaks.

Enrollment averages a few utterance embeddings into a per-person
voiceprint; at transcribe time the utterance's embedding is cosine-matched
against every enrolled print. A match needs BOTH a floor score AND a clear
margin over the runner-up — anything else is `unknown`, which the callers
treat as the most-restricted tier (docs/plans/speaker-id.md).

Personalization, never authentication: nothing in here grants anything.
Matching only ever selects which *narrowing* applies downstream.
"""

import json
import logging
import math
import uuid as uuid_mod
from typing import Optional

from app import db, settings_store

log = logging.getLogger(__name__)

_FIELDS = ("id", "name", "role", "persona_notes", "enrolled_clips",
           "created_at", "updated_at")


def _row(r, with_print: bool = False) -> dict:
    d = {k: (str(r[k]) if k == "id" else r[k]) for k in _FIELDS}
    for k in ("created_at", "updated_at"):
        d[k] = str(d[k]) if d[k] else None
    d["enrolled"] = r["voiceprint"] is not None
    if with_print:
        vp = r["voiceprint"]
        d["voiceprint"] = json.loads(vp) if isinstance(vp, str) else vp
    return d


async def list_profiles() -> list[dict]:
    async with db.acquire() as conn:
        rows = await conn.fetch(
            "SELECT * FROM user_profiles ORDER BY created_at")
    return [_row(r) for r in rows]


async def get(profile_id: str) -> Optional[dict]:
    try:
        pid = uuid_mod.UUID(str(profile_id))
    except ValueError:
        return None
    async with db.acquire() as conn:
        r = await conn.fetchrow("SELECT * FROM user_profiles WHERE id = $1", pid)
    return _row(r) if r else None


async def create(name: str, role: str, persona_notes: Optional[str]) -> dict:
    if role not in ("operator", "kid", "guest"):
        raise ValueError("role must be operator, kid, or guest")
    async with db.acquire() as conn:
        r = await conn.fetchrow(
            """INSERT INTO user_profiles (id, name, role, persona_notes)
               VALUES ($1, $2, $3, $4) RETURNING *""",
            uuid_mod.uuid4(), name.strip(), role, (persona_notes or "").strip() or None)
    log.info("profile created: %s (%s)", name, role)
    return _row(r)


async def update(profile_id: str, patch: dict) -> Optional[dict]:
    allowed = {k: v for k, v in patch.items()
               if k in ("name", "role", "persona_notes")}
    if "role" in allowed and allowed["role"] not in ("operator", "kid", "guest"):
        raise ValueError("role must be operator, kid, or guest")
    if not allowed:
        return await get(profile_id)
    sets = ", ".join(f"{k} = ${i + 2}" for i, k in enumerate(allowed))
    async with db.acquire() as conn:
        r = await conn.fetchrow(
            f"UPDATE user_profiles SET {sets}, updated_at = now() "
            f"WHERE id = $1 RETURNING *",
            uuid_mod.UUID(str(profile_id)), *allowed.values())
    return _row(r) if r else None


async def delete(profile_id: str) -> bool:
    """Deleting a profile deletes its voiceprint with it — the whole
    biometric record lives and dies in this one row."""
    async with db.acquire() as conn:
        result = await conn.execute(
            "DELETE FROM user_profiles WHERE id = $1",
            uuid_mod.UUID(str(profile_id)))
    return result.endswith("1")


async def add_enrollment(profile_id: str, embedding: list[float]) -> Optional[dict]:
    """Fold one more clip's embedding into the profile's running mean.
    The clip's audio was already discarded by the caller — only the vector
    arrives here."""
    async with db.acquire() as conn:
        r = await conn.fetchrow(
            "SELECT * FROM user_profiles WHERE id = $1",
            uuid_mod.UUID(str(profile_id)))
        if r is None:
            return None
        n = r["enrolled_clips"]
        old = r["voiceprint"]
        old = json.loads(old) if isinstance(old, str) else old
        if old and len(old) == len(embedding) and n > 0:
            merged = [(o * n + e) / (n + 1) for o, e in zip(old, embedding)]
        else:
            merged, n = list(embedding), 0
        r = await conn.fetchrow(
            """UPDATE user_profiles
               SET voiceprint = $2, enrolled_clips = $3, updated_at = now()
               WHERE id = $1 RETURNING *""",
            r["id"], json.dumps(merged), n + 1)
    log.info("enrollment clip %d folded into %s", n + 1, r["name"])
    return _row(r)


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


async def match(embedding: Optional[list[float]]) -> Optional[dict]:
    """The utterance's speaker, or None for unknown. A match needs the top
    score over `voice.speaker_threshold` AND a `voice.speaker_margin` gap
    to the runner-up — a hesitant match is treated as no match, landing in
    the safe ask-who-this-is path."""
    if not embedding:
        return None
    async with db.acquire() as conn:
        rows = await conn.fetch(
            "SELECT * FROM user_profiles WHERE voiceprint IS NOT NULL")
    if not rows:
        return None
    scored = []
    for r in rows:
        vp = r["voiceprint"]
        vp = json.loads(vp) if isinstance(vp, str) else vp
        if len(vp) != len(embedding):
            continue   # model changed since enrollment — re-enroll
        scored.append((_cosine(embedding, vp), r))
    if not scored:
        return None
    scored.sort(key=lambda t: t[0], reverse=True)
    top, best = scored[0]
    second = scored[1][0] if len(scored) > 1 else -1.0
    threshold = float(settings_store.get("voice.speaker_threshold") or 0.55)
    margin = float(settings_store.get("voice.speaker_margin") or 0.10)
    if top < threshold or (top - second) < margin:
        log.info("speaker match declined: top=%.3f second=%.3f", top, second)
        return None
    out = _row(best)
    out["confidence"] = round(top, 3)
    return out


async def enrolled_count() -> int:
    async with db.acquire() as conn:
        return await conn.fetchval(
            "SELECT count(*) FROM user_profiles WHERE voiceprint IS NOT NULL") or 0
