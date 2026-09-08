"""The delivery ladder: the two ways she speaks, and what "delivered" means.

S11-1/2 gave the watch beat eyes — it runs the checks, records notices and
reconciles the ones the world has cleared — and delivers NOTHING. This module
is the other half: the one place a beat hands a sentence to a channel, and the
one place that decides, per channel, whether anybody was actually reached.

Two rungs, in the order Jeremy set (docs/plans/rebuild/slice-11-proactive.md):

  * CHAT always runs and is the GUARANTEED rung. An assistant row in the
    owner's active conversation is what "she told you" means, and `reached` is
    that row's existence — written AND read back — never the fact that a write
    was attempted.
  * DEVICE runs only when the caller says `urgent`. Urgency is a property of
    the CHECK, declared in code (checks.Check.urgent) and carried here as a
    bool; nothing in this module reads a sentence to decide whether to push,
    so no wording a model produces can promote a finding to a 3am phone
    notification. The urgent list has exactly one entry — the stack being
    down — which is why an urgent notice may push at any hour.

The vocabulary is the one the Schedules page already renders (apps/web
schedulesFormat.deliveryLines): `ok` only from a channel's own result, `failed`
with the stated reason, `stated` for a fact that is neither — "no paired
device was connected". So a beat's receipt drills in beside a reminder's with
no new frontend code, and the three verdicts mean the same thing in both.

WHAT THIS MODULE REFUSES TO DO:

  * It never counts an attempt as a delivery. The chat rung SELECTs the row
    back after the INSERT; a helper that returned without writing (or a write
    the database rolled back under us) is a FAILED rung with those words, not a
    quiet success. "Accepted by transport" is never "received".
  * It never omits a rung. A leg that was climbed always reports — including
    "no paired device had a live socket", which is a stated fact rather than a
    silence. An absent rung is never a delivery.
  * It never lets `reached` disagree with the chat rung (Delivered.__post_init__
    recomputes it), and never lets a Rung carry a verdict outside the three the
    page renders or a detail with no words in it.

Nothing here asks anyone for anything (owner ruling 2026-09-03): a device that
is offline CANNOT be reached, which is stated; nothing decides that it MAY not
be.
"""

from __future__ import annotations

import json
import logging
import uuid
from dataclasses import dataclass

import asyncpg

from app import chat, conversations, devices_ws, peers, tools, traces
from app.identity import Person

logger = logging.getLogger("core")

# The channel names. "chat" and a device's own name are what the page prints;
# DEVICES names the leg itself, for the one rung that is about the device leg
# as a whole rather than about any one machine.
CHAT = "chat"
DEVICES = "devices"

# The three verdicts, exactly as apps/web/src/pages/schedules/schedulesFormat.ts
# renders them. A fourth would print as nothing there, so the set is closed
# here and Rung refuses anything outside it.
OK = "ok"
FAILED = "failed"
STATED = "stated"
VERDICTS = (OK, FAILED, STATED)

# The stated facts. Word-for-word the reminder's sentence for the no-device
# case (scheduler._fire_reminder), so one fact reads one way wherever it is
# stated.
NO_DEVICE_CONNECTED = "no paired device was connected"
NO_PERSON = "there is no person on this delivery, so there is no conversation to write into"
NO_PERSON_DEVICES = "there is no person on this delivery, so no device was notified"
NOT_READ_BACK = (
    "the chat row was not there when it was read back — nothing was delivered, "
    "whatever the write returned"
)
DEVICE_SILENT = "the device did not confirm"


class DeliveryError(Exception):
    """A Rung or a Delivered that could not be true of anything."""


@dataclass(frozen=True)
class Rung:
    """One channel's own verdict, in that channel's own words.

    `channel` is what was reached (or not): "chat", a device's name, or
    DEVICES for a statement about the device leg itself. `verdict` is one of
    the three the Schedules page renders. `detail` must SAY something — an
    empty detail is a rung that reports nothing, which is the silence this
    module exists to make impossible.
    """

    channel: str
    verdict: str
    detail: str

    def __post_init__(self) -> None:
        if self.verdict not in VERDICTS:
            raise DeliveryError(
                f"{self.verdict!r} is not a delivery verdict — the page renders "
                f"{', '.join(VERDICTS)}"
            )
        if not (self.channel or "").strip():
            raise DeliveryError("a rung has to name the channel it is about")
        if not (self.detail or "").strip():
            raise DeliveryError(
                f"the {self.channel} rung has no words — a rung that says nothing is a "
                "silence, and a silence is never a delivery"
            )


