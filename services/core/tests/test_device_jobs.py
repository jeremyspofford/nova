"""Jobs on her machines as rows (S30c T9): migration 048's device_jobs table,
insert/read with env NAMES only, the agent's terminal `job` frame applied to
that device's own row at its own epoch, and the `job_ack` core answers with.

The frame core reads is the agent's committed golden
(apps/novad/internal/client/testdata/job_golden.json, written by novad's
TestTheJobFrameIsTheGoldenCoreReads) — the two sides share one file, so a
change to either breaks a test on the other."""

from __future__ import annotations

import asyncio
import json
import logging
import re
import uuid
from datetime import UTC, datetime
from pathlib import Path

import asyncpg
import pytest

from app import device_jobs, devices_ws
from tests.conftest import requires_db
from tests.device_fakes import FakeWSConn
from tests.test_devices_ws import _close, _connect, _enroll

pytestmark = requires_db

_MIGRATION = Path(__file__).resolve().parents[1] / "migrations/048_device_jobs.sql"
_GOLDEN = (
    Path(__file__).resolve().parents[3] / "apps/novad/internal/client/testdata/job_golden.json"
)
_ID = re.compile(r"^[0-9a-f]{12}$")
SECRET = "s3cr3t-value-that-must-never-land"


@pytest.fixture(autouse=True)
def _clean_hub():
    devices_ws.hub._conns.clear()
    devices_ws.hub._pending.clear()
    devices_ws.hub._last_command.clear()
    yield
    devices_ws.hub._conns.clear()
    devices_ws.hub._pending.clear()
    devices_ws.hub._last_command.clear()


def _golden() -> dict:
    return json.loads(_GOLDEN.read_text())


async def _turn(pool) -> uuid.UUID:
    return await pool.fetchval(
        "INSERT INTO turns (kind, conversation_id, model) VALUES ('chat', NULL, 'm') RETURNING id"
    )


async def _job(pool, device_id, **kw) -> str:
    args = {
        "device_id": device_id,
        "turn_id": None,
        "argv": ["sleep", "200"],
        "cwd": "/home/me",
        "env": None,
        "ran_in": "host",
        "box": None,
    }
    args.update(kw)
    return await device_jobs.insert(pool, **args)


async def _row(pool, job_id: str) -> dict | None:
    r = await pool.fetchrow("SELECT * FROM device_jobs WHERE id = $1", job_id)
    return dict(r) if r else None


def _frame(jid: str, **kw) -> dict:
    f = {
        "type": "job",
        "job_id": jid,
        "state": "done",
        "exit_code": 7,
        "started_at": "2026-10-12T09:00:00Z",
        "ended_at": "2026-10-12T09:03:20.123456789Z",
        "log_bytes": 1234,
        "reason": "it ended",
    }
    f.update(kw)
    return f


async def _insert_raw(pool, device_id, **over):
    cols = {
        "id": "00000000aa01",
        "device_id": device_id,
        "argv": ["true"],
        "env_keys": [],
        "ran_in": "host",
        "state": "starting",
    }
    cols.update(over)
    names = ", ".join(cols)
    marks = ", ".join(f"${i}" for i in range(1, len(cols) + 1))
    await pool.execute(f"INSERT INTO device_jobs ({names}) VALUES ({marks})", *cols.values())


# -- C1: the table -----------------------------------------------------------


async def test_c1_the_migration_is_048_and_the_next_free_number():
    names = sorted(p.name for p in _MIGRATION.parent.glob("*.sql"))
    assert _MIGRATION.name in names
    assert names[names.index(_MIGRATION.name) - 1] == "047_wake_attempts.sql"
    assert sum(1 for n in names if n.startswith("048_")) == 1


async def test_c1_the_table_has_every_column(pool):
    cols = {
        r["column_name"]: r["data_type"]
        for r in await pool.fetch(
            "SELECT column_name, data_type FROM information_schema.columns "
            "WHERE table_name = 'device_jobs'"
        )
    }
    assert cols == {
        "id": "text",
        "device_id": "uuid",
        "turn_id": "uuid",
        "argv": "jsonb",
        "cwd": "text",
        "env_keys": "ARRAY",
        "ran_in": "text",
        "box": "text",
        "state": "text",
        "exit_code": "integer",
        "reason": "text",
        "started_at": "timestamp with time zone",
        "ended_at": "timestamp with time zone",
        "log_bytes": "bigint",
        "created_at": "timestamp with time zone",
        "updated_at": "timestamp with time zone",
    }


