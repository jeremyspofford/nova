"""app/wake_attempts.py (S46a T4): the single writer of the wake ledger.

Insert at send, update as evidence arrives, and an outcome only the columns
show: settle() derives it, nobody passes one in. Reads never carry the MAC —
the reply and span code that reads them can then not leak it. Documentation
MAC/addresses only (the repo is public)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from app import wake_attempts
from tests.conftest import requires_db

pytestmark = requires_db

MAC = "02:00:5e:10:00:01"
BROADCAST = "192.0.2.255"
T0 = datetime(2026, 10, 11, 12, 0, tzinfo=UTC)


async def _device(pool, name: str = "box"):
    return await pool.fetchval(
        "INSERT INTO devices (name, platform, hostname, pubkey) "
        "VALUES ($1, 'windows', $1, $2) RETURNING id",
        name,
        "ab" * 32,
    )


async def _sent(pool, device, relay=None, **kw):
    args = {
        "device_id": device,
        "relay_device_id": relay,
        "adapter": "Wi-Fi",
        "mac": MAC,
        "relay_iface": "eth0",
        "broadcast": BROADCAST,
        "packets": 6,
        "trigger": "tool",
        "sent_at": T0,
        "deadline_s": 120,
        **kw,
    }
    return await wake_attempts.record_sent(pool, **args)


def test_the_closed_sets_match_the_migration():
    assert wake_attempts.TRIGGERS == ("tool", "route", "test")
    assert wake_attempts.OUTCOMES == (
        "ready",
        "answered",
        "no_answer",
        "relay_cannot",
        "not_asleep",
        "stopped",
        "interrupted",
    )


async def test_record_sent_inserts_an_open_row_and_the_read_has_no_mac(pool):
    device = await _device(pool)
    relay = await _device(pool, "hub")
    turn = await pool.fetchval("INSERT INTO turns (kind) VALUES ('chat') RETURNING id")
    attempt = await _sent(pool, device, relay, turn_id=turn)

    row = await wake_attempts.get(pool, attempt)
    assert row["id"] == attempt
    assert row["device_id"] == device and row["relay_device_id"] == relay
    assert row["adapter"] == "Wi-Fi" and row["relay_iface"] == "eth0"
    assert str(row["broadcast"]) == BROADCAST and row["packets"] == 6
    assert row["sent_at"] == T0 and row["deadline_s"] == 120
    assert row["trigger"] == "tool" and row["turn_id"] == turn
    assert row["outcome"] is None and row["answered_at"] is None
    assert "mac" not in row
    assert MAC not in repr(row) and MAC.replace(":", "") not in repr(row)
    # the MAC is on the private row, as sent
    stored = await pool.fetchval("SELECT mac::text FROM wake_attempts WHERE id = $1", attempt)
    assert stored == MAC


async def test_a_second_open_attempt_for_the_machine_is_refused_with_when(pool):
    device = await _device(pool)
    await _sent(pool, device)
    with pytest.raises(wake_attempts.AttemptOpen) as err:
        await _sent(pool, device, sent_at=T0 + timedelta(seconds=5))
    assert "12:00:00" in str(err.value)
    assert MAC not in str(err.value)
    assert await pool.fetchval("SELECT count(*) FROM wake_attempts") == 1


async def test_record_sent_refuses_a_deadline_outside_30_to_600(pool):
    device = await _device(pool)
    for bad in (29, 601):
        with pytest.raises(ValueError, match="30"):
            await _sent(pool, device, deadline_s=bad)
    with pytest.raises(ValueError, match="trigger"):
        await _sent(pool, device, trigger="chat")


async def test_record_not_sent_is_decided_at_once_with_its_words(pool):
    device = await _device(pool)
    attempt = await wake_attempts.record_not_sent(
        pool,
        device_id=device,
        outcome="relay_cannot",
        reason="no connected agent shares box's network",
        trigger="tool",
        adapter="Wi-Fi",
        mac=MAC,
    )
    row = await wake_attempts.get(pool, attempt)
    assert row["outcome"] == "relay_cannot" and row["sent_at"] is None
    assert row["reason"] == "no connected agent shares box's network"
    assert row["decided_at"] is not None
    with pytest.raises(ValueError, match="no_answer"):
        await wake_attempts.record_not_sent(
            pool, device_id=device, outcome="no_answer", reason="x", trigger="tool"
        )
    with pytest.raises(ValueError, match="reason"):
        await wake_attempts.record_not_sent(
            pool, device_id=device, outcome="not_asleep", reason="", trigger="tool"
        )


async def test_evidence_lands_only_inside_the_deadline_and_first_wins(pool):
    device = await _device(pool)
    attempt = await _sent(pool, device)

    # before the send is not evidence of this send
    assert not await wake_attempts.mark_answered(pool, attempt, T0 - timedelta(seconds=1))
    # after the deadline is not inside the measurement
    assert not await wake_attempts.mark_answered(pool, attempt, T0 + timedelta(seconds=121))
    assert (await wake_attempts.get(pool, attempt))["answered_at"] is None

    assert await wake_attempts.mark_answered(pool, attempt, T0 + timedelta(seconds=40))
    assert not await wake_attempts.mark_answered(pool, attempt, T0 + timedelta(seconds=50))
    assert await wake_attempts.mark_serving(pool, attempt, T0 + timedelta(seconds=70))
    row = await wake_attempts.get(pool, attempt)
    assert row["answered_at"] == T0 + timedelta(seconds=40)
    assert row["serving_at"] == T0 + timedelta(seconds=70)


async def test_settle_derives_the_outcome_from_the_columns(pool):
    a, b, c, d = [await _device(pool, n) for n in "abcd"]
    ready = await _sent(pool, a)
    await wake_attempts.mark_answered(pool, ready, T0 + timedelta(seconds=30))
    await wake_attempts.mark_serving(pool, ready, T0 + timedelta(seconds=50))
    answered = await _sent(pool, b)
    await wake_attempts.mark_answered(pool, answered, T0 + timedelta(seconds=30))
    silent = await _sent(pool, c)
    waiting = await _sent(pool, d)

    after = T0 + timedelta(seconds=121)
    assert await wake_attempts.settle(pool, ready, now=T0 + timedelta(seconds=60)) == "ready"
    assert await wake_attempts.settle(pool, answered, now=after) == "answered"
    assert await wake_attempts.settle(pool, silent, now=after) == "no_answer"
    # inside the deadline with nothing: no outcome yet, never a guess
    assert await wake_attempts.settle(pool, waiting, now=T0 + timedelta(seconds=60)) is None
    assert (await wake_attempts.get(pool, waiting))["outcome"] is None
    # answered without serving, still inside the deadline: serving may yet come
    assert await wake_attempts.settle(pool, answered, now=after) == "answered"

    for attempt, outcome in ((ready, "ready"), (answered, "answered"), (silent, "no_answer")):
        row = await wake_attempts.get(pool, attempt)
        assert row["outcome"] == outcome and row["decided_at"] is not None


async def test_answered_but_not_serving_waits_for_the_deadline(pool):
    device = await _device(pool)
    attempt = await _sent(pool, device)
    await wake_attempts.mark_answered(pool, attempt, T0 + timedelta(seconds=30))
    assert await wake_attempts.settle(pool, attempt, now=T0 + timedelta(seconds=60)) is None
    assert await wake_attempts.settle(pool, attempt, now=T0 + timedelta(seconds=120)) == "answered"


async def test_a_decided_row_is_never_rewritten(pool):
    device = await _device(pool)
    attempt = await _sent(pool, device)
    assert await wake_attempts.settle(pool, attempt, now=T0 + timedelta(seconds=200)) == "no_answer"
    # a reconnect after the row is decided does not turn it into an answer
    assert not await wake_attempts.mark_answered(pool, attempt, T0 + timedelta(seconds=60))
    assert await wake_attempts.settle(pool, attempt, now=T0 + timedelta(seconds=300)) == "no_answer"
    row = await wake_attempts.get(pool, attempt)
    assert row["outcome"] == "no_answer" and row["answered_at"] is None
    # and the machine may be tried again
    assert await _sent(pool, device, sent_at=T0 + timedelta(seconds=400))


async def test_latest_and_open_for_a_machine(pool):
    device = await _device(pool)
    other = await _device(pool, "other")
    assert await wake_attempts.latest_for(pool, device) is None
    assert await wake_attempts.open_for(pool, device) is None
    first = await _sent(pool, device)
    await wake_attempts.settle(pool, first, now=T0 + timedelta(seconds=200))
    second = await _sent(pool, device, sent_at=T0 + timedelta(seconds=300))
    await _sent(pool, other)

    latest = await wake_attempts.latest_for(pool, device)
    assert latest["id"] == second and "mac" not in latest
    opened = await wake_attempts.open_for(pool, device)
    assert opened["id"] == second and "mac" not in opened
    await wake_attempts.settle(pool, second, now=T0 + timedelta(seconds=600))
    assert await wake_attempts.open_for(pool, device) is None
    assert (await wake_attempts.latest_for(pool, device))["id"] == second
