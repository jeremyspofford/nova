"""The delivery ladder: what "delivered" means on each rung.

The pins here are all one rule in different clothes — a delivery that reached
nobody is a FAILED delivery, never a quiet success:

  * the chat rung is the row, READ BACK. A persist that returns without
    leaving a row is a failure with those words, not an ok.
  * `reached` is the chat rung's verdict and cannot be claimed separately.
  * the device rung's `ok` comes from the device's own result frame — a device
    that refuses is a failed rung IN ITS OWN WORDS.
  * no connected device is ONE stated rung, never an absent one; the digest
    still landed, so reached stays True.
  * only urgent touches a device: a digest never puts a frame on a socket.
"""

from __future__ import annotations

import asyncio
import uuid

import pytest

from app import chat, delivery, devices, devices_ws, traces
from app.identity import Person
from app.main import app
from tests.conftest import requires_db
from tests.device_fakes import FakeDevice, FakeWSConn

pytestmark = requires_db

TEXT = "The gateway has been unreachable for 40 minutes."


@pytest.fixture(autouse=True)
def _clean_hub():
    devices_ws.hub._conns.clear()
    devices_ws.hub._pending.clear()
    yield
    devices_ws.hub._conns.clear()
    devices_ws.hub._pending.clear()


async def _owner(pool) -> Person:
    pid = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ('jeremy', 'owner') RETURNING id"
    )
    return Person(id=pid, name="jeremy", role="owner")


async def _inactive_conversation(pool, person: Person) -> uuid.UUID:
    """A beat's own conversation: the newest row, deliberately NOT active, so a
    delivery that picked the newest row instead of the ACTIVE one would land
    here and this suite would say so."""
    return await pool.fetchval(
        "INSERT INTO conversations (person_id, title, active) VALUES ($1, 'beats', false) "
        "RETURNING id",
        person.id,
    )


async def _messages(pool):
    return await pool.fetch(
        "SELECT m.id, m.role, m.content, m.turn_id, m.conversation_id, c.active "
        "FROM messages m JOIN conversations c ON c.id = m.conversation_id "
        "ORDER BY m.created_at"
    )


async def _connect(pool, *, name: str) -> tuple[FakeDevice, FakeWSConn, asyncio.Task]:
    """Enroll and drive serve() to a registered socket (test_scheduler's shape)."""
    device = FakeDevice()
    creator = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ('adult', 'adult') RETURNING id"
    )
    code = await devices.mint_pairing_code(pool, created_by=creator)
    enrolled = await devices.enroll(
        pool,
        code=code["code"],
        pubkey=device.pubkey_hex,
        name=name,
        platform="linux",
        hostname="host",
    )
    device.device_id = enrolled["device_id"]
    conn = FakeWSConn()
    task = asyncio.create_task(devices_ws.serve(conn, pool))
    ready = await asyncio.wait_for(device.handshake(conn), 2)
    assert ready["type"] == "ready"
    return device, conn, task


async def _close(conn: FakeWSConn, task: asyncio.Task) -> None:
    conn.feed_close()
    await asyncio.wait_for(task, 2)


def _frames(conn: FakeWSConn) -> list[str]:
    return [frame["type"] for frame in conn.sent]


# -- the chat rung -------------------------------------------------------------


async def test_the_chat_rung_writes_the_row_into_the_active_conversation_and_reads_it_back(pool):
    person = await _owner(pool)
    beats_conversation = await _inactive_conversation(pool, person)
    turn = await traces.open_turn(pool, kind="beat", person_id=person.id)

    result = await delivery.deliver(app, pool, text=TEXT, urgent=False, person=person, turn=turn)

    assert result.reached is True
    assert result.reason is None
    (rung,) = result.rungs
    assert (rung.channel, rung.verdict) == ("chat", "ok")

    (message,) = await _messages(pool)
    # The row is the delivery: it is the assistant's, it carries the beat's
    # turn (so the transcript can be badged from the trace), and it landed in
    # the ACTIVE conversation — never in the beat's own inactive one.
    assert (message["role"], message["content"]) == ("assistant", TEXT)
    assert message["turn_id"] == turn.id
    assert message["active"] is True
    assert message["conversation_id"] != beats_conversation
    # The rung's words name the row it read back, so the receipt can be checked
    # against the database by hand.
    assert str(message["id"]) in rung.detail
    assert result.receipt == {"chat": {"ok": True}}


async def test_a_delivery_with_no_turn_still_writes_the_row_unlinked(pool):
    """`turn` changes the TRACE, never a verdict."""
    person = await _owner(pool)

    result = await delivery.deliver(app, pool, text=TEXT, urgent=False, person=person)

    assert result.reached is True
    (message,) = await _messages(pool)
    assert message["content"] == TEXT and message["turn_id"] is None