async def test_c1_the_migration_runs_a_second_time(pool):
    await pool.execute(_MIGRATION.read_text())


@pytest.mark.parametrize(
    "over",
    [
        {"id": "00000000AA01"},
        {"id": "00000000aa0"},
        {"id": "../00000000a"},
        {"env_keys": ["TOKEN=abc"]},
        {"env_keys": ["1X"]},
        {"env_keys": ["OK", ""]},
        {"env_keys": ["A B"]},
        {"env_keys": ["OK", None]},
        {"argv": []},
        {"argv": "sleep 200"},
        {"argv": {"0": "sleep"}},
        {"ran_in": "elsewhere"},
        {"state": "finished"},
        {"log_bytes": -1},
    ],
)
async def test_c1_the_database_refuses_a_bad_row(pool, over):
    device_id, _ = await _enroll(pool)
    with pytest.raises(asyncpg.CheckViolationError):
        await _insert_raw(pool, device_id, **over)
    assert await pool.fetchval("SELECT count(*) FROM device_jobs") == 0


async def test_c1_a_good_raw_row_is_accepted_and_goes_with_its_device(pool):
    device_id, _ = await _enroll(pool)
    await _insert_raw(pool, device_id, env_keys=["GH_TOKEN", "_x1"], state="lost", log_bytes=0)
    assert await pool.fetchval("SELECT count(*) FROM device_jobs") == 1
    await pool.execute("DELETE FROM devices WHERE id = $1", device_id)
    assert await pool.fetchval("SELECT count(*) FROM device_jobs") == 0


async def test_c1_a_deleted_turn_leaves_the_job_with_no_turn(pool):
    device_id, _ = await _enroll(pool)
    turn = await _turn(pool)
    job = await _job(pool, device_id, turn_id=turn)
    await pool.execute("DELETE FROM turns WHERE id = $1", turn)
    row = await _row(pool, job)
    assert row is not None and row["turn_id"] is None


# -- C2: insert / get ----------------------------------------------------------


async def test_c2_insert_writes_a_starting_row_with_a_fresh_id_and_the_turn(pool):
    device_id, _ = await _enroll(pool)
    turn = await _turn(pool)
    job = await _job(
        pool,
        device_id,
        turn_id=turn,
        argv=["uv", "run", "pytest"],
        cwd="/w/.worktrees/nova-ab12",
        ran_in="box",
        box="nova-box-ab12",
    )
    assert _ID.match(job)
    other = await _job(pool, device_id)
    assert other != job
    row = await device_jobs.get(pool, job)
    assert row["id"] == job
    assert row["device_id"] == device_id
    assert row["turn_id"] == turn
    assert row["argv"] == ["uv", "run", "pytest"]
    assert row["cwd"] == "/w/.worktrees/nova-ab12"
    assert row["ran_in"] == "box"
    assert row["box"] == "nova-box-ab12"
    assert row["state"] == "starting"
    assert row["exit_code"] is None and row["ended_at"] is None
    assert row["created_at"] is not None and row["updated_at"] is not None


async def test_c2_new_job_id_is_twelve_lowercase_hex_and_fresh():
    ids = {device_jobs.new_job_id() for _ in range(200)}
    assert len(ids) == 200
    assert all(_ID.match(i) for i in ids)


async def test_c2_env_values_never_reach_the_row(pool):
    device_id, _ = await _enroll(pool)
    job = await _job(pool, device_id, env={"GH_TOKEN": SECRET, "FOO": "bar-baz-qux"})
    row = await device_jobs.get(pool, job)
    assert sorted(row["env_keys"]) == ["FOO", "GH_TOKEN"]
    raw = await pool.fetchval("SELECT row_to_json(j)::text FROM device_jobs j WHERE id = $1", job)
    assert SECRET not in raw and "bar-baz-qux" not in raw
    named = await _job(pool, device_id, env=["ONLY_NAME"])
    assert (await device_jobs.get(pool, named))["env_keys"] == ["ONLY_NAME"]
    none = await _job(pool, device_id, env=None)
    assert (await device_jobs.get(pool, none))["env_keys"] == []


