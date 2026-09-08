"""The typed settings registry.

A setting exists because SETTING_DEFS says so — the table carries values
only. An unknown key is refused by name rather than quietly stored, so a
typo in the web app is visible the first time it is made instead of
becoming an invisible no-op setting.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from zoneinfo import ZoneInfo

import asyncpg
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app import db, schedule

logger = logging.getLogger("core")

router = APIRouter(prefix="/api/v1/settings", tags=["settings"])


@dataclass(frozen=True)
class SettingDef:
    key: str
    type: str  # one of _PYTHON_TYPES below
    default: Any
    description: str
    # A check beyond the type, run by validated() after it: returns the problem
    # in words, or None when the value is acceptable. Optional — most defs need
    # only the type. Never serialized (def_json drops it).
    validate: Callable[[Any], str | None] | None = None


def _timezone_problem(value: Any) -> str | None:
    """The zone must load: a misspelt zone stored here would make every
    absolute-time timer compute in the wrong place, silently."""
    if not isinstance(value, str) or not value.strip():
        return "the timezone is empty — give an IANA zone name like America/New_York"
    try:
        ZoneInfo(value)
    except Exception:  # ZoneInfoNotFoundError; ValueError for a path-shaped string
        return f"{value!r} is not an IANA timezone (e.g. America/New_York, Europe/London, UTC)"
    return None


def _digest_at_problem(value: Any) -> str | None:
    """The digest's hour, validated by BUILDING the schedule the digest beat
    actually runs on.

    `schedule.validate` is the only parser of a time of day in this service, so
    a value accepted here is a value the tick can compute a next firing from. A
    second, friendlier parser written here is how "24:00" gets stored by one
    and refused by the other, and the beat that could not advance its own spec
    would be paused hours later with a reason nobody connected to this write.
    """
    try:
        schedule.validate({"kind": "day", "at": value})
    except schedule.SpecError as exc:
        return f"it is the local time of day her digest is written — {exc}"
    return None


def _max_notices_problem(value: Any) -> str | None:
    """A backstop that may not be a muzzle. Zero (or a negative) would leave
    the digest composing a message about nothing while notices piled up
    unread — a silence that looks exactly like a quiet day."""
    if value < 1:
        return (
            f"at least one notice has to fit in a digest, got {value} — a digest that may "
            "carry none would tell him nothing, and would look like a quiet day"
        )
    return None


def def_json(definition: SettingDef) -> dict:
    """The def as the API lists it — every field but the validate callable."""
    return {
        "key": definition.key,
        "type": definition.type,
        "default": definition.default,
        "description": definition.description,
    }


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
        default="nova",
        description=(
            "Theme a browser that has never chosen one starts on. The web app "
            "owns the list of themes; 'nova' is its default."
        ),
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
        key="agents.responsiveness_check",
        type="bool",
        default=False,
        # The description IS the operator-facing disclaimer — the web toggle
        # renders it verbatim (S3 walk-fix round 9). It states the trade-off
        # (extra model calls), what it helps (small-model drift), and that it
        # is an AI judgment, not a guarantee. Default False: opt-in, and when
        # off the chat turn makes ZERO extra model calls.
        description=(
            "Double-check each reply is on-topic. When on, after Nova answers, "
            "a quick model check judges whether the reply addresses your "
            "message; if it drifted (e.g. to an earlier topic — common on "
            "smaller local models), Nova re-answers once, focused on your "
            "question. Trade-off: 1-2 extra model calls per reply, so replies "
            "are slower and use more compute (most noticeable on local "
            "models). The check is itself an AI judgment — in this version the "
            "same model reviewing its own reply — so it is a helpful safety "
            "net, not a guarantee. Off by default."
        ),
    ),
    SettingDef(
        key="nova.timezone",
        type="str",
        default="UTC",
        description=(
            "The IANA timezone this household lives in (e.g. America/New_York). "
            "Reminders and schedules at an absolute time are computed in it, and "
            "get_time answers in it. Set during setup; change it here if you move."
        ),
        validate=_timezone_problem,
    ),
    SettingDef(
        key="proactive.enabled",
        type="bool",
        default=False,
        description=(
            "Nova looks for herself: an hourly pass over the health checks that "
            "writes down what it finds and acts where she can, and one message a "
            "day about what is standing. Off by default — this is the switch that "
            "decides whether she looks at all. While it is off, a beat that fires "
            "runs no check, records nothing and delivers nothing, and says so on "
            "the firing; turn it on and the next firing works. Nothing else about "
            "her changes either way."
        ),
    ),
    SettingDef(
        key="proactive.digest_at",
        type="str",
        default="08:00",
        description=(
            "The time of day (HH:MM, 24-hour) her one daily digest is written, on "
            "the clock this household reads (nova.timezone). Writing it moves the "
            "digest beat's next firing straight away — the reply says where it "
            "landed. A paused digest stays paused."
        ),
        validate=_digest_at_problem,
    ),
    SettingDef(
        key="proactive.max_notices_per_day",
        type="int",
        default=20,
        description=(
            "The most findings one digest may carry. A backstop under the one-"
            "message-a-day rule: if something breaks at scale — fifty timers "
            "failing at once — the digest still reads as a message rather than a "
            "log. What does not fit is not dropped: it is still owed, and it is in "
            "the next digest. 20 fits a few sentences about each without the "
            "message becoming a wall."
        ),
        validate=_max_notices_problem,
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
                f"setting {key} expects {definition.type}, got {type(value).__name__}: {value!r}"
            ),
        )
    if definition.validate is not None:
        problem = definition.validate(value)
        if problem is not None:
            raise HTTPException(status_code=400, detail=f"setting {key}: {problem}")
    return definition


async def read_values(pool: asyncpg.Pool) -> dict[str, Any]:
    """Every def's current value, defaults where unset."""
    rows = await pool.fetch("SELECT key, value FROM settings")
    stored = {row["key"]: row["value"] for row in rows}
    return {d.key: stored.get(d.key, d.default) for d in SETTING_DEFS}