async def test_a_chat_write_that_raises_makes_reached_false_with_the_reason(pool, monkeypatch):
    person = await _owner(pool)

    async def boom(*args, **kwargs):
        raise RuntimeError("the messages table is gone")

    monkeypatch.setattr(chat, "_persist_assistant", boom)

    result = await delivery.deliver(app, pool, text=TEXT, urgent=False, person=person)

    assert result.reached is False
    (rung,) = result.rungs
    assert rung.verdict == "failed"
    assert rung.detail == "could not write the chat row: RuntimeError: the messages table is gone"
    # The reason the caller hands notices.mark_failed is the rung's own words.
    assert result.reason == rung.detail
    assert result.receipt == {"chat": {"ok": False, "reason": rung.detail}}
    assert await _messages(pool) == []


async def test_a_write_that_left_no_row_is_a_failed_delivery_not_a_quiet_success(pool, monkeypatch):
    """The read-back is the point: a persist that returns cleanly and writes
    nothing is exactly the "reported success I did not check" defect, and the
    only thing that catches it is going back to the database to look."""
    person = await _owner(pool)

    async def wrote_nothing(*args, **kwargs):
        return None

    monkeypatch.setattr(chat, "_persist_assistant", wrote_nothing)

    result = await delivery.deliver(app, pool, text=TEXT, urgent=False, person=person)

    assert result.reached is False
    (rung,) = result.rungs
    assert (rung.channel, rung.verdict) == ("chat", "failed")
    assert rung.detail == delivery.NOT_READ_BACK
    assert result.receipt["chat"] == {"ok": False, "reason": delivery.NOT_READ_BACK}


async def test_a_delivery_with_no_person_has_nowhere_to_write_and_says_so(pool):
    result = await delivery.deliver(app, pool, text=TEXT, urgent=True, person=None)

    assert result.reached is False
    chat_rung = result.rung("chat")
    assert chat_rung is not None and chat_rung.detail == delivery.NO_PERSON
    # The urgent leg still REPORTS: an absent rung is never a delivery.
    devices_rung = result.rung("devices")
    assert devices_rung is not None
    assert (devices_rung.verdict, devices_rung.detail) == ("stated", delivery.NO_PERSON_DEVICES)
    assert result.receipt["note"] == delivery.NO_PERSON_DEVICES


# -- the device rung -----------------------------------------------------------


async def test_urgent_notifies_every_connected_device_and_each_ok_is_its_own_result_frame(pool):
    person = await _owner(pool)
    laptop, laptop_conn, laptop_task = await _connect(pool, name="laptop")
    phone, phone_conn, phone_task = await _connect(pool, name="phone")
    # A paired device with no live socket is not a target — and not a failure.
    await devices.enroll(
        pool,
        code=(await devices.mint_pairing_code(pool, created_by=person.id))["code"],
        pubkey=FakeDevice().pubkey_hex,
        name="desktop",
        platform="linux",
        hostname="host",
    )

    result, laptop_command, phone_command = await asyncio.gather(
        delivery.deliver(app, pool, text=TEXT, urgent=True, person=person),
        asyncio.wait_for(laptop.answer_command(laptop_conn), 5),
        asyncio.wait_for(phone.answer_command(phone_conn), 5),
    )

    assert result.reached is True
    assert [(rung.channel, rung.verdict) for rung in result.rungs] == [
        ("chat", "ok"),
        ("laptop", "ok"),
        ("phone", "ok"),
    ]
    # Each device's rung carries the tool's own words about that machine.
    assert result.rung("laptop").detail == "Sent a notification to laptop."
    assert result.rung("phone").detail == "Sent a notification to phone."
    assert result.receipt == {
        "chat": {"ok": True},
        "devices": [{"name": "laptop", "ok": True}, {"name": "phone", "ok": True}],
    }
    # The text he reads in chat is the text his phone buzzed with.
    for command in (laptop_command, phone_command):
        assert command["envelope"]["capability"] == "system.notify"
        assert command["envelope"]["args"]["message"] == TEXT

    await _close(laptop_conn, laptop_task)
    await _close(phone_conn, phone_task)


async def test_a_device_that_refuses_is_a_failed_rung_in_its_own_words(pool):
    person = await _owner(pool)
    laptop, conn, task = await _connect(pool, name="laptop")

    result, _command = await asyncio.gather(
        delivery.deliver(app, pool, text=TEXT, urgent=True, person=person),
        asyncio.wait_for(
            laptop.answer_command(conn, ok=False, error="notifications are switched off"), 5
        ),
    )

    # The chat rung landed, so somebody was reached; the device did not, and
    # says why in the words the device itself used.
    assert result.reached is True
    rung = result.rung("laptop")
    assert (rung.verdict, rung.detail) == ("failed", "laptop: notifications are switched off")
    assert result.receipt["devices"] == [
        {"name": "laptop", "ok": False, "reason": "laptop: notifications are switched off"}
    ]

    await _close(conn, task)


async def test_urgent_with_no_connected_device_is_one_stated_rung_and_chat_still_reached(pool):
    person = await _owner(pool)
    # Paired but never connected: device_notify has no queue, so "asleep" is a
    # stated fact, not a silent drop and not a failure.
    await devices.enroll(
        pool,
        code=(await devices.mint_pairing_code(pool, created_by=person.id))["code"],
        pubkey=FakeDevice().pubkey_hex,
        name="desktop",
        platform="linux",
        hostname="host",
    )

    result = await delivery.deliver(app, pool, text=TEXT, urgent=True, person=person)

    assert result.reached is True
    assert [(rung.channel, rung.verdict) for rung in result.rungs] == [
        ("chat", "ok"),
        ("devices", "stated"),
    ]
    assert result.rung("devices").detail == delivery.NO_DEVICE_CONNECTED
    assert result.receipt == {
        "chat": {"ok": True},
        "devices": [],
        "note": delivery.NO_DEVICE_CONNECTED,
    }