@pytest.mark.parametrize(
    "bad",
    [
        {"argv": []},
        {"argv": ["ok", 3]},
        {"argv": "sleep 200"},
        {"env": {"TOKEN=abc": "v"}},
        {"env": ["1X"]},
        {"env": {"OK": 5}},
        {"ran_in": "elsewhere"},
    ],
)
async def test_c2_bad_input_raises_and_inserts_nothing(pool, bad):
    device_id, _ = await _enroll(pool)
    with pytest.raises(ValueError) as exc:
        await _job(pool, device_id, **bad)
    assert SECRET not in str(exc.value)
    assert await pool.fetchval("SELECT count(*) FROM device_jobs") == 0


async def test_c2_get_of_an_unknown_or_malformed_id_is_none(pool):
    assert await device_jobs.get(pool, "0123456789ab") is None
    assert await device_jobs.get(pool, "../etc") is None
    assert await device_jobs.get(pool, None) is None


# -- C3: a terminal frame ---------------------------------------------------------


async def test_c3_a_terminal_frame_is_stored_on_its_row(pool):
    device_id, _ = await _enroll(pool)
    job = await _job(pool, device_id)
    before = (await _row(pool, job))["updated_at"]
    await asyncio.sleep(0.01)
    out = await device_jobs.apply_frame(pool, device_id, _frame(job), epoch=0)
    assert out == "stored"
    row = await device_jobs.get(pool, job)
    assert row["state"] == "done"
    assert row["exit_code"] == 7
    assert row["started_at"] == datetime(2026, 10, 12, 9, 0, tzinfo=UTC)
    assert row["ended_at"] == datetime(2026, 10, 12, 9, 3, 20, 123456, tzinfo=UTC)
    assert row["log_bytes"] == 1234
    assert row["reason"] == "it ended"
    assert row["updated_at"] > before
    # the start-time columns are not the frame's to change
    assert row["argv"] == ["sleep", "200"] and row["cwd"] == "/home/me"


async def test_c3_exit_zero_stays_zero_and_null_stays_null(pool):
    device_id, _ = await _enroll(pool)
    zero = await _job(pool, device_id)
    assert await device_jobs.apply_frame(pool, device_id, _frame(zero, exit_code=0), epoch=0) == (
        "stored"
    )
    assert (await device_jobs.get(pool, zero))["exit_code"] == 0
    lost = await _job(pool, device_id)
    out = await device_jobs.apply_frame(
        pool,
        device_id,
        _frame(lost, state="lost", exit_code=None, started_at=None, reason="its wrapper is gone"),
        epoch=0,
    )
    assert out == "stored"
    row = await device_jobs.get(pool, lost)
    assert (row["state"], row["exit_code"], row["started_at"], row["reason"]) == (
        "lost",
        None,
        None,
        "its wrapper is gone",
    )


@pytest.mark.parametrize("state", ["failed_to_start", "stopped"])
async def test_c3_every_terminal_state_is_stored(pool, state):
    device_id, _ = await _enroll(pool)
    job = await _job(pool, device_id)
    assert await device_jobs.apply_frame(pool, device_id, _frame(job, state=state), epoch=0) == (
        "stored"
    )
    assert (await device_jobs.get(pool, job))["state"] == state


async def test_c3_the_same_frame_again_is_stored_with_the_same_values(pool):
    device_id, _ = await _enroll(pool)
    job = await _job(pool, device_id)
    assert await device_jobs.apply_frame(pool, device_id, _frame(job), epoch=0) == "stored"
    first = await device_jobs.get(pool, job)
    assert await device_jobs.apply_frame(pool, device_id, _frame(job), epoch=0) == "stored"
    again = await device_jobs.get(pool, job)
    first.pop("updated_at"), again.pop("updated_at")
    assert again == first


async def test_c3_a_nul_in_the_reason_does_not_lose_the_frame(pool):
    device_id, _ = await _enroll(pool)
    job = await _job(pool, device_id)
    out = await device_jobs.apply_frame(pool, device_id, _frame(job, reason="a\x00b"), epoch=0)
    assert out == "stored"
    assert (await device_jobs.get(pool, job))["reason"] == "a�b"


