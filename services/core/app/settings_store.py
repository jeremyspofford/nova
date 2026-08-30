"""The typed settings registry.

A setting exists because SETTING_DEFS says so — the table carries values
only. An unknown key is refused by name rather than quietly stored, so a
typo in the web app is visible the first time it is made instead of
becoming an invisible no-op setting.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

import asyncpg
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app import db

router = APIRouter(prefix="/api/v1/settings", tags=["settings"])


@dataclass(frozen=True)
class SettingDef:
    key: str
    type: str  # one of _PYTHON_TYPES below
    default: Any
    description: str


SETTING_DEFS: tuple[SettingDef, ...] = (
    SettingDef(
        key="onboarding.completed",
        type="bool",
        default=False,
        description="The setup wizard finished, inference round-trip included.",
    ),
    SettingDef(
        key="chat.model",
        type="str",
        default="",
        description="Model core asks the gateway for on every chat turn.",
    ),
    SettingDef(
        key="appearance.default_preset",
        type="str",
        default="default",
        description="Theme preset the web app starts on.",
    ),
    SettingDef(
        key="agents.max_tool_rounds",
        type="int",
        default=6,
        description=(
            "How many times one chat turn may call the model while it is still "
            "asking for tools. Reaching the limit ends the turn with a note "
            "saying so, never silently."
        ),
    ),
    SettingDef(
        key="autonomy.graduation_runs",
        type="int",
        default=5,
        description=(
            "Consecutive approved-and-succeeded runs of a consent-tier action "
            "class before it is promoted to auto (ruling S3-R5). A failure or "
            "an operator revoke resets the count and, for an earned class, "
            "demotes it back to consent."
        ),
    ),
)

DEFS_BY_KEY: dict[str, SettingDef] = {d.key: d for d in SETTING_DEFS}

# type(value) is checked exactly: python says True == 1, JSON does not — so
# `int` here refuses `true` rather than storing it as 1.
_PYTHON_TYPES: dict[str, type] = {"bool": bool, "str": str, "int": int}


class SettingWrite(BaseModel):
    key: str
    value: Any = Field(default=...)


def validated(key: str, value: Any) -> SettingDef:
    """The def for this key, or a 400 stating what is wrong."""
    definition = DEFS_BY_KEY.get(key)
    if definition is None:
        raise HTTPException(
            status_code=400,
            detail=f"unknown setting key: {key} — known keys: {', '.join(sorted(DEFS_BY_KEY))}",
        )
    expected = _PYTHON_TYPES[definition.type]
    if type(value) is not expected:
        raise HTTPException(
            status_code=400,
            detail=(
                f"setting {key} expects {definition.type}, "
                f"got {type(value).__name__}: {value!r}"
            ),
        )
    return definition


async def read_values(pool: asyncpg.Pool) -> dict[str, Any]:
    """Every def's current value, defaults where unset."""
    rows = await pool.fetch("SELECT key, value FROM settings")
    stored = {row["key"]: row["value"] for row in rows}
    return {d.key: stored.get(d.key, d.default) for d in SETTING_DEFS}


async def read_value(pool: asyncpg.Pool | asyncpg.Connection, key: str) -> Any:
    # Accepts a pool OR a live transaction connection: autonomy.record_outcome
    # reads the graduation threshold on its own transaction's conn so the read
    # sees the same snapshot as the row it just locked. Both expose .fetchrow.
    definition = DEFS_BY_KEY[key]
    row = await pool.fetchrow("SELECT value FROM settings WHERE key = $1", key)
    return definition.default if row is None else row["value"]


@router.get("")
async def list_settings() -> dict:
    values = await read_values(await db.get_pool())
    return {"settings": [{**asdict(d), "value": values[d.key]} for d in SETTING_DEFS]}


@router.put("")
async def write_setting(body: SettingWrite) -> dict:
    definition = validated(body.key, body.value)
    pool = await db.get_pool()
    await pool.execute(
        "INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
        definition.key,
        body.value,
    )
    return {"key": definition.key, "value": body.value}