async def test_a_device_leg_that_could_not_even_look_is_failed_never_stated(pool, monkeypatch):
    """`stated` means "we looked and this is the fact". A lookup that fell over
    looked at nothing, so it is a FAILURE with its reason — dressing it as a
    stated fact would be the silent-fallback defect wearing the page's own
    vocabulary."""
    person = await _owner(pool)

    async def blind(*args, **kwargs):
        raise RuntimeError("the devices table is unreadable")

    monkeypatch.setattr(delivery, "_connected_device_names", blind)

    result = await delivery.deliver(app, pool, text=TEXT, urgent=True, person=person)

    rung = result.rung("devices")
    assert rung.verdict == "failed"
    assert rung.detail == (
        "could not read which devices are connected: RuntimeError: the devices table is unreadable"
    )
    assert result.receipt["devices"] == [{"name": "devices", "ok": False, "reason": rung.detail}]
    assert "note" not in result.receipt


async def test_a_revoked_device_holding_a_socket_is_not_a_target(pool):
    """The target list is the hub's live set INTERSECTED with the unrevoked
    rows — derived both ways, so a revoked machine drops out by the absence of
    a row rather than by anyone remembering to check a flag."""
    person = await _owner(pool)
    _laptop, conn, task = await _connect(pool, name="laptop")
    device_id = uuid.UUID(next(iter(devices_ws.hub.connected_ids())))
    await devices.revoke(pool, device_id=device_id, actor="jeremy")

    result = await delivery.deliver(app, pool, text=TEXT, urgent=True, person=person)

    assert [rung.channel for rung in result.rungs] == ["chat", "devices"]
    assert result.rung("devices").verdict == "stated"
    assert "command" not in _frames(conn)

    await _close(conn, task)


async def test_a_digest_never_touches_a_device(pool):
    """Only the urgent family may push. A non-urgent delivery puts NO frame on
    a live socket and says nothing about devices at all — an empty devices list
    would read as "we looked and found none", which is a different fact."""
    person = await _owner(pool)
    _laptop, conn, task = await _connect(pool, name="laptop")

    result = await delivery.deliver(app, pool, text=TEXT, urgent=False, person=person)

    assert result.reached is True
    assert [rung.channel for rung in result.rungs] == ["chat"]
    assert result.receipt == {"chat": {"ok": True}}
    assert "devices" not in result.receipt
    assert "command" not in _frames(conn)

    await _close(conn, task)


# -- the shapes themselves -----------------------------------------------------


async def test_the_receipt_only_ever_speaks_the_vocabulary_the_schedules_page_renders(pool):
    """schedulesFormat.deliveryLines reads {"chat": {ok, reason?}, "devices":
    [{name, ok, reason?}], "note"?} and nothing else — a key it has not met
    renders as silence, so the shape is pinned on this side too."""
    person = await _owner(pool)
    laptop, conn, task = await _connect(pool, name="laptop")

    result, _command = await asyncio.gather(
        delivery.deliver(app, pool, text=TEXT, urgent=True, person=person),
        asyncio.wait_for(laptop.answer_command(conn), 5),
    )

    assert set(result.receipt) <= {"chat", "devices", "note"}
    assert set(result.receipt["chat"]) <= {"ok", "reason"}
    for entry in result.receipt["devices"]:
        assert set(entry) <= {"name", "ok", "reason"}
    assert {rung.verdict for rung in result.rungs} <= set(delivery.VERDICTS)

    await _close(conn, task)


def test_a_rung_cannot_carry_a_verdict_the_page_cannot_render_or_say_nothing():
    with pytest.raises(delivery.DeliveryError):
        delivery.Rung("chat", "sent", "off it went")
    with pytest.raises(delivery.DeliveryError):
        delivery.Rung("chat", "ok", "   ")
    with pytest.raises(delivery.DeliveryError):
        delivery.Rung("", "ok", "somewhere")


def test_reached_cannot_be_claimed_against_a_failed_chat_rung():
    failed = delivery.Rung("chat", "failed", "the conversation is gone")
    with pytest.raises(delivery.DeliveryError):
        delivery.Delivered(rungs=(failed,), reached=True, receipt={"chat": {"ok": False}})
    with pytest.raises(delivery.DeliveryError):
        delivery.Delivered(
            rungs=(delivery.Rung("laptop", "ok", "sent"),), reached=True, receipt={"x": 1}
        )
    # And the receipt is never empty: mark_delivered refuses one, so a delivery
    # can never hand it one.
    with pytest.raises(delivery.DeliveryError):
        delivery.Delivered(
            rungs=(delivery.Rung("chat", "ok", "message 1"),), reached=True, receipt={}
        )