@dataclass(frozen=True)
class Delivered:
    """What one delivery actually did.

    `rungs` is every leg that was climbed, in order, chat first. `reached` is
    the ONE fact a caller acts on: an assistant row is in his conversation.
    `receipt` is the dict that goes onto the firing (`timer_firings.delivery`)
    and onto `notices.mark_delivered` — the Schedules page's own shape,
    `{"chat": {ok, reason?}, "devices": [{name, ok, reason?}], "note"?}`.

    The receipt is deliberately the page's vocabulary and nothing more; each
    channel's own words live in full on the rungs, where a caller that wants
    to log or quote them can find them.

    `reached` is recomputed here from the chat rung rather than trusted from
    the caller: a Delivered claiming it reached him with a failed chat rung
    would be exactly the "reported success I did not check" defect, so it
    cannot be constructed.
    """

    rungs: tuple[Rung, ...]
    reached: bool
    receipt: dict

    def __post_init__(self) -> None:
        chat_rungs = [rung for rung in self.rungs if rung.channel == CHAT]
        if not chat_rungs:
            raise DeliveryError(
                "every delivery climbs the chat rung — a Delivered with no chat rung "
                "cannot say whether anybody was reached"
            )
        if self.reached != (chat_rungs[0].verdict == OK):
            raise DeliveryError(
                "reached is the chat rung's verdict, not a separate claim: "
                f"chat is {chat_rungs[0].verdict!r} but reached is {self.reached!r}"
            )
        if not self.receipt:
            raise DeliveryError("a delivery receipt is never empty — the chat rung is always in it")

    @property
    def reason(self) -> str | None:
        """Why nobody was reached, in the chat rung's own words — None when
        somebody was. This is the string the caller hands notices.mark_failed."""
        if self.reached:
            return None
        return next(rung.detail for rung in self.rungs if rung.channel == CHAT)

    def rung(self, channel: str) -> Rung | None:
        return next((rung for rung in self.rungs if rung.channel == channel), None)


async def deliver(
    app,
    pool: asyncpg.Pool,
    *,
    text: str,
    urgent: bool,
    person: Person | None,
    turn: traces.Turn | None = None,
) -> Delivered:
    """Say `text` to `person`, and report per channel what actually happened.

    The chat rung always runs: `text` is persisted as an assistant row in the
    person's ACTIVE conversation (conversations.active_conversation — the same
    row his chat page reads; a beat's own conversation is inactive and can
    never be picked here) and then read back. `reached` is True only if that
    row is there afterwards.

    The device rung runs ONLY when `urgent` is True, and then it runs for every
    paired device with a live socket right now — one `device_notify` each, one
    Rung each, `ok` taken only from that device's own result frame. When no
    paired device has a live socket the leg still reports: ONE rung with
    verdict `stated` naming that fact. `device_notify` has no queue, so "your
    phone was asleep" is a stated fact and never a silent drop.

    `turn` is optional and changes only the TRACE, never a verdict: given the
    beat's turn, the chat row is linked to it (the link is what lets a
    transcript be badged from the trace) and each device call goes through
    chat._run_tool, so it files a real `tool` span with its args redacted and
    the connectivity fact it determined. Without a turn the same call goes
    straight through tools.dispatch — same executor, same `ok`, no span.

    THE CALLER'S OBLIGATION, stated here because this module cannot do it: if
    `reached` is False, nobody was told, and the notices this text was for must
    be marked FAILED with `Delivered.reason` (notices.mark_failed) — never
    delivered, never quietly dropped. `failed` keeps a notice in
    DELIVERABLE_STATES, so the next digest still owes it to him: a repeat of
    something that never landed is not a repeat. When `reached` is True the
    caller hands `Delivered.receipt` to notices.mark_delivered, which refuses
    an empty receipt for the same reason this function refuses to build one.
    """
    rungs: list[Rung] = []
    receipt: dict = {}

    chat_rung = await _chat_rung(pool, text=text, person=person, turn=turn)
    rungs.append(chat_rung)
    receipt[CHAT] = {"ok": chat_rung.verdict == OK}
    if chat_rung.verdict != OK:
        receipt[CHAT]["reason"] = chat_rung.detail
        logger.warning("delivery: the chat rung failed — %s", chat_rung.detail)

    if urgent:
        # Only the urgent leg touches a device. A digest is not allowed to
        # reach for one, so there is no "devices" key on its receipt at all:
        # an empty list would read as "we looked and found none", which is a
        # different fact from "we never looked".
        device_rungs, entries, note = await _device_rungs(
            app, pool, text=text, person=person, turn=turn
        )
        rungs.extend(device_rungs)
        receipt[DEVICES] = entries
        if note is not None:
            receipt["note"] = note

    return Delivered(rungs=tuple(rungs), reached=chat_rung.verdict == OK, receipt=receipt)


# -- the chat rung -------------------------------------------------------------