# -- C4: its own job, its own epoch, a well-formed frame -----------------------------


async def test_c4_another_devices_job_is_unknown_and_untouched(pool):
    mine, _ = await _enroll(pool, name="mine")
    theirs, _ = await _enroll(pool, name="theirs")
    job = await _job(pool, theirs)
    before = await _row(pool, job)
    assert await device_jobs.apply_frame(pool, mine, _frame(job), epoch=0) == "unknown"
    assert await _row(pool, job) == before


async def test_c4_an_id_with_no_row_is_unknown_and_logged(pool, caplog):
    device_id, _ = await _enroll(pool)
    with caplog.at_level(logging.INFO, logger="core"):
        out = await device_jobs.apply_frame(pool, device_id, _frame("0123456789ab"), epoch=0)
    assert out == "unknown"
    assert "0123456789ab" in caplog.text
    assert await pool.fetchval("SELECT count(*) FROM device_jobs") == 0


async def test_c4_a_frame_from_a_moved_epoch_stores_nothing(pool):
    device_id, _ = await _enroll(pool)
    job = await _job(pool, device_id)
    await pool.execute("UPDATE devices SET audit_epoch = 3 WHERE id = $1", device_id)
    before = await _row(pool, job)
    assert await device_jobs.apply_frame(pool, device_id, _frame(job), epoch=2) == "moved"
    assert await _row(pool, job) == before
    assert await device_jobs.apply_frame(pool, device_id, _frame(job), epoch=3) == "stored"
    assert (await _row(pool, job))["state"] == "done"


@pytest.mark.parametrize(
    "over",
    [
        {"job_id": "0123456789AB"},
        {"job_id": "../etc/pass"},
        {"job_id": 12},
        {"state": "running"},
        {"state": "waiting_lock"},
        {"state": "finished"},
        {"exit_code": "0"},
        {"exit_code": 1.5},
        {"exit_code": True},
        {"started_at": "yesterday"},
        {"ended_at": "2026-10-12T09:03:20"},
        {"ended_at": 5},
        {"log_bytes": -1},
        {"log_bytes": "41"},
        {"log_bytes": None},
        {"reason": 5},
    ],
)
async def test_c4_a_malformed_frame_stores_nothing(pool, over, caplog):
    device_id, _ = await _enroll(pool)
    job = await _job(pool, device_id)
    before = await _row(pool, job)
    frame = _frame(job, **over)
    with caplog.at_level(logging.INFO, logger="core"):
        assert await device_jobs.apply_frame(pool, device_id, frame, epoch=0) == "malformed"
    assert caplog.text
    assert await _row(pool, job) == before


# -- C5: the socket answers job_ack -----------------------------------------------


def _acks(conn: FakeWSConn) -> list[dict]:
    return [f for f in conn.sent if isinstance(f, dict) and f.get("type") == "job_ack"]


async def _await_ack(conn: FakeWSConn, job_id: str) -> None:
    async def wait():
        while not any(a.get("job_id") == job_id for a in _acks(conn)):
            await asyncio.sleep(0.01)

    await asyncio.wait_for(wait(), 2)


async def test_c5_a_stored_frame_is_acked_with_its_id(pool):
    device_id, _device, conn, task = await _connect(pool)
    try:
        job = await _job(pool, device_id)
        conn.feed(_frame(job))
        await _await_ack(conn, job)
        assert _acks(conn) == [{"type": "job_ack", "job_id": job}]
        assert (await device_jobs.get(pool, job))["state"] == "done"
        assert devices_ws.hub.is_connected(device_id)
    finally:
        await _close(conn, task)