async def read_value(pool: asyncpg.Pool | asyncpg.Connection, key: str) -> Any:
    # Accepts a pool OR a live transaction connection, so a caller inside its
    # own transaction can read a setting on the same snapshot as the rows it
    # holds. Both expose .fetchrow.
    definition = DEFS_BY_KEY[key]
    row = await pool.fetchrow("SELECT value FROM settings WHERE key = $1", key)
    return definition.default if row is None else row["value"]


@router.get("")
async def list_settings() -> dict:
    values = await read_values(await db.get_pool())
    return {"settings": [{**def_json(d), "value": values[d.key]} for d in SETTING_DEFS]}


@router.put("")
async def write_setting(body: SettingWrite) -> dict:
    """Store one value, and re-time the digest beat when this was one of the
    settings its firing is computed from.

    `beats.ensure_beats` never touches an existing row, deliberately — a
    restart must not undo a pause or a hand-set hour — so a new digest time
    would otherwise sit in the table doing nothing until somebody deleted the
    row. The move happens HERE, at the write, and never by polling: the answer
    carries `note`, the words `retime_digest` composed from the row it read
    back, so the page says where the digest actually landed instead of assuming
    it moved.

    A re-time that could not be made does not undo the write — the value IS
    stored — so it is stated in `note` rather than raised: the operator sees
    the one thing that failed, and the setting he just typed is not silently
    rolled back under him.
    """
    definition = validated(body.key, body.value)
    pool = await db.get_pool()
    await pool.execute(
        "INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
        definition.key,
        body.value,
    )
    written: dict = {"key": definition.key, "value": body.value}
    # Function-local: app.beats imports THIS module at its top (it reads the
    # digest hour), so naming it up there would close the cycle — the same
    # one-way idiom beats itself uses for app.checks and app.delivery.
    from app import beats

    if definition.key in beats.retimes_the_digest():
        try:
            written["note"] = await beats.retime_digest(pool)
        except Exception as exc:  # noqa: BLE001 - the reason is the answer
            logger.exception("the digest beat could not be re-timed after writing %s", body.key)
            written["note"] = (
                f"{body.key} is stored, but the digest beat could not be re-timed "
                f"({type(exc).__name__}: {exc}) — it still fires at its old time"
            )
    return written