async def _chat_rung(
    pool: asyncpg.Pool, *, text: str, person: Person | None, turn: traces.Turn | None
) -> Rung:
    """Write the row, then read it back. Both halves are the delivery.

    chat._persist_assistant is reused rather than a second INSERT (the same
    reuse scheduler._fire_reminder makes) so a beat's message goes through the
    ONE persist boundary — including without_markup, which is why the read-back
    compares against the persisted form rather than against the argument.
    """
    if person is None:
        return Rung(CHAT, FAILED, NO_PERSON)
    try:
        conversation = await conversations.active_conversation(pool, person)
    except Exception as exc:  # noqa: BLE001 - the reason is the record
        return Rung(
            CHAT,
            FAILED,
            f"could not find {person.name}'s conversation: {peers.reason(exc)}",
        )
    conversation_id = conversation["id"]
    turn_id = turn.id if turn is not None else None
    try:
        await chat._persist_assistant(pool, conversation_id, text, turn_id)
    except Exception as exc:  # noqa: BLE001 - the reason is the record
        return Rung(CHAT, FAILED, f"could not write the chat row: {peers.reason(exc)}")
    try:
        message_id = await pool.fetchval(
            "SELECT id FROM messages WHERE conversation_id = $1 AND role = 'assistant' "
            "AND content = $2 AND turn_id IS NOT DISTINCT FROM $3 "
            "ORDER BY created_at DESC LIMIT 1",
            conversation_id,
            chat.without_markup(text),
            turn_id,
        )
    except Exception as exc:  # noqa: BLE001 - the reason is the record
        return Rung(CHAT, FAILED, f"could not read the chat row back: {peers.reason(exc)}")
    if message_id is None:
        return Rung(CHAT, FAILED, NOT_READ_BACK)
    return Rung(CHAT, OK, f"message {message_id} in conversation {conversation_id}")


# -- the device rung -----------------------------------------------------------


async def _connected_device_names(pool: asyncpg.Pool) -> list[str]:
    """Every paired, live device whose socket is in the hub RIGHT NOW: the hub's
    live set intersected with the registry's unrevoked rows, sorted by name.

    Derived from the hub every call — there is no stored "connected" flag to go
    stale, and a revoked row is excluded by the ABSENCE of a match rather than
    by anyone remembering to check a column.
    """
    ids = [uuid.UUID(device_id) for device_id in devices_ws.hub.connected_ids()]
    if not ids:
        return []
    rows = await pool.fetch(
        "SELECT name FROM devices WHERE revoked_at IS NULL AND id = ANY($1::uuid[]) ORDER BY name",
        ids,
    )
    return [row["name"] for row in rows]


async def _device_rungs(
    app,
    pool: asyncpg.Pool,
    *,
    text: str,
    person: Person | None,
    turn: traces.Turn | None,
) -> tuple[tuple[Rung, ...], list[dict], str | None]:
    """The urgent leg: one rung per connected device, or one stated rung.

    Returns the rungs, the receipt's `devices` entries, and the receipt's
    `note` (the stated fact) when there is one.
    """
    if person is None:
        return (Rung(DEVICES, STATED, NO_PERSON_DEVICES),), [], NO_PERSON_DEVICES
    try:
        names = await _connected_device_names(pool)
    except Exception as exc:  # noqa: BLE001 - the reason is the record
        # The receipt's only failure slot is a device entry, so the leg names
        # ITSELF here rather than borrowing `note`: a note renders as `stated`,
        # and a failure dressed as a stated fact is the thing this module is
        # for. Clumsy to read, honest to read.
        reason = f"could not read which devices are connected: {peers.reason(exc)}"
        return (
            (Rung(DEVICES, FAILED, reason),),
            [{"name": DEVICES, "ok": False, "reason": reason}],
            None,
        )
    if not names:
        return (Rung(DEVICES, STATED, NO_DEVICE_CONNECTED),), [], NO_DEVICE_CONNECTED

    ctx = tools.context_for(app, person, facts_sink=[])
    rungs: list[Rung] = []
    entries: list[dict] = []
    for index, name in enumerate(names, start=1):
        result, ok = await _notify(turn, ctx, index=index, device=name, text=text)
        if ok:
            rungs.append(Rung(name, OK, result.strip() or "the device confirmed"))
            entries.append({"name": name, "ok": True})
        else:
            # The tool's OWN stated head, never a sentence written here: a
            # device that refused said why, and that is what the page shows.
            reason = chat._activity_reason(result) or DEVICE_SILENT
            rungs.append(Rung(name, FAILED, reason))
            entries.append({"name": name, "ok": False, "reason": reason})
    return tuple(rungs), entries, None


async def _notify(
    turn: traces.Turn | None,
    ctx: tools.ToolContext,
    *,
    index: int,
    device: str,
    text: str,
) -> tuple[str, bool]:
    """One device_notify, through the same funnel every tool call goes through.

    `ok` is decided by tools.dispatch and by nothing here: device_notify raises
    ToolFailure unless the device's own `result` frame said ok, so an `ok` rung
    is the device's word, not core's. The two paths differ ONLY in whether a
    span is filed — chat._run_tool is dispatch plus the span — so a delivery
    made without a turn reports exactly what one made with a turn reports.
    """
    call = chat.ToolCall(
        id=f"call_{index}",
        name="device_notify",
        arguments=json.dumps({"device": device, "message": text}),
    )
    if turn is not None:
        return await chat._run_tool(turn, ctx, call)
    return await tools.dispatch(call.name, call.arguments, ctx)