async def test_c5_a_socket_at_a_later_epoch_has_its_frame_stored_and_acked(pool):
    # a re-paired device authenticates at audit_epoch > 0; its job frame is
    # applied at THAT socket's epoch (never a constant), so it is stored and
    # acked rather than read as "moved" and re-sent every session
    device_id, device = await _enroll(pool)
    await pool.execute("UPDATE devices SET audit_epoch = 4 WHERE id = $1", device_id)
    conn = FakeWSConn()
    task = asyncio.create_task(devices_ws.serve(conn, pool))
    try:
        challenge = await asyncio.wait_for(conn.next_sent(), 2)
        conn.feed(
            {
                "type": "auth",
                "device_id": str(device_id),
                "sig": device.sign_nonce(challenge["nonce"]),
            }
        )
        assert (await asyncio.wait_for(conn.next_sent(), 2))["type"] == "ready"
        job = await _job(pool, device_id)
        conn.feed(_frame(job))
        await _await_ack(conn, job)
        assert _acks(conn) == [{"type": "job_ack", "job_id": job}]
        row = await device_jobs.get(pool, job)
        assert row["state"] == "done"
        assert row["exit_code"] == 7
        assert not task.done()
    finally:
        await _close(conn, task)


async def test_c5_an_unknown_id_is_acked_so_it_is_never_resent_forever(pool):
    device_id, _device, conn, task = await _connect(pool)
    try:
        conn.feed(_frame("0123456789ab"))
        await _await_ack(conn, "0123456789ab")
        assert await pool.fetchval("SELECT count(*) FROM device_jobs") == 0
    finally:
        await _close(conn, task)


async def test_c5_malformed_and_moved_frames_get_no_ack_and_the_session_stays(pool, caplog):
    device_id, _device, conn, task = await _connect(pool)
    try:
        bad = await _job(pool, device_id)
        conn.feed(_frame(bad, state="running"))
        conn.feed(_frame("NOT-AN-ID"))
        good = await _job(pool, device_id)
        conn.feed(_frame(good))
        await _await_ack(conn, good)  # frames are handled in order
        assert _acks(conn) == [{"type": "job_ack", "job_id": good}]
        assert (await device_jobs.get(pool, bad))["state"] == "starting"

        moved = await _job(pool, device_id)
        await pool.execute(
            "UPDATE devices SET audit_epoch = audit_epoch + 1 WHERE id = $1", device_id
        )
        conn.feed(_frame(moved))
        # once the moved frame is handled (its warning logged), put the row
        # back at the socket's epoch (only a test does this) so the next
        # frame — unknown, acked — shows nothing was acked in between

        async def moved_logged():
            while f"job {moved} frame not stored" not in caplog.text:
                await asyncio.sleep(0.01)

        await asyncio.wait_for(moved_logged(), 2)
        await pool.execute("UPDATE devices SET audit_epoch = 0 WHERE id = $1", device_id)
        conn.feed(_frame("0123456789ab"))
        await _await_ack(conn, "0123456789ab")
        assert [a["job_id"] for a in _acks(conn)] == [good, "0123456789ab"]
        assert (await device_jobs.get(pool, moved))["state"] == "starting"
        assert not task.done()
    finally:
        await _close(conn, task)


async def test_c5_a_frame_that_cannot_be_applied_does_not_end_the_session(pool, monkeypatch):
    async def boom(*_a, **_k):
        raise RuntimeError("postgres went away")

    device_id, _device, conn, task = await _connect(pool)
    try:
        monkeypatch.setattr(device_jobs, "apply_frame", boom)
        conn.feed(_frame("0123456789ab"))
        conn.feed({"type": "heartbeat"})
        await asyncio.sleep(0.2)
        assert not task.done()
        assert _acks(conn) == []
    finally:
        await _close(conn, task)


# -- C6: the golden contract --------------------------------------------------------


async def test_c6_the_agents_golden_frame_is_stored_and_acked(pool):
    golden = _golden()
    assert golden["type"] == "job"
    device_id, _device, conn, task = await _connect(pool)
    try:
        await _insert_raw(pool, device_id, id=golden["job_id"])
        conn.feed(golden)
        await _await_ack(conn, golden["job_id"])
    finally:
        await _close(conn, task)
    row = await device_jobs.get(pool, golden["job_id"])
    assert row["state"] == golden["state"]
    assert row["exit_code"] == golden["exit_code"]
    assert row["started_at"] == datetime.fromisoformat(golden["started_at"])
    assert row["ended_at"] == datetime.fromisoformat(golden["ended_at"])
    assert row["log_bytes"] == golden["log_bytes"]
    assert row["reason"] == golden["reason"]
